import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncAlerts,alertsOf,parseMarker,LABEL} from '../../scripts/autopilot/notify.mjs';

/** In-memory GitHub issues API for one repository (o/r); nothing leaves the process. */
function fakeGitHub({issues=[],labelExists=false,fail=()=>false,throwOn=()=>false}={}){
  const calls=[],gh={issues:issues.map(i=>({...i})),comments:{},labelExists};let next=100;
  const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}});
  const fetchImpl=async(url,opts={})=>{
    const u=new URL(url),method=opts.method||'GET',body=opts.body?JSON.parse(opts.body):null,path=u.pathname.replace(/^\/repos\/o\/r/,'');
    calls.push({host:u.host,method,path,query:u.search,body,headers:opts.headers});
    if(throwOn(method,path))throw Error('network down');
    if(fail(method,path))return json({message:'boom'},500);
    let m;
    if(method==='GET'&&path==='/issues')return json(gh.issues.filter(i=>i.state==='open'&&i.labels.some(l=>l.name===u.searchParams.get('labels'))));
    if(method==='GET'&&path===`/labels/${LABEL}`)return gh.labelExists?json({name:LABEL}):json({message:'Not Found'},404);
    if(method==='POST'&&path==='/labels'){gh.labelExists=true;return json({name:body.name},201)}
    if(method==='POST'&&path==='/issues'){const i={number:next++,title:body.title,body:body.body,state:'open',labels:body.labels.map(name=>({name})),created_at:'2026-11-25T10:00:00Z'};gh.issues.push(i);return json(i,201)}
    if((m=path.match(/^\/issues\/(\d+)$/))&&method==='PATCH'){const i=gh.issues.find(x=>x.number===Number(m[1]));Object.assign(i,body);return json(i)}
    if((m=path.match(/^\/issues\/(\d+)\/comments$/))&&method==='POST'){(gh.comments[m[1]]??=[]).push(body.body);return json({id:1},201)}
    return json({message:'unexpected'},404);
  };
  return {fetchImpl,calls,gh,writes:()=>calls.filter(c=>c.method!=='GET')};
}
const summary=(at,attention)=>({generated_at:at,dry_run:false,attention});
const stall=(msg='No new publisher was emailed on the last 2 weekdays (60 ready).')=>({level:'action',code:'sending_stalled',message:msg,fix:'Autopilot keeps retrying.'});
const vault=(level='warn',mib='16.0')=>({level,code:'vault_size',message:`The sealed vault is ${mib} MiB.`,fix:'A developer must shrink it.'});
const run=(gh,s,extra={})=>syncAlerts({summary:s,token:'t0k',repo:'o/r',fetchImpl:gh.fetchImpl,...extra});
const issue=(gh,code)=>gh.gh.issues.find(i=>i.title===`LinkForge: ${code}`);

