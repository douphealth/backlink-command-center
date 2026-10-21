"""Portfolio Editorial Outreach CLI: research, verify, draft, send with hard safety gates, verify backlinks."""
from __future__ import annotations
import argparse
import csv
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import requests
from .engine import Engine, is_public_url, render_html_report, utc_now
from .integrations import BraveSearch, GmailAPI, NotConfigured
from .portfolio import validate_portfolio, audit_assets, asset_is_verified, ranked_sites, site_progress
from .submissions import import_forms, verify_form, record_form_receipt
from .dataforseo import DataForSEO, DataForSEOBlocked, DataForSEOUncertain, DataForSEOError, _rate_from_user
from .dataforseo_workflow import run_dataforseo_cycle
from . import opstate
from .monitoring import monitor_replies
from .crm import import_crm, crm_sync_due
from .analytics import import_referrals, referral_summary

# Diverse, intent-specific searches instead of repeating generic "write for us" SEO spam.
QUERY_TEMPLATES=[
  '"{topic}" "resources" "recommended"',
  '"{topic}" "resource library" "submit"',
  '"{topic}" "useful links"',
  '"{topic}" "best free tools"',
  '"{topic}" "expert roundup"',
  '"{topic}" "submit a resource"',
  '"{topic}" "write for us"',
  '"{topic}" "editorial guidelines"',
  '"{topic}" "podcast" "guest"',
  '"{topic}" "contributor guidelines"',
  '"{topic}" "tool collection"',
  '"{topic}" "suggest a resource"',
]

BLOCKED_PUBLISHERS={'facebook.com','x.com','twitter.com','reddit.com','quora.com',
                    'linkedin.com','instagram.com','tiktok.com','pinterest.com',
                    'youtube.com','wikipedia.org','google.com','bing.com',
                    'medium.com','substack.com'}


def pick_query(engine,site):
    """Select a footprint query not already attempted recently for this domain."""
    topic=(site.get('topic') or '').strip()
    for template in QUERY_TEMPLATES:
        query=template.format(topic=topic)
        if not engine.queried_recently(site['domain'],query,days=14):
            return query
    return ''


def reserve_search_budget(engine,limit:int,*,provider='brave'):
    """Transactional request reservation; no API-call retries on uncertain outcomes."""
    from zoneinfo import ZoneInfo
    day=datetime.now(ZoneInfo('Europe/Athens')).strftime('%Y-%m-%d')
    try:
        engine.conn.execute('BEGIN IMMEDIATE')
        row=engine.conn.execute('SELECT count FROM api_usage WHERE day=? AND provider=?',(day,provider)).fetchone()
        if (row['count'] if row else 0)>=limit:
            engine.conn.rollback();return False
        engine.conn.execute('INSERT INTO api_usage(day,provider,count) VALUES(?,?,1) '
                            'ON CONFLICT(day,provider) DO UPDATE SET count=count+1',(day,provider))
        engine.conn.commit();return True
    except Exception:
        engine.conn.rollback();raise


def load_config(path):
    cfg=json.loads(Path(path).read_text(encoding='utf-8'))
    validate_portfolio(cfg)
    return cfg


