"""v4 portfolio integration regression tests (all external networks mocked)."""
from datetime import datetime, timedelta, timezone
import csv
import json
from pathlib import Path
import pytest
from portfolio_pr.engine import Engine
from portfolio_pr.portfolio import validate_portfolio, audit_assets, asset_is_verified, ranked_sites, site_progress
from portfolio_pr.submissions import import_forms, verify_form, record_form_receipt
from portfolio_pr.cli import pick_query, discover, qualify_pending, draft_ready

ASSET='https://imagealchemy.app/'
SOURCE='https://publisher.example.org/recommended-image-tools'
CONTACT='editorial@publisher.example.org'

class Response:
    status_code=200
    def __init__(self,url,text,status=200):
        self.url=url;self.text=text;self.status_code=status
        self.headers={'Content-Type':'text/html'}

class Session:
    def __init__(self,pages):self.pages=pages;self.calls=[]
    def get(self,url,**kwargs):
        self.calls.append(url)
        text,status=self.pages.get(url,('not found',404))
        return Response(url,text,status)

class Search:
    def __init__(self):self.queries=[]
    def search(self,query,count=10):
        self.queries.append(query)
        return [{'url':SOURCE,'title':'Free image compressor resources','snippet':'Include best image optimizer tools'}]

@pytest.fixture
def engine(tmp_path):return Engine(tmp_path/'test.sqlite3')

@pytest.fixture
def config():return {'sender_name':'Alexios Papaioannou','sites':[
    {'domain':'imagealchemy.app','assets':[ASSET], 'topic':'image compression',
     'identity':'ImageAlchemy independent app', 'editorial_idea':'Show tradeoffs of fully local privacy-first image compression.'},
    {'domain':'gearuptogrow.com','assets':['https://gearuptogrow.com/learning/spaced-repetition/'],
     'topic':'spaced repetition', 'identity':'Gear Up to Grow', 'editorial_idea':'Practical spaced review planning.'},
]}

def test_registry_covers_all_owned_sites():
    cfg=json.loads(Path('config/sites.json').read_text())
    names=validate_portfolio(cfg)
    assert len(names)>=10
    assert all(site['assets'] for site in cfg['sites'])
    assert 'frenchyfab.com' in names and 'imagealchemy.app' in names
    assert sum(len(site['assets']) for site in cfg['sites'])>=15


def test_registry_rejects_duplicates_and_off_site_assets(config):
    duplicate=json.loads(json.dumps(config));duplicate['sites'].append(config['sites'][0])
    with pytest.raises(ValueError,match='Duplicate'):validate_portfolio(duplicate)
    wrong=json.loads(json.dumps(config));wrong['sites'][0]['assets']=['https://publisher.example.org/']
    with pytest.raises(ValueError,match='Asset must'):validate_portfolio(wrong)


def test_asset_audit_caches_and_fair_site_priority(engine,config):
    src=Session({ASSET:('<title>ImageAlchemy Compressor</title> Free image compression',200),
                 config['sites'][1]['assets'][0]:('<title>Study planner</title>',200)})
    audit=audit_assets(engine,config,max_checks=10,session=src)
    assert len(audit['checked'])==2
    assert all(item['status']=='live' for item in audit['checked'])
    assert asset_is_verified(engine,ASSET)
    assert not audit_assets(engine,config,max_checks=10,session=src)['checked']
    assert len(src.calls)==2
    pr=ranked_sites(engine,config)
    assert len(pr)==2 and pr[0]['priority']>=80
    engine.record_search('imagealchemy.app','"image compression" "best tools"',10,2)
    assert ranked_sites(engine,config)[0]['domain']=='gearuptogrow.com'
    assert site_progress(engine,config)[0]['assets_verified']==1


def test_discovery_uses_both_sites_and_never_repeats_query(engine,config,monkeypatch):
    urls={asset:('<title>Verified asset</title>Image compression study planner',200)
          for site in config['sites'] for asset in site['assets']}
    audit_assets(engine,config,max_checks=10,session=Session(urls))
    monkeypatch.setenv('MAX_SEARCHES_PER_DAY','20')
    search=Search();out=discover(engine,config,max_calls=2,search=search)
    assert out['searched']==2 and len(out['searched_sites'])==2
    before=set(search.queries)
    another=discover(engine,config,max_calls=2,search=search)
    assert another['searched']==2
    assert not before & set(search.queries[2:])
    assert len(engine.conn.execute('SELECT * FROM search_history').fetchall())==4
    assert engine.conn.execute('SELECT COUNT(*) n FROM candidates').fetchone()['n']>=2


def test_missing_asset_verification_prevents_pitches(engine,config,monkeypatch):
    monkeypatch.setenv('MAX_SEARCHES_PER_DAY','20')
    search=Search()
    out=discover(engine,config,max_calls=3,search=search)
    assert out['searched']==0 and out['assets_not_verified']
    assert not search.queries


