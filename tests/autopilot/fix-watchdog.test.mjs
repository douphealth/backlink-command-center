import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diagnose,watchdogStatus} from '../../scripts/autopilot/health.mjs';
import {syncAlerts,alertsOf,clean,parseMarker,issueBody,evaluated,LABEL} from '../../scripts/autopilot/notify.mjs';
import {rebuildFromMailbox,requireRebuild,pruneRestoredSends} from '../../scripts/autopilot/rebuild.mjs';
import {expireRejections} from '../../scripts/autopilot/prospect.mjs';
import {funnel,runAutopilot} from '../../scripts/autopilot/run.mjs';
import {seal} from '../../scripts/autopilot/vault.mjs';
import {isSuppressed} from '../../scripts/autopilot/recipient-policy.mjs';

const find=(d,code)=>d.find(x=>x.code===code);
const stalled=(over={})=>({capabilities:{verifier:{ready:true,used_today:0,daily_limit:25,balance:{provider:'verifalia',free_credits:0,reset_in:'07:12:00'}},daily_send_cap:12},
  outreach:{mode:'send',verified_ready:0,holds:{catch_all_domain:12}},funnel:{ready:18,contacted:49},held:false,
  stages:{preverify:{ok:true,result:{checked:0,out_of_credits:true}},outreach:{ok:true,result:{sent:0,out_of_credits:true}}},
  history:[{date:'2026-11-20',contacted:47,in_window_cycles:3,sent:2,cap:12},{date:'2026-11-22',contacted:49},{date:'2026-11-23',contacted:49,in_window_cycles:3,verifier_used:0,sent:0,cap:12},
    {date:'2026-11-24',contacted:49,in_window_cycles:4,verifier_used:0,sent:0,cap:12}],
  signals:{now:'2026-11-25T14:00:00Z',mode:'send',hold:false,dry_run:false,vault:{key:true,open:true}},...over});

