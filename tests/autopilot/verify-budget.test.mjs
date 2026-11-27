import test from 'node:test';
import assert from 'node:assert/strict';
import {RecipientVerifier,usableVerification,verifyLedger,jurisdictionHold,serverUnknown} from '../../scripts/autopilot/recipient-policy.mjs';
import {applyProof,publisherHold} from '../../scripts/autopilot/outreach.mjs';

const now=Date.parse('2026-11-25T09:00:00Z'),today='2026-11-25'; // a Wednesday
const env={EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:'25',VERIFALIA_USERNAME:'lf-user',VERIFALIA_PASSWORD:'not-a-real-secret'};
const json=(status,body)=>({status,json:async()=>body});
const editorial=(...emails)=>'<h1>Editorial inquiries and resource suggestions</h1>'+emails.map(e=>`<p><a href="mailto:${e}">Write to our editors</a></p>`).join('');
const prospect=(extra={})=>({id:'p',domain:'pub.example',page_url:'https://pub.example/guide/',email_source:'https://pub.example/contact/',email:'editor@pub.example',status:'ready',history:[],...extra});
/** Verifalia (and optionally Hunter) mocked per address: `results[email]` overrides the Verifalia entry, `hunter[email]` the Hunter data. */
function rig({free=25,results={},hunter={},envChange={},state={},html=editorial('editor@pub.example'),pages}={}){
  const calls=[],fetched=[];
  const fetchImpl=async(u,o={})=>{const c={u,method:o.method||'GET',body:o.body};calls.push(c);
    if(u.includes('api.hunter.io')){const e=new URL(u).searchParams.get('email');c.email=e;
      return json(200,{data:{email:e,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false,...(hunter[e]||{})}})}
    if(u.endsWith('/credits/balance'))return json(200,{freeCredits:free,freeCreditsResetIn:'08:00:00'});
    if(c.method==='POST'){const e=JSON.parse(o.body).entries[0].inputData;c.email=e;
      return json(200,{overview:{id:'job',status:'Completed'},entries:{data:[{inputData:e,emailAddress:e,classification:'Deliverable',status:'Success',isDisposableEmailAddress:false,...(results[e]||{})}]}})}
    if(c.method==='DELETE')return json(200,{});
    return json(404,{});
  };
  const v=new RecipientVerifier({state,env:{...env,...envChange},now:()=>now,fetchImpl,
    fetchPage:async u=>{fetched.push(u);const body=pages?pages(u):html;return body?{status:200,url:u,body}:{status:404,url:u,body:''}},resolveMx:async()=>[{priority:10,exchange:'mx.pub.example'}]});
  return {v,state,calls,fetched,posts:()=>calls.filter(c=>c.method==='POST').map(c=>c.email),hunterCalls:()=>calls.filter(c=>c.u.includes('api.hunter.io')).map(c=>c.email)};
}
const UNKNOWN={classification:'Unknown',status:'MailboxTemporarilyUnavailable'};

test('each day spends min(owner daily limit, live free credits); paid credits stay blocked',async()=>{
  const few=rig({free:3});assert.equal(await few.v.creditsLeft(),3);
  for(const e of ['a','b','c'])assert.equal((await few.v.mailbox(e+'@pub.example')).status,'valid');
  assert.equal((await few.v.mailbox('d@pub.example')).reason,'verifalia_free_credits_used_up');assert.equal(few.posts().length,3);
  assert.equal(await few.v.creditsLeft(),0);
  const capped=rig({free:25,envChange:{EMAIL_VERIFY_DAILY_LIMIT:'2'}});assert.equal(await capped.v.creditsLeft(),2);
  await capped.v.mailbox('a@pub.example');await capped.v.mailbox('b@pub.example');
  assert.equal((await capped.v.mailbox('c@pub.example')).reason,'verification_budget_exhausted');assert.equal(capped.posts().length,2);
  const empty=rig({free:0});assert.equal(await empty.v.creditsLeft(),0);assert.equal((await empty.v.mailbox('a@pub.example')).reason,'verifalia_free_credits_used_up');
  assert.equal(empty.posts().length,0,'no paid submission without VERIFALIA_ALLOW_PAID=YES');
  const high=rig({free:5,envChange:{VERIFALIA_QUALITY:'High'}});assert.equal(await high.v.creditsLeft(),2,'High costs 2 credits a check');
  assert.equal(high.calls.filter(c=>c.u.endsWith('/credits/balance')).length,1,'reading the balance is a free GET, done once');
});

