import os,sys,sqlite3,tempfile,importlib
from pathlib import Path
from fastapi.testclient import TestClient

APP=Path(__file__).resolve().parents[1]
UPSTREAM=APP/'engine'/'src'
sys.path.insert(0,str(UPSTREAM));sys.path.insert(0,str(APP))
from portfolio_pr.engine import Engine
from portfolio_pr.dataforseo import SCHEMA as DFS_SCHEMA


def client_setup(tmp_path):
    db=tmp_path/'worker.sqlite3';engine=Engine(db)
    engine.conn.executescript(DFS_SCHEMA)
    cid=engine.add_candidate(site='gearuptofit.com',source_url='https://example.com/resources/',asset_url='https://gearuptofit.com/shoe-finder/',kind='resource',title='test target')
    engine.conn.close()
    os.environ['PR_DB_PATH']=str(db)
    os.environ['DASHBOARD_ADMIN_PASSWORD']='a_good_password_used_only_in_tests_4321'
    os.environ['DASHBOARD_SESSION_SECRET']='a_secret_longer_than_32_chars_for_testing_only'
    os.environ['DASHBOARD_COOKIE_SECURE']='false'
    import server
    importlib.reload(server)
    return TestClient(server.app), db,cid


def login(client):
    r=client.post('/api/login',json={'password':os.environ['DASHBOARD_ADMIN_PASSWORD']})
    assert r.status_code==200,r.text
    return {'x-csrf-token':r.json()['csrf']}


def test_auth_required(tmp_path):
    c,db,cid=client_setup(tmp_path)
    for path in ('overview','prospects','spend','suppression','sites','outreach','activity','operations','learning'):
        assert c.get('/api/'+path).status_code==401
    assert c.post('/api/login',json={'password':'wrong'}).status_code==401
    h=login(c)
    assert c.get('/api/overview').status_code==200
    assert c.post('/api/suppression',json={'identity':'example.org','reason':'not relevant'}).status_code==403
    assert c.post('/api/suppression',json={'identity':'example.org','reason':'not relevant'},headers=h).status_code==200
    assert c.get('/api/suppression').json()['total']==1
    assert c.post('/api/logout',headers=h).status_code==200
    assert c.get('/api/overview').status_code==401


def test_real_db_no_fictional_metrics(tmp_path):
    c,db,cid=client_setup(tmp_path);h=login(c)
    d=c.get('/api/overview').json()
    assert d['counts']['prospects']==1
    assert d['counts']['sent']==0
    assert d['counts']['links']==0
    assert d['spend']['month_usd']==0
    assert d['worker_status']=='No worker heartbeat recorded'
    rows=c.get('/api/prospects').json()['items']
    assert rows[0]['publisher_domain']=='example.com'
    assert rows[0]['traffic_monthly'] is None
    assert c.get('/api/sites').json()['items']


def test_cannot_forge_verification(tmp_path):
    c,db,cid=client_setup(tmp_path);h=login(c)
    r=c.patch('/api/prospects/'+str(cid),json={'status':'verified_ready'},headers=h)
    assert r.status_code==409
    r=c.patch('/api/prospects/'+str(cid),json={'status':'hold','note':'bad publisher'},headers=h)
    assert r.status_code==200
    assert c.get('/api/prospects?status=hold').json()['total']==1
    assert c.get('/api/activity').json()['items'][0]['type']=='admin_status_changed'


def test_spend_reserved_and_actual(tmp_path):
    c,db,cid=client_setup(tmp_path);h=login(c)
    import datetime
    today=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    conn=sqlite3.connect(db)
    conn.execute('INSERT INTO dfs_requests(request_id,key_hash,site,endpoint,day_utc,month_utc,reserved_micro,actual_micro,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',('r','hash','gearuptofit.com','backlinks/domain_intersection/live',today,today[:7],55000,30000,'completed',today+'T08:30:00Z'))
    conn.commit();conn.close()
    d=c.get('/api/overview').json()
    assert abs(d['spend']['month_usd']-0.03)<1e-8
    assert d['spend']['unreconciled']==0
    assert c.get('/api/spend').json()['items'][0]['actual_micro']==30000


