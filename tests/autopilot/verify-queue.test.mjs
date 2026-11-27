import test from 'node:test';
import assert from 'node:assert/strict';
import {preverify,creditValue,gmailTransport,applyProof} from '../../scripts/autopilot/outreach.mjs';
import {RecipientVerifier,verifaliaVerdict,usableVerification} from '../../scripts/autopilot/recipient-policy.mjs';

const iso=ms=>new Date(ms).toISOString();
const mk=(id,extra={})=>({id,status:'ready',email:`editor@${id}.com`,domain:`${id}.com`,page_url:`https://${id}.com/a`,qv:2,score:60,history:[],...extra});
const proofFor=p=>({ok:true,email:p.email,evidence:{source:`https://${p.domain}/contact/`,email:p.email,rank:95,observed_at:iso(Date.now())},
  verification:verifaliaVerdict({inputData:p.email,emailAddress:p.email,classification:'Deliverable',status:'Success',isDisposableEmailAddress:false},p.email,Date.now())});
/** A mailer that records what was asked; `answer(p,o)` decides the result (default: verified). */
const recorder=({answer=p=>proofFor(p),credits,screen}={})=>{const asked=[];return {asked,mailer:{
  authorizeRecipient:async(p,o)=>{asked.push((o.followup?'fu:':'')+p.id);return answer(p,o)},
  ...(credits?{verifierCredits:async o=>credits(o)}:{}),
  ...(screen?{prescreenRecipient:async p=>{asked.push('screen:'+p.id);return screen(p)}}:{})}}};

test('due follow-ups are verified first (followup:true), then new prospects',async()=>{
  const at=Date.parse('2026-11-25T05:00:00Z'); // Wednesday: EU window opens 07:00, US 13:00
  const state={prospects:{
    n1:mk('n1',{score:95}),n2:mk('n2',{score:90}),
    fu:mk('fu',{status:'sent',domain:'fu.co.uk',email:'editor@fu.co.uk',history:[{type:'initial',at:iso(at-7*864e5),mode:'send',to:'editor@fu.co.uk'}]}),
    early:mk('early',{status:'sent',history:[{type:'initial',at:iso(at-2*864e5),mode:'send'}]}), // not due for days
    replied:mk('replied',{status:'sent',replied_at:iso(at),history:[{type:'initial',at:iso(at-9*864e5),mode:'send'}]})}};
  const {asked,mailer}=recorder();
  const r=await preverify({state,mailer,max:5,now:()=>new Date(at)});
  assert.deepEqual(asked,['fu:fu','n1','n2']);assert.equal(r.followups_checked,1);assert.equal(r.followups_verified,1);
  assert.equal(state.prospects.fu.status,'sent','a follow-up proof never changes the conversation');assert.ok(usableVerification(state.prospects.fu.recipient_proof.verification,'editor@fu.co.uk'));
  const off=recorder();state.prospects.fu.recipient_proof=undefined;
  await preverify({state:{prospects:{fu:state.prospects.fu}},mailer:off.mailer,max:5,followups:false,now:()=>new Date(at)});
  assert.deepEqual(off.asked,[],'no follow-up proofs while follow-ups are not being sent');
});

test('checking stops once proofs fill the day\'s remaining sending capacity',async()=>{
  const at=Date.parse('2026-11-25T05:00:00Z');
  const fresh=()=>({prospects:{a:mk('a',{score:99}),b:mk('b',{score:90}),c:mk('c',{score:80})}});
  let s=fresh(),{asked,mailer}=recorder();
  const r=await preverify({state:s,mailer,max:10,cap:2,now:()=>new Date(at)});
  assert.deepEqual(asked,['a','b']);assert.equal(r.capacity_full,1,'a third proof would expire unused');
  // Proofs already in hand count, and so do today's sends.
  s=fresh();s.prospects.a.recipient_proof=proofFor(s.prospects.a);s.prospects.sent=mk('sent',{status:'sent',history:[{type:'initial',at:iso(at-3600e3),mode:'send'}]});
  ({asked,mailer}=recorder());await preverify({state:s,mailer,max:10,cap:3,now:()=>new Date(at)});
  assert.deepEqual(asked,['b'],'cap 3 - 1 sent today - 1 proof in hand = 1 more');
  // A failed check does not use up a slot.
  s=fresh();({asked,mailer}=recorder({answer:p=>p.id==='a'?{ok:false,reason:'no_verified_mailbox',detail:'mailbox_unknown'}:proofFor(p)}));
  await preverify({state:s,mailer,max:10,cap:1,now:()=>new Date(at)});assert.deepEqual(asked,['a','b']);
  // Today full (cap reached): plan for tomorrow's window, if it is within the horizon.
  s=fresh();s.prospects.x=mk('x',{status:'sent',history:[1,2].map(i=>({type:'initial',at:iso(Date.parse('2026-11-25T14:00:00Z')-i*60e3),mode:'send'}))});
  ({asked,mailer}=recorder());const late=await preverify({state:s,mailer,max:10,cap:2,now:()=>new Date('2026-11-25T15:00:00Z')});
  assert.deepEqual(asked,[],'US inboxes open again tomorrow 13:00 (22 h away): a proof bought now would expire');assert.equal(late.capacity_full,3);
  s=fresh();for(const p of Object.values(s.prospects)){p.domain=p.id+'.co.uk';p.email=`editor@${p.domain}`}
  s.prospects.x=mk('x',{status:'sent',history:[1,2].map(i=>({type:'initial',at:iso(Date.parse('2026-11-25T14:00:00Z')-i*60e3),mode:'send'}))});
  ({asked,mailer}=recorder());await preverify({state:s,mailer,max:10,cap:2,now:()=>new Date('2026-11-25T15:00:00Z')});
  assert.deepEqual(asked,['a','b'],'EU inboxes: tomorrow 07:00 is within the horizon and tomorrow has a fresh cap');
});

