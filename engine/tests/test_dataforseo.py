"""DataForSEO API integration tests: realistic mocked network, ZERO paid test calls."""
from __future__ import annotations
import json
import base64
from decimal import Decimal
from datetime import datetime,timezone
from pathlib import Path
import pytest
import requests
from portfolio_pr.engine import Engine
from portfolio_pr.dataforseo import (
    DataForSEO,DataForSEOBlocked,DataForSEOError,DataForSEOUncertain,Limits,micro,
    _rate_from_user,
)
from portfolio_pr.dataforseo_workflow import topic_matches


class FakeResponse:
    def __init__(self,data,status_code=200):
        self._data=data;self.status_code=status_code
    def raise_for_status(self):
        if self.status_code>=400:raise requests.HTTPError(f'HTTP {self.status_code}')
    def json(self):return self._data


def price_items():
    return {'price':{'backlinks':{
        name:{'live':{'priority_normal':[
            {'cost_type':'per_request','cost':0.024},
            {'cost_type':'per_result','cost':0.000036}]}}
        for name in ('competitors','domain_intersection','backlinks')}},
        'money':{'balance':5.00}}


def account_response(user=None):
    return {'status_code':20000,'cost':0,'tasks':[{'status_code':20000,
        'result':[user if user is not None else price_items()]}]}


def intersection_response():
    return {'status_code':20000,'cost':0.0241,'tasks':[{
      'id':'paid-task-1','status_code':20000,'cost':0.0241,'result':[
        {'items':[{'summary':{'intersections_count':2},'domain_intersection':{
             '1':{'target':'studyhelper.org','rank':500,'backlinks_spam_score':5,
                  'referring_pages':100,'referring_pages_nofollow':20},
             '2':{'target':'studyhelper.org','rank':470,'backlinks_spam_score':4,
                  'referring_pages':100,'referring_pages_nofollow':10}}},
            {'summary':{'intersections_count':2},'domain_intersection':{
             '1':{'target':'spamportal.org','rank':888,'backlinks_spam_score':99},
             '2':{'target':'spamportal.org','rank':800,'backlinks_spam_score':90}}}
        ],'items_count':2,'total_count':2}]}]}


def backlink_response():
    return {'status_code':20000,'cost':0.02408,'tasks':[{
        'status_code':20000,'id':'paid-task-2','cost':0.02408,
        'result':[{'items':[{'domain_from':'studyhelper.org',
                    'url_from':'https://studyhelper.org/study-plan-resources',
                    'url_to':'https://peer1.org/example','page_from_status_code':200,
                    'page_from_title':'Study Planning Resources'},
                  {'domain_from':'malicious-studyhelper.org',
                    'url_from':'https://malicious-studyhelper.org/','url_to':'https://peer1.org/'}]}]}]}


class FakeSession:
    def __init__(self,responses=None,fail_post=False):
        self.gets=0;self.posts=0;self.responses=list(responses or [])
        self.fail_post=fail_post;self.payloads=[]
    def get(self,url,**kwargs):
        self.gets+=1
        assert url=='https://api.dataforseo.com/v3/appendix/user_data'
        assert kwargs.get('auth')==('test-login','test-password')
        return FakeResponse(account_response())
    def post(self,url,**kwargs):
        self.posts+=1;self.payloads.append((url,kwargs['json']))
        assert url.startswith('https://api.dataforseo.com/v3/backlinks/')
        assert kwargs.get('auth')==('test-login','test-password')
        assert len(kwargs['json'])==1
        if self.fail_post:raise requests.Timeout('deliberately lost paid response')
        if not self.responses:raise AssertionError('Unexpected paid call')
        return FakeResponse(self.responses.pop(0))


@pytest.fixture
def eng(tmp_path):
    e=Engine(tmp_path/'dfs.sqlite3')
    yield e
    e.conn.close()


def client(eng,session=None,enabled=True,limits=None):
    return DataForSEO(eng,login='test-login',password='test-password',
       session=session or FakeSession(),enabled=enabled,limits=limits)