def test_suppression_never_deletes(tmp_path):
    c,db,cid=client_setup(tmp_path);h=login(c)
    assert c.post('/api/suppression',json={'identity':'badsite.com','reason':'selling links'},headers=h).status_code==200
    assert c.post('/api/suppression',json={'identity':'badsite.com','reason':'disallowed publisher'},headers=h).status_code==200
    rows=c.get('/api/suppression').json()['items']
    assert len(rows)==1 and rows[0]['reason']=='disallowed publisher'
    assert c.post('/api/suppression',json={'identity':'http://127.0.0.1','reason':'localhost'},headers=h).status_code==422


def test_app_static_no_secrets(tmp_path):
    c,db,cid=client_setup(tmp_path)
    assert c.get('/').status_code==200
    assert c.get('/app.js').status_code==200
    assert c.get('/styles.css').status_code==200
    assert 'DATAFORSEO_PASSWORD' not in c.get('/app.js').text


def test_operations_are_authenticated_and_safe_defaults(tmp_path):
    c,db,cid=client_setup(tmp_path)
    assert c.get('/api/operations').status_code==401
    assert c.post('/api/operations/commands',json={'action':'research'}).status_code==401
    h=login(c)
    data=c.get('/api/operations').json()
    assert data['controls']=={'research_paused':False,'outreach_paused':True,'dataforseo_paused':True}
    assert data['worker']['running'] is False
    assert data['commands']==[]
    assert c.get('/api/learning').status_code==200
    assert c.post('/api/operations/control',json={'key':'dataforseo_paused','paused':False},headers=h).status_code==409
    assert c.post('/api/operations/control',json={'key':'outreach_paused','paused':False},headers=h).status_code==409
    assert c.post('/api/operations/control',json={'key':'unrecognized','paused':True},headers=h).status_code==422
    assert c.post('/api/operations/control',json={'key':'dataforseo_paused','paused':False,'acknowledge_risk':True},headers=h).status_code==200
    assert c.get('/api/operations').json()['controls']['dataforseo_paused'] is False
    assert c.get('/api/spend').json()['items']==[]


def test_command_queue_deduplicates_and_observes_pause(tmp_path):
    c,db,cid=client_setup(tmp_path)
    h=login(c)
    initial=c.post('/api/operations/commands',json={'action':'research'},headers=h).json()
    assert initial['created'] is True and initial['status']=='queued'
    repeated=c.post('/api/operations/commands',json={'action':'research'},headers=h).json()
    assert repeated['created'] is False and repeated['id']==initial['id']
    assert c.post('/api/operations/commands',json={'action':'mischief'},headers=h).status_code==422
    assert c.post('/api/operations/control',json={'key':'research_paused','paused':True},headers=h).status_code==200
    assert c.post('/api/operations/commands',json={'action':'research'},headers=h).status_code==409
    from portfolio_pr import opstate
    with sqlite3.connect(db) as con:
        opstate.ensure(con)
        claimed=opstate.claim(con)
        assert claimed==(initial['id'],'research')
        opstate.complete(con,claimed[0],True,'No paid calls made')
        opstate.heartbeat(con,action='research_finished',event='research')
    data=c.get('/api/operations').json()
    assert data['commands'][0]['status']=='completed'
    assert data['worker']['running'] is True
    assert data['worker']['last_research_at']
    assert c.get('/api/overview').json()['worker_status']=='Worker online'