test('Hunter is never used at its default budget of 0, whatever Verifalia answers',async()=>{
  const unknown=rig({results:{'editor@pub.example':UNKNOWN},envChange:{HUNTER_API_KEY:'real-looking-key'}});
  assert.equal((await unknown.v.mailbox('editor@pub.example')).status,'unknown');assert.deepEqual(unknown.hunterCalls(),[]);
  const usedUp=rig({free:0,envChange:{HUNTER_API_KEY:'real-looking-key'}});
  assert.equal((await usedUp.v.mailbox('editor@pub.example')).reason,'verifalia_free_credits_used_up');assert.deepEqual(usedUp.hunterCalls(),[]);
  assert.equal(await usedUp.v.creditsLeft(),0,'a zero Hunter budget adds no checks');
  const only=rig({envChange:{VERIFALIA_USERNAME:'',VERIFALIA_PASSWORD:'',HUNTER_API_KEY:'real-looking-key',HUNTER_DAILY_LIMIT:'0'}});
  assert.equal((await only.v.verify(prospect())).reason,'verifier_not_configured');assert.equal(only.calls.length,0);
});

test('Hunter: a second opinion only on an undecided Verifalia answer, its own counter, and only valid + not accept-all passes',async()=>{
  const e='editor@pub.example',hk={HUNTER_API_KEY:'real-looking-key',HUNTER_DAILY_LIMIT:'2'};
  const second=rig({results:{[e]:{classification:'Unknown',status:'MailboxValidationTimeout'}},envChange:hk});
  const v=await second.v.mailbox(e);assert.equal(v.provider,'hunter');assert.ok(usableVerification(v,e,now));
  assert.equal(second.state.email_verifier_usage[today],1,'Verifalia counter: its own check only');assert.equal(second.state.hunter_usage[today],1,'Hunter counts on its own budget');
  for(const r of [{status:'ServerIsCatchAll',classification:'Risky'},{classification:'Risky',status:'Success'},{classification:'Undeliverable',status:'MailboxDoesNotExist'}]){
    const f=rig({results:{[e]:r},envChange:hk});const out=await f.v.mailbox(e);
    assert.deepEqual(f.hunterCalls(),[],JSON.stringify(r));assert.equal(usableVerification(out,e,now),false);
  }
  const acceptAll=rig({results:{[e]:UNKNOWN},hunter:{[e]:{status:'accept_all',accept_all:true}},envChange:hk});
  assert.equal(usableVerification(await acceptAll.v.mailbox(e),e,now),false);assert.ok(acceptAll.state.catch_all_domains['pub.example'],'Hunter accept-all marks the domain catch-all');
  const budget=rig({results:{'a@pub.example':UNKNOWN,'b@pub.example':UNKNOWN,'c@pub.example':UNKNOWN},envChange:hk});
  for(const x of ['a','b','c'])await budget.v.mailbox(x+'@pub.example');
  assert.deepEqual(budget.hunterCalls(),['a@pub.example','b@pub.example'],'stops at its own daily budget');assert.equal(budget.state.email_verifier_usage[today],3);
  const fallback=rig({free:0,envChange:hk});const fb=await fallback.v.mailbox(e);
  assert.equal(fb.provider,'hunter');assert.deepEqual(fallback.posts(),[],'fallback when Verifalia\'s free credits are used up, never a paid Verifalia check');
  assert.equal(await fallback.v.creditsLeft(),1,'Hunter\'s remaining budget');assert.equal(await fallback.v.creditsLeft({screen:true}),0,'screening never uses Hunter');
});

