"""Optional read-only synchronization with the existing portfolio Google Sheets CRM.

A separate Google OAuth consent must grant spreadsheets.readonly. No ChatGPT
connector token is copied into this worker, no writing around access controls.
Imported contacts remain UNVERIFIED until official page checks pass.
"""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
import os
import re
import requests
from .engine import is_public_url, reg_domain, utc_now
from .integrations import GmailAPI, NotConfigured

class SheetsCRM:
    def __init__(self,spreadsheet_id=None,oauth=None,session=None):
        self.spreadsheet_id=spreadsheet_id or os.getenv('GOOGLE_CRM_SPREADSHEET_ID','')
        self.oauth=oauth or GmailAPI()
        self.session=session or requests.Session()

    def configured(self):
        return bool(self.spreadsheet_id and self.oauth.configured())

    def read(self,range_a1:str):
        if not self.configured():raise NotConfigured('Sheets CRM requires GOOGLE_CRM_SPREADSHEET_ID and an OAuth token with spreadsheets.readonly scope')
        r=self.session.get('https://sheets.googleapis.com/v4/spreadsheets/'+
             quote(self.spreadsheet_id,safe='')+'/values/'+quote(range_a1,safe=''),
             params={'valueRenderOption':'FORMATTED_VALUE'},
             headers={'Authorization':'Bearer '+self.oauth._token()},timeout=(5,20))
        r.raise_for_status()
        return r.json().get('values',[])


def _valid_email(value:str)->bool:
    return bool(re.fullmatch(r'[a-zA-Z0-9_.+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',value.strip()))


def import_crm(engine,config,client=None,*,max_rows=900):
    """Import known history/suppression and candidate URLs; do NOT infer prior acceptance.

    Reads official user's CRM, never stores secrets in repository and never trusts
    its source link as verified without a new live publication-side page check.
    """
    client=client or SheetsCRM()
    if not client.configured():
        return {'status':'not_configured','imported':0,'suppressed':0,'forms':0}
    sites={s['domain'] for s in config['sites']}
    # The CRM's own Gmail SENT history is a permanent publisher-level dedupe source.
    data={name:client.read(f"'{name}'!A2:{limit}")[:max_rows] for name,limit in
          [('Outreach','M1200'),('Suppression','E1200'),('Prospects','K1200'),('Forms','J1200')]}
    past=0
    for row in data['Outreach']:
        row=list(row)+['']*13
        to=row[3].strip().lower();site=reg_domain(row[1]);pub=reg_domain(to.split('@',1)[-1]) if _valid_email(to) else ''
        if site not in sites or not pub:continue
        # Do not suppress all unrelated gmail.com recipients when an editor uses Gmail.
        from .engine import FREE_MAIL
        engine.suppress(to,'Prior campaign contact — check Gmail before future outreach','Existing CRM / Gmail sent')
        if pub not in FREE_MAIL:engine.suppress(pub,'Previous publisher contact across portfolio','Existing CRM / Gmail sent')
        past+=1
    suppressions=0
    for row in data['Suppression']:
        row=list(row)+['']*5
        identity=row[0].strip().lower()
        if not identity or ('@' not in identity and '.' not in identity):continue
        engine.suppress(identity,row[1] or 'Previously suppressed','Existing CRM suppression')
        suppressions+=1
    imported=0;skipped=0
    for row in data['Prospects']:
        row=list(row)+['']*11
        site=reg_domain(row[0]);source=row[2].strip();asset=row[4].strip()
        if site not in sites or not is_public_url(source) or not is_public_url(asset) or reg_domain(asset)!=site:
            skipped+=1;continue
        state=row[8].lower()
        if any(word in state for word in ('rejected','suppressed','hold','sent','blocked')):continue
        publisher=reg_domain(source)
        if engine.is_suppressed(publisher=publisher) or engine.publisher_already_in_pipeline(publisher):continue
        listed_address=row[3].strip()
        email=listed_address if _valid_email(listed_address) else ''
        try:
            engine.add_candidate(site=site,source_url=source,asset_url=asset,kind='resource',
              title=row[1],contact_email=email,contact_source_url=source,
              editorial_policy_url=(row[10].strip() if is_public_url(row[10].strip()) and reg_domain(row[10])==publisher else ''),
              editorial_evidence=row[5][:300])
            imported+=1
        except ValueError:
            skipped+=1
    forms=0
    for row in data['Forms']:
        row=list(row)+['']*10
        site=reg_domain(row[1]);url=row[3].strip();asset=row[2].strip()
        if site not in sites or not is_public_url(url) or not is_public_url(asset) or reg_domain(asset)!=site:continue
        if 'submitted' in row[7].lower() and 'not submitted' not in row[7].lower():continue
        engine.conn.execute('''INSERT INTO submissions(site,publisher,form_url,asset_url,eligibility,
             needs_login,needs_captcha,rights_confirmed,status,source_url,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site,form_url,asset_url) DO NOTHING''',
             (site,row[0][:160],url,asset,row[4][:400],
              int('yes' in row[5].lower() or 'required' in row[5].lower()),
              int('captcha' in row[6].lower()),0,'researched',url,utc_now()))
        forms+=1
    engine.conn.commit()
    summary={'status':'read_only_import','imported':imported,'suppressed':suppressions,
             'historical_contacts':past,'forms':forms,'skipped_unverifiable':skipped}
    engine.log('crm_sync_finished',summary)
    return summary


def crm_sync_due(engine,hours=12):
    row=engine.conn.execute("SELECT time_utc FROM activity WHERE type='crm_sync_finished' ORDER BY id DESC LIMIT 1").fetchone()
    return row is None or (datetime.now(timezone.utc)-datetime.fromisoformat(row['time_utc']))>timedelta(hours=hours)