def test_ledger_totals_include_rows_older_than_last_150(tmp_path):
    c,db,cid=client_setup(tmp_path)
    login(c)
    import datetime
    today=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')
    with sqlite3.connect(db) as con:
        for i in range(200):
            con.execute('INSERT INTO dfs_requests(request_id,key_hash,site,endpoint,day_utc,month_utc,reserved_micro,actual_micro,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                (f'r{i}',f'h{i}','gearuptofit.com','backlinks/domain_intersection/live',today,today[:7],1000,1000,'completed',today+'T10:00:00Z'))
    overview=c.get('/api/overview').json()
    assert overview['spend']['month_usd']==0.2
    assert overview['spend']['today_usd']==0.2
    assert overview['spend']['requests_observed']==200


def test_worker_respects_operator_research_and_outreach_holds(tmp_path,monkeypatch):
    c,db,cid=client_setup(tmp_path)
    login(c)
    from portfolio_pr import opstate,worker
    monkeypatch.setenv('PR_DB_PATH',str(db))
    monkeypatch.setenv('PR_CONFIG',str(APP/'engine'/'config'/'sites.json'))
    monkeypatch.setenv('PR_SEND_ENABLED','YES')
    with sqlite3.connect(db) as con:
        opstate.ensure(con)
        opstate.set_flag(con,'research_paused',True)
        con.commit()
    assert worker.run_once()['status']=='paused'
    calls=[]
    monkeypatch.setattr(worker,'main',lambda args:calls.append(args) or 0)
    with sqlite3.connect(db) as con:
        opstate.set_flag(con,'research_paused',False)
        con.commit()
    assert worker.run_once()['status']=='needs_log_reconciliation'
    assert '--send-live' not in calls[-1]
    with sqlite3.connect(db) as con:
        opstate.set_flag(con,'outreach_paused',False)
        con.commit()
    assert worker.run_once()['status']=='needs_log_reconciliation'
    assert '--send-live' in calls[-1]


def test_operator_schema_is_identical_to_worker(tmp_path):
    import opstate
    from portfolio_pr import opstate as worker_ops
    assert opstate.SCHEMA==worker_ops.SCHEMA
    assert opstate.CONTROLS==worker_ops.CONTROLS
    assert opstate.ACTIONS==worker_ops.ACTIONS


def test_csv_export_requires_login_and_blocks_formula_injection(tmp_path):
    c,db,cid=client_setup(tmp_path)
    assert c.get('/api/export/prospects').status_code==401
    login(c)
    with sqlite3.connect(db) as con:
        con.execute("UPDATE candidates SET title='=HYPERLINK(\"https://unsafe.example\")' WHERE id=?",(cid,))
    result=c.get('/api/export/prospects')
    assert result.status_code==200 and 'text/csv' in result.headers['content-type']
    assert "'=HYPERLINK" not in result.text # title is not in allowlisted export fields
    assert c.get('/api/export/credentials').status_code==404
    assert 'DATAFORSEO_PASSWORD' not in result.text
    assert c.get('/api/export/spend').status_code==200


def test_worker_ops_queue_failure_is_sticky_no_repeat(tmp_path,monkeypatch):
    c,db,cid=client_setup(tmp_path)
    h=login(c)
    from portfolio_pr import worker
    monkeypatch.setenv('PR_DB_PATH',str(db))
    monkeypatch.setenv('PR_CONFIG',str(APP/'engine'/'config'/'sites.json'))
    monkeypatch.setattr(worker,'main',lambda args:2)
    response=c.post('/api/operations/commands',json={'action':'verify'},headers=h)
    assert response.status_code==200
    assert worker.execute_queued() is True
    data=c.get('/api/operations').json()
    assert data['commands'][0]['status']=='failed'
    assert worker.execute_queued() is False
    assert c.get('/api/operations').json()['commands'][0]['status']=='failed'


def test_no_work_is_not_reported_as_success(tmp_path,monkeypatch):
    c,db,cid=client_setup(tmp_path)
    from portfolio_pr import worker
    monkeypatch.setenv('PR_DB_PATH',str(db))
    monkeypatch.setenv('PR_CONFIG',str(APP/'engine'/'config'/'sites.json'))
    def no_work(_args):
        with sqlite3.connect(db) as con:
            con.execute('INSERT INTO activity(time_utc,type,detail) VALUES(?,?,?)',
                        ('2026-10-21T00:00:00+00:00','run_finished','{"run_status":"blocked_or_no_pending_work"}'))
        return 0
    monkeypatch.setattr(worker,'main',no_work)
    assert worker.run_once()['status']=='no_meaningful_work'


def test_proxy_secret_required_for_public_tunnel(tmp_path,monkeypatch):
    """Direct public tunnel access is denied without the Cloudflare Pages secret."""
    proxy_secret='independent-long-strong-test-proxy-secret-12345678'
    monkeypatch.setenv('DASHBOARD_PROXY_SECRET',proxy_secret)
    client,_,_=client_setup(tmp_path)
    assert client.get('/api/session').status_code==403
    assert client.get('/').status_code==403
    assert client.post('/api/login',json={'password':os.environ['DASHBOARD_ADMIN_PASSWORD']},
                       headers={'X-Backlink-Proxy-Token':'invalid'}).status_code==403
    headers={'X-Backlink-Proxy-Token':proxy_secret,'X-Backlink-Client-IP':'203.0.113.29'}
    assert client.get('/',headers=headers).status_code==200
    login_result=client.post('/api/login',json={'password':os.environ['DASHBOARD_ADMIN_PASSWORD']},headers=headers)
    assert login_result.status_code==200
    assert client.get('/api/session',headers=headers).status_code==200
