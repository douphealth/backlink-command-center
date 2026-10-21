"""Cost-bounded autonomous DataForSEO competitor-gap discovery.

A DataForSEO overlap is a CANDIDATE, not a topical prospect or a live backlink.
Only after verifying publisher-topic fit do we spend a second call to retrieve an
actual referring page, which itself needs independent live-page validation.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re

from .dataforseo import DataForSEO, DataForSEOBlocked, DataForSEOUncertain
from .engine import fetch_page, reg_domain
from .portfolio import asset_is_verified

_STOP={'a','an','and','to','of','for','the','in','by','with','all','on','free','best','site','tools','tool','ai'}


def topic_matches(topic: str, text: str) -> bool:
    """Very conservative evidence for topical peer; not a guaranteed classifier."""
    words=[w.lower() for w in re.findall(r'[a-zA-Z]{3,}',topic) if w.lower() not in _STOP]
    if not words:return False
    text=text.lower()[:8000]
    token_matches=sum(1 for w in set(words) if w in text)
    return token_matches>=max(1,min(2,len(set(words))))


def peek_peer_candidates(dfs: DataForSEO, site:dict, max_http=8):
    """One cached/paid competitor discovery call, followed by NO-COST live site checks."""
    suggestion=dfs.discover_peer_domains(site['domain'],limit=12)
    qualified=[]; checked=[]
    for p in suggestion['candidates'][:max_http]:
        url='https://'+p['domain']+'/'
        resp=fetch_page(url)
        matches=(200<=resp['status']<300 and topic_matches(site['topic'],
                    (resp.get('title') or '')+' '+(resp.get('text') or '')))
        checked.append({'domain':p['domain'],'http_status':resp['status'],'matches_topic':matches})
        if matches:
            qualified.append(p['domain'])
    return {'peers':qualified[:2],'checked':checked,'dfs_cost_usd':suggestion['actual_usd'],
            'cached':suggestion['cached']}


def run_dataforseo_cycle(engine, portfolio_cfg:dict, *, dfs=None, max_sample_calls=1):
    dfs=dfs or DataForSEO(engine)
    if not dfs.configured:
        return {'status':'blocked','reason':'No DataForSEO credentials in worker environment',
                'paid_requests':0,'actual_paid_usd':'0.000000'}
    if not dfs.enabled:
        return {'status':'blocked','reason':'DATAFORSEO_PAID_ENABLED=NO; account will not be charged',
                'paid_requests':0,'actual_paid_usd':'0.000000'}

    # Cycle across ten sites using their actual last paid research, not a hardcoded favorite.
    old=engine.conn.execute('''SELECT site,MAX(created_at) last_call FROM dfs_requests
                  GROUP BY site''').fetchall()
    last={r['site']:r['last_call'] for r in old}
    sites=sorted(portfolio_cfg['sites'],key=lambda s:(last.get(s['domain'],'') or '',s['domain']))
    observed=[]
    for site in sites:
        asset=next((u for u in site.get('assets',[]) if asset_is_verified(engine,u,max_age_days=14)),None)
        if not asset:
            observed.append({'site':site['domain'],'blocked':'No recently verified live asset'});continue
        domain=site['domain']
        try:
            # Explicitly curated peers are still validated before use. An empty
            # list triggers bounded DataForSEO peer discovery, not guesswork.
            peers=[reg_domain(x) for x in site.get('competitors',[]) if x]
            if len(peers)<2:
                peer_data=peek_peer_candidates(dfs,site)
                peers=peer_data['peers']
                if len(peers)<2:
                    observed.append({'site':domain,'blocked':'DataForSEO peers lacked verified topical fit',
                                     'peer_review':peer_data});break
            else:
                # We do not charge for textual peer validation.
                checked=[]
                good=[]
                for peer in peers[:4]:
                    if peer==domain or peer in good:continue
                    # A real topical page is more reliable than only testing
                    # a brand homepage, but never trust a configured cross-host URL.
                    from .engine import is_public_url
                    selected=site.get('competitor_pages',{}).get(peer,'https://'+peer+'/')
                    if not is_public_url(selected) or reg_domain(selected)!=peer:
                        checked.append({'domain':peer,'http':None,'topic_matches':False,
                                        'error':'untrusted or cross-domain evidence URL'})
                        continue
                    result=fetch_page(selected)
                    fits=200<=result['status']<300 and topic_matches(site['topic'],
                        (result.get('title') or '')+' '+(result.get('text') or ''))
                    checked.append({'domain':peer,'evidence_url':selected,'http':result['status'],
                                    'topic_matches':fits})
                    if fits:good.append(peer)
                peers=good[:2]
                if len(peers)<2:
                    observed.append({'site':domain,'blocked':'Configured competitor sites failed live topic relevance check','peers':checked});continue
            # Server-side owned-site EXCLUSION avoids a separate paid survey of own backlinks.
            gap=dfs.domain_gap(domain,peers,limit=60)
            attempt={'site':domain,'peers':peers,'found_gap_domains':len(gap['candidate_domains']),
                     'gap_cached':gap['cached'],'gap_api_cost_usd':gap['paid_usd'],
                     'candidate_pages':[],'page_samples_checked':0}
            if max_sample_calls>0:
                for item in gap['candidate_domains'][:8]:
                    pub=item['publisher']
                    previous=engine.conn.execute('''SELECT sample_status FROM dfs_gap_domains
                      WHERE owned_site=? AND publisher_domain=?''',(domain,pub)).fetchone()
                    if previous and previous['sample_status'] in ('candidate_page_found','no_suitable_page','off_topic'):
                        continue
                    page=fetch_page('https://'+pub+'/')
                    relevant=200<=page['status']<300 and topic_matches(site['topic'],
                        (page.get('title') or '')+' '+(page.get('text') or ''))
                    if not relevant:
                        engine.conn.execute('''UPDATE dfs_gap_domains SET sample_status='off_topic'
                          WHERE owned_site=? AND publisher_domain=?''',(domain,pub))
                        engine.conn.commit()
                        continue
                    sampled=dfs.enrich_page(domain,pub,peers[0],asset,limit=3)
                    attempt['candidate_pages'].extend(sampled['source_pages'])
                    attempt['page_samples_checked']+=1
                    break
            observed.append(attempt)
            engine.log('dfs_portfolio_cycle',attempt)
            break # Exactly one site per scheduled cycle, no pricey portfolio-wide burst.
        except (DataForSEOBlocked,DataForSEOUncertain) as exc:
            observed.append({'site':domain,'blocked':str(exc),'paid_budget_status':dfs.status()})
            engine.log('dfs_portfolio_blocked',{'site':domain,'reason':str(exc)})
            break
    return {'status':'processed' if observed and any('found_gap_domains' in a for a in observed) else 'blocked',
            'details':observed,'budget':dfs.status()}
