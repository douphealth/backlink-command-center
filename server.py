"""Private control plane for the existing Backlink Finder v4.1 SQLite database.

No access to DataForSEO credentials, no paid API calls and no automatic sending.
Management writes are constrained to editorial states, suppressions, and notes.
"""
from __future__ import annotations
import hashlib, hmac, json, os, secrets, sqlite3, time, csv, io
from datetime import datetime, timezone, timedelta
import opstate
from pathlib import Path
from contextlib import contextmanager
from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

ROOT=Path(__file__).resolve().parent
DB=Path(os.getenv('PR_DB_PATH',str(ROOT / 'state' / 'outreach.sqlite3')))
PASSWORD=os.getenv('DASHBOARD_ADMIN_PASSWORD','')
SECRET=os.getenv('DASHBOARD_SESSION_SECRET','')
COOKIE_SECURE=os.getenv('DASHBOARD_COOKIE_SECURE','true').lower()=='true'
PROXY_SECRET=os.getenv('DASHBOARD_PROXY_SECRET','')
if PROXY_SECRET and len(PROXY_SECRET)<32:
    raise RuntimeError('DASHBOARD_PROXY_SECRET must be at least 32 characters when configured')
if len(PASSWORD)<16 or len(SECRET)<32:
    raise RuntimeError('Set DASHBOARD_ADMIN_PASSWORD (16+ chars) and DASHBOARD_SESSION_SECRET (32+ chars); no insecure defaults')
app=FastAPI(title='Backlink Command Center',docs_url=None,redoc_url=None,openapi_url=None)
SESSIONS:dict[str,dict]={}; ATTEMPTS:dict[str,list[float]]={}

def timestamp():return datetime.now(timezone.utc).isoformat(timespec='seconds')
def qdict(row):return dict(row)
@contextmanager
def connection(write=False):
    DB.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(f'file:{DB}?mode={"rw" if DB.exists() else "rwc"}',uri=True,timeout=12,isolation_level=None)
    db.row_factory=sqlite3.Row
    db.execute('PRAGMA busy_timeout=12000')
    try:
        if write:db.execute('BEGIN IMMEDIATE')
        yield db
        if write:db.commit()
    except Exception:
        if write:db.rollback()
        raise
    finally:db.close()

def fetch_all(db,table,sql,args=()):
    if not table_exists(db,table):return []
    return [qdict(r) for r in db.execute(sql,args)]
def table_exists(db,name):
    return bool(db.execute('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?',(name,)).fetchone())
def count(db,name,where='1=1',args=()):
    if not table_exists(db,name):return 0
    return db.execute(f'SELECT COUNT(*) FROM {name} WHERE {where}',args).fetchone()[0]

def gate(request:Request):
    token=request.cookies.get('bcc_session','')
    s=SESSIONS.get(hashlib.sha256(token.encode()).hexdigest()) if token else None
    if not s or s['expires']<time.time():raise HTTPException(401,'Sign in to continue')
    if request.method not in ('GET','HEAD','OPTIONS'):
        if not hmac.compare_digest(request.headers.get('x-csrf-token',''),s['csrf']):raise HTTPException(403,'Invalid CSRF token')
    return s

class Login(BaseModel):password:str
@app.post('/api/login')
def login(payload:Login,request:Request,response:Response):
    ip=(request.headers.get('x-backlink-client-ip') if PROXY_SECRET else '') or (request.client.host if request.client else 'unknown');now=time.time()
    attempts=[t for t in ATTEMPTS.get(ip,[]) if now-t<900]
    if len(attempts)>=7:raise HTTPException(429,'Too many attempts. Try again later.')
    if not hmac.compare_digest(payload.password.encode(),PASSWORD.encode()):
        ATTEMPTS[ip]=attempts+[now];raise HTTPException(401,'Invalid password')
    ATTEMPTS.pop(ip,None)
    token=secrets.token_urlsafe(48);csrf=secrets.token_urlsafe(32)
    SESSIONS[hashlib.sha256(token.encode()).hexdigest()]={'expires':now+8*3600,'csrf':csrf}
    response.set_cookie('bcc_session',token,max_age=8*3600,httponly=True,secure=COOKIE_SECURE,samesite='strict',path='/')
    return {'ok':True,'csrf':csrf}
