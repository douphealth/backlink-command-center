from email import message_from_bytes
import base64
from urllib.parse import urlsplit

import pytest

from portfolio_pr.integrations import BraveSearch,GmailAPI,NotConfigured

class Resp:
    def __init__(self,data,status=200):self.data=data;self.status_code=status
    def raise_for_status(self):
        if self.status_code>=400:raise RuntimeError(f'HTTP {self.status_code}')
    def json(self):return self.data

class FakeSession:
    def __init__(self):self.calls=[];self.responses=[]
    def queue(self,result):self.responses.append(result)
    def get(self,url,**kwargs):
        self.calls.append(('GET',url,kwargs))
        return self.responses.pop(0)
    def post(self,url,**kwargs):
        self.calls.append(('POST',url,kwargs))
        return self.responses.pop(0)


def test_brave_requires_real_key_no_api_calls():
    sess=FakeSession()
    with pytest.raises(NotConfigured): BraveSearch(api_key='',session=sess).search('study skills')
    assert sess.calls==[]


def test_brave_records_source_url_without_inventing_metrics():
    sess=FakeSession()
    sess.queue(Resp({'web':{'results':[{'url':'https://resource.example.org/links','title':'Resources','description':'Study skills'}]}}))
    b=BraveSearch(api_key='TEST_ONLY',session=sess)
    found=b.search('learning resources')
    assert found[0]['url']=='https://resource.example.org/links'
    assert 'spam_score' not in found[0]
    assert 'X-Subscription-Token' in sess.calls[0][2]['headers']


def test_gmail_requires_oauth_and_no_silent_send():
    sess=FakeSession()
    m=GmailAPI(client_id='',client_secret='',refresh_token='',session=sess)
    assert not m.configured()
    with pytest.raises(NotConfigured):m.send('editor@example.org','Idea','Hi','Alexios')
    assert sess.calls==[]


def test_gmail_api_returns_exact_message_id_and_preserves_subject():
    sess=FakeSession()
    sess.queue(Resp({'access_token':'UNIT_TEST_TOKEN'}))
    sess.queue(Resp({'id':'17abc_safely_from_provider','threadId':'thread_1'}))
    gmail=GmailAPI('client','secret','refresh',session=sess)
    id=gmail.send('editor@example.org','Study tools for your article','Hello editor,\nAn evidence-grounded idea.','Alexios')
    assert id=='17abc_safely_from_provider'
    assert sess.calls[0][1]=='https://oauth2.googleapis.com/token'
    payload=sess.calls[1][2]['json']['raw']
    msg=message_from_bytes(base64.urlsafe_b64decode(payload + '='*(-len(payload)%4)))
    assert msg['To']=='editor@example.org'
    assert msg['Subject']=='Study tools for your article'
    assert msg.get_payload(decode=True).decode().startswith('Hello editor,')


def test_dns_mx_check_not_mailbox_validation():
    sess=FakeSession()
    sess.queue(Resp({'Status':0,'Answer':[{'name':'example.org.','type':15,'data':'10 mail.example.org.'}]}))
    sess.queue(Resp({'Status':0,'Answer':[]}))
    gmail=GmailAPI('client','secret','refresh',session=sess)
    assert gmail.mx_status('editor@example.org')=='mx_present'
    assert gmail.mx_status('editor@nomx.example.org')=='no_mx'
    assert gmail.mx_status('not-an-address')=='invalid_email'


def test_remote_gmail_draft_created_without_sending():
    sess=FakeSession()
    sess.queue(Resp({'access_token':'UNIT_TEST_TOKEN'}))
    sess.queue(Resp({'id':'draft-xyz-actual','message':{'id':'message-id'}}))
    gmail=GmailAPI('client','secret','refresh',session=sess)
    got=gmail.create_draft('editor@example.org','Pitch [BLF]','Hello editor')
    assert got=='draft-xyz-actual'
    assert sess.calls[-1][1].endswith('/users/me/drafts')
    payload=sess.calls[-1][2]['json']['message']['raw']
    parsed=message_from_bytes(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
    assert parsed['Subject']=='Pitch [BLF]'
    assert not any('/messages/send' in x[1] for x in sess.calls)


def test_remote_gmail_draft_can_be_sent_once():
    sess=FakeSession()
    sess.queue(Resp({'access_token':'UNIT_TEST_TOKEN'}))
    sess.queue(Resp({'id':'sent-id','threadId':'thread'}))
    gmail=GmailAPI('client','secret','refresh',session=sess)
    assert gmail.send_draft('draft-id')=='sent-id'
    assert sess.calls[-1][1].endswith('/users/me/drafts/send')
    assert sess.calls[-1][2]['json']=={'id':'draft-id'}


def test_contact_history_excludes_unsent_own_drafts():
    sess=FakeSession()
    sess.queue(Resp({'access_token':'UNIT_TEST_TOKEN'}))
    sess.queue(Resp({'messages':[]}))
    gmail=GmailAPI('client','secret','refresh',session=sess)
    assert gmail.find_contact_history('editor@example.org') is False
    query=sess.calls[-1][2]['params']['q']
    assert '-in:drafts' in query and 'editor@example.org' in query


def test_gmail_refreshes_access_token_on_expiry(monkeypatch):
    sess=FakeSession()
    sess.queue(Resp({'access_token':'TOKEN_1','expires_in':200}))
    sess.queue(Resp({'access_token':'TOKEN_2','expires_in':3600}))
    gmail=GmailAPI('client','secret','refresh',session=sess)
    monkeypatch.setattr('portfolio_pr.integrations.time.monotonic',lambda:1000.0)
    assert gmail._token()=='TOKEN_1'
    monkeypatch.setattr('portfolio_pr.integrations.time.monotonic',lambda:1120.0)
    assert gmail._token()=='TOKEN_2'
    assert len(sess.calls)==2


def test_gmail_previous_contact_to_any_publisher_staff_blocks(monkeypatch):
    sess=FakeSession()
    sess.queue(Resp({'access_token':'TOKEN_1'}))
    sess.queue(Resp({'messages':[{'id':'previous-send'}]}))
    gmail=GmailAPI('client','secret','refresh',session=sess)
    assert gmail.find_publisher_history('publisher.example.org') is True
    assert 'to:(@example.org)' in sess.calls[-1][2]['params']['q']