test('a follow-up due later today keeps a credit reserved',async()=>{
  const at=Date.parse('2026-11-25T00:30:00Z'); // horizon ends 20:30; the follow-up is due 20:45 (US window open until 21:00)
  const state={prospects:{n:mk('n'),fu:mk('fu',{status:'sent',history:[{type:'initial',at:'2026-11-19T20:45:00.000Z',mode:'send'}]})}};
  let {asked,mailer}=recorder({credits:()=>1});
  let r=await preverify({state,mailer,max:5,now:()=>new Date(at)});
  assert.deepEqual(asked,[],'the last credit is kept for the follow-up');assert.equal(r.reserved_for_followups,1);assert.equal(r.out_of_credits,true);
  ({asked,mailer}=recorder({credits:()=>2}));r=await preverify({state,mailer,max:5,now:()=>new Date(at)});
  assert.deepEqual(asked,['n']);
  // Three hours later the follow-up is inside the horizon and is verified first.
  ({asked,mailer}=recorder({credits:()=>2}));await preverify({state,mailer,max:5,now:()=>new Date(at+3*3600e3)});
  assert.deepEqual(asked,['fu:fu']);
});

test('weekend: leftover credits screen the queue, and a screen never becomes a send proof',async()=>{
  const sat=Date.parse('2026-11-28T10:00:00Z');
  const state={prospects:{a:mk('a',{score:40}),b:mk('b'),c:mk('c'),d:mk('d'),e:mk('e'),fu:mk('fu',{status:'sent',history:[{type:'initial',at:iso(sat-8*864e5),mode:'send'}]})}};
  const results={a:{ok:false,reason:'screen_only',screened:'valid',email:'editor@a.com'},b:{ok:false,reason:'screen_only',screened:'invalid',detail:'mailbox_invalid'},
    c:{ok:false,reason:'screen_only',screened:'catch_all',detail:'mailbox_accept_all'},d:{ok:false,reason:'screen_only',screened:'unknown',detail:'mailbox_verification_unavailable'},
    e:{ok:false,reason:'jurisdiction_consent_required',detail:'jurisdiction_consent_required'}};
  const {asked,mailer}=recorder({screen:p=>results[p.id],credits:o=>o.screen?10:10});
  const r=await preverify({state,mailer,max:10,now:()=>new Date(sat)});
  assert.ok(asked.every(x=>x.startsWith('screen:')),'no send-proof check on a Saturday');assert.ok(!asked.includes('screen:fu'),'follow-ups are not screened');
  const {a,b,c,d,e}=state.prospects;
  assert.equal(a.prescreen.result,'valid');assert.equal(a.status,'ready');assert.equal(a.recipient_proof,undefined);assert.equal(a.contact_quality,undefined);
  assert.equal(b.status,'contact_unverifiable');assert.equal(c.status,'contact_unverifiable');assert.equal(d.prescreen,undefined,'no answer: screened again later');
  assert.deepEqual([e.status,e.contact_quality.detail,e.prescreen],['ready','jurisdiction_consent_required',undefined],'a free rule failed before any check: an ordinary hold');
  assert.deepEqual([r.screened,r.prescreen_valid,r.prescreen_retired,r.checked],[3,1,2,0]);
  // Monday: the screened inbox ranks first in its window, and still needs a fresh, real check before any send.
  assert.ok(creditValue({},a,50,sat)>creditValue({},mk('x'),100,sat));
  const mon=recorder();await preverify({state:{prospects:{a,x:mk('x',{score:90})}},mailer:mon.mailer,max:1,now:()=>new Date('2026-11-30T05:00:00Z')});
  assert.deepEqual(mon.asked,['a']);
  // Nothing screened again within a week, and nothing without credits.
  const again=recorder({screen:p=>results[p.id]});await preverify({state:{prospects:{a}},mailer:again.mailer,max:5,now:()=>new Date(sat+3600e3)});assert.deepEqual(again.asked,[]);
  const broke=recorder({screen:p=>results[p.id],credits:()=>0});const br=await preverify({state:{prospects:{x:mk('x')}},mailer:broke.mailer,max:5,now:()=>new Date(sat)});
  assert.deepEqual(broke.asked,[]);assert.equal(br.out_of_credits,true);
});

