import test from 'node:test';
import assert from 'node:assert/strict';
import {RecipientVerifier,verifaliaVerdict,usableVerification,VERIFALIA_API} from '../../scripts/autopilot/recipient-policy.mjs';

const now=Date.parse('2026-11-05T09:00:00Z');
const email='editor@journal.example';
const html='<h1>Editorial inquiries and resource suggestions</h1><a href="mailto:editor@journal.example">Contact our editor</a>';
const prospect={domain:'journal.example',page_url:'https://journal.example/resources/',email_source:'https://journal.example/contact/',email,history:[]};
const env={EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:'10',VERIFALIA_USERNAME:'lf-user',VERIFALIA_PASSWORD:'not-a-real-secret'};
const json=(status,body)=>({status,json:async()=>body});
const entry=(e=email,extra={})=>({inputData:e,emailAddress:e,classification:'Deliverable',status:'Success',isDisposableEmailAddress:false,isRoleAccount:true,...extra});
const done=(e,extra)=>({overview:{id:'job-1',status:'Completed'},entries:{data:[entry(e,extra)],meta:{isTruncated:false}}});
function fixture({free=25,result=extra=>done(email,extra),extra={},post,envChange={},state={}}={}){
  const calls=[];
  const fetchImpl=async(u,o={})=>{calls.push({u,method:o.method||'GET',headers:o.headers||{},body:o.body});
    if(u.includes('api.hunter.io'))return json(200,{data:{email:new URL(u).searchParams.get('email'),status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}});
    if(u.endsWith('/credits/balance'))return json(200,{creditPacks:500,freeCredits:free,freeCreditsResetIn:'08:00:00'});
    if(o.method==='POST'){if(post)return post(u,o);const body=JSON.parse(o.body);return json(200,result({...extra,inputData:body.entries[0].inputData,emailAddress:body.entries[0].inputData}))}
    if(o.method==='DELETE')return json(200,{});
    return json(404,{});
  };
  const v=new RecipientVerifier({state,env:{...env,...envChange},now:()=>now,fetchImpl,
    fetchPage:async u=>({status:200,url:u,body:html}),resolveMx:async()=>[{priority:10,exchange:'mx.journal.example'}]});
  return {v,calls,state,posts:()=>calls.filter(c=>c.method==='POST')};
}

