"""The real worker entrypoint must invoke the metered DataForSEO cycle, not just its standalone CLI."""
from pathlib import Path
import json
import portfolio_pr.cli as cli


def test_run_integrates_metered_dfs_and_persists_report(tmp_path,monkeypatch,capsys):
    config={'sender_name':'Alexios Papaioannou','sites':[{
       'domain':'example.org','topic':'editorial tools',
       'identity':'Example independent publishing site',
       'editorial_idea':'Independent evaluation methodology',
       'assets':['https://example.org/useful-tool']}]}
    fp=tmp_path/'sites.json';fp.write_text(json.dumps(config))
    db=tmp_path/'state.sqlite3'
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('DATAFORSEO_AUTO_GAP','YES')
    monkeypatch.setenv('DATAFORSEO_PAID_ENABLED','NO')
    monkeypatch.setenv('PR_INITIAL_SUPPRESSION_CSV',str(tmp_path/'absent.csv'))
    monkeypatch.setattr(cli,'crm_sync_due',lambda *args,**kwargs:False)
    monkeypatch.setattr(cli,'audit_assets',lambda *args,**kwargs:{'checked':[]})
    monkeypatch.setattr(cli,'discover',lambda *args,**kwargs:{'searched':0,'recorded_raw_candidates':0})
    monkeypatch.setattr(cli,'qualify_pending',lambda *args,**kwargs:{'checked':0})
    monkeypatch.setattr(cli,'draft_ready',lambda *args,**kwargs:{'drafts':[]})
    monkeypatch.setattr(cli,'sync_remote_drafts',lambda *args,**kwargs:{'created':[]})
    monkeypatch.setattr(cli,'send_ready',lambda *args,**kwargs:{'sent':[]})
    monkeypatch.setattr(cli,'weekly_check',lambda *args,**kwargs:{'reviewed':0,'verified_links':0,'followup_drafts':[]})
    monkeypatch.setattr(cli,'referral_summary',lambda *args,**kwargs:{})
    called=[]
    def fake_cycle(engine,cfg):
        called.append(cfg['sites'][0]['domain'])
        return {'status':'processed','details':[{'site':'example.org','found_gap_domains':2}],
                'actual_paid_usd':'0.000000'}
    monkeypatch.setattr(cli,'run_dataforseo_cycle',fake_cycle)
    code=cli.main(['--db',str(db),'--config',str(fp),'run','--max-calls','0'])
    assert code==0
    result=json.loads(capsys.readouterr().out)
    assert called==['example.org']
    assert result['dataforseo']['status']=='processed'
    assert result['run_status']=='work_done'
    assert Path('output/backlink-report.html').exists()


def test_run_genuine_missing_dataforseo_credentials_never_calls_paid_api(tmp_path,monkeypatch,capsys):
    config={'sender_name':'Alexios Papaioannou','sites':[{
       'domain':'example.org','topic':'editorial tools',
       'identity':'Example independent publishing site',
       'editorial_idea':'Independent evaluation methodology',
       'assets':['https://example.org/useful-tool']}]}
    fp=tmp_path/'sites.json';fp.write_text(json.dumps(config))
    db=tmp_path/'state.sqlite3'
    monkeypatch.chdir(tmp_path)
    for key in ('DATAFORSEO_LOGIN','DATAFORSEO_PASSWORD','DATAFORSEO_API_LOGIN','DATAFORSEO_API_PASSWORD'):
        monkeypatch.delenv(key,raising=False)
    monkeypatch.setenv('DATAFORSEO_AUTO_GAP','YES')
    monkeypatch.setenv('DATAFORSEO_PAID_ENABLED','NO')
    monkeypatch.setenv('PR_INITIAL_SUPPRESSION_CSV',str(tmp_path/'absent.csv'))
    monkeypatch.setattr(cli,'crm_sync_due',lambda *args,**kwargs:False)
    monkeypatch.setattr(cli,'audit_assets',lambda *args,**kwargs:{'checked':[]})
    monkeypatch.setattr(cli,'discover',lambda *args,**kwargs:{'searched':0,'recorded_raw_candidates':0})
    monkeypatch.setattr(cli,'qualify_pending',lambda *args,**kwargs:{'checked':0})
    monkeypatch.setattr(cli,'draft_ready',lambda *args,**kwargs:{'drafts':[]})
    monkeypatch.setattr(cli,'sync_remote_drafts',lambda *args,**kwargs:{'created':[]})
    monkeypatch.setattr(cli,'send_ready',lambda *args,**kwargs:{'sent':[]})
    monkeypatch.setattr(cli,'weekly_check',lambda *args,**kwargs:{'reviewed':0,'verified_links':0,'followup_drafts':[]})
    monkeypatch.setattr(cli,'referral_summary',lambda *args,**kwargs:{})
    code=cli.main(['--db',str(db),'--config',str(fp),'run','--max-calls','0'])
    assert code==0
    result=json.loads(capsys.readouterr().out)
    assert result['dataforseo']['status']=='blocked'
    assert 'credentials' in result['dataforseo']['reason']
    from portfolio_pr.engine import Engine
    from portfolio_pr.dataforseo import DataForSEO
    e=Engine(db)
    assert DataForSEO(e).status()['paid_requests_today']==0


def test_default_run_never_uses_paid_dfs_even_with_credentials(tmp_path,monkeypatch,capsys):
    """A token accidentally provisioned cannot create a paid request by itself."""
    config={'sender_name':'Alexios','sites':[{'domain':'example.org','topic':'tools',
        'identity':'Independent tool','editorial_idea':'Original tool evaluation',
        'assets':['https://example.org/tool']}]}
    config_file=tmp_path/'sites.json';config_file.write_text(json.dumps(config))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('DATAFORSEO_PAID_ENABLED','YES')
    monkeypatch.setenv('DATAFORSEO_AUTO_GAP','NO')
    monkeypatch.setenv('DATAFORSEO_LOGIN','never-use-this-test')
    monkeypatch.setenv('DATAFORSEO_PASSWORD','unused')
    monkeypatch.setenv('PR_INITIAL_SUPPRESSION_CSV',str(tmp_path/'absent.csv'))
    monkeypatch.setattr(cli,'crm_sync_due',lambda *args,**kwargs:False)
    monkeypatch.setattr(cli,'audit_assets',lambda *args,**kwargs:{'checked':[]})
    monkeypatch.setattr(cli,'discover',lambda *args,**kwargs:{'searched':0})
    monkeypatch.setattr(cli,'qualify_pending',lambda *args,**kwargs:{'checked':0})
    monkeypatch.setattr(cli,'draft_ready',lambda *args,**kwargs:{'drafts':[]})
    monkeypatch.setattr(cli,'sync_remote_drafts',lambda *args,**kwargs:{'created':[]})
    monkeypatch.setattr(cli,'send_ready',lambda *args,**kwargs:{'sent':[]})
    monkeypatch.setattr(cli,'weekly_check',lambda *args,**kwargs:{'reviewed':0,'verified_links':0,'followup_drafts':[]})
    monkeypatch.setattr(cli,'referral_summary',lambda *args,**kwargs:{})
    def fail_if_paid(*args,**kwargs):raise AssertionError('No paid DataForSEO call allowed')
    monkeypatch.setattr(cli,'run_dataforseo_cycle',fail_if_paid)
    result=cli.main(['--db',str(tmp_path/'offline.sqlite3'),'--config',str(config_file),'run','--max-calls','0'])
    assert result==0
    out=json.loads(capsys.readouterr().out)
    assert out['dataforseo']['status']=='disabled'