def test_is_disabled_without_provisioned_login(eng):
    c=DataForSEO(eng,login='',password='',enabled=True,session=FakeSession())
    assert c.configured is False
    with pytest.raises(DataForSEOBlocked,match='absent'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert c.status()['paid_requests_today']==0


def test_free_account_rate_check_does_not_bill(eng):
    session=FakeSession();c=client(eng,session)
    user=c.account()
    assert user['money']['balance']==5
    fixed,row=_rate_from_user(user,'backlinks/domain_intersection/live')
    assert str(fixed)=='0.024' and str(row)=='0.000036'
    assert session.gets==1 and session.posts==0
    assert c.status()['month_spend_or_reserved_usd']=='0.000000'


def test_real_structure_gap_response_budget_cache_and_exclusion(eng):
    session=FakeSession([intersection_response()]);c=client(eng,session)
    a=c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'],limit=60)
    assert session.posts==1 and session.gets==1
    posted=session.payloads[0][1][0]
    assert posted['targets']=={'1':'peer1.org','2':'peer2.org'}
    assert posted['exclude_targets']==['gearuptogrow.com']
    assert posted['limit']==60
    assert len(a['candidate_domains'])==1
    item=a['candidate_domains'][0]
    assert item['publisher']=='studyhelper.org'
    assert item['rank_1000']==500
    assert item['nofollow_share']==pytest.approx(0.15)
    assert item['traffic_monthly'] if 'traffic_monthly' in item else True
    assert a['rejected']['spam']==1
    assert a['actual_backlink_pages_sampled']==0
    assert a['paid_usd']=='0.024100'
    b=c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'],limit=60)
    assert b['cached'] is True and session.posts==1 and session.gets==1
    assert c.status()['month_spend_or_reserved_usd']=='0.024100'
    assert c.status()['cache_rows']==1
    assert eng.conn.execute('SELECT COUNT(*) n FROM candidates').fetchone()['n']==0  # No URL yet!


def test_page_enrichment_uses_actual_link_source_not_domain_guess(eng):
    session=FakeSession([intersection_response(),backlink_response()]);c=client(eng,session)
    c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    x=c.enrich_page('gearuptogrow.com','studyhelper.org','peer1.org',
                    'https://gearuptogrow.com/learning/spaced-repetition/')
    assert session.posts==2
    assert len(x['source_pages'])==1
    row=eng.conn.execute('SELECT * FROM candidates').fetchone()
    assert row['source_url']=='https://studyhelper.org/study-plan-resources'
    assert row['gap_own_baseline_verified']==1
    assert row['traffic_monthly'] is None  # Backlinks API is NOT organic traffic estimation.
    assert row['domain_rank']==500   # DataForSEO rank is 0-1000, NOT Ahrefs DR
    assert session.payloads[1][1][0]['filters']==['domain_from','like','%studyhelper.org']


def test_ensure_no_spend_when_disabled_even_with_credentials(eng):
    session=FakeSession([intersection_response()]);c=client(eng,session,enabled=False)
    with pytest.raises(DataForSEOBlocked,match='disabled'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert session.gets==0 and session.posts==0


def test_caps_are_fail_closed_before_paid_post(eng):
    session=FakeSession([intersection_response()]);limits=Limits(request_micro=micro('0.02'))
    c=client(eng,session,limits=limits)
    with pytest.raises(DataForSEOBlocked,match='per-request'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert session.gets==1 and session.posts==0


def test_daily_budget_concurrent_reservations_prevent_overuse(eng):
    session=FakeSession([intersection_response()]);c=client(eng,session,
             limits=Limits(day_micro=micro('0.0327')))
    a=c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'],limit=60)
    assert session.posts==1
    with pytest.raises(DataForSEOBlocked,match='Hard daily'):
        c.discover_peer_domains('gearuptogrow.com',limit=12)
    assert session.posts==1


def test_fail_closed_if_api_price_missing(eng):
    sess=FakeSession();c=client(eng,sess)
    account=price_items();account['price']['backlinks']['domain_intersection']['live']={}
    c.account=lambda **kwargs:account
    with pytest.raises(DataForSEOBlocked,match='Current DataForSEO rate unavailable'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert sess.posts==0


def test_timeout_keeps_budget_held_and_blocks_all_later_paid_calls(eng):
    sess=FakeSession(fail_post=True);c=client(eng,sess)
    with pytest.raises(DataForSEOUncertain,match='no retries'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert c.status()['unreconciled_paid_requests']==1
    assert c.status()['month_spend_or_reserved_usd']!='0.000000'
    with pytest.raises(DataForSEOBlocked,match='Unreconciled'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    with pytest.raises(DataForSEOBlocked,match='Unreconciled'):
        c.discover_peer_domains('gearuptogrow.com')
    assert sess.posts==1


def test_paid_api_task_error_charged_but_never_cached(eng):
    error={'status_code':20000,'tasks':[{'status_code':50000,'id':'error1',
           'cost':0.024,'result':[]}]}
    sess=FakeSession([error]);c=client(eng,sess)
    with pytest.raises(DataForSEOError,match='API rejected'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert c.status()['month_spend_or_reserved_usd']=='0.024000'
    assert c.status()['cache_rows']==0


def test_malformed_paid_result_keeps_reservation_and_prevents_retry(eng):
    missing={'status_code':20000,'tasks':[{'status_code':20000,'id':'x','result':[]}]}
    sess=FakeSession([missing]);c=client(eng,sess)
    with pytest.raises(DataForSEOUncertain,match='actual USD cost'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert c.status()['unreconciled_paid_requests']==1


def test_single_paid_request_cap_no_unsafe_endpoints(eng):
    c=client(eng,FakeSession())
    with pytest.raises(DataForSEOBlocked,match='not allowlisted'):
        c.post('dataforseo_labs/google/ranked_keywords/live',{'limit':3},site='gearuptogrow.com')
    with pytest.raises(DataForSEOBlocked,match='limit'):
        c.post('backlinks/competitors/live',{'limit':100000},site='gearuptogrow.com')


def test_topic_checks_do_not_equate_backlink_overlap_with_niche_match():
    assert topic_matches('houseplant care','Best advice for houseplant care')
    assert not topic_matches('houseplant care','Internet hosting and unrelated SSL certificates')


def test_default_config_hard_ceiling_cannot_be_raised_by_env(monkeypatch):
    monkeypatch.setenv('DFS_MAX_USD_PER_MONTH','100')
    with pytest.raises(DataForSEOBlocked,match='audited hard ceiling'):
        Limits.environment()

class VariableBalanceSession(FakeSession):
    """Simulates the official free /appendix/user_data price and account balance."""
    def __init__(self, balances, responses=None):
        super().__init__(responses=responses)
        self.balances=list(balances)
    def get(self,url,**kwargs):
        self.gets+=1
        assert url=='https://api.dataforseo.com/v3/appendix/user_data'
        assert self.balances, 'Unexpected free account check'
        user=price_items()
        user['money']['balance']=self.balances.pop(0)
        return FakeResponse(account_response(user))


def test_official_user_data_uses_price_not_rates(eng):
    sess=FakeSession()
    user=price_items()
    user['rates']={'limits':{'day':{'backlinks':{}}}}  # Actual usage caps are NOT endpoint prices.
    c=client(eng,sess)
    c.account=lambda **kwargs:user
    assert _rate_from_user(user,'backlinks/backlinks/live') == (Decimal('0.024'),Decimal('0.000036'))
    assert sess.posts==0


def test_account_balances_match_worker_cost_no_false_alarm(eng):
    sess=VariableBalanceSession(['5.000000','4.975900'],[intersection_response()])
    c=client(eng,sess)
    c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    c.account(force=True)
    assert c.status()['unresolved_external_spend_alerts']==0
    assert sess.posts==1 and sess.gets==2


def test_external_spending_detected_and_permanently_blocks_new_calls(eng):
    sess=VariableBalanceSession(['5.000000','4.875900'],[intersection_response()])
    c=client(eng,sess)
    c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    with pytest.raises(DataForSEOBlocked,match='Unexpected external'):
        c.account(force=True)
    assert c.status()['unresolved_external_spend_alerts']==1
    with pytest.raises(DataForSEOBlocked,match='spending anomaly'):
        c.discover_peer_domains('gearuptogrow.com')
    assert sess.posts==1


def test_unknown_account_price_type_blocks_paid_calls(eng):
    sess=FakeSession()
    user=price_items()
    user['price']['backlinks']['domain_intersection']['live']['priority_normal'].append(
        {'cost_type':'per_kilobyte','cost':0.05})
    c=client(eng,sess)
    c.account=lambda **kwargs:user
    with pytest.raises(DataForSEOBlocked,match='Unrecognized'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert sess.posts==0


def test_missing_provider_price_blocks_no_charge(eng):
    sess=FakeSession();user=price_items();user.pop('price')
    c=client(eng,sess)
    c.account=lambda **kwargs:user
    with pytest.raises(DataForSEOBlocked,match='rate unavailable'):
        c.domain_gap('gearuptogrow.com',['peer1.org','peer2.org'])
    assert sess.posts==0


def test_basic_auth_secret_file_free_check_uses_real_format_without_paid_post(eng,tmp_path,monkeypatch):
    for key in ('DATAFORSEO_LOGIN','DATAFORSEO_API_LOGIN',
                'DATAFORSEO_PASSWORD','DATAFORSEO_API_PASSWORD'):
        monkeypatch.delenv(key,raising=False)
    secret=tmp_path/'dataforseo-auth.txt'
    secret.write_bytes(base64.b64encode(b'test-login:test-password')+b'\n')
    secret.chmod(0o600)
    monkeypatch.setenv('DATAFORSEO_BASIC_AUTH_FILE',str(secret))
    session=FakeSession()
    api=DataForSEO(eng,session=session,enabled=False)
    assert api.configured
    assert api.account()['money']['balance']==5.00
    assert session.gets==1 and session.posts==0
    assert api.status()['paid_enabled'] is False


def test_corrupt_basic_auth_secret_is_rejected_without_leaking_contents(eng,tmp_path,monkeypatch):
    monkeypatch.delenv('DATAFORSEO_LOGIN',raising=False)
    monkeypatch.delenv('DATAFORSEO_PASSWORD',raising=False)
    secret=tmp_path/'bad-auth.txt'
    secret.write_text('%%%NOT_BASE64_PRIVATE%%%',encoding='utf-8')
    monkeypatch.setenv('DATAFORSEO_BASIC_AUTH_FILE',str(secret))
    with pytest.raises(DataForSEOBlocked,match='Unreadable or invalid DataForSEO Basic Auth secret file') as e:
        DataForSEO(eng,session=FakeSession(),enabled=True)
    assert 'PRIVATE' not in str(e.value)
    assert 'bad-auth' not in str(e.value)


def test_partial_environment_pair_does_not_mix_with_secret_file(eng,tmp_path,monkeypatch):
    monkeypatch.setenv('DATAFORSEO_LOGIN','test-login')
    monkeypatch.delenv('DATAFORSEO_PASSWORD',raising=False)
    monkeypatch.delenv('DATAFORSEO_API_PASSWORD',raising=False)
    secret=tmp_path/'auth.txt'
    secret.write_bytes(base64.b64encode(b'other-login:other-password'))
    monkeypatch.setenv('DATAFORSEO_BASIC_AUTH_FILE',str(secret))
    c=DataForSEO(eng,session=FakeSession(),enabled=False)
    assert not c.configured
