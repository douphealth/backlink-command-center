import csv
from pathlib import Path
import sqlite3
import tempfile
from unittest.mock import MagicMock

import pytest

from portfolio_pr.engine import Engine, fetch_page, reg_domain, is_public_url, render_html_report
from portfolio_pr.cli import qualify_pending, draft_ready, send_ready, discover
from portfolio_pr.integrations import BraveSearch, NotConfigured

ASSET='https://gearuptogrow.com/learning/spaced-repetition/'
SOURCE='https://openwriting.example.org/contribute'
CONTACT='editor@openwriting.example.org'

HTML_SOURCE=f'''<html><head><title>Academic learning contributor guidelines</title></head>
<body><h1>Write for us</h1><p>We welcome independent educational resource story pitches for study planning.
Send a pitch to the editorial team at {CONTACT}.</p><a href="mailto:{CONTACT}">Editorial contact</a></body></html>'''

class Response:
    def __init__(self,url,text,status=200):
        self.url=url
        self.text=text
        self.status_code=status
        self.headers={'Content-Type':'text/html'}

class FakeSession:
    def __init__(self,pages):self.pages=pages;self.calls=[]
    def get(self,url,**kwargs):
        self.calls.append(url)
        if url not in self.pages: return Response(url,'Not Found',404)
        return Response(url,self.pages[url])

class FakeGmail:
    def __init__(self,history=False,failed=False):self.history=history;self.sent=[];self.failed=failed
    def configured(self):return True
    def recent_sent_count(self,days=7):return 0
    def find_contact_history(self,email):return self.history
    def send(self,to_address,subject,body,from_name):
        if self.failed:raise RuntimeError('provider uncertain')
        self.sent.append((to_address,subject))
        return 'GMAIL_ID_FROM_PROVIDER'

@pytest.fixture
def engine(tmp_path):return Engine(tmp_path/'state'/'db.sqlite3')

@pytest.fixture
def site_config():return {'sender_name':'Alexios Papaioannou','sites':[{'domain':'gearuptogrow.com','identity':'Gear Up to Grow','editorial_idea':'A practical illustration of transparent spaced review plans for students.','assets':[ASSET],'topic':'study skills'}]}


def add_candidate(engine,spam=None,contact=CONTACT,source=SOURCE,asset=ASSET,kind='resource'):
    return engine.add_candidate(site='gearuptogrow.com',source_url=source,asset_url=asset,kind=kind,
         spam_score=spam,contact_email=contact,contact_source_url=source,editorial_policy_url=source)


def test_domain_normalization_and_url_restrictions():
    assert reg_domain('https://news.bbc.co.uk/a')=='bbc.co.uk'
    assert reg_domain('https://sub.a.example.com/a')=='example.com'
    for url in ['file:///etc/passwd','http://localhost:4000/','http://127.0.0.1/','http://10.0.0.7/','https://[::1]/','http://metadata.google.internal/x','http://example.com:9200/']:
        assert not is_public_url(url)
    assert is_public_url('https://example.org/resource')


def test_actual_gap_requires_two_competitors_and_excludes_own_links(engine,tmp_path):
    file=tmp_path/'refs.csv'
    rows=[
        ['https://good.example.net/resources','peerone.com','5','1200','47','false'],
        ['https://good.example.net/resources','peertwo.com','5','1200','47','false'],
        ['https://single.example.com/page','peerone.com','','','',''],
        ['https://already.example.org/links','peerone.com','','','',''],
        ['https://already.example.org/links','peertwo.com','','','',''],
        ['https://already.example.org/links','gearuptogrow.com','','','',''],
    ]
    with file.open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['source_url','target_domain','spam_score','monthly_traffic','domain_rank','nofollow']);w.writerows(rows)
    result=engine.load_backlink_gap(file,'gearuptogrow.com',['peerone.com','peertwo.com'],ASSET)
    assert result['gap_domains']==1
    c=engine.get_candidates()[0]
    assert c['publisher_domain']=='example.net'
    assert c['competitor_count']==2
    assert c['traffic_monthly']==1200
    assert c['spam_score']==5


def test_unknown_metrics_remain_null(engine):
    i=add_candidate(engine)
    c=engine.conn.execute('SELECT * FROM candidates WHERE id=?',(i,)).fetchone()
    assert c['traffic_monthly'] is None
    assert c['spam_score'] is None
    assert c['domain_rank'] is None