@app.get('/api/session')
def session(s=Depends(gate)):return {'authenticated':True,'csrf':s['csrf']}
@app.post('/api/logout')
def logout(request:Request,response:Response,s=Depends(gate)):
    token=request.cookies.get('bcc_session','');SESSIONS.pop(hashlib.sha256(token.encode()).hexdigest(),None)
    response.delete_cookie('bcc_session',path='/');return {'ok':True}

SITE_CONFIG=ROOT/'config'/'sites.json'
def sites():
    if SITE_CONFIG.exists():return json.loads(SITE_CONFIG.read_text(encoding='utf-8')).get('sites',[])
    return []

@app.get('/api/overview')
def overview(s=Depends(gate)):
    with connection() as db:
        allc=count(db,'candidates');qual=count(db,'candidates',"status IN ('verified_ready','qualified')")
        drafted=count(db,'messages',"status IN ('draft','draft_uncertain')")
        sent=count(db,'messages',"status='sent'")
        links=count(db,'verified_links');pending=count(db,'submissions',"status IN ('researched','eligible','ready')")
        # Use EVERY ledger row, not the most recent 150 only.
        today=datetime.now(timezone.utc).strftime('%Y-%m-%d');month=today[:7]
        spent_today=spent_month=unreconciled=request_count=0
        if table_exists(db,'dfs_requests'):
            spend_row=db.execute('''SELECT
              COALESCE(SUM(CASE WHEN day_utc=? THEN COALESCE(actual_micro,reserved_micro) ELSE 0 END),0),
              COALESCE(SUM(CASE WHEN month_utc=? THEN COALESCE(actual_micro,reserved_micro) ELSE 0 END),0),
              SUM(CASE WHEN status IN ('uncertain','reserved') THEN 1 ELSE 0 END),COUNT(*)
              FROM dfs_requests''',(today,month)).fetchone()
            spent_today,spent_month,unreconciled,request_count=[int(x or 0) for x in spend_row]
        events=fetch_all(db,'activity',"SELECT id,time_utc,type,detail,candidate_id FROM activity ORDER BY id DESC LIMIT 9")
        alerts=fetch_all(db,'dfs_spend_alerts',"SELECT id,kind,observed_utc FROM dfs_spend_alerts WHERE cleared_utc IS NULL ORDER BY id DESC LIMIT 5")
        by_state=fetch_all(db,'candidates',"SELECT status,COUNT(*) AS count FROM candidates GROUP BY status ORDER BY count DESC")
        by_site=fetch_all(db,'candidates',"SELECT site,COUNT(*) AS prospects,SUM(CASE WHEN status='verified_ready' THEN 1 ELSE 0 END) AS qualified FROM candidates GROUP BY site ORDER BY prospects DESC")
        heartbeat=fetch_all(db,'activity',"SELECT time_utc,type FROM activity ORDER BY id DESC LIMIT 1")
        recent=fetch_all(db,'dfs_requests',"SELECT day_utc,SUM(COALESCE(actual_micro,reserved_micro)) AS micro FROM dfs_requests GROUP BY day_utc ORDER BY day_utc DESC LIMIT 14")
        return {'generated_at':timestamp(),'counts':{'prospects':allc,'qualified':qual,'drafts':drafted,'sent':sent,'links':links,'pending_forms':pending},'spend':{'today_usd':spent_today/1e6,'month_usd':spent_month/1e6,'today_limit':.12,'month_limit':1.,'requests_observed':request_count,'unreconciled':unreconciled,'alerts':alerts,'daily':list(reversed(recent))},'by_state':by_state,'by_site':by_site,'events':events,'last_activity':heartbeat[0] if heartbeat else None,'sites_configured':len(sites()),'links_verified':links,'data_source':'SQLite — verified operational records only','worker_status':worker_summary(db)['label'],'dfs_configured':bool(os.getenv('DATAFORSEO_BASIC_AUTH_FILE') or os.getenv('DATAFORSEO_LOGIN')),'paid_enabled':os.getenv('DATAFORSEO_PAID_ENABLED','NO').upper()=='YES'}

