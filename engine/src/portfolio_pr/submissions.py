"""Evidence-based official submission tracking; never auto-submit or fake receipts."""
from __future__ import annotations
import csv
from pathlib import Path
from .engine import is_public_url, reg_domain, utc_now, fetch_page


def import_forms(engine,path: str | Path):
    accepted=0;rejected=[]
    with open(path,encoding='utf-8-sig',newline='') as f:
        for line,row in enumerate(csv.DictReader(f),start=2):
            site=reg_domain(row.get('site',''))
            form_url=(row.get('form_url') or '').strip()
            asset_url=(row.get('asset_url') or '').strip()
            publisher=(row.get('publisher') or '').strip()
            if not (site and publisher and is_public_url(form_url) and is_public_url(asset_url)
                    and reg_domain(asset_url)==site):
                rejected.append({'line':line,'reason':'invalid official-form/asset/site fields'});continue
            if engine.is_suppressed(publisher=reg_domain(form_url)):
                rejected.append({'line':line,'reason':'suppressed publisher'});continue
            engine.conn.execute('''INSERT INTO submissions(site,publisher,form_url,asset_url,eligibility,needs_login,
              needs_captcha,rights_confirmed,status,source_url,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site,form_url,asset_url) DO NOTHING''',
              (site,publisher,form_url,asset_url,row.get('eligibility',''),
               int(str(row.get('needs_login','')).lower() in ('true','yes','1')),
               int(str(row.get('needs_captcha','')).lower() in ('true','yes','1')),
               int(str(row.get('rights_confirmed','')).lower() in ('true','yes','1')),
               'researched',row.get('policy_url',''),utc_now()))
            accepted+=1
    engine.conn.commit()
    engine.log('form_import',{'accepted_rows':accepted,'rejected_rows':rejected})
    return {'accepted':accepted,'rejected':rejected}


def verify_form(engine,submission_id:int, session=None):
    row=engine.conn.execute('SELECT * FROM submissions WHERE id=?',(submission_id,)).fetchone()
    if not row:raise KeyError(submission_id)
    page=fetch_page(row['form_url'],session=session)
    if page['status'] not in range(200,300):
        status='check_unavailable';reason='Form page inaccessible; not submitted'
    elif row['needs_login']:
        status='blocked';reason='Account/login required; not authenticated'
    elif row['needs_captcha']:
        status='blocked';reason='CAPTCHA required; never bypass'
    elif not row['rights_confirmed']:
        status='needs_review';reason='Rights or licensing not verified'
    else:
        status='eligible_for_authorized_browser';reason='Eligibility does not establish a completed submission'
    engine.conn.execute('''UPDATE submissions SET status=?,blocker=?,checked_at=?,page_title=? WHERE id=?''',
                        (status,reason,utc_now(),page.get('title',''),submission_id))
    engine.conn.commit()
    engine.log('form_verified',{'id':submission_id,'status':status,'http':page['status']})
    return {'id':submission_id,'status':status,'reason':reason,'http':page['status']}


def record_form_receipt(engine,submission_id:int,receipt:str,public_listing_url=''):
    """Receipts originate from real browser/provider results and must be supplied externally."""
    row=engine.conn.execute('SELECT * FROM submissions WHERE id=?',(submission_id,)).fetchone()
    if row is None:raise KeyError(submission_id)
    if not receipt.strip() or len(receipt.strip())<6:raise ValueError('Concrete external receipt required')
    if row['status'] not in ('eligible_for_authorized_browser','submitted'):
        raise ValueError('Submission must have passed form eligibility check')
    if public_listing_url and (not is_public_url(public_listing_url) or reg_domain(public_listing_url)!=reg_domain(row['form_url'])):
        raise ValueError('Listing URL must belong to the verified submission publisher')
    engine.conn.execute('''UPDATE submissions SET status='submitted',receipt=?,submitted_at=?,listing_url=? WHERE id=?''',
                        (receipt.strip(),utc_now(),public_listing_url,submission_id))
    engine.conn.commit()
    engine.log('form_submission_confirmed',{'id':submission_id,'listing':public_listing_url,'receipt':receipt.strip()})
    return {'status':'submitted','receipt':receipt.strip(),'id':submission_id}