def test_verified_published_invitation_can_prepare_draft(engine,site_config):
    i=add_candidate(engine)
    session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<html><title>Free study planner</title><h1>Study planning</h1></html>'})
    result=engine.verify(i,session=session)
    assert result['status']=='verified_ready',result
    assert result['score']>=70
    assert result['contact_email']==CONTACT
    drafts=draft_ready(engine,site_config)
    assert len(drafts['drafts'])==1
    email=engine.conn.execute('SELECT * FROM messages WHERE candidate_id=?',(i,)).fetchone()
    assert 'no reply or follow-up' in email['body']
    assert ASSET in email['body']
    assert len(email['subject'])<60


def test_no_published_contact_no_draft(engine,site_config):
    i=add_candidate(engine,contact='guess@openwriting.example.org')
    session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<h1>Study planner</h1>'})
    result=engine.verify(i,session=session)
    assert not result['contact_email']
    assert result['status']=='research'
    assert draft_ready(engine,site_config)['drafts']==[]


def test_bad_page_and_preexisting_exact_link_rejected(engine):
    i=add_candidate(engine,spam=45)
    session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<h1>study planner</h1>'})
    result=engine.verify(i,session=session)
    assert result['status']=='rejected'
    assert result['excluded']=='Spam score above 30'

    source2='https://other.example.org/resources'
    j=add_candidate(engine,source=source2,contact='editor@other.example.org')
    html=f'<html><title>Resources</title>Write for us <a href="{ASSET}">Already featured</a><a href="mailto:editor@other.example.org">contact</a></html>'
    session=FakeSession({source2:html,ASSET:'<h1>planner</h1>'})
    ret=engine.verify(j,session=session)
    assert ret['status']=='rejected'
    assert ret['already_links']