ORDER={'score':'score','site':'site','publisher':'publisher_domain','updated':'last_updated'}
@app.get('/api/prospects')
def prospects(status:str='',site:str='',q:str='',sort:str='score',page:int=1,page_size:int=25,s=Depends(gate)):
    page=max(1,min(10000,page));page_size=max(1,min(100,page_size))
    wh=['1=1'];args=[]
    if status and status!='all':wh.append('status=?');args.append(status)
    if site and site!='all':wh.append('site=?');args.append(site)
    if q:wh.append('(publisher_domain LIKE ? OR title LIKE ? OR source_url LIKE ?)');args+=['%'+q[:100]+'%']*3
    w=' AND '.join(wh)
    with connection() as db:
        if not table_exists(db,'candidates'):return {'items':[],'total':0,'page':page,'page_size':page_size}
        total=db.execute('SELECT COUNT(*) FROM candidates WHERE '+w,args).fetchone()[0]
        order=ORDER.get(sort,'score')
        rows=db.execute(f'SELECT id,site,publisher_domain,source_url,asset_url,kind,title,status,score,contact_email,source_checked_at,traffic_monthly,spam_score,domain_rank,competitor_count,excluded_reason,explicit_invitation,last_updated,editorial_policy_url FROM candidates WHERE {w} ORDER BY {order} DESC NULLS LAST,id DESC LIMIT ? OFFSET ?',args+[page_size,(page-1)*page_size]).fetchall()
        return {'items':[qdict(x) for x in rows],'total':total,'page':page,'page_size':page_size}

class ProspectPatch(BaseModel):status:str=Field(pattern=r'^(found|research|verified_ready|rejected|hold|qualified|retry)$');note:str=Field(default='',max_length=400)
@app.patch('/api/prospects/{cid}')
def patch_prospect(cid:int,body:ProspectPatch,s=Depends(gate)):
    with connection(write=True) as db:
        row=db.execute('SELECT id,status FROM candidates WHERE id=?',(cid,)).fetchone()
        if not row:raise HTTPException(404,'Prospect not found')
        if body.status in ('verified_ready','qualified') and row['status'] not in ('verified_ready','qualified'):
            raise HTTPException(409,'Cannot manually promote a prospect to verified. Run source verification in the engine first.')
        db.execute('UPDATE candidates SET status=?,last_updated=? WHERE id=?',(body.status,timestamp(),cid))
        db.execute('INSERT INTO activity(time_utc,type,candidate_id,detail) VALUES(?,?,?,?)',(timestamp(),'admin_status_changed',cid,json.dumps({'from':row['status'],'to':body.status,'note':body.note})))
    return {'ok':True}

@app.get('/api/outreach')
def outreach(page:int=1,page_size:int=60,s=Depends(gate)):
    page=max(page,1);page_size=max(1,min(page_size,100))
    with connection() as db:
        items=fetch_all(db,'messages',"SELECT m.id,m.to_address,m.subject,m.status,m.gmail_id,m.gmail_draft_id,m.sent_at,m.created_at,m.followup_at,c.site,c.publisher_domain,c.asset_url FROM messages m JOIN candidates c ON c.id=m.candidate_id ORDER BY m.id DESC LIMIT ? OFFSET ?",(page_size,(page-1)*page_size))
        return {'items':items,'total':count(db,'messages'),'page':page}

@app.get('/api/placements')
def placements(s=Depends(gate)):
    with connection() as db:
        items=fetch_all(db,'verified_links',"SELECT v.*,c.site,c.publisher_domain,c.kind FROM verified_links v JOIN candidates c ON c.id=v.candidate_id ORDER BY v.observed_at DESC LIMIT 250")
        return {'items':items,'total':count(db,'verified_links')}