test('after a server-level unknown no more credits go to that mail domain this cycle',async()=>{
  const html=editorial('editor@pub.example','submissions@pub.example');
  const down=rig({html,results:{'editor@pub.example':{classification:'Unknown',status:'SmtpConnectionTimeout'}}});
  const r=await down.v.verify(prospect());
  assert.deepEqual(down.posts(),['editor@pub.example'],'the second address on the same server is not checked');
  assert.equal(r.detail,'mailbox_unknown_server');assert.equal(publisherHold(r.detail),false,'our-side style hold: re-checked later');
  const other=await down.v.verify(prospect({id:'q',email:'submissions@pub.example'}));
  assert.equal(other.detail,'mailbox_unknown_server');assert.deepEqual(down.posts(),['editor@pub.example'],'no spend for another prospect on that domain either');
  const p=prospect();applyProof(down.state,p,r);applyProof(down.state,p,r);assert.equal(p.status,'ready','never retired for a server problem');
  // Next cycle (new verifier): the server may be back, so the other address is checked.
  const next=rig({html,state:down.state});await next.v.verify(prospect());assert.deepEqual(next.posts(),['submissions@pub.example']);
  // A mailbox-level unknown says nothing about the server: the next address is still checked.
  const box=rig({html,results:{'editor@pub.example':UNKNOWN}});await box.v.verify(prospect());
  assert.deepEqual(box.posts(),['editor@pub.example','submissions@pub.example']);
  assert.equal(serverUnknown({status:'unknown',provider_status:'DnsQueryTimeout'}),true);assert.equal(serverUnknown({status:'unknown',provider_status:'ServerIsCatchAll',catch_all:true}),false);
  assert.equal(serverUnknown({status:'unknown',provider_status:'SmtpConnectionFailure',reason:'recently_inconclusive'}),false,'a cached answer from an earlier cycle does not block the domain');
});

test('DE/AT/CH and Impressum-sourced addresses are held before any page fetch or credit unless the owner opts in',async()=>{
  for(const p of [prospect({domain:'blog.de',page_url:'https://blog.de/a/',email_source:'https://blog.de/contact/',email:'editor@blog.de'}),
    prospect({domain:'zeitung.at',page_url:'https://zeitung.at/a/',email_source:'https://zeitung.at/kontakt/',email:'editor@zeitung.at'}),
    prospect({email_source:'https://pub.example/impressum'})]){
    const f=rig();const r=await f.v.verify(p);
    assert.equal(r.detail,'jurisdiction_consent_required',p.domain);assert.equal(f.calls.length,0,'no credit, no balance call');assert.equal(f.fetched.length,0,'no page fetch');
  }
  // The only published contact sits on the Impressum page: held for that address, without a credit.
  const pages=u=>/impressum/.test(u)?editorial('editor@pub.example'):'<p>Read more on our <a href="/impressum">contact and imprint</a> page.</p>';
  const imp=rig({pages});const r=await imp.v.verify(prospect({email_source:'https://pub.example/guide/'}));
  assert.equal(r.detail,'jurisdiction_consent_required');assert.equal(imp.calls.length,0);
  const optIn=rig({pages,envChange:{OUTREACH_DACH:'YES'}});assert.equal((await optIn.v.verify(prospect({email_source:'https://pub.example/guide/'}))).ok,true);
  assert.equal(jurisdictionHold({email:'ed@verlag.ch'}),true);assert.equal(jurisdictionHold({domain:'pub.example',email:'ed@pub.example',source:'https://pub.example/contact/'}),false);
  // Publisher-side: retired after two strikes, like other publisher-side holds.
  const p=prospect();applyProof({},p,r);assert.equal(p.status,'ready');applyProof({},p,r);assert.equal(p.status,'contact_unverifiable');
});

