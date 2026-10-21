from datetime import datetime, timezone
import json
import pytest
from portfolio_pr.engine import Engine
from portfolio_pr.monitoring import monitor_replies
from portfolio_pr.integrations import GmailAPI

ASSET='https://imagealchemy.app/'
SOURCE='https://publisher.example.org/free-tools'
CONTACT='editor@publisher.example.org'


def prime_sent(engine):
    i=engine.add_candidate(site='imagealchemy.app',source_url=SOURCE,asset_url=ASSET,kind='resource')
    engine.conn.execute("INSERT INTO messages(candidate_id,to_address,subject,body,created_at,sent_at,status,gmail_id) VALUES(?,?,?,?,?,?,?,?)",
        (i,CONTACT,'Specific study [BLF]','Hello',datetime.now(timezone.utc).isoformat(),datetime.now(timezone.utc).isoformat(),'sent','MSG_SENT'))
    engine.conn.commit()
    return i

class FakeGmail:
    def __init__(self,snippet='Thanks, send more details',sender='Publisher <editor@publisher.example.org>'):
        self.snippet=snippet;self.sender=sender
    def configured(self):return True
    def thread_for_message(self,message_id):
        return {'thread_id':'THREAD-ID', 'thread':{'messages':[
            {'id':'MSG_SENT','labelIds':['SENT'],'payload':{'headers':[{'name':'From','value':'Alexios <owner@gmail.com>'}]}},
            {'id':'MSG_INBOUND','labelIds':['INBOX'],'snippet':self.snippet,
              'payload':{'headers':[{'name':'From','value':self.sender}]}}
        ]}}


def test_monitor_receives_human_reply_without_claiming_acceptance(tmp_path):
    engine=Engine(tmp_path/'test.sqlite3')
    i=prime_sent(engine)
    first=monitor_replies(engine,gmail=FakeGmail())
    assert first['new_replies']==1 and not first['opt_outs']
    assert engine.report()['links_live']==0
    assert engine.conn.execute('SELECT outcome FROM outcomes').fetchone()[0]=='reply_received'
    again=monitor_replies(engine,gmail=FakeGmail())
    assert again['new_replies']==0


def test_monitor_honors_explicit_optout(tmp_path):
    engine=Engine(tmp_path/'test.sqlite3')
    prime_sent(engine)
    result=monitor_replies(engine,gmail=FakeGmail('Please remove me from your emails'))
    assert result['opt_outs']==1
    assert engine.is_suppressed(CONTACT,'publisher.example.org')


def test_monitor_does_not_accept_unrelated_or_auto_messages(tmp_path):
    engine=Engine(tmp_path/'test.sqlite3')
    prime_sent(engine)
    result=monitor_replies(engine,gmail=FakeGmail('Your mail could not be delivered','Mail Delivery <mailer-daemon@google.com>'))
    assert result['new_replies']==0 and result['opt_outs']==0


def test_own_baseline_must_be_explicit_for_confirmed_gap(tmp_path):
    import csv
    engine=Engine(tmp_path/'test.sqlite3')
    path=tmp_path/'links.csv'
    with path.open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['source_url','target_domain'])
        w.writerow([SOURCE,'competitora.org']);w.writerow([SOURCE,'competitorb.org'])
    result=engine.load_backlink_gap(path,'imagealchemy.app',['competitora.org','competitorb.org'],ASSET)
    assert not result['owned_baseline_verified']
    assert 'POTENTIAL' in result['gap_confidence']
    assert engine.conn.execute('SELECT gap_own_baseline_verified FROM candidates').fetchone()[0]==0
    result=engine.load_backlink_gap(path,'imagealchemy.app',['competitora.org','competitorb.org'],ASSET,own_baseline_verified=True)
    assert result['owned_baseline_verified']
    assert engine.conn.execute('SELECT gap_own_baseline_verified FROM candidates').fetchone()[0]==1


def test_portfolio_report_shows_per_domain_zeros(tmp_path):
    from portfolio_pr.engine import render_html_report
    cfg=json.load(open('config/sites.json'))
    engine=Engine(tmp_path/'test.sqlite3')
    target=tmp_path/'report.html'
    render_html_report(engine,target,portfolio_config=cfg)
    text=target.read_text()
    for site in cfg['sites']:
        assert site['domain'] in text
    assert 'Confirmed form receipts' in text
    assert 'Sent in this local worker only' in text