@app.get('/api/forms')
def forms(s=Depends(gate)):
    with connection() as db:
        return {'items':fetch_all(db,'submissions',"SELECT id,site,publisher,form_url,asset_url,status,blocker,needs_login,needs_captcha,rights_confirmed,receipt,listing_url,checked_at FROM submissions ORDER BY id DESC LIMIT 200"),'total':count(db,'submissions')}

@app.get('/api/spend')
def spend(s=Depends(gate)):
    with connection() as db:
        return {'items':fetch_all(db,'dfs_requests',"SELECT request_id,site,endpoint,status,day_utc,reserved_micro,actual_micro,created_at,error_type FROM dfs_requests ORDER BY created_at DESC LIMIT 150"),'alerts':fetch_all(db,'dfs_spend_alerts',"SELECT kind,observed_utc,detail,cleared_utc FROM dfs_spend_alerts ORDER BY id DESC LIMIT 30"),'gaps':fetch_all(db,'dfs_gap_domains',"SELECT owned_site,publisher_domain,last_seen_utc,competitor_json,rank_1000,spam_score,nofollow_share,sample_status FROM dfs_gap_domains ORDER BY last_seen_utc DESC LIMIT 100")}

@app.get('/api/activity')
def activity(limit:int=80,s=Depends(gate)):
    with connection() as db:
        return {'items':fetch_all(db,'activity',"SELECT id,time_utc,type,candidate_id,detail FROM activity ORDER BY id DESC LIMIT ?",(max(1,min(limit,300)),))}

@app.get('/api/suppression')
def suppression(s=Depends(gate)):
    with connection() as db:
        return {'items':fetch_all(db,'suppression',"SELECT identity,reason,source,created_at FROM suppression ORDER BY created_at DESC LIMIT 350"),'total':count(db,'suppression')}
class SuppressRequest(BaseModel):identity:str=Field(min_length=4,max_length=255);reason:str=Field(min_length=5,max_length=280)
@app.post('/api/suppression')
def suppress(body:SuppressRequest,s=Depends(gate)):
    from urllib.parse import urlsplit
    from email.utils import parseaddr
    value=body.identity.strip().lower()
    if ('@' not in value and ('.' not in value or '/' in value or ' ' in value)) or len(value)>255:
        raise HTTPException(422,'Supply a valid email address or publisher domain')
    if value.startswith(('http:','https:')):raise HTTPException(422,'Use bare domain or email')
    with connection(write=True) as db:
        if not table_exists(db,'suppression'):raise HTTPException(409,'Start the engine once to initialize its database')
        db.execute('INSERT INTO suppression(identity,reason,source,created_at) VALUES(?,?,?,?) ON CONFLICT(identity) DO UPDATE SET reason=excluded.reason,source=excluded.source',(value,body.reason,'Backlink Command Center',timestamp()))
        db.execute('INSERT INTO activity(time_utc,type,detail) VALUES(?,?,?)',(timestamp(),'admin_suppressed',json.dumps({'identity':value,'reason':body.reason})))
    return {'ok':True}

@app.get('/api/sites')
def sites_endpoint(s=Depends(gate)):
    configured=sites()
    with connection() as db:
        result=[]
        for site in configured:
            dom=site['domain'];assets=fetch_all(db,'portfolio_assets',"SELECT url,http_status,status,checked_at FROM portfolio_assets WHERE domain=? ORDER BY checked_at DESC",(dom,))
            result.append({'domain':dom,'topic':site.get('topic',''),'assets_total':len(site.get('assets',[])),'verified_assets':sum(a['status']=='verified' for a in assets),'asset_checks':assets[:3]})
    return {'items':result}
@app.get('/api/health')
def health(s=Depends(gate)):
    with connection() as db:
        last=fetch_all(db,'activity',"SELECT time_utc,type FROM activity ORDER BY id DESC LIMIT 1")
        return {'database':'connected','last_event':last[0] if last else None,'db_bytes':DB.stat().st_size if DB.exists() else 0,'worker':worker_summary(db),'gmail':'not tested','dataforseo':'not tested','automation':'only VPS worker heartbeat establishes liveness'}