def test_auto_follow_official_contact_and_only_published_address(engine):
    source=f'''<html><title>Best image compression resources</title>
      <p>Editors update this image compressor comparison each year.</p>
      <a href="https://publisher.example.org/write-for-us">Pitch our staff</a></html>'''
    policy=f'''<html><title>Editor contributions</title>Write for us. Send a pitch
      about free image compression tools to <a href="mailto:{CONTACT}">{CONTACT}</a></html>'''
    pages={SOURCE:(source,200),'https://publisher.example.org/write-for-us':(policy,200),
           ASSET:('<title>Free image compressor</title>Compress your images',200)}
    i=engine.add_candidate(site='imagealchemy.app',source_url=SOURCE,asset_url=ASSET,kind='resource')
    res=engine.verify(i,session=Session(pages))
    assert res['editorial_invitation']
    assert res['contact_email']==CONTACT
    assert res['status']=='verified_ready'
    assert engine.conn.execute('SELECT editorial_policy_url FROM candidates WHERE id=?',(i,)).fetchone()[0].endswith('/write-for-us')


def test_form_only_route_recorded_not_claimed_submitted(engine):
    form='https://publisher.example.org/suggest-a-resource'
    source=f'<title>Best image compression tools</title><a href="{form}">suggest</a> image compression resource collection'
    policy='<title>Submit a Resource</title>Submit a resource to our image compression library <form action="/submit"><input></form>'
    pages={SOURCE:(source,200),form:(policy,200),ASSET:('<title>image compression tools</title>',200)}
    i=engine.add_candidate(site='imagealchemy.app',source_url=SOURCE,asset_url=ASSET)
    res=engine.verify(i,session=Session(pages))
    assert res['status']=='research'
    f=engine.conn.execute('SELECT * FROM submissions WHERE site=?',('imagealchemy.app',)).fetchall()
    assert len(f)==1 and f[0]['status']=='researched' and not f[0]['receipt']


def test_submission_requires_eligibility_and_true_receipt(engine,tmp_path):
    csvpath=tmp_path/'forms.csv'
    with csvpath.open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['site','publisher','form_url','asset_url','needs_login','needs_captcha','rights_confirmed'])
        w.writeheader();w.writerow({'site':'imagealchemy.app','publisher':'Relevant Publisher','form_url':SOURCE,
                  'asset_url':ASSET,'needs_login':'false','needs_captcha':'false','rights_confirmed':'true'})
    assert import_forms(engine,csvpath)['accepted']==1
    s=engine.conn.execute('SELECT id FROM submissions').fetchone()[0]
    with pytest.raises(ValueError):record_form_receipt(engine,s,'fake receipt')
    result=verify_form(engine,s,session=Session({SOURCE:('<title>Real submission form</title>Submit resource',200)}))
    assert result['status']=='eligible_for_authorized_browser'
    with pytest.raises(ValueError):record_form_receipt(engine,s,'a')
    with pytest.raises(ValueError):record_form_receipt(engine,s,'confirmation-X','https://unrelated.example.com/post')
    success=record_form_receipt(engine,s,'publisher-confirmation-123',SOURCE)
    assert success['status']=='submitted'


def test_ambiguous_publisher_duplicate_prevents_other_site_pitch(engine):
    source='<title>Study plan resources</title> Write for us <a href="mailto:editor@publisher.example.org">editor</a>'
    a='https://gearuptogrow.com/learning/spaced-repetition/'
    pages={SOURCE:(source,200),a:('<title>Study planning</title>plan',200),
           ASSET:('<title>image compression study planner</title>',200)}
    one=engine.add_candidate(site='gearuptogrow.com',source_url=SOURCE,asset_url=a,
        contact_email='editor@publisher.example.org',kind='resource')
    engine.verify(one,session=Session(pages))
    # Even a barely qualified draft is sufficient to block new pitches to one newsroom.
    engine.conn.execute('INSERT INTO messages(candidate_id,to_address,subject,body,created_at) VALUES(?,?,?,?,?)',
           (one,'editor@publisher.example.org','Pitch [BLF]','Hi',datetime.now(timezone.utc).isoformat()))
    engine.conn.commit()
    two=engine.add_candidate(site='imagealchemy.app',source_url=SOURCE,asset_url=ASSET,kind='resource')
    assert engine.verify(two,session=Session(pages))['status']=='rejected'
    assert engine.conn.execute('SELECT status FROM candidates WHERE id=?',(two,)).fetchone()[0]=='rejected'


def test_temporary_page_failure_is_retryable(engine):
    i=engine.add_candidate(site='imagealchemy.app',source_url=SOURCE,asset_url=ASSET)
    page=Session({SOURCE:('temporary',503),ASSET:('<title>image compressor</title>',200)})
    assert engine.verify(i,session=page)['status']=='retry'


def test_initial_asset_audit_covers_distinct_portfolio_domains_first(engine):
    """First constrained run visits five brands, not first brand's five URLs."""
    from portfolio_pr.portfolio import audit_assets
    config={'sites':[]}
    pages={}
    for i in range(6):
        domain=f'brand{i}.example.org'
        urls=[f'https://brand{i}.example.org/{j}' for j in range(3)]
        config['sites'].append({'domain':domain,'assets':urls})
        pages.update({url:('<title>Useful published guide</title>',200) for url in urls})
    result=audit_assets(engine,config,max_checks=5,session=Session(pages))
    assert len({x['site'] for x in result['checked']})==5
    assert len(result['checked'])==5
    next_result=audit_assets(engine,config,max_checks=5,session=Session(pages))
    assert any(x['site']=='brand5.example.org' for x in next_result['checked'])