test('deliverable inbox passes with Basic auth, no credentials in URLs, and the job is deleted after reading',async()=>{
  const f=fixture(),r=await f.v.verify(prospect);
  assert.equal(r.ok,true);assert.equal(r.verification.provider,'verifalia');assert.ok(usableVerification(r.verification,email,now));
  const post=f.posts()[0];assert.equal(post.u,VERIFALIA_API[0]+'/email-validations?waitTime=30000');
  assert.deepEqual(JSON.parse(post.body),{entries:[{inputData:email}],quality:'Standard'});
  assert.equal(post.headers.Authorization,'Basic '+Buffer.from('lf-user:not-a-real-secret').toString('base64'));
  assert.ok(f.calls.every(c=>!c.u.includes('not-a-real-secret')&&!c.u.includes('lf-user')));
  assert.ok(f.calls.some(c=>c.method==='DELETE'&&c.u.endsWith('/email-validations/job-1')));
  assert.equal(f.state.verifier_balance.free_credits,24); // Standard quality costs 1 credit
});
test('only Deliverable + Success for the exact address counts; catch-all, risky, disposable and mismatches never do',()=>{
  assert.equal(verifaliaVerdict(entry(),email,now).status,'valid');
  for(const e of [entry(email,{status:'ServerIsCatchAll',classification:'Risky'}),entry(email,{classification:'Unknown',status:'MailboxValidationTimeout'}),
    entry(email,{isDisposableEmailAddress:true}),entry('other@journal.example'),entry(email,{classification:'Risky',status:'Success'}),undefined])
    assert.equal(usableVerification(verifaliaVerdict(e,email,now),email,now),false,JSON.stringify(e));
  assert.equal(verifaliaVerdict(entry(email,{classification:'Undeliverable',status:'MailboxDoesNotExist'}),email,now).status,'invalid');
  assert.equal(verifaliaVerdict(entry(email,{status:'ServerIsCatchAll',classification:'Risky'}),email,now).catch_all,true);
});
test('free credits only: no submission when today\'s free credits cannot cover the check',async()=>{
  const f=fixture({free:1,envChange:{VERIFALIA_QUALITY:'High'}});const r=await f.v.mailbox(email);
  assert.equal(r.reason,'verifalia_free_credits_used_up');assert.equal(f.posts().length,0);
  const std=fixture({free:1,envChange:{VERIFALIA_QUALITY:'Standard'}});assert.equal((await std.v.mailbox(email)).status,'valid');
  const paid=fixture({free:0,envChange:{VERIFALIA_ALLOW_PAID:'YES'}});assert.equal((await paid.v.mailbox(email)).status,'valid');
  assert.ok(!paid.calls.some(c=>c.u.endsWith('/credits/balance')));
});
test('falls back to Hunter when Verifalia free credits are used up',async()=>{
  const f=fixture({free:0,envChange:{HUNTER_API_KEY:'unit-test-key'}});const r=await f.v.mailbox(email);
  assert.equal(r.status,'valid');assert.equal(r.provider,'hunter');assert.equal(f.posts().length,0);
});
test('balance is read once per run and decremented locally',async()=>{
  const f=fixture({free:4,envChange:{VERIFALIA_QUALITY:'High'}});await f.v.mailbox('a@journal.example');await f.v.mailbox('b@journal.example');
  assert.equal((await f.v.mailbox('c@journal.example')).reason,'verifalia_free_credits_used_up');
  assert.equal(f.calls.filter(c=>c.u.endsWith('/credits/balance')).length,1);assert.equal(f.posts().length,2);
});
test('catch-all domains are remembered and never checked again for 90 days',async()=>{
  const f=fixture({extra:{status:'ServerIsCatchAll',classification:'Risky'}});
  assert.equal((await f.v.verify(prospect)).ok,false);assert.ok(f.state.catch_all_domains['journal.example']);
  const again=fixture({state:f.state});assert.equal((await again.v.verify({...prospect,email:'editor@journal.example'})).ok,false);assert.equal(again.posts().length,0);
});
test('unknown results are not re-bought for 3 days; invalid ones are suppressed',async()=>{
  const f=fixture({extra:{classification:'Unknown',status:'MailboxTemporarilyUnavailable'}});
  assert.equal((await f.v.mailbox(email)).status,'unknown');assert.equal((await f.v.mailbox(email)).reason,'recently_inconclusive');assert.equal(f.posts().length,1);
  const bad=fixture({extra:{classification:'Undeliverable',status:'MailboxDoesNotExist'}});
  assert.equal((await bad.v.mailbox(email)).status,'invalid');assert.ok(bad.state.suppression[email]);
});
test('a queued job is polled to completion',async()=>{
  let polls=0;const f=fixture({post:async()=>json(202,{overview:{id:'job-9',status:'InProgress'}})});
  const base=f.v.fetch;f.v.fetch=async(u,o={})=>{if(u.includes('/email-validations/job-9?')){polls++;return json(polls<2?202:200,polls<2?{overview:{id:'job-9',status:'InProgress'}}:{overview:{id:'job-9',status:'Completed'},entries:{data:[entry()]}})}return base(u,o)};
  assert.equal((await f.v.mailbox(email)).status,'valid');assert.equal(polls,2);
});
test('no credits, bad login and network errors fail closed; a POST is never re-sent',async()=>{
  const nc=fixture({post:async()=>json(402,{})});assert.equal((await nc.v.mailbox(email)).status,'unknown');
  assert.equal((await nc.v.mailbox('x@journal.example')).reason,'verifalia_no_credits');assert.equal(nc.posts().length,1);
  const auth=fixture({post:async()=>json(401,{})});assert.equal((await auth.v.mailbox(email)).reason,'verifalia_login_rejected');
  let posts=0;const net=fixture({post:async()=>{posts++;throw new TypeError('fetch failed')}});
  assert.equal((await net.v.mailbox(email)).status,'unknown');assert.equal(posts,1);
  const pending=fixture({post:async()=>json(202,{overview:{id:'j',status:'InProgress'}})});
  pending.v.fetch=(b=>async(u,o={})=>u.includes('/email-validations/j?')?json(202,{overview:{id:'j',status:'InProgress'}}):b(u,o))(pending.v.fetch);
  assert.equal((await pending.v.mailbox(email)).reason,'verification_pending');
});
test('owner daily cap still applies across providers',async()=>{
  const f=fixture({envChange:{EMAIL_VERIFY_DAILY_LIMIT:'1'}});await f.v.mailbox('a@journal.example');
  assert.equal((await f.v.mailbox('b@journal.example')).reason,'verification_budget_exhausted');assert.equal(f.posts().length,1);
  const off=fixture({envChange:{EMAIL_VERIFICATION_ENABLED:'NO'}});assert.equal((await off.v.verify(prospect)).reason,'verifier_not_configured');assert.equal(off.calls.length,0);
});