# Durable shared worker state. The dashboard never initiates paid API calls.
def ensure_operations():
    with connection() as db:
        opstate.ensure(db)


def worker_summary(db):
    if not table_exists(db,'worker_status'):
        return {'running':False,'label':'No worker heartbeat recorded','last_seen_at':None}
    row=db.execute('SELECT * FROM worker_status WHERE id=1').fetchone()
    if not row or not row['last_seen_at']:
        return {'running':False,'label':'No worker heartbeat recorded','last_seen_at':None}
    last=row['last_seen_at']
    try:
        age=max(0,(datetime.now(timezone.utc)-datetime.fromisoformat(last.replace('Z','+00:00'))).total_seconds())
    except (ValueError,TypeError):
        age=999999
    online=age<=90 and row['last_action']!='stopped'
    return {'running':online,'label':'Worker online' if online else 'Worker heartbeat stale',
            'last_seen_at':last,'seconds_since_last_seen':int(age),
            'last_action':row['last_action'],'last_research_at':row['last_research_at'],
            'last_monitor_at':row['last_monitor_at'],'last_error':row['last_error']}



EXPORTS = {
    'prospects':('candidates',('site','publisher_domain','source_url','asset_url','kind',
      'status','score','contact_email','source_checked_at','editorial_policy_url','spam_score',
      'traffic_monthly','domain_rank','competitor_count','excluded_reason')),
    'outreach':('messages',('candidate_id','to_address','subject','status','gmail_id',
      'gmail_draft_id','created_at','sent_at','followup_at')),
    'placements':('verified_links',('candidate_id','placement_url','target_url','rel','observed_at')),
    'submissions':('submissions',('site','publisher','form_url','asset_url','status',
      'blocker','needs_login','needs_captcha','receipt','listing_url','checked_at')),
    'spend':('dfs_requests',('request_id','site','endpoint','status','day_utc',
      'reserved_micro','actual_micro','created_at','error_type')),
    'suppression':('suppression',('identity','reason','source','created_at')),
}


def safe_csv_cell(value):
    if value is None:return ''
    if isinstance(value,str) and value.lstrip().startswith(('=','+','-','@')):
        return "'"+value
    return value


@app.get('/api/export/{kind}')
def export_rows(kind:str,s=Depends(gate)):
    if kind not in EXPORTS:
        raise HTTPException(404,'Unknown export')
    table,columns=EXPORTS[kind]
    csv_buf=io.StringIO()
    writer=csv.writer(csv_buf)
    writer.writerow(columns)
    with connection() as db:
        if table_exists(db,table):
            sql=f'SELECT {",".join(columns)} FROM {table} ORDER BY ROWID DESC LIMIT 5000'
            for row in db.execute(sql):
                writer.writerow([safe_csv_cell(value) for value in row])
    csv_buf.seek(0)
    return StreamingResponse(iter([csv_buf.getvalue()]),media_type='text/csv; charset=utf-8',
                             headers={'Content-Disposition':f'attachment; filename="linkforge-{kind}.csv"'})


@app.get('/api/operations')
def operations(s=Depends(gate)):
    ensure_operations()
    with connection() as db:
        jobs=fetch_all(db,'worker_commands','''SELECT id,action,status,requested_at,started_at,
             finished_at,outcome,error FROM worker_commands ORDER BY id DESC LIMIT 30''')
        return {'worker':worker_summary(db),'controls':opstate.flags(db),
                'commands':jobs,'actions':opstate.ACTIONS,
                'policy':{'dataforseo_hard_month_usd':1.0,'dataforseo_hard_day_usd':.12,
                          'dataforseo_max_request_usd':.06,
                          'outbound_note':'The server PR_SEND_ENABLED gate and global suppression still apply.',
                          'research_note':'Research requires verified portfolio assets and a configured search provider.'}}


class OperatorSwitch(BaseModel):
    key:str
    paused:bool
    acknowledge_risk:bool=False