def discover(engine, cfg, *, max_calls=9, search=None, require_verified_assets=True):
    """Portfolio-fair sourcing with zero billing or false authority claims.

    Unverified assets are *never* pitched by the independent worker. The
    preview/audit phase must mark them live first. All searches are tracked.
    """
    search=search or BraveSearch()
    if isinstance(search,BraveSearch) and not search.api_key:
        engine.log('discovery_blocked',{'reason':'BRAVE_API_KEY absent; safe import-only mode'})
        return {'searched':0,'recorded_raw_candidates':0,'skipped':'BRAVE_API_KEY absent; no billed request'}
    max_calls=min(max(0,int(max_calls)),12)
    cap=max(0,min(int(os.getenv('MAX_SEARCHES_PER_DAY','12')),100))
    if max_calls==0 or cap==0:return {'searched':0,'recorded_raw_candidates':0,'skipped':'budget=0'}
    count=0;inserted=0;errors=[];searched_sites=[];not_ready=[];seen=set()
    for ranked in ranked_sites(engine,cfg):
        if count>=max_calls:break
        site=ranked['site'];domain=site['domain']
        if not site.get('assets'):continue
        # Rotate assets per site when multiple valuable URLs are available.
        attempts=ranked['attempts']
        urls=site['assets'];choices=urls[attempts%len(urls):]+urls[:attempts%len(urls)]
        chosen=next((a for a in choices if asset_is_verified(engine,a)),None)
        if require_verified_assets and not chosen:
            not_ready.append(domain)
            continue
        asset=chosen or urls[0]
        query=pick_query(engine,site)
        if not query:continue
        if not reserve_search_budget(engine,cap):break
        count+=1
        encountered=0;added=0;error=''
        try:
            items=search.search(query,count=10)
            for item in items:
                url=item.get('url','')
                if not is_public_url(url):continue
                from .engine import reg_domain
                publisher=reg_domain(url)
                if not publisher or publisher in BLOCKED_PUBLISHERS or publisher==domain:
                    continue
                encountered+=1
                if engine.is_suppressed(publisher=publisher):continue
                # No second active pitch to a publisher, even for a different owned site.
                if engine.publisher_already_in_pipeline(publisher):continue
                try:
                    kind='resource' if any(x in query for x in ('resources','useful links','resource library')) else 'roundup' if 'best free' in query or 'collection' in query else 'guest_post' if 'guidelines' in query or 'write for us' in query else 'interview'
                    existing=engine.conn.execute('''SELECT 1 FROM candidates WHERE site=? AND source_url=? AND asset_url=? LIMIT 1''',
                        (domain,url,asset)).fetchone()
                    engine.add_candidate(site=domain,source_url=url,asset_url=asset,
                        kind=kind,title=item.get('title',''))
                    if not existing:added+=1
                except ValueError:
                    continue
            inserted+=added
        except Exception as ex:
            error=type(ex).__name__
            errors.append({'site':domain,'query':query,'error':error})
            engine.log('search_error',errors[-1])
        finally:
            engine.record_search(domain,query,encountered,added,error)
            searched_sites.append(domain)
    summary={'searched':count,'recorded_raw_candidates':inserted,
             'searched_sites':searched_sites,'assets_not_verified':not_ready,'errors':errors}
    engine.log('discovery',summary)
    return summary


def qualify_pending(engine,limit=20,session=None):
    cutoff=(datetime.now(timezone.utc)-timedelta(days=7)).isoformat()
    rows=engine.conn.execute("SELECT id FROM candidates WHERE status='found' OR (status='research' AND (source_checked_at IS NULL OR source_checked_at<?)) OR (status='retry' AND (source_checked_at IS NULL OR source_checked_at<?)) ORDER BY score DESC NULLS LAST,id LIMIT ?",(cutoff,(datetime.now(timezone.utc)-timedelta(days=2)).isoformat(),limit)).fetchall()
    verified=0;eligible=0;failed=0
    for c in rows:
        ret=engine.verify(c['id'],session=session)
        verified+=1
        if ret['status']=='verified_ready':eligible+=1
        if ret['status']=='rejected':failed+=1
    return {'checked':verified,'eligible':eligible,'rejected':failed}


def draft_ready(engine,cfg,limit=10):
    mapping={s['domain'].lower():s for s in cfg['sites']}
    candidates=engine.conn.execute('''SELECT c.id,c.site,c.kind,c.score FROM candidates c LEFT JOIN messages m ON m.candidate_id=c.id
      WHERE c.status='verified_ready' AND m.id IS NULL AND c.score>=70 ORDER BY c.score DESC LIMIT 500''').fetchall()
    feedback=engine.learning_evidence()
    candidates=sorted(candidates,key=lambda c:c['score']+feedback.get(c['kind'],{}).get('bounded_score_adjustment',0),reverse=True)[:limit]
    drafts=[];errors=[]
    for c in candidates:
        try:
            d=engine.prepare_draft(c['id'],{**mapping[c['site']],'sender_name':cfg['sender_name']}); drafts.append({'id':c['id'],'to':d['to_address'],'subject':d['subject']})
        except (ValueError,KeyError) as exc:errors.append({'id':c['id'],'error':str(exc)})
    return {'drafts':drafts,'errors':errors}