test('pre-verify checks the best queued inboxes while outreach is paused and never sends',async()=>{
  const {preverify}=await import('../../scripts/autopilot/outreach.mjs');
  const t=new Date().toISOString(),sent=[],asked=[];
  const mk=(id,score)=>({id,domain:id+'.example',site:'s.com',page_url:`https://${id}.example/r`,asset_url:'https://s.com/a',email:`editor@${id}.example`,qv:2,status:'ready',score,history:[]});
  const state={prospects:{a:mk('a',40),b:mk('b',90),c:mk('c',70),d:{...mk('d',99),contact_quality:{status:'held',detail:'no_email_published',checked_at:t}}},contacted:{},suppression:{}};
  const mailer={send:async m=>sent.push(m),authorizeRecipient:async p=>{asked.push(p.id);return p.id==='b'?{ok:true,email:p.email,evidence:{source:`https://${p.domain}/contact`,email:p.email,rank:95,observed_at:t},
    verification:verifaliaVerdict(entry(p.email),p.email,Date.now())}:{ok:false,reason:'no_verified_mailbox',detail:'mailbox_unknown'}}};
  const r=await preverify({state,mailer,max:2});
  assert.deepEqual(asked,['b','c']);assert.deepEqual(r,{checked:2,verified:1,held:1});assert.equal(sent.length,0);
  assert.equal(state.prospects.b.contact_quality.status,'verified');assert.equal(state.prospects.c.contact_quality.status,'held');
  assert.deepEqual((await preverify({state,mailer,max:5})).checked,1); // b already verified, c and d held recently with a reason: only a
  delete state.prospects.c.contact_quality.detail;
  assert.equal((await preverify({state,mailer,max:5})).checked,1); // a hold with no recorded reason (older code) is re-checked now
});

test('held inboxes carry a precise, address-free reason that is aggregated publicly',async()=>{
  const {outreachStatus}=await import('../../scripts/autopilot/outreach.mjs');
  const generic=fixture();generic.v.fetchPage=async u=>({status:200,url:u,body:'<p>Site issues: webmaster@journal.example</p>'}); // not an accepted inbox type
  assert.deepEqual(await generic.v.verify(prospect),{ok:false,reason:'no_published_editorial_contact',detail:'only_non_editorial_inbox_published'});
  const none=fixture();none.v.fetchPage=async u=>({status:200,url:u,body:'<p>Use our contact form.</p>'});
  assert.equal((await none.v.verify(prospect)).detail,'no_email_published');
  const down=fixture();down.v.fetchPage=async u=>({status:503,url:u,body:''});
  assert.equal((await down.v.verify(prospect)).detail,'publisher_pages_unreachable');
  const mx=fixture();mx.v.resolveMx=async()=>[];assert.equal((await mx.v.verify(prospect)).detail,'mx_no_explicit_mx');
  const ca=fixture({extra:{status:'ServerIsCatchAll',classification:'Risky'}});assert.equal((await ca.v.verify(prospect)).detail,'mailbox_accept_all');
  const t=new Date().toISOString(),mk=(id,detail)=>({id,domain:id+'.example',email:`editor@${id}.example`,status:'ready',qv:2,history:[],contact_quality:{status:'held',reason:'x',detail,checked_at:t}});
  const st=outreachStatus({prospects:{a:mk('a','only_non_editorial_inbox_published'),b:mk('b','only_non_editorial_inbox_published'),c:mk('c','no_email_published')}},{limit:12,mode:'off',qualifyVersion:2});
  assert.deepEqual(st.holds,{only_non_editorial_inbox_published:2,no_email_published:1});assert.doesNotMatch(JSON.stringify(st),/@/);
});
test('a rejected login is recorded for the dashboard and stops further Verifalia calls this run',async()=>{
  const f=fixture();f.v.fetch=async()=>({status:401,json:async()=>({})});
  assert.equal((await f.v.mailbox(email)).reason,'verifalia_login_rejected');assert.equal(f.state.verifier_balance.error,'login_rejected');
  let calls=0;f.v.fetch=async()=>{calls++;return {status:401,json:async()=>({})}};await f.v.mailbox('x@journal.example');assert.equal(calls,0);
});