@app.post('/api/operations/control')
def update_control(body:OperatorSwitch,s=Depends(gate)):
    if body.key not in opstate.CONTROLS:
        raise HTTPException(422,'Unsupported setting')
    if body.key in ('dataforseo_paused','outreach_paused') and not body.paused and not body.acknowledge_risk:
        raise HTTPException(409,'Explicit acknowledgement required to release a protected hold')
    ensure_operations()
    with connection(write=True) as db:
        old=opstate.flag(db,body.key)
        opstate.set_flag(db,body.key,body.paused)
        if table_exists(db,'activity'):
            db.execute('INSERT INTO activity(time_utc,type,detail) VALUES(?,?,?)',
                       (timestamp(),'operator_control',json.dumps({'key':body.key,'from':old,'to':body.paused})))
    return {'ok':True,'key':body.key,'paused':body.paused,
            'effective_note':'The worker environment and provider budget ceilings remain independent gates.'}


class QueueRequest(BaseModel):
    action:str


@app.post('/api/operations/commands')
def create_command(body:QueueRequest,s=Depends(gate)):
    if body.action not in opstate.ACTIONS:
        raise HTTPException(422,'Unsupported worker action')
    ensure_operations()
    with connection(write=True) as db:
        if body.action=='research' and opstate.flag(db,'research_paused'):
            raise HTTPException(409,'Research paused. Resume research first.')
        job_id,new=opstate.enqueue(db,body.action)
        if new and table_exists(db,'activity'):
            db.execute('INSERT INTO activity(time_utc,type,detail) VALUES(?,?,?)',
                       (timestamp(),'operator_command_queued',json.dumps({'action':body.action,'command_id':job_id})))
    return {'ok':True,'id':job_id,'created':new,'status':'queued',
            'note':'Queued in SQLite; only a live VPS worker can complete this job.'}


@app.get('/api/learning')
def learning(s=Depends(gate)):
    with connection() as db:
        outcomes=fetch_all(db,'outcomes', '''SELECT o.candidate_id,o.outcome,o.evidence,o.time_utc,
            c.site,c.kind,c.publisher_domain FROM outcomes o JOIN candidates c ON c.id=o.candidate_id
            ORDER BY o.id DESC LIMIT 150''')
        referrals=fetch_all(db,'referral_metrics', '''SELECT site,referrer_domain,date,sessions,engaged_sessions,
            conversions,source FROM referral_metrics ORDER BY date DESC LIMIT 100''')
        searches=fetch_all(db,'search_history', '''SELECT site,query,attempted_at,result_count,inserted_count,error
            FROM search_history ORDER BY id DESC LIMIT 50''')
        counts=[]
        if table_exists(db,'outcomes'):
            counts=[qdict(x) for x in db.execute('SELECT outcome,COUNT(*) AS total FROM outcomes GROUP BY outcome')]
        return {'outcomes':outcomes,'referrals':referrals,'searches':searches,
                'outcome_counts':counts,'referral_sessions_in_latest_rows':sum(int(x['sessions']) for x in referrals),
                'notes':'Referral data only includes actually imported analytics; missing rows are unknown.'}


@app.get('/')
def index():return FileResponse(ROOT/'public'/'index.html')
@app.get('/app.js')
def js():return FileResponse(ROOT/'public'/'app.js',media_type='text/javascript')
@app.get('/styles.css')
def css():return FileResponse(ROOT/'public'/'styles.css',media_type='text/css')
@app.get('/favicon.svg')
def icon():return FileResponse(ROOT/'public'/'favicon.svg',media_type='image/svg+xml')

@app.get('/robots.txt')
def robots(): return PlainTextResponse('User-agent: *\nDisallow: /\n')

@app.middleware('http')
async def security_headers(request,call_next):
    if PROXY_SECRET:
        provided=request.headers.get('x-backlink-proxy-token','')
        if not hmac.compare_digest(provided,PROXY_SECRET):
            return JSONResponse({'detail':'API gateway authorization required'},status_code=403,headers={'Cache-Control':'no-store'})
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['X-Frame-Options']='DENY'
    response.headers['Content-Security-Policy']=("default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    response.headers['Cache-Control']='no-store'
    return response