test('catch-all holds retire on the first strike; publisher mismatch now retires after two',async()=>{
  for(const detail of ['mailbox_accept_all','catch_all_domain']){
    const p=prospect();applyProof({},p,{ok:false,reason:'no_verified_mailbox',detail});assert.equal(p.status,'contact_unverifiable',detail);
    const f=prospect({status:'sent'});applyProof({},f,{ok:false,reason:'no_verified_mailbox',detail},{followup:true});assert.equal(f.status,'sent','follow-ups keep their own rule');
  }
  const ca=rig({results:{'editor@pub.example':{status:'ServerIsCatchAll',classification:'Risky'}}});const r=await ca.v.verify(prospect());
  assert.equal(r.detail,'mailbox_accept_all');assert.deepEqual(ca.state.verify_stats.other,{n:1,valid:0,catch_all:1},'the mail host learns it was catch-all');
  const cp=prospect();applyProof(ca.state,cp,r);assert.equal(cp.status,'contact_unverifiable');
  // A catch-all first inbox with an undecided second one is not a catch-all verdict for the whole prospect.
  const mixed=rig({html:editorial('editor@pub.example','editor.pub@gmail.com'),results:{'editor@pub.example':{status:'ServerIsCatchAll',classification:'Risky'},'editor.pub@gmail.com':UNKNOWN}});
  const m=await mixed.v.verify(prospect());assert.equal(m.detail,'mailbox_unknown');const mp=prospect();applyProof({},mp,m);assert.equal(mp.status,'ready');
  const mm=rig();const mis=await mm.v.verify(prospect({page_url:'https://elsewhere.example/a'}));assert.equal(mis.detail,'publisher_mismatch');
  const q=prospect();applyProof({},q,mis);assert.equal(q.status,'ready');applyProof({},q,mis);assert.equal(q.status,'contact_unverifiable');
});

test('mail-host learning also counts catch-all answers',async()=>{
  const f=rig({results:{'editor@pub.example':{status:'ServerIsCatchAll',classification:'Risky'}}});
  await f.v.mailbox('editor@pub.example',{mxClass:'google'});await f.v.mailbox('ok@other.example',{mxClass:'google'});
  assert.deepEqual(f.state.verify_stats.google,{n:2,valid:1,catch_all:1});
});

test('ledger: every check, credit and outcome is counted per day, with emails sent from the history',async()=>{
  const e=x=>x+'@pub.example';
  const f=rig({results:{[e('b')]:{classification:'Undeliverable',status:'MailboxDoesNotExist'},[e('c')]:{status:'ServerIsCatchAll',classification:'Risky'},[e('d')]:UNKNOWN,[e('x')]:UNKNOWN},
    envChange:{HUNTER_API_KEY:'real-looking-key',HUNTER_DAILY_LIMIT:'1'},hunter:{[e('x')]:{status:'unknown',smtp_check:false}}});
  for(const x of ['a','b','c','d','x'])await f.v.mailbox(e(x));
  await f.v.mailbox(e('a')); // cached proof: no request, not counted
  await f.v.verify(prospect({email_source:'https://pub.example/impressum'})); // held for free: not counted
  assert.deepEqual(f.state.verify_ledger,[{date:today,checks:6,credits:5,valid:2,invalid:1,catch_all:1,unknown:1,hunter_checks:1,screen_only:0,emails_sent:0}]);
  const day=n=>new Date(now-n*864e5).toISOString();
  const state={...f.state,prospects:{
    s:{history:[{type:'initial',at:day(0),mode:'send',to:'editor@pub.example'},{type:'followup',at:day(0),mode:'send'},{type:'initial',at:day(0),mode:'draft'},{type:'reply',at:day(0)}]},
    t:{history:[{type:'initial',at:day(3),mode:'send'},{type:'initial',at:day(40),mode:'send'}]}},
    email_verifier_usage:{[day(40).slice(0,10)]:5,[today]:5},hunter_usage:{[day(31).slice(0,10)]:1}};
  state.verify_ledger.push({date:day(20).slice(0,10),checks:9,credits:9,email:'leak@pub.example'},{date:day(40).slice(0,10),checks:3,credits:3});
  const out=verifyLedger(state,{now});
  assert.deepEqual(out.ledger.map(x=>[x.date,x.credits,x.emails_sent]),[[day(3).slice(0,10),0,1],[today,5,2]],'last 14 days only');
  assert.equal(out.credits_per_email,1.67,'5 credits / 3 emails over the last 7 days');
  assert.deepEqual(state.verify_ledger.map(x=>x.date),[day(20).slice(0,10),day(3).slice(0,10),today],'30 days kept in the vault');
  assert.equal(state.verify_ledger[0].email,undefined,'only counts are kept');assert.doesNotMatch(JSON.stringify(out),/@/);
  assert.deepEqual(Object.keys(state.email_verifier_usage),[today]);assert.deepEqual(state.hunter_usage,{});
  assert.equal(verifyLedger({prospects:{}},{now}).credits_per_email,null,'no emails: no ratio');
});