def sync_remote_drafts(engine,limit=10,gmail=None):
    """Put verified local draft messages into Gmail Drafts without sending.

    If an API timeout happens, do not retry automatically: draft may have been created.
    """
    gmail=gmail or GmailAPI()
    if not gmail.configured():return {'created':[],'blocked':'missing Gmail OAuth with gmail.compose scope'}
    rows=engine.conn.execute("""SELECT m.*,c.publisher_domain,c.explicit_invitation,c.status AS prospect_status
       FROM messages m JOIN candidates c ON c.id=m.candidate_id
       WHERE m.status='draft' AND m.gmail_draft_id IS NULL AND c.status='verified_ready'
       ORDER BY c.score DESC LIMIT ?""",(limit,)).fetchall()
    made=[];blocked=[]
    for m in rows:
        if engine.is_suppressed(m['to_address'],m['publisher_domain']) or not m['explicit_invitation']:
            blocked.append({'candidate':m['candidate_id'],'reason':'recipient suppression or unverified invitation'});continue
        try:
            if gmail.find_contact_history(m['to_address']):
                blocked.append({'candidate':m['candidate_id'],'reason':'previously contacted'});continue
            draft_id=gmail.create_draft(m['to_address'],m['subject'],m['body'])
            engine.mark_gmail_draft(m['candidate_id'],draft_id)
            made.append({'candidate':m['candidate_id'],'gmail_draft_id':draft_id})
        except Exception as exc:
            blocked.append({'candidate':m['candidate_id'],'reason':type(exc).__name__+'; reconcile Gmail Drafts'})
            engine.log('gmail_draft_uncertain',{'candidate':m['candidate_id'],'error':type(exc).__name__},m['candidate_id'])
            # Mark as needing manual reconciliation, not as unsent and safe to retry.
            engine.conn.execute("UPDATE messages SET status='draft_uncertain' WHERE id=?",(m['id'],));engine.conn.commit()
            break
    return {'created':made,'blocked':blocked}


def weekly_check(engine,gmail=None,limit=40):
    """Verify existing target-page links and draft a SINGLE same-thread weekly follow-up.

    Requires legitimate OAuth access. This never sends follow-ups.
    """
    gmail=gmail or GmailAPI()
    older=(datetime.now(timezone.utc)-timedelta(days=7)).isoformat()
    candidates=engine.conn.execute("""SELECT c.id,c.publisher_domain,c.source_url,c.asset_url,m.*
       FROM candidates c JOIN messages m ON c.id=m.candidate_id
       WHERE m.status='sent' ORDER BY m.sent_at ASC LIMIT ?""",(limit,)).fetchall()
    result={'reviewed':0,'verified_links':0,'followup_drafts':[], 'replies_found':0,'blocked':[]}
    processed_publishers=set()
    for m in candidates:
        result['reviewed']+=1
        # The real page source is checked, but a distinct published placement URL must be supplied
        # if the editor chose a new story URL. No link is implied from a Gmail send.
        link=engine.verify_placement(m['candidate_id'])
        if link['live'] is True:result['verified_links']+=1
        if m['sent_at'] is None or m['sent_at']>older or m['followup_draft_id'] or m['followup_at']:
            continue
        if m['publisher_domain'] in processed_publishers:continue
        if engine.is_suppressed(m['to_address'],m['publisher_domain']):continue
        processed_publishers.add(m['publisher_domain'])
        if not gmail.configured():
            result['blocked'].append({'candidate':m['candidate_id'],'reason':'Gmail OAuth not configured; no follow-up created'});continue
        try:
            info=gmail.thread_for_message(m['gmail_id'])
            messages=info['thread'].get('messages',[])
            # Check any other sender message after the original; avoid interpreting self-sent mail as replies.
            original_found=False;replied=False
            orig_id_header=''
            for x in messages:
                headers={h.get('name','').lower():h.get('value','') for h in x.get('payload',{}).get('headers',[])}
                if x.get('id')==m['gmail_id']:
                    original_found=True
                    orig_id_header=headers.get('message-id','')
                elif original_found and 'SENT' not in x.get('labelIds',[]):
                    if 'mailer-daemon' not in headers.get('from','').lower() and 'no-reply' not in headers.get('from','').lower():
                        replied=True
            if replied:
                result['replies_found']+=1;continue
            if not orig_id_header:
                result['blocked'].append({'candidate':m['candidate_id'],'reason':'Original Message-ID not available'});continue
            body=(f"Hello,\n\nOne brief follow-up about the free resource I sent for your "+
                  f"editorial consideration: {m['asset_url']} . If it is not relevant, no reply is needed.\n\n"+
                  "Best,\nAlexios Papaioannou")
            draft_id=gmail.create_draft(m['to_address'],m['subject'],body,
                                      thread_id=info['thread_id'],in_reply_to=orig_id_header)
            engine.mark_followup_draft(m['candidate_id'],draft_id)
            result['followup_drafts'].append({'candidate':m['candidate_id'],'gmail_draft_id':draft_id})
        except Exception as exc:
            engine.conn.execute("UPDATE messages SET followup_at=? WHERE candidate_id=? AND followup_at IS NULL",('UNCERTAIN; CHECK GMAIL DRAFTS',m['candidate_id']))
            engine.conn.commit()
            engine.log('followup_draft_uncertain',{'candidate':m['candidate_id'],'error':type(exc).__name__},m['candidate_id'])
            result['blocked'].append({'candidate':m['candidate_id'],'reason':type(exc).__name__+'; do not retry until reconciled'})
            break
    return result