test('opens one labelled issue per action code (plus the vault-size and inflow warnings) with message, fix, time and an optional mention',async()=>{
  const gh=fakeGitHub();
  const r=await run(gh,summary('2026-11-25T10:00:00Z',[stall('Held because ed@pub.example never verified.'),vault(),{level:'warn',code:'low_throughput',message:'m',fix:'f'},
    {level:'warn',code:'prospect_inflow_low',message:'No new addresses in 3 cycles.',fix:'f'},{level:'info',code:'holds',message:'m',fix:'f'}]),{mention:'owner-login'});
  assert.deepEqual({opened:r.opened,errors:r.errors},{opened:3,errors:0});
  assert.deepEqual(gh.gh.issues.map(i=>i.title).sort(),['LinkForge: prospect_inflow_low','LinkForge: sending_stalled','LinkForge: vault_size']);
  const i=issue(gh,'sending_stalled');
  assert.deepEqual(i.labels.map(l=>l.name),[LABEL]);
  assert.match(i.body,/\*\*Held because \[email\] never verified\.\*\*/);assert.match(i.body,/\*\*Fix:\*\* Autopilot keeps retrying\./);
  assert.match(i.body,/first seen 2026-11-25 10:00 UTC/);assert.match(i.body,/\n@owner-login\n/);
  assert.deepEqual(parseMarker(i.body),{code:'sending_stalled',level:'action',sig:parseMarker(i.body).sig,since:'2026-11-25T10:00:00Z',updated:'2026-11-25T10:00:00Z',absent:0,cycle:'2026-11-25T10:00:00Z'});
  assert.ok(gh.gh.labelExists,'the label is created once when missing');assert.equal(gh.calls.filter(c=>c.path==='/labels').length,1);
  const c=gh.calls[0];assert.equal(c.host,'api.github.com');assert.equal(c.headers.Authorization,'Bearer t0k');assert.match(c.query,/labels=linkforge-alert/);
});
test('re-running on the same cycle, or an unchanged next cycle, writes nothing',async()=>{
  const gh=fakeGitHub();await run(gh,summary('2026-11-25T10:00:00Z',[stall()]));const n=gh.writes().length;
  await run(gh,summary('2026-11-25T10:00:00Z',[stall()]));await run(gh,summary('2026-11-25T14:00:00Z',[stall()]));
  assert.equal(gh.writes().length,n);
});
test('a changed message rewrites the body without a comment; escalation adds exactly one comment',async()=>{
  const gh=fakeGitHub({labelExists:true});
  await run(gh,summary('2026-11-25T10:00:00Z',[stall(),vault()]),{mention:'owner-login'});
  const r=await run(gh,summary('2026-11-25T14:00:00Z',[stall('No new publisher was emailed on the last 3 weekdays (58 ready).'),vault()]));
  assert.equal(r.updated,1);assert.equal(r.escalated,0);
  const i=issue(gh,'sending_stalled');assert.match(i.body,/last 3 weekdays \(58 ready\)/);assert.doesNotMatch(i.body,/@owner-login/,'the mention is for the opening only');
  assert.match(i.body,/first seen 2026-11-25 10:00 UTC · last changed 2026-11-25 14:00 UTC/);
  assert.deepEqual(gh.gh.comments,{});
  const e=await run(gh,summary('2026-11-25T18:00:00Z',[stall('No new publisher was emailed on the last 3 weekdays (58 ready).'),vault('action','22.4')]));
  assert.equal(e.escalated,1);const v=issue(gh,'vault_size');
  assert.equal(gh.gh.comments[v.number].length,1);assert.match(gh.gh.comments[v.number][0],/^Escalated from warn to action: The sealed vault is 22\.4 MiB\./);
  assert.equal(parseMarker(v.body).level,'action');
  await run(gh,summary('2026-11-25T22:00:00Z',[stall('No new publisher was emailed on the last 3 weekdays (58 ready).'),vault('action','22.6')]));
  assert.equal(gh.gh.comments[v.number].length,1,'a new message at the same level is not an escalation');
});
test('an issue closes with a short comment after 2 consecutive cycles without its code, counted once per cycle',async()=>{
  const gh=fakeGitHub({labelExists:true});
  await run(gh,summary('2026-11-25T10:00:00Z',[stall()]));const i=issue(gh,'sending_stalled');
  await run(gh,summary('2026-11-25T14:00:00Z',[]));
  assert.equal(i.state,'open');assert.equal(parseMarker(i.body).absent,1);assert.match(i.body,/\*\*No new publisher/,'the text is kept while counting');
  await run(gh,summary('2026-11-25T14:00:00Z',[]));assert.equal(i.state,'open','the same cycle is never counted twice');
  const r=await run(gh,summary('2026-11-25T18:00:00Z',[]));
  assert.equal(r.closed,1);assert.equal(i.state,'closed');assert.equal(i.state_reason,'completed');
  assert.equal(gh.gh.comments[i.number].length,1);assert.match(gh.gh.comments[i.number][0],/^Cleared: .*2 consecutive cycles/);
  // A later recurrence opens a fresh issue.
  await run(gh,summary('2026-11-26T10:00:00Z',[stall()]));assert.equal(gh.gh.issues.filter(x=>x.title==='LinkForge: sending_stalled').length,2);
});
test('a code that returns after one quiet cycle resets the count',async()=>{
  const gh=fakeGitHub({labelExists:true});
  await run(gh,summary('2026-11-25T10:00:00Z',[stall()]));const i=issue(gh,'sending_stalled'),text=i.body.split('<!--')[0];
  await run(gh,summary('2026-11-25T14:00:00Z',[]));
  await run(gh,summary('2026-11-25T18:00:00Z',[stall()]));assert.equal(parseMarker(i.body).absent,0);assert.equal(i.body.split('<!--')[0],text,'same text, only the hidden counter changes');
  await run(gh,summary('2026-11-25T22:00:00Z',[]));assert.equal(i.state,'open');
});
test('existing alert issues without a marker are adopted by title; unrelated issues are left alone',async()=>{
  const gh=fakeGitHub({labelExists:true,issues:[{number:7,title:'LinkForge: vault_locked',body:'opened by hand',state:'open',labels:[{name:LABEL}],created_at:'2026-11-20T00:00:00Z'},
    {number:8,title:'Something else',body:'x',state:'open',labels:[{name:LABEL}]},{number:9,title:'LinkForge: gmail_send_blocked',body:'other label',state:'open',labels:[{name:'bug'}]}]});
  const r=await run(gh,summary('2026-11-25T10:00:00Z',[{level:'action',code:'vault_locked',message:'The vault could not be opened.',fix:'Restore the key.'}]));
  assert.equal(r.opened,0);assert.equal(r.updated,1);assert.equal(parseMarker(gh.gh.issues[0].body).code,'vault_locked');
  assert.equal(gh.gh.issues[1].body,'x');assert.equal(gh.gh.issues[2].body,'other label');
});
test('GitHub errors and network failures are logged, counted and never thrown',async()=>{
  const logs=[];
  const down=fakeGitHub({throwOn:()=>true});
  assert.equal((await run(down,summary('2026-11-25T10:00:00Z',[stall()]),{log:m=>logs.push(m)})).errors,1);
  const refused=fakeGitHub({labelExists:true,fail:(m,p)=>m==='POST'&&p==='/issues'});
  const r=await run(refused,summary('2026-11-25T10:00:00Z',[stall(),vault()]),{log:m=>logs.push(m)});
  assert.equal(r.errors,2);assert.equal(r.opened,0);
  assert.ok(logs.every(l=>/^notify: .* failed \(GitHub API|network down/.test(l)),logs.join('\n'));
});
test('skips without a token or repository, on dry runs and on unreadable summaries; bad mentions are ignored',async()=>{
  const gh=fakeGitHub();
  assert.match((await syncAlerts({summary:summary('2026-11-25T10:00:00Z',[stall()]),token:'',repo:'o/r',fetchImpl:gh.fetchImpl})).skipped,/GITHUB_TOKEN/);
  assert.match((await syncAlerts({summary:summary('2026-11-25T10:00:00Z',[stall()]),token:'t',repo:'not a repo',fetchImpl:gh.fetchImpl})).skipped,/GITHUB_REPOSITORY/);
  assert.equal((await run(gh,{...summary('2026-11-25T10:00:00Z',[stall()]),dry_run:true})).skipped,'dry run');
  assert.equal((await run(gh,null)).skipped,'no readable summary');
  assert.equal(gh.calls.length,0);
  await run(gh,summary('2026-11-25T10:00:00Z',[stall()]),{mention:'not a login!'});
  assert.doesNotMatch(issue(gh,'sending_stalled').body,/@not/);
});
test('only code, level, message and fix are posted; addresses and @ never reach GitHub',async()=>{
  const gh=fakeGitHub();
  await run(gh,summary('2026-11-25T10:00:00Z',[{level:'action',code:'owner_decision_pending',message:'1 publisher reply is waiting (write to @someone or ed@pub.example).',fix:'Reply in Gmail.',extra:'ed@pub.example'}]));
  const posted=JSON.stringify(gh.writes().map(c=>c.body));
  assert.doesNotMatch(posted,/pub\.example/);assert.doesNotMatch(posted,/@someone/,'stray @ cannot ping anyone');
  assert.deepEqual([...alertsOf({attention:[{level:'action',code:'Bad Code!',message:'x',fix:'y'}]}).keys()],[]);
});
test('the command line never fails the workflow',()=>{
  const dir=mkdtempSync(join(tmpdir(),'notify-')),file=join(dir,'autopilot.json');
  writeFileSync(file,JSON.stringify(summary('2026-11-25T10:00:00Z',[stall()])));
  const script=fileURLToPath(new URL('../../scripts/autopilot/notify.mjs',import.meta.url));
  const env={...process.env};delete env.GITHUB_TOKEN;delete env.GITHUB_REPOSITORY;
  const r=spawnSync(process.execPath,[script,file],{env,encoding:'utf8'});
  assert.equal(r.status,0);assert.match(r.stdout,/notify: skipped \(GITHUB_TOKEN or GITHUB_REPOSITORY not set\)/);
  const bad=spawnSync(process.execPath,[script,join(dir,'missing.json')],{env:{...env,GITHUB_TOKEN:'t',GITHUB_REPOSITORY:'o/r'},encoding:'utf8'});
  assert.equal(bad.status,0);assert.match(bad.stdout,/no readable summary/);
});