test('screening runs only when the credits would otherwise expire',async()=>{
  const state=()=>({prospects:{a:mk('a'),uk:mk('uk',{domain:'uk.co.uk',email:'editor@uk.co.uk'})}});
  for(const [when,expect] of [['2026-11-27T22:00:00Z',['screen:a','screen:uk']],['2026-11-29T09:00:00Z',[]],['2026-11-29T12:00:00Z',['uk']]]){
    const {asked,mailer}=recorder({screen:()=>({ok:false,reason:'screen_only',screened:'valid'})});
    await preverify({state:state(),mailer,max:5,now:()=>new Date(when)});
    assert.deepEqual(asked.sort(),expect,when); // Friday night screens; Sunday morning saves credits for Monday; Sunday noon verifies for Monday 07:00
  }
});

test('a real weekend screen with the verifier: stored as screen-only, refused by every send gate, re-bought before a send',async()=>{
  const email='editor@pub.example',calls=[];let now=Date.parse('2026-11-28T10:00:00Z');
  const state={};
  const fetchImpl=async(u,o={})=>{calls.push({u,method:o.method||'GET'});
    if(u.endsWith('/credits/balance'))return {status:200,json:async()=>({freeCredits:20})};
    if(o.method==='POST')return {status:200,json:async()=>({overview:{id:'j',status:'Completed'},entries:{data:[{inputData:email,emailAddress:email,classification:'Deliverable',status:'Success',isDisposableEmailAddress:false}]}})};
    return {status:200,json:async()=>({})}};
  const make=()=>new RecipientVerifier({state,now:()=>now,fetchImpl,resolveMx:async()=>[{exchange:'mx.pub.example'}],
    env:{EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:'25',VERIFALIA_USERNAME:'u',VERIFALIA_PASSWORD:'p',HUNTER_API_KEY:'real-looking-key',HUNTER_DAILY_LIMIT:'5'},
    fetchPage:async u=>({status:200,url:u,body:`<h1>Editorial inquiries</h1><a href="mailto:${email}">Editor</a>`})});
  const p={id:'p',domain:'pub.example',page_url:'https://pub.example/guide/',email_source:'https://pub.example/contact/',email,status:'ready',history:[]};
  const r=await make().verify(p,{prescreen:true});
  assert.equal(r.ok,false);assert.equal(r.screened,'valid');assert.equal(r.verification,undefined);
  assert.equal(applyProof(state,p,{...r,ok:true}),false,'even a forged ok cannot pass without a usable verification');
  const stored=Object.values(state.email_verifications)[0];assert.equal(stored.screen_only,true);assert.equal(usableVerification(stored,email,now),false);
  assert.equal(calls.filter(c=>c.u.includes('hunter')).length,0,'screening never spends Hunter budget');
  assert.deepEqual(state.verify_ledger.map(x=>[x.checks,x.credits,x.screen_only,x.valid]),[[1,1,1,1]]);
  // The SMTP gate refuses it too: the same verdict made a minute ago on the real clock is refused only because it is a screen.
  const fresh={...stored,checked_at:new Date(Date.now()-60e3).toISOString(),expires_at:new Date(Date.now()-60e3+864e5).toISOString()};
  assert.equal(usableVerification({...fresh,screen_only:undefined},email),true);assert.equal(usableVerification(fresh,email),false);
  const transport=gmailTransport({GMAIL_ADDRESS:'me@example.com',GMAIL_APP_PASSWORD:'not-real'});
  await assert.rejects(transport.send({to:email,raw:'x',recipientProof:{email,verification:fresh,evidence:{source:'https://pub.example/contact/'},publisher_domain:'pub.example'}}),/SMTP blocked/);
  // Sunday 22 h later, still under 24 h: the cached screen is not reused; a fresh check is bought and that one is a proof.
  now+=22*3600e3;const posts=calls.filter(c=>c.method==='POST').length;
  const real=await make().verify(p);assert.equal(real.ok,true);assert.equal(calls.filter(c=>c.method==='POST').length,posts+1);
  assert.equal(real.verification.screen_only,undefined);assert.ok(usableVerification(real.verification,email,now));
});

test('existing catch-all holds leave the ready queue at once',async()=>{
  const t=iso(Date.now()),state={prospects:{a:mk('a',{contact_quality:{status:'held',detail:'catch_all_domain',checked_at:t}}),b:mk('b',{contact_quality:{status:'held',detail:'mailbox_accept_all',checked_at:t}}),
    c:mk('c',{contact_quality:{status:'held',detail:'mailbox_unknown',checked_at:t}})}};
  const {mailer}=recorder();const r=await preverify({state,mailer,max:0,now:()=>new Date('2026-11-25T05:00:00Z')});
  assert.equal(r.catch_all_retired,2);assert.deepEqual(Object.values(state.prospects).map(p=>p.status),['contact_unverifiable','contact_unverifiable','ready']);
});