test('401 (bad login) and 403 (missing permission) are told apart and published without credentials',async()=>{
  const bad=fixture();bad.v.fetch=async()=>({status:401,json:async()=>({})});
  assert.equal((await bad.v.mailbox(email)).reason,'verifalia_login_rejected');assert.deepEqual({e:bad.state.verifier_balance.error,s:bad.state.verifier_balance.http_status},{e:'login_rejected',s:401});
  const perm=fixture();perm.v.fetch=async u=>({status:u.endsWith('/credits/balance')?403:200,json:async()=>({})});
  assert.equal((await perm.v.mailbox(email)).reason,'verifalia_permission_denied');assert.equal(perm.state.verifier_balance.endpoint,'credits_balance');
  const sub=fixture({post:async()=>json(403,{})});assert.equal((await sub.v.mailbox(email)).reason,'verifalia_permission_denied');assert.equal(sub.state.verifier_balance.endpoint,'submit_validation');
  assert.doesNotMatch(JSON.stringify([bad.state.verifier_balance,perm.state.verifier_balance]),/lf-user|not-a-real-secret/);
});
test('holds caused on our side are re-checked next run and hidden once the verifier works again',async()=>{
  const {preverify,outreachStatus,publisherHold}=await import('../../scripts/autopilot/outreach.mjs');
  assert.equal(publisherHold('mailbox_verifalia_login_rejected'),false);assert.equal(publisherHold('mailbox_verification_budget_exhausted'),false);
  assert.equal(publisherHold('no_email_published'),true);assert.equal(publisherHold('mx_null_mx'),true);assert.equal(publisherHold('mailbox_accept_all'),true);
  const old=new Date(Date.now()-3600e3).toISOString(),mk=(id,detail)=>({id,domain:id+'.example',email:`editor@${id}.example`,status:'ready',qv:2,score:50,history:[],contact_quality:{status:'held',detail,checked_at:old}});
  const state={prospects:{a:mk('a','mailbox_verifalia_login_rejected'),b:mk('b','no_email_published')},contacted:{},suppression:{},verifier_balance:{provider:'verifalia',free_credits:19,checked_at:new Date().toISOString()}};
  const asked=[];await preverify({state,mailer:{authorizeRecipient:async p=>{asked.push(p.id);return {ok:false,reason:'x',detail:'no_email_published'}}},max:5});
  assert.deepEqual(asked,['a']); // login-hold re-checked now; publisher-side hold waits
  state.prospects.c=mk('c','mailbox_verifalia_login_rejected');
  assert.deepEqual(outreachStatus(state,{limit:12,mode:'off',qualifyVersion:2}).holds,{no_email_published:2}); // stale login hold hidden
});
test('free queue screening retires unsendable prospects, upgrades addresses and spends no credits',async()=>{
  const {screenQueue}=await import('../../scripts/autopilot/outreach.mjs');
  const pages={'a.example':'<p>Use our form.</p>','b.example':'<h1>Editorial submissions</h1><a href="mailto:editor@b.example">Editor</a>','c.example':''};
  const st={prospects:{},suppression:{},email_verifications:{},email_verifier_usage:{}};
  for(const id of ['a','b','c'])st.prospects[id]={id,domain:id+'.example',page_url:`https://${id}.example/r`,email:`old@${id}.example`,status:'ready',score:50,history:[]};
  const calls=[];
  const v=new RecipientVerifier({state:st,env:{},now:()=>Date.now(),fetchImpl:async(...a)=>{calls.push(a);return json(500,{})},
    fetchPage:async u=>{const h=new URL(u).hostname,body=pages[h];return body?{status:200,url:u,body}:{status:503,url:u,body:''}},resolveMx:async()=>[]});
  const mailer={screenRecipient:(p,o)=>v.verify(p,{...o,screenOnly:true})};
  const r=await screenQueue({state:st,mailer});
  assert.deepEqual(r,{screened:3,kept:1,retired:1,address_updated:1});
  assert.equal(st.prospects.a.status,'contact_unverifiable');assert.equal(st.prospects.b.email,'editor@b.example');
  assert.equal(st.prospects.c.status,'ready'); // unreachable pages: retried later, never retired
  assert.equal(calls.length,0,'screening must not call any paid provider');
  assert.equal((await screenQueue({state:st,mailer})).screened,1); // only c is due again: a retired, b screened for 14 days
});
