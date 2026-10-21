"""Optional GA4/referral export import. No guessed traffic, paid SEO metrics, or conversions."""
from __future__ import annotations
import csv
import datetime as dt
from .engine import reg_domain, utc_now


def import_referrals(engine,path,valid_sites):
    sites={reg_domain(s) for s in valid_sites}
    accepted=0;rejected=0
    with open(path,encoding='utf-8-sig',newline='') as f:
        for row in csv.DictReader(f):
            site=reg_domain(row.get('site',''));ref=reg_domain(row.get('referrer_domain',''))
            date=(row.get('date') or '').strip()
            try:
                dt.date.fromisoformat(date)
                sessions=int(row.get('sessions',''))
                engaged=int(row['engaged_sessions']) if str(row.get('engaged_sessions','')).strip() else None
                conversions=int(row['conversions']) if str(row.get('conversions','')).strip() else None
                assert site in sites and ref and sessions>=0
                assert engaged is None or 0<=engaged<=sessions
                assert conversions is None or conversions>=0
            except (ValueError,TypeError,AssertionError):
                rejected+=1;continue
            source=row.get('source','GA4 export').strip() or 'GA4 export'
            engine.conn.execute('''INSERT INTO referral_metrics(site,referrer_domain,date,sessions,engaged_sessions,conversions,source,imported_at)
             VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(site,referrer_domain,date,source) DO UPDATE SET
             sessions=excluded.sessions,engaged_sessions=excluded.engaged_sessions,
             conversions=excluded.conversions,imported_at=excluded.imported_at''',
             (site,ref,date,sessions,engaged,conversions,source,utc_now()))
            accepted+=1
    engine.conn.commit()
    engine.log('referral_import',{'source_file':str(path),'accepted_rows':accepted,'rejected_rows':rejected})
    return {'accepted_rows':accepted,'rejected_rows':rejected}


def referral_summary(engine,site=None):
    if site:
        rows=engine.conn.execute('''SELECT SUM(sessions) sessions,SUM(conversions) conversions
           FROM referral_metrics WHERE site=?''',(reg_domain(site),)).fetchone()
    else:
        rows=engine.conn.execute('''SELECT SUM(sessions) sessions,SUM(conversions) conversions
           FROM referral_metrics''').fetchone()
    return {'measured_sessions':rows['sessions'], 'measured_conversions':rows['conversions'],
            'status':'no data' if rows['sessions'] is None else 'from imported analytics'}