def _is_business_hour(tz_hour:int):return 8<=tz_hour<19


def send_ready(engine,cfg,limit=2,gmail=None,dry_run=True):
    """Never uses arbitrary send targets. Exactly one official public published mailto required."""
    if dry_run or os.getenv('PR_SEND_ENABLED','')!='YES':
        return {'sent':[],'blocked':'dry_run or PR_SEND_ENABLED != YES'}
    # Protect publisher reputation on a new host. The local SQLite state must
    # know prior outreach before ANY fresh emails are allowed to go out.
    if os.getenv('PR_REQUIRE_HISTORY_SEED','YES')=='YES':
        seeded=engine.conn.execute("SELECT 1 FROM activity WHERE type IN ('suppression_import','crm_sync_finished') LIMIT 1").fetchone()
        if not seeded:
            return {'sent':[],'blocked':'historical outreach/suppression reconciliation not completed'}
    gmail=gmail or GmailAPI()
    if not gmail.configured():return {'sent':[],'blocked':'missing Gmail OAuth credentials'}
    from zoneinfo import ZoneInfo
    now=datetime.now(ZoneInfo('Europe/Athens'))
    if not _is_business_hour(now.hour):return {'sent':[],'blocked':'outside Athens editorial outreach hours'}
    day=now.date().isoformat()
    day_start=datetime.combine(now.date(),datetime.min.time(),tzinfo=ZoneInfo('Europe/Athens')).astimezone(timezone.utc).isoformat()
    week_start=(datetime.now(timezone.utc)-timedelta(days=7)).isoformat()
    day_cap=int(os.getenv('MAX_SEND_PER_DAY','2'))
    week_cap=int(os.getenv('MAX_SEND_PER_WEEK','8'))
    if day_cap<1 or week_cap<1:return {'sent':[],'blocked':'send quotas disabled'}
    daily=engine.sent_count_since(day_start)
    weekly=engine.sent_count_since(week_start)
    if daily>=day_cap or weekly>=week_cap:return {'sent':[],'blocked':'local send cap reached'}
    # Gmail cross-check safeguards: if Gmail search errors, abort; never blindly send.
    try:
        portfolio_domains=[x['domain'] for x in cfg['sites']]
        # Older injected test adapters may not support the optional keyword argument.
        try:global_week=gmail.recent_sent_count(days=7,portfolio_domains=portfolio_domains)
        except TypeError:global_week=gmail.recent_sent_count(days=7)
    except Exception as exc:return {'sent':[],'blocked':'Gmail portfolio sent history unavailable: '+type(exc).__name__}
    if global_week>=week_cap:return {'sent':[],'blocked':'Gmail overall weekly sent count at limit'}
    max_allowed=min(limit,day_cap-daily,week_cap-weekly,week_cap-global_week)
    all_drafts=engine.conn.execute("""SELECT m.*,c.publisher_domain,c.status AS prospect_status,c.explicit_invitation,c.contact_source_url,
                       c.source_checked_at,c.asset_checked_at FROM messages m JOIN candidates c ON c.id=m.candidate_id
                       WHERE m.status='draft' AND c.status='verified_ready' ORDER BY c.score DESC LIMIT ?""",(max_allowed,)).fetchall()
    sent=[];blocked=[]
    for d in all_drafts:
        if engine.is_suppressed(d['to_address'],d['publisher_domain']):
            blocked.append({'candidate':d['candidate_id'],'why':'suppressed'});continue
        if engine.publisher_already_in_pipeline(d['publisher_domain'],exclude_candidate_id=d['candidate_id']):
            blocked.append({'candidate':d['candidate_id'],'why':'publisher already has different portfolio pitch'});continue
        # Email sender must check ALL previously contacted people in that newsroom.
        # A different mailbox at the same domain is not a green light to resend.
        if d['prospect_status']!='verified_ready':
            blocked.append({'candidate':d['candidate_id'],'why':'prospect is not verified_ready'});continue
        if engine.conn.execute('SELECT score FROM candidates WHERE id=?',(d['candidate_id'],)).fetchone()['score']<80:
            blocked.append({'candidate':d['candidate_id'],'why':'sender requires editorial-fit score >=80'});continue
        if not d['explicit_invitation'] or not d['contact_source_url']:
            blocked.append({'candidate':d['candidate_id'],'why':'unverified contact source'});continue
        if (datetime.now(timezone.utc)-datetime.fromisoformat(d['source_checked_at'])).days>14:
            blocked.append({'candidate':d['candidate_id'],'why':'source check stale'});continue
        try:
            if callable(getattr(gmail,'mx_status',None)):
                mx=gmail.mx_status(d['to_address'])
                if mx!='mx_present':
                    blocked.append({'candidate':d['candidate_id'],'why':'email domain MX health '+mx})
                    continue
            if gmail.find_contact_history(d['to_address']):
                blocked.append({'candidate':d['candidate_id'],'why':'already contacted in Gmail'});continue
            if callable(getattr(gmail,'find_publisher_history',None)) and gmail.find_publisher_history(d['publisher_domain']):
                blocked.append({'candidate':d['candidate_id'],'why':'publisher organization already contacted through Gmail'});continue
            gmail_id=(gmail.send_draft(d['gmail_draft_id']) if d['gmail_draft_id'] else
                      gmail.send(d['to_address'],d['subject'],d['body'],cfg['sender_name']))
            engine.mark_sent(d['candidate_id'],gmail_id)
            sent.append({'candidate':d['candidate_id'],'recipient':d['to_address'],'gmail_id':gmail_id})
        except Exception as exc:
            blocked.append({'candidate':d['candidate_id'],'why':type(exc).__name__})
            # A Gmail timeout may mean it sent. Never automatically retry an ambiguous send.
            engine.conn.execute("UPDATE messages SET status='needs_reconciliation' WHERE id=?",(d['id'],))
            engine.conn.commit()
            engine.log('send_attempt_unconfirmed',{'candidate':d['candidate_id'],'error':type(exc).__name__},d['candidate_id'])
            break  # No retries on ambiguous provider outcomes.
    return {'sent':sent,'blocked':blocked}