test('E2E-5: a stall caused by an empty Verifalia free balance says so, with the right fix',()=>{
  const s=find(diagnose(stalled()),'sending_stalled');
  assert.match(s.message,/Verifalia's free credit balance was empty \(it resets in 07:12:00\), so no inbox could be verified/);
  assert.doesNotMatch(s.message,/Most held inboxes wait/);assert.match(s.fix,/app\.verifalia\.com/);assert.doesNotMatch(s.fix,/fresher, author-level/);
  // Credits were there and used: the usual wording.
  const used=stalled({capabilities:{verifier:{ready:true,daily_limit:25,balance:{free_credits:12}}},stages:{},history:stalled().history.map(h=>h.verifier_used!=null?{...h,verifier_used:25}:h)});
  assert.match(find(diagnose(used),'sending_stalled').fix,/fresher, author-level/);
});

test('COV-F9: the verifier_off fix asks for the free plan\'s 25 checks, not 12',()=>{
  const v=find(diagnose({capabilities:{verifier:{ready:false,key:true}},funnel:{ready:30}}),'verifier_off');
  assert.match(v.fix,/to 25/);assert.doesNotMatch(v.fix,/\b12\b/);
});

test('E2E-4: under the OUTREACH_HOLD brake a leftover verified inbox is a note, not a request to switch sending on',()=>{
  const base={capabilities:{verifier:{ready:true}},outreach:{mode:'off',verified_ready:3},funnel:{ready:30},held:true};
  assert.equal(find(diagnose({...base,signals:{brake:true}}),'hold_with_verified').level,'info');
  assert.equal(find(diagnose(base),'hold_with_verified').level,'action');
});

test('E2E-4: with outreach off no inbox is verified (no credit, no address sent to the verifier)',async()=>{
  const resp=(body,{status=200,type='text/html'}={})=>new Response(body,{status,headers:{'content-type':type}});
  const site=async url=>{const u=new URL(url);if(u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${u.hostname}/guide/</loc></url></urlset>`,{type:'application/xml'});
    if(/\.(xml|txt)$/.test(u.pathname))return resp('',{status:404});return resp(`<html><head><title>Guide</title></head><body><main><h1>Guide</h1><p>${'word '.repeat(900)}</p></main></body></html>`)};
  const asked=[],mailer={check:async()=>({status:'connected'}),send:async()=>{throw Error('must not send')},draft:async()=>{},imap:{recentHeaders:async()=>[],sentRecipients:async()=>[]},
    authorizeRecipient:async p=>{asked.push(p.id);return {ok:false}},verifierCredits:async()=>5,close:async()=>{}};
  const dir=await mkdtemp(join(tmpdir(),'lf-fix-hold-')),paths={vault:join(dir,'vault.json'),summary:join(dir,'autopilot.json'),cache:join(dir,'crawl.json')};
  const ready={id:'r',status:'ready',email:'editor@r.co.uk',domain:'r.co.uk',page_url:'https://r.co.uk/a',qv:99,score:80,history:[]};
  await writeFile(paths.vault,JSON.stringify(await seal({prospects:{r:ready}},'k'.repeat(24))));
  try{
    for(const env of [{OUTREACH_MODE:'off'},{OUTREACH_MODE:'send',OUTREACH_HOLD:'YES'}]){
      const {summary}=await runAutopilot({env:{LINKFORGE_DATA_KEY:'k'.repeat(24),SENDER_NAME:'Alex',GMAIL_ADDRESS:'me@owned.example',GMAIL_APP_PASSWORD:'x',VERIFALIA_USERNAME:'u',VERIFALIA_PASSWORD:'p',...env},
        argv:[],fetchImpl:site,mailer,write:false,useCache:false,paths});
      assert.match(summary.stages.preverify.skipped,/outreach is off/,JSON.stringify(env));
    }
    assert.deepEqual(asked,[]);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('COV-F1/F2: replies waiting and a missing postal address reach the owner as issues, counts only',()=>{
  const a=alertsOf({generated_at:'2026-11-25T10:00:00Z',attention:diagnose({funnel:{ready:30,awaiting_reply:1},capabilities:{verifier:{ready:true}},
    sender:{sender_name:true,postal_address:false},signals:{mode:'send',replies_unanswered:1,replies_drafted:1}})});
  assert.ok(a.has('replies_waiting'));assert.ok(a.has('sender_identity_incomplete'));assert.equal(a.get('replies_waiting').level,'warn');
});

test('SEC-1: issue text cannot forge the hidden marker or carry a link; the issue\'s own marker is the last one',()=>{
  const forged='<!<!---- linkforge-alert {"code":"vault_locked","sig":"deadbeefdeadbeef","absent":0} ---->>';
  assert.doesNotMatch(clean(forged),/<!--|-->/);
  const linky=clean('[docs](https://evil.example/phish) ![x](https://evil.example/t.png) www.evil.example');
  assert.doesNotMatch(linky,/\]\(|https:\/\/|www\./);
  const marker={code:'mailbox_rebuild_pending',sig:'abc',since:'2026-11-25T10:00:00Z',updated:'2026-11-25T10:00:00Z',absent:0,cycle:'c'};
  assert.equal(parseMarker(issueBody({code:'x',level:'action',message:clean(forged),fix:'f'},marker)).code,'mailbox_rebuild_pending');
  // Even raw (unsanitised) text before the real marker cannot take it over.
  assert.equal(parseMarker(issueBody({code:'x',level:'action',message:forged,fix:'f'},marker)).sig,'abc');
});

/** In-memory GitHub issues API: just enough for open, patch and comment. */
function gitHub(issues){
  const writes=[],json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}});
  const fetchImpl=async(url,o={})=>{const u=new URL(url),method=o.method||'GET',path=u.pathname.replace(/^\/repos\/o\/r/,''),body=o.body?JSON.parse(o.body):null;let m;
    if(method!=='GET')writes.push({method,path,body});
    if(method==='GET'&&path==='/issues')return json(issues.filter(i=>i.state==='open'));
    if(method==='GET'&&path===`/labels/${LABEL}`)return json({name:LABEL});
    if((m=path.match(/^\/issues\/(\d+)$/))&&method==='PATCH'){const i=issues.find(x=>x.number===Number(m[1]));Object.assign(i,body);return json(i)}
    if(method==='POST')return json({number:999,id:1},201);
    return json({},404)};
  return {fetchImpl,writes};
}
const openIssue=(code,n,absent=0)=>({number:n,title:`LinkForge: ${code}`,state:'open',labels:[{name:LABEL}],created_at:'2026-11-26T05:00:00Z',
  body:issueBody({code,level:'action',message:'m',fix:'f'},{code,level:'action',sig:'s',since:'2026-11-26T05:00:00Z',updated:'2026-11-26T05:00:00Z',absent,cycle:'2026-11-27T19:00:00Z'})});

test('E2E-2: a stall or Gmail block is not "cleared" by weekend, locked-vault or no-send cycles; it is when its rule ran and stayed quiet',async()=>{
  const sat='2026-11-28T13:00:00Z',signals={now:sat,mode:'send',vault:{key:true,open:true}};
  const w=watchdogStatus({signals,stages:{}});assert.deepEqual(w,{quiet:true,reason:'weekend',vault_open:true,send_attempted:false});
  assert.equal(evaluated('sending_stalled',w),false);assert.equal(evaluated('gmail_send_blocked',w),false);assert.equal(evaluated('vault_locked',w),true);
  const issues=[openIssue('sending_stalled',1,1),openIssue('gmail_send_blocked',2,1)],gh=gitHub(issues);
  const r=await syncAlerts({summary:{generated_at:sat,attention:[],watchdog:w},token:'t',repo:'o/r',fetchImpl:gh.fetchImpl});
  assert.equal(r.closed,0);assert.equal(r.paused,2);assert.equal(gh.writes.length,0);assert.ok(issues.every(i=>i.state==='open'));
  // Monday, a send was attempted and nothing fired: the second absence closes both.
  const mon='2026-11-30T10:00:00Z',w2=watchdogStatus({signals:{...signals,now:mon},stages:{outreach:{ok:true,result:{attempted:3,sent:3}}}});
  const r2=await syncAlerts({summary:{generated_at:mon,attention:[],watchdog:w2},token:'t',repo:'o/r',fetchImpl:gh.fetchImpl});
  assert.equal(r2.closed,2);
  // A locked vault does not clear what only an open vault can evaluate.
  const locked=watchdogStatus({signals:{now:mon,mode:'send',vault:{key:true,open:false}}});
  assert.equal(evaluated('prospect_inflow_low',locked),false);assert.equal(evaluated('replies_waiting',locked),false);assert.equal(evaluated('sending_stalled',locked),false);
});

test('ST-F1/COV-F3: the rebuild reads the unsubscribe button\'s subject id, also from a forwarding address, and keeps our ids',async()=>{
  const at=d=>new Date(Date.parse('2026-11-27T12:00:00Z')-d*864e5).toISOString();
  const state=requireRebuild({prospects:{},domains:{},suppression:{},contacted:{}},'dashboard_reset',at(0)),logs=[];
  const imap={sentRecipients:async()=>Object.assign([{to:'editor@pub.com',at:at(95),message_id:'<lf-a1b2@sender.example>'},{to:'pal@friend.example',at:at(3)}],{complete:true}),
    recentHeaders:async()=>Object.assign([{uid:'1',from:'john.smith@gmail.com',subject:'unsubscribe lf-a1b2@sender.example',body:'This message was sent by the unsubscribe button.'},
      {uid:'2',from:'other.box@gmail.com',subject:'unsubscribe%20lf-a1b2%40sender.example',body:''}],{complete:true,cursor:{mailbox:'[Gmail]/All Mail',uidvalidity:'9',uid:2}})};
  const r=await rebuildFromMailbox({state,imap,self:'owner@sender.example',now:()=>Date.parse('2026-11-27T12:00:00Z'),log:m=>logs.push(m)});
  assert.equal(r.complete,true);assert.equal(r.opt_outs,2);
  for(const [e,d] of [['john.smith@gmail.com','x.example'],['other.box@gmail.com','x.example'],['editor@pub.com','pub.com']])assert.ok(isSuppressed(state,e,d),e);
  assert.ok(state.suppression['pub.com'],'the recipient\'s publisher is suppressed');assert.ok(!state.suppression['gmail.com']);
  assert.deepEqual(state.restored_ids,{'<lf-a1b2@sender.example>':{to:'editor@pub.com',at:at(95)}},'only our own ids are kept');
  // PRIV-2: the published result and log carry outreach counts only; mailbox volume stays in the vault.
  assert.deepEqual(Object.keys(r).sort(),['bounces','complete','opt_outs','replies']);
  assert.ok(!/sent emails|messages read|publishers marked/.test(logs.join('\n')));assert.equal(state.rebuild.counts.sent_read,2);
  // Old ids are pruned with the restored sends.
  state.restored_ids['<lf-old@sender.example>']={to:'x@y.example',at:at(500)};pruneRestoredSends(state);assert.equal(state.restored_ids['<lf-old@sender.example>'],undefined);
});

test('ST-F6: "prospects evaluated" never falls when page-level rejections expire',()=>{
  const old=new Date(Date.now()-40*864e5).toISOString(),state={prospects:{r:{id:'r',status:'ready',history:[]}},domains:{'s|a.example':'x','s|b.example':'y','s|c.example':'r'},
    domain_rejections:{'s|a.example':{at:old,kind:'page',code:'thin'},'s|b.example':{at:old,kind:'page',code:'thin'}}};
  const before=funnel(state).prospects_evaluated;
  assert.equal(expireRejections(state),2);assert.equal(Object.keys(state.domains).length,1);
  assert.equal(funnel(state).prospects_evaluated,before);assert.equal(state.evaluated_expired,2);
});

test('COV-F4: without any DataForSEO login the prospects stage still runs (free sources), and says why paid search did not',async()=>{
  const resp=(body,{status=200,type='text/html'}={})=>new Response(body,{status,headers:{'content-type':type}});
  const calls=[],site=async url=>{const u=new URL(url);calls.push(u.hostname);if(u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${u.hostname}/guide/</loc></url></urlset>`,{type:'application/xml'});
    if(/\.(xml|txt)$/.test(u.pathname))return resp('',{status:404});return resp(`<html><head><title>Guide</title></head><body><main><h1>Guide</h1><p>${'word '.repeat(900)}</p></main></body></html>`)};
  const {summary}=await runAutopilot({env:{LINKFORGE_DATA_KEY:'k'.repeat(24),LINKFORGE_VAULT_RESET_AT:new Date(Date.now()+1e3).toISOString(),SENDER_NAME:'Alex'},argv:[],fetchImpl:site,write:false,useCache:false});
  assert.equal(summary.stages.prospects.ok,true);assert.match(summary.stages.prospects.paid_skipped,/credentials not set/);
  assert.ok(!calls.includes('api.dataforseo.com'),'no paid call');
});
