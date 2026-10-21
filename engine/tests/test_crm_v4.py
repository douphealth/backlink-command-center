"""CRM synchronization uses user's existing verified spreadsheet IDs; no phantom sends."""
from pathlib import Path
from portfolio_pr.engine import Engine
from portfolio_pr.crm import import_crm, crm_sync_due, SheetsCRM


class FakeCRM:
    def configured(self):return True
    def read(self,range_a1):
        if 'Outreach' in range_a1:
            return [['2026-10-17','gearuptogrow.com','University X','editor@university.edu',
                     'Study planner pitch','https://gearuptogrow.com/learning/spaced-repetition/']]
        if 'Suppression' in range_a1:
            return [['support@badserver.example','Hard bounce','DSN-123']]
        if 'Prospects' in range_a1:
            return [['imagealchemy.app','Tool List','https://tools.example.org/submit',
                     'Editor contact TBD','https://imagealchemy.app/',
                     'A resource list about image editing','Public editor page','85','Qualified','2026-10-20','https://tools.example.org/submit']]
        if 'Forms' in range_a1:
            return [['Tool Directory','imagealchemy.app','https://imagealchemy.app/',
                     'https://directory.example.org/submit','Free product','Yes','CAPTCHA','Not submitted','','2026-10-20']]
        return []


def test_crm_import_prerequisites_and_real_history(tmp_path):
    engine=Engine(tmp_path/'test.sqlite3')
    config={'sender_name':'Alexios','sites':[{'domain':'gearuptogrow.com'}, {'domain':'imagealchemy.app'}]}
    report=import_crm(engine,config,client=FakeCRM())
    assert report['status']=='read_only_import'
    assert engine.is_suppressed('other@university.edu','university.edu')
    assert engine.is_suppressed('support@badserver.example','badserver.example')
    assert report['imported']==1
    c=engine.get_candidates()[0]
    assert c['contact_email']=='' # not invented from free-text CRM notes
    assert c['status']=='found' # source-side verification still required
    s=engine.conn.execute('SELECT * FROM submissions').fetchone()
    assert s['needs_login']==1 and s['needs_captcha']==1 and s['status']=='researched'
    assert crm_sync_due(engine,hours=12) is False


def test_crm_not_configured_no_network(tmp_path):
    engine=Engine(tmp_path/'test.sqlite3')
    config={'sender_name':'Alexios','sites':[]}
    class Unconfigured:
        def configured(self):return False
    assert import_crm(engine,config,client=Unconfigured())['status']=='not_configured'