def export_candidates(engine,path):
    rows=engine.get_candidates(100000)
    keys=['id','site','publisher_domain','source_url','asset_url','kind','source_title','competitor_count',
          'spam_score','traffic_monthly','domain_rank','nofollow_share','contact_email',
          'editorial_policy_url','contact_source_url','explicit_invitation','score','status','excluded_reason']
    with open(path,'w',encoding='utf-8',newline='') as f:
        w=csv.DictWriter(f,fieldnames=keys,extrasaction='ignore');w.writeheader();w.writerows(rows)
    return len(rows)


def main(argv=None):
    parser=argparse.ArgumentParser(description='Evidence-led portfolio editorial backlink engine')
    parser.add_argument('--db',default='state/outreach.sqlite3')
    parser.add_argument('--config',default='config/sites.json')
    sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('init')
    sub.add_parser('dfs-budget')
    sub.add_parser('dfs-account')  # FREE user_data GET, no paid calls
    q=sub.add_parser('dfs-gap');q.add_argument('--site',required=True);q.add_argument('--competitor',action='append',required=True);q.add_argument('--limit',type=int,default=60)
    q=sub.add_parser('dfs-peers');q.add_argument('--site',required=True);q.add_argument('--limit',type=int,default=12)
    q=sub.add_parser('dfs-enrich');q.add_argument('--site',required=True);q.add_argument('--publisher',required=True);q.add_argument('--competitor',required=True);q.add_argument('--asset',required=True)
    sub.add_parser('dfs-cycle')
    f=sub.add_parser('import-footprints');f.add_argument('csv')
    x=sub.add_parser('import-suppression');x.add_argument('csv')
    g=sub.add_parser('import-gap');g.add_argument('csv',nargs='+');g.add_argument('--site',required=True);g.add_argument('--asset',required=True);g.add_argument('--competitor',action='append',required=True);g.add_argument('--own-baseline-verified',action='store_true')
    s=sub.add_parser('discover');s.add_argument('--max-calls',type=int,default=9)
    s=sub.add_parser('verify');s.add_argument('--limit',type=int,default=20)
    s=sub.add_parser('draft');s.add_argument('--limit',type=int,default=10)
    s=sub.add_parser('send');s.add_argument('--limit',type=int,default=2);s.add_argument('--live',action='store_true')
    s=sub.add_parser('sync-drafts');s.add_argument('--limit',type=int,default=10)
    s=sub.add_parser('weekly-check');s.add_argument('--limit',type=int,default=40)
    s=sub.add_parser('check-links');s.add_argument('--limit',type=int,default=25);s.add_argument('--id',type=int);s.add_argument('--placement-url')
    s=sub.add_parser('record-outcome');s.add_argument('--id',type=int,required=True);s.add_argument('--type',required=True);s.add_argument('--evidence',required=True)
    sub.add_parser('learning')
    s=sub.add_parser('report');s.add_argument('--output',default='output/backlink-report.html')
    s=sub.add_parser('export');s.add_argument('--output',default='output/prospects.csv')
    s=sub.add_parser('audit-sites');s.add_argument('--max-checks',type=int,default=12)
    sub.add_parser('portfolio')
    sub.add_parser('sync-crm')
    s=sub.add_parser('import-referrals');s.add_argument('csv')
    s=sub.add_parser('import-forms');s.add_argument('csv')
    s=sub.add_parser('verify-forms');s.add_argument('--limit',type=int,default=6)
    s=sub.add_parser('record-form-receipt');s.add_argument('--id',required=True,type=int);s.add_argument('--receipt',required=True);s.add_argument('--listing-url',default='')
    s=sub.add_parser('monitor-replies');s.add_argument('--limit',type=int,default=25)
    s=sub.add_parser('health');s.add_argument('--strict',action='store_true');s.add_argument('--max-age-hours',type=int,default=12)
    s=sub.add_parser('run');s.add_argument('--max-calls',type=int,default=9);s.add_argument('--send-live',action='store_true')
    args=parser.parse_args(argv)
    engine=Engine(args.db)
    cfg=load_config(args.config) if args.command not in (
        'init','import-footprints','import-suppression','import-gap','verify','check-links',
        'record-outcome','learning','export','import-forms','verify-forms','record-form-receipt','health','monitor-replies','dfs-budget','dfs-account','dfs-gap','dfs-peers','dfs-enrich') else None
    out={}
    try:
        if args.command=='init':out={'db':args.db,'status':'initialized'}
        elif args.command=='dfs-budget':out=DataForSEO(engine).status()
        elif args.command=='dfs-account':
            dfs=DataForSEO(engine);user=dfs.account(force=True)
            out={'connected':True,'free_check':True,'account_balance_usd':user['money']['balance'],
                 'pricing_usd':{n:tuple(map(str,_rate_from_user(user,'backlinks/'+n+'/live')))
                     for n in ('competitors','domain_intersection','backlinks')},'paid_calls':0}
        elif args.command=='dfs-gap':out=DataForSEO(engine).domain_gap(args.site,args.competitor,limit=args.limit)
        elif args.command=='dfs-peers':out=DataForSEO(engine).discover_peer_domains(args.site,limit=args.limit)
        elif args.command=='dfs-enrich':out=DataForSEO(engine).enrich_page(args.site,args.publisher,args.competitor,args.asset)
        elif args.command=='dfs-cycle':out=run_dataforseo_cycle(engine,cfg)
        elif args.command=='import-footprints':out={'imported':engine.load_footprints(args.csv)}
        elif args.command=='import-suppression':out={'imported_suppressions':engine.load_suppressions(args.csv)}
        elif args.command=='import-gap':out=engine.load_backlink_gap(args.csv,args.site,args.competitor,args.asset,own_baseline_verified=args.own_baseline_verified)
        elif args.command=='discover':out=discover(engine,cfg,max_calls=args.max_calls)
        elif args.command=='verify':out=qualify_pending(engine,args.limit)
        elif args.command=='draft':out=draft_ready(engine,cfg,args.limit)
        elif args.command=='send':out=send_ready(engine,cfg,args.limit,dry_run=not args.live)
        elif args.command=='sync-drafts':out=sync_remote_drafts(engine,args.limit)
        elif args.command=='weekly-check':out=weekly_check(engine,limit=args.limit)
        elif args.command=='record-outcome':
            engine.record_outcome(args.id,args.type,args.evidence)
            out={'candidate':args.id,'outcome':args.type,'status':'recorded'}
        elif args.command=='learning':out={'evidence':engine.learning_evidence()}
        elif args.command=='audit-sites':out={'assets':audit_assets(engine,cfg,max_checks=args.max_checks),'portfolio':site_progress(engine,cfg)}
        elif args.command=='portfolio':out={'domains':validate_portfolio(cfg),'priority':ranked_sites(engine,cfg),'site_funnel':site_progress(engine,cfg)}
        elif args.command=='import-forms':out=import_forms(engine,args.csv)
        elif args.command=='import-referrals':out=import_referrals(engine,args.csv,[x['domain'] for x in cfg['sites']])
        elif args.command=='sync-crm':out=import_crm(engine,cfg)
        elif args.command=='verify-forms':
            found=engine.conn.execute("SELECT id FROM submissions WHERE status='researched' ORDER BY id LIMIT ?",(args.limit,)).fetchall()
            out={'checked':[verify_form(engine,x['id']) for x in found]}
        elif args.command=='record-form-receipt':out=record_form_receipt(engine,args.id,args.receipt,args.listing_url)
        elif args.command=='monitor-replies':out=monitor_replies(engine,limit=args.limit)
        elif args.command=='health':
            dfs_status=DataForSEO(engine).status()
            recent=engine.conn.execute("SELECT time_utc,detail FROM activity WHERE type='run_finished' ORDER BY id DESC LIMIT 1").fetchone()
            age_hours=((datetime.now(timezone.utc)-datetime.fromisoformat(recent['time_utc'])).total_seconds()/3600) if recent else None
            failures=engine.conn.execute("SELECT COUNT(*) n FROM activity WHERE type='run_failed' AND time_utc>=?",((datetime.now(timezone.utc)-timedelta(days=2)).isoformat(),)).fetchone()['n']
            source_enabled=bool(os.getenv('BRAVE_API_KEY'))
            out={'last_completed_run_utc':recent['time_utc'] if recent else None,'age_hours':round(age_hours,2) if age_hours is not None else None,
                 'failures_48h':failures,'unattended_discovery_configured':source_enabled,
                 'gmail_oauth_configured':GmailAPI().configured(),'dataforseo':dfs_status,'assets_audited':engine.conn.execute('SELECT COUNT(*) n FROM portfolio_assets').fetchone()['n'],
                  'status':('stale' if age_hours is None or age_hours>args.max_age_hours else 'degraded' if not (source_enabled or (dfs_status['configured'] and dfs_status['paid_enabled'])) else 'running')}
            if args.strict and out['status']!='running':
                print(json.dumps(out,indent=2),file=sys.stderr)
                return 2
        elif args.command=='check-links':
            if args.placement_url and args.id is None:
                raise ValueError('--placement-url requires --id to avoid attributing a link to the wrong prospect')
            ids=[args.id] if args.id is not None else [c['id'] for c in engine.conn.execute(
                "SELECT id FROM candidates WHERE status IN ('sent','link_live') LIMIT ?",(args.limit,))]
            out={'checked':len(ids),'links':[{'id':i,**engine.verify_placement(
                i,placement_url=args.placement_url if args.id is not None else None)} for i in ids]}
        elif args.command=='report':out={'report_path':str(render_html_report(engine,args.output,portfolio_config=cfg)),'metrics':engine.report()}
        elif args.command=='export':
            Path(args.output).parent.mkdir(parents=True,exist_ok=True)
            out={'csv':args.output,'records':export_candidates(engine,args.output)}
        elif args.command=='run':
            # Research is always attempted even when sending or SEO APIs are unavailable.
            seed_path=Path(os.getenv('PR_INITIAL_SUPPRESSION_CSV','config/initial-suppression.csv'))
            seed_marker=engine.conn.execute("SELECT 1 FROM activity WHERE type='suppression_import' LIMIT 1").fetchone()
            if seed_path.exists() and not seed_marker:engine.load_suppressions(seed_path)
            crm_error=False
            if crm_sync_due(engine,hours=int(os.getenv('PR_CRM_SYNC_HOURS','12'))):
                try:crm_result=import_crm(engine,cfg)
                except (requests.RequestException,NotConfigured,ValueError) as e:
                    crm_error=True
                    crm_result={'status':'read_blocked','reason':type(e).__name__}
                    engine.log('crm_sync_failed',crm_result)
            else:crm_result={'status':'fresh_cached'}
            source_audit=audit_assets(engine,cfg,max_checks=int(os.getenv('MAX_ASSET_CHECKS_PER_RUN','5')))
            result_discover=discover(engine,cfg,max_calls=args.max_calls)
            # DataForSEO is opt-in, metered, and independently budgeted. If its
            # account validation or paid research is blocked, ordinary public
            # footprint research still continues; failures remain visible.
            # The operator can only PAUSE paid research; the provider gateway still
            # enforces hard budgets, pricing validation and no unsafe retries.
            dfs_paused = (engine.conn.execute("SELECT 1 FROM sqlite_master WHERE name='operator_controls'").fetchone()
                          and opstate.flag(engine.conn,'dataforseo_paused'))
            if os.getenv('DATAFORSEO_AUTO_GAP','NO') == 'YES' and not dfs_paused:
                try:
                    dfs_research=run_dataforseo_cycle(engine,cfg)
                except (DataForSEOBlocked,DataForSEOUncertain,DataForSEOError) as exc:
                    dfs_research={'status':'blocked','reason':str(exc)}
                    engine.log('dfs_cycle_blocked',dfs_research)
            else:
                dfs_research={'status':'disabled','reason':('Operator paused DataForSEO paid research' if dfs_paused else 'DATAFORSEO_AUTO_GAP != YES')}
            out={'crm_sync':crm_result,'asset_audit':source_audit,'discovery':result_discover,
                 'dataforseo':dfs_research,
                 'qualification':qualify_pending(engine,limit=25),
                 'drafting':draft_ready(engine,cfg,limit=10),
                 'remote_drafts':sync_remote_drafts(engine,limit=10),
                 'sending':send_ready(engine,cfg,limit=3,dry_run=(not args.send_live or crm_error))}
            found=engine.conn.execute("SELECT id FROM submissions WHERE status='researched' ORDER BY id LIMIT 3").fetchall()
            out['forms_review']=[verify_form(engine,x['id']) for x in found]
            last_weekly=engine.conn.execute("SELECT time_utc FROM activity WHERE type='weekly_finished' ORDER BY id DESC LIMIT 1").fetchone()
            if not last_weekly or datetime.now(timezone.utc)-datetime.fromisoformat(last_weekly['time_utc'])>timedelta(days=7):
                out['weekly_review']=weekly_check(engine,limit=30)
                engine.log('weekly_finished',{'reviewed':out['weekly_review']['reviewed'],
                                              'verified_links':out['weekly_review']['verified_links'],
                                              'followup_drafts':len(out['weekly_review']['followup_drafts'])})
            out['metrics']=engine.report()
            out['measured_referral_outcomes']=referral_summary(engine)
            out['portfolio']=site_progress(engine,cfg)
            previous=engine.conn.execute("SELECT COUNT(*) n FROM activity WHERE type='run_finished'").fetchone()['n']
            if (previous+1)%7==0:
                out['learning_review']=engine.learning_evidence()
                engine.log('learning_review',out['learning_review'])
            render_html_report(engine,'output/backlink-report.html',portfolio_config=cfg)
            meaningful=bool(out['discovery'].get('searched') or out['qualification'].get('checked') or
                            out['forms_review'] or out['asset_audit'].get('checked') or
                            out['sending'].get('sent') or out['dataforseo'].get('status')=='processed')
            out['run_status']='work_done' if meaningful else 'blocked_or_no_pending_work'
            engine.log('run_finished',out)
    except (ValueError,NotConfigured,KeyError,OSError,requests.RequestException,DataForSEOError) as e:
        engine.log('run_failed',{'command':args.command,'error':str(e)})
        print(json.dumps({'status':'blocked','reason':str(e)},indent=2),file=sys.stderr)
        return 2
    print(json.dumps(out,indent=2,ensure_ascii=False,default=str))
    return 0

if __name__=='__main__':raise SystemExit(main())