def test_suppression_prevents_outreach(engine):
    i=add_candidate(engine)
    engine.suppress('openwriting.example.org','Opted out','receipt')
    res=engine.verify(i,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<h1>Study planner</h1>'}))
    assert res['status']=='rejected'


def test_send_requires_opt_in_and_history_check(engine,site_config,monkeypatch):
    i=add_candidate(engine)
    engine.verify(i,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<h1>study</h1>'}))
    draft_ready(engine,site_config)
    gmail=FakeGmail()
    monkeypatch.setenv('PR_SEND_ENABLED','YES')
    monkeypatch.setenv('PR_REQUIRE_HISTORY_SEED','NO')
    monkeypatch.setenv('MAX_SEND_PER_DAY','2')
    monkeypatch.setenv('MAX_SEND_PER_WEEK','8')
    assert send_ready(engine,site_config,gmail=gmail,dry_run=True)['sent']==[]
    from portfolio_pr.cli import _is_business_hour
    assert _is_business_hour(12) and not _is_business_hour(23)
    # isolate from actual local wall time by monkeypatching business hour check
    monkeypatch.setattr('portfolio_pr.cli._is_business_hour',lambda hour:True)
    gmail.history=True
    assert send_ready(engine,site_config,gmail=gmail,dry_run=False)['sent']==[]
    gmail.history=False
    sent=send_ready(engine,site_config,gmail=gmail,dry_run=False)
    assert sent['sent'][0]['gmail_id']=='GMAIL_ID_FROM_PROVIDER'
    assert engine.sent_count_since('2020-01-01T00:00:00+00:00')==1
    assert send_ready(engine,site_config,gmail=gmail,dry_run=False)['sent']==[]
    with pytest.raises(ValueError):engine.mark_sent(i,'SECOND_ID')


def test_verify_live_link_only_not_send_status(engine):
    i=add_candidate(engine)
    engine.verify(i,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<h1>study</h1>'}))
    # A reply or send never becomes a backlink. Only the exact hosted link qualifies.
    assert engine.report()['links_live']==0
    original=f'<html><title>Resource</title><a href="{ASSET}" rel="nofollow">External study planner</a></html>'
    ret=engine.verify_placement(i,session=FakeSession({SOURCE:original}))
    assert ret['live'] and ret['rel']=='nofollow'
    assert engine.report()['links_live']==1
    ret=engine.verify_placement(i,session=FakeSession({SOURCE:'<html>No link now</html>'}))
    assert not ret['live']
    assert engine.report()['links_live']==0


def test_report_offline_and_no_data(engine,tmp_path):
    add_candidate(engine)
    dest=tmp_path/'backlink-report.html'
    render_html_report(engine,dest,site='gearuptogrow.com')
    text=dest.read_text()
    assert 'no data' in text
    assert 'Verified live links' in text
    assert 'no automatic backlink claims' in text


def test_no_paid_search_without_key(engine,site_config,monkeypatch):
    monkeypatch.delenv('BRAVE_API_KEY',raising=False)
    assert discover(engine,site_config,max_calls=3)['searched']==0
    assert engine.conn.execute('SELECT COUNT(*) FROM api_usage').fetchone()[0]==0


def test_ambiguous_send_requires_reconciliation(engine,site_config,monkeypatch):
    i=add_candidate(engine)
    engine.verify(i,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<title>study planner</title><h1>study</h1>'}))
    draft_ready(engine,site_config)
    monkeypatch.setenv('PR_SEND_ENABLED','YES')
    monkeypatch.setenv('PR_REQUIRE_HISTORY_SEED','NO')
    monkeypatch.setattr('portfolio_pr.cli._is_business_hour',lambda hour:True)
    gmail=FakeGmail(failed=True)
    result=send_ready(engine,site_config,gmail=gmail,dry_run=False)
    assert not result['sent']
    assert engine.conn.execute('SELECT status FROM messages WHERE candidate_id=?',(i,)).fetchone()['status']=='needs_reconciliation'
    assert not send_ready(engine,site_config,gmail=gmail,dry_run=False)['sent']


def test_competitor_gap_missing_metrics_never_guessed(engine,tmp_path):
    path=tmp_path/'refs.csv'
    path.write_text('source_url,target_domain\nhttps://publisher.example.com/r,alpha.org\nhttps://publisher.example.com/r,beta.net\n')
    stats=engine.load_backlink_gap(path,'gearuptogrow.com',['alpha.org','beta.net'],ASSET)
    assert stats['gap_domains']==1
    prospect=engine.get_candidates()[0]
    assert prospect['spam_score'] is None
    assert prospect['traffic_monthly'] is None


def test_same_contact_is_suppressed_across_sites(engine):
    i=add_candidate(engine)
    engine.suppress(CONTACT,'Previously contacted','Gmail receipt')
    result=engine.verify(i,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<h1>study</h1>'}))
    assert result['status']=='rejected'


def test_verified_needs_topic_overlap(engine):
    i=add_candidate(engine)
    source='<title>Write for us</title><h1>Submit a pitch</h1><a href="mailto:'+CONTACT+'">editorial</a>'
    result=engine.verify(i,session=FakeSession({SOURCE:source,ASSET:'<title>Advanced neurobiological study planner</title>'}))
    assert result['status']=='research'


def test_suppression_csv_roundtrip(engine,tmp_path):
    path=tmp_path/'suppress.csv';path.write_text('identity,reason,source\ncontact@publisher.org,Opted out,reply_id\n')
    assert engine.load_suppressions(path)==1
    assert engine.is_suppressed('contact@publisher.org','publisher.org')


def test_outcomes_only_from_evidence_and_bounded_learning(engine):
    candidate=add_candidate(engine)
    with pytest.raises(ValueError):engine.record_outcome(candidate,'link_live','inferred')
    with pytest.raises(ValueError):engine.record_outcome(candidate,'accepted','')
    engine.record_outcome(candidate,'reply_positive','gmail_msg_verified_123')
    engine.record_outcome(candidate,'reply_positive','gmail_msg_verified_123')
    assert engine.conn.execute("SELECT COUNT(*) FROM outcomes WHERE candidate_id=?",(candidate,)).fetchone()[0]==1
    assert engine.learning_evidence()['resource']['bounded_score_adjustment']==0
    engine.record_outcome(candidate,'opt_out','gmail_reply_opt_out_123')
    assert engine.is_suppressed(CONTACT,'openwriting.example.org')


def test_final_delivery_failure_does_not_claim_live_link(engine):
    candidate=add_candidate(engine)
    engine.record_outcome(candidate,'connection_timeout','gmail_dsn_final_timeout_123')
    assert engine.report()['links_live']==0
    assert engine.is_suppressed(CONTACT,'openwriting.example.org')


def test_ahrefs_style_multifile_export_and_owned_exclusion(engine,tmp_path):
    p=tmp_path/'alpha.csv'
    p.write_text('Referring page URL,Target URL,Domain rating,Organic traffic,Link type\n'
        'https://public.example.net/a,https://competitor-alpha.com/page,56,3000,Dofollow\n'
        'https://other.example.org/r,https://competitor-alpha.com/post,35,600,Dofollow\n')
    q=tmp_path/'beta.csv'
    q.write_text('Referring page URL,Target URL,Domain rating,Organic traffic,Link type\n'
        'https://public.example.net/a,https://competitor-beta.org/article,55,2800,Dofollow\n'
        'https://other.example.org/r,https://competitor-beta.org/article,45,600,Dofollow\n'
        'https://other.example.org/r,https://gearuptogrow.com/learning/spaced-repetition/,45,600,Dofollow\n')
    result=engine.load_backlink_gap([p,q],'gearuptogrow.com',['competitor-alpha.com','competitor-beta.org'],ASSET)
    assert result['files']==2 and result['gap_domains']==1
    prospect=engine.get_candidates()[0]
    assert prospect['publisher_domain']=='example.net' and prospect['domain_rank']==56
    assert prospect['traffic_monthly']==2800


def test_competitor_domain_gap_may_span_different_pages(engine):
    # Actual skill selects publishers linking to >=2 peers across the domain,
    # not necessarily on the same published page.
    cid=engine.add_candidate(site='gearuptogrow.com',source_url=SOURCE,asset_url=ASSET,
        kind='competitor_gap',competitor_names=['competitor-one.com','competitor-two.org'],
        contact_email=CONTACT,contact_source_url=SOURCE,editorial_policy_url=SOURCE)
    live=HTML_SOURCE+'<a href="https://competitor-one.com/a">One</a>'
    res=engine.verify(cid,session=FakeSession({SOURCE:live,ASSET:'<title>Study skills planner</title>'}))
    assert res['status']=='verified_ready'
    missing=engine.verify(cid,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<title>Study skills planner</title>'}))
    assert missing['status']=='rejected'
    assert 'No imported competitor backlink' in missing['excluded']


def test_low_estimated_traffic_is_a_rejection_not_fake_unknown(engine):
    cid=engine.add_candidate(site='gearuptogrow.com',source_url=SOURCE,asset_url=ASSET,
        kind='resource',traffic_monthly=200,contact_email=CONTACT,contact_source_url=SOURCE,
        editorial_policy_url=SOURCE)
    res=engine.verify(cid,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<title>Study planner</title>'}))
    assert res['status']=='rejected' and 'traffic below' in res['excluded']


def test_suppression_import_blocks_other_editor_at_same_company_but_not_all_gmail(engine,tmp_path):
    p=tmp_path/'history.csv'
    p.write_text('identity,reason,source\neditor@school.edu,Previously contacted,Gmail sent ID\nthemysticaweb@gmail.com,Previously contacted,Gmail sent ID\n')
    assert engine.load_suppressions(p)==2
    assert engine.is_suppressed('other@school.edu','school.edu')
    assert not engine.is_suppressed('unrelated@gmail.com','independent.example.org')


def test_verify_actual_new_editorial_placement_url(engine):
    cid=add_candidate(engine)
    real='https://openwriting.example.org/new-study-tips-article'
    session=FakeSession({real:f'<h1>Study tips</h1><a href="{ASSET}" rel="noopener">Study planner</a>'})
    result=engine.verify_placement(cid,session=session,placement_url=real)
    assert result['live'] is True and result['placement_url']==real
    dbrow=engine.conn.execute('SELECT * FROM verified_links WHERE candidate_id=?',(cid,)).fetchone()
    assert dbrow['placement_url']==real
    unavailable=FakeSession({})
    # Temporary HTTP 0 (simulated DNS/connect problem) must not erase a previously verified link.
    from unittest.mock import patch
    with patch('portfolio_pr.engine.fetch_page',return_value={'status':0,'error':'Timeout','links':[]}):
        assert engine.verify_placement(cid)['status']=='check_unavailable'
    assert engine.report()['links_live']==1


def test_reject_third_party_placement_attribution(engine):
    cid=add_candidate(engine)
    with pytest.raises(ValueError):engine.verify_placement(cid,placement_url='https://another-publisher.example.net/article')


def test_gmail_draft_ids_are_idempotent(engine,site_config):
    cid=add_candidate(engine)
    engine.verify(cid,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<title>Study planner</title>'}))
    draft_ready(engine,site_config)
    draft=engine.conn.execute('SELECT * FROM messages WHERE candidate_id=?',(cid,)).fetchone()
    assert draft['subject'].endswith(' [BLF]') and len(draft['subject'])<60
    assert len(draft['body'].split())<=120
    engine.mark_gmail_draft(cid,'REAL_DRAFT_ID')
    with pytest.raises(ValueError): engine.mark_gmail_draft(cid,'SECOND_DRAFT_ID')
    assert engine.conn.execute('SELECT gmail_draft_id FROM messages WHERE candidate_id=?',(cid,)).fetchone()[0]=='REAL_DRAFT_ID'


def test_existing_sqlite_db_migrates_three_columns(tmp_path):
    import sqlite3
    p=tmp_path/'old.sqlite3'
    with sqlite3.connect(p) as db:
        db.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY,candidate_id INTEGER NOT NULL UNIQUE,to_address TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',gmail_id TEXT UNIQUE,created_at TEXT NOT NULL,sent_at TEXT)")
    db=Engine(p)
    columns={row['name'] for row in db.conn.execute('PRAGMA table_info(messages)')}
    assert {'gmail_draft_id','followup_draft_id','followup_at'} <= columns


def test_remote_drafts_sync_one_time_no_send(engine,site_config):
    from portfolio_pr.cli import sync_remote_drafts
    cid=add_candidate(engine)
    engine.verify(cid,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<title>Study planner</title>'}))
    draft_ready(engine,site_config)
    class RemoteGmail:
        def __init__(self):self.calls=[]
        def configured(self):return True
        def find_contact_history(self,email):return False
        def create_draft(self,contact,subject,body):
            self.calls.append(('draft',contact,subject))
            return 'VERIFIED_REMOTE_DRAFT_ID'
    g=RemoteGmail()
    r=sync_remote_drafts(engine,gmail=g)
    assert len(r['created'])==1 and len(g.calls)==1
    again=sync_remote_drafts(engine,gmail=g)
    assert again['created']==[] and len(g.calls)==1


def test_weekly_check_creates_one_same_thread_followup_draft(engine,site_config,monkeypatch):
    from portfolio_pr.cli import weekly_check
    from datetime import datetime,timezone,timedelta
    cid=add_candidate(engine)
    engine.verify(cid,session=FakeSession({SOURCE:HTML_SOURCE,ASSET:'<title>Study planner</title>'}))
    draft_ready(engine,site_config)
    engine.mark_sent(cid,'SENT-ID-123')
    cutoff=(datetime.now(timezone.utc)-timedelta(days=8)).isoformat()
    engine.conn.execute('UPDATE messages SET sent_at=? WHERE candidate_id=?',(cutoff,cid));engine.conn.commit()
    monkeypatch.setattr(engine,'verify_placement',lambda cid: {'live':False,'status':'checked'})
    class FakeThreadGmail:
        def __init__(self):self.drafts=[]
        def configured(self):return True
        def thread_for_message(self,m):
            return {'thread_id':'actual-thread-id','thread':{'messages':[{'id':'SENT-ID-123','labelIds':['SENT'],
            'payload':{'headers':[{'name':'Message-ID','value':'<original-message-id@account.example>'}]}}]}}
        def create_draft(self,to,subject,body,thread_id,in_reply_to):
            self.drafts.append((to,subject,body,thread_id,in_reply_to))
            return 'FOLLOWUP-DRAFT-ID'
    g=FakeThreadGmail()
    result=weekly_check(engine,gmail=g)
    assert result['reviewed']==1 and len(result['followup_drafts'])==1
    assert g.drafts[0][-2:] == ('actual-thread-id','<original-message-id@account.example>')
    assert g.drafts[0][1].endswith(' [BLF]')
    again=weekly_check(engine,gmail=g)
    assert again['followup_drafts']==[] and len(g.drafts)==1
