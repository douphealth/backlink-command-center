"""Portfolio-wide source prioritization and asset health checks.

Ranks websites using logged work, *not* guessed traffic or commercial values.
Every domain participates fairly, and only confirmed live assets are pitched.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from .engine import fetch_page, is_public_url, reg_domain, utc_now


def validate_portfolio(config: dict) -> list[str]:
    """Reject accidental partial or malformed registries; no synthetic URLs."""
    if not isinstance(config, dict) or not isinstance(config.get('sites'), list):
        raise ValueError('Expected sites list')
    domains = set()
    for site in config['sites']:
        domain = reg_domain(site.get('domain', ''))
        if not domain or domain in domains:
            raise ValueError('Duplicate/empty portfolio domain: '+str(domain))
        domains.add(domain)
        if not site.get('identity') or not site.get('topic') or not site.get('editorial_idea'):
            raise ValueError('Incomplete site identity/topic/editorial_idea: '+domain)
        assets = site.get('assets') or []
        if not assets:
            raise ValueError('Every portfolio website must have at least one configured linkable asset: '+domain)
        for url in assets:
            if not is_public_url(url) or not (reg_domain(url) == domain or reg_domain(url).endswith('.'+domain)):
                raise ValueError('Asset must be a valid URL under the owned domain: '+str(url))
    return sorted(domains)


def audit_assets(engine, config: dict, *, max_checks=5, max_age_days=7, session=None):
    """Cache factual HTTP evidence; inaccessible sites remain unverified, never claimed dead."""
    now=datetime.now(timezone.utc)
    pending=[]
    for site in config['sites']:
        for asset in site['assets']:
            old=engine.conn.execute('SELECT checked_at,http_status FROM portfolio_assets WHERE url=?',(asset,)).fetchone()
            if old and (now-datetime.fromisoformat(old['checked_at']))<timedelta(days=max_age_days):
                continue
            pending.append((site['domain'],asset))
    # First cover distinct sites before retrying a second/third asset of the
    # same brand. Initial startup must not spend the full budget on site #1.
    by_domain={}
    for domain,url in pending:
        by_domain.setdefault(domain,[]).append(url)
    # Brand not yet audited goes first on EVERY run; otherwise brand #6 could
    # starve while brands #1-5 rotate through their secondary URLs.
    def priority(domain):
        row=engine.conn.execute("SELECT COUNT(*) n FROM portfolio_assets WHERE domain=? AND status='live'",(domain,)).fetchone()
        return (row['n'], list(by_domain).index(domain))
    fair_pending=[]
    while any(by_domain.values()):
        for domain in sorted(by_domain,key=priority):
            if by_domain[domain]:
                fair_pending.append((domain,by_domain[domain].pop(0)))
    checked=[]
    for domain,url in fair_pending[:max(0,int(max_checks))]:
        page=fetch_page(url,session=session)
        state='live' if 200<=page['status']<300 else 'unavailable'
        engine.conn.execute('''INSERT INTO portfolio_assets(domain,url,checked_at,http_status,title,status,error)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET
          checked_at=excluded.checked_at,http_status=excluded.http_status,
          title=excluded.title,status=excluded.status,error=excluded.error''',
          (domain,url,utc_now(),page['status'],page.get('title',''),state,page.get('error','')))
        checked.append({'site':domain,'url':url,'http':page['status'],'status':state})
    engine.conn.commit()
    if checked:
        engine.log('asset_audit',{'checked':checked})
    return {'checked':checked,'remaining':max(0,len(pending)-len(checked))}


def asset_is_verified(engine, asset: str, *, max_age_days=14) -> bool:
    row=engine.conn.execute('SELECT status,checked_at FROM portfolio_assets WHERE url=?',(asset,)).fetchone()
    if not row or row['status']!='live':return False
    return (datetime.now(timezone.utc)-datetime.fromisoformat(row['checked_at']))<=timedelta(days=max_age_days)


def ranked_sites(engine,config,*, now=None):
    """Fair adaptive rotation: reward validated links but penalize ignored sites.

    Does NOT infer demand, publisher quality, DR, traffic or monetary ROI.
    """
    now=now or datetime.now(timezone.utc)
    result=[]
    for site in config['sites']:
        domain=site['domain']
        last=engine.conn.execute('SELECT MAX(attempted_at) x FROM search_history WHERE site=?',(domain,)).fetchone()['x']
        age_days=min(30, (now-datetime.fromisoformat(last)).total_seconds()/86400) if last else 30
        leads=engine.conn.execute("SELECT COUNT(*) n FROM candidates WHERE site=? AND status='verified_ready'",(domain,)).fetchone()['n']
        links=engine.conn.execute('SELECT COUNT(*) n FROM verified_links l JOIN candidates c ON c.id=l.candidate_id WHERE c.site=?',(domain,)).fetchone()['n']
        attempted=engine.conn.execute('SELECT COUNT(*) n FROM search_history WHERE site=?',(domain,)).fetchone()['n']
        recent=engine.conn.execute('SELECT COUNT(*) n FROM search_history WHERE site=? AND attempted_at>=?',
            (domain,(now-timedelta(days=2)).isoformat())).fetchone()['n']
        # Weight freshness/fairness far above popularity; only observed wins slightly shift priority.
        priority=round(60 + 0.9*age_days + min(6,links*2) - min(10,leads*2) - min(15,recent*4),2)
        result.append({'domain':domain,'site':site,'priority':priority,'last_search':last,
                       'ready':leads,'links':links,'attempts':attempted,'recent_searches':recent})
    return sorted(result,key=lambda row:(-row['priority'],row['domain']))


def site_progress(engine,config):
    """Portfolio funnel, with 0 rather than invented estimates."""
    rows=[]
    for site in config['sites']:
        domain=site['domain']
        stats=engine.conn.execute('''SELECT COUNT(*) total,
             SUM(CASE WHEN status='verified_ready' THEN 1 ELSE 0 END) eligible,
             SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) rejected
             FROM candidates WHERE site=?''',(domain,)).fetchone()
        msg=engine.conn.execute('''SELECT COUNT(DISTINCT m.id) sent
          FROM messages m JOIN candidates c ON c.id=m.candidate_id
          WHERE c.site=? AND m.status='sent' ''',(domain,)).fetchone()
        links=engine.conn.execute('''SELECT COUNT(*) n FROM verified_links l
          JOIN candidates c ON c.id=l.candidate_id WHERE c.site=?''',(domain,)).fetchone()['n']
        assets=engine.conn.execute('''SELECT COUNT(*) n FROM portfolio_assets WHERE domain=? AND status='live' ''',(domain,)).fetchone()['n']
        traffic=engine.conn.execute('SELECT SUM(sessions) sessions,SUM(conversions) conversions FROM referral_metrics WHERE site=?',(domain,)).fetchone()
        rows.append({'domain':domain,'assets_configured':len(site['assets']),'assets_verified':assets,
                     'candidates':stats['total'] or 0,'eligible':stats['eligible'] or 0,
                     'rejected':stats['rejected'] or 0,'sent':msg['sent'] or 0,'live_links':links,
                     'measured_referrals':traffic['sessions'],'measured_conversions':traffic['conversions']})
    return rows
