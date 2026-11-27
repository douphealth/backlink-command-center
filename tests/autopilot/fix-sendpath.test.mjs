import test from 'node:test';
import assert from 'node:assert/strict';
import {runOutreach,preverify,reconcileSent,screenQueue,emailedAddresses,noteBaseline} from '../../scripts/autopilot/outreach.mjs';
import {templatePitch} from '../../scripts/autopilot/pitch.mjs';
import {hunterVerdict,verifaliaVerdict} from '../../scripts/autopilot/recipient-policy.mjs';
import {QUALIFY_VERSION} from '../../scripts/autopilot/prospect.mjs';

const iso=(ms=Date.now())=>new Date(ms).toISOString(),older=d=>iso(Date.now()-d*864e5);
const site={domain:'owned.example',topic:'gardening'};
const asset={url:'https://owned.example/planner/',title:'Garden Planner',type:'interactive_tool',interactive:true,description:'Plan beds by sun and season.',reasons:[]};
const mk=(id,o={})=>({id,domain:`${id}.example`,site:'owned.example',page_url:`https://${id}.example/resources/`,title:'Garden resources',asset_url:asset.url,
  email:`editor@${id}.example`,email_source:`https://${id}.example/contact/`,qv:QUALIFY_VERSION,status:'ready',score:70,history:[],...o});
const proofOf=(q,email=q.email)=>{const t=Date.now();return {ok:true,email,evidence:{source:`https://${q.domain}/contact/`,email,rank:95,observed_at:iso(t)},
  verification:hunterVerdict({data:{email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},email,t)}};
function fixture(prospects,{state:extra={},authorize=q=>proofOf(q),config={}}={}){
  const sent=[],checks=[],state={prospects,reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{},...extra};
  const writer={write:async(p,a,s,o={})=>templatePitch(p,a,{senderName:o.senderName,site:s})};
  return {sent,checks,state,args:{state,assets:[asset],sites:[site],writer,
    mailer:{authorizeRecipient:async q=>{checks.push(q.id);return authorize(q)},send:async m=>sent.push(m.to),draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@owned.example',senderName:'Owner',gapMs:()=>0,sendWindow:false,...config}}};
}

test('F2: one person who publishes the same address on two blogs is pitched once, and no credit is spent on the second',async()=>{
  const a=mk('janes-garden',{email:'janedoe.writes@gmail.com',score:90}),b=mk('janes-kitchen',{email:'janedoe.writes@gmail.com',score:80});
  const f=fixture({a,b});
  const r=await runOutreach(f.args);
  assert.equal(r.sent,1);assert.deepEqual(f.sent,['janedoe.writes@gmail.com']);assert.equal(f.checks.length,1,'the second prospect costs no verification');
  assert.equal(b.status,'skipped_duplicate');assert.equal(r.address_already_emailed,1);assert.ok(f.state.contacted['janes-kitchen.example'],'that publisher counts as contacted too');
  // Next cycle the same: the address is in the history now.
  b.status='ready';const g=fixture({a,b},{state:{contacted:{}}});await runOutreach(g.args);assert.equal(g.sent.length,0);assert.equal(b.status,'skipped_duplicate');
});

test('F2/ST-F3: an address switched to by verification is checked again, against our records, the Sent folder and restored sends',async()=>{
  const switched=q=>proofOf(q,'jane.doe@gmail.com');
  for(const [name,extra] of [['restored_sent',{state:{restored_sent:{'jane.doe@gmail.com':older(40)}}}],['sent folder',{config:{sentIndex:new Map([['jane.doe@gmail.com',Date.now()-50*864e5]])}}]]){
    const p=mk('blog',{email:'hello@blog.example'}),f=fixture({p},{authorize:switched,...extra});
    const r=await runOutreach(f.args);
    assert.equal(f.sent.length,0,name);assert.equal(p.status,'skipped_duplicate',name);assert.equal(r.address_already_emailed,1,name);assert.ok(f.state.contacted['blog.example'],name);
  }
  // Older than the 90-day window: it may be pitched.
  const p=mk('blog',{email:'hello@blog.example'}),f=fixture({p},{authorize:switched,state:{restored_sent:{'jane.doe@gmail.com':older(120)}}});
  await runOutreach(f.args);assert.deepEqual(f.sent,['jane.doe@gmail.com']);
  // Only real sends count: a draft never blocks the address.
  assert.ok(!emailedAddresses({prospects:{x:{history:[{type:'initial',mode:'draft',to:'d@x.example',at:iso()}]}}}).has('d@x.example'));
});

test('F2: pre-verification spends no credit on an address that was already emailed',async()=>{
  const at=Date.parse('2026-11-25T05:00:00Z'),asked=[];
  const state={prospects:{a:mk('a',{email:'jane@gmail.com',domain:'a.com'}),b:mk('b',{domain:'b.com',email:'editor@b.com'}),
    sent:mk('s',{status:'sent',domain:'s.com',email:'jane@gmail.com',history:[{type:'initial',mode:'send',to:'jane@gmail.com',at:iso(at-2*864e5)}]})}};
  await preverify({state,mailer:{authorizeRecipient:async q=>{asked.push(q.id);return {ok:false,reason:'x',detail:'mailbox_unknown'}}},max:5,now:()=>new Date(at)});
  assert.deepEqual(asked,['b']);
});

test('ST-F5: a prospect the free screen just held is not verified again the same cycle (no second strike within minutes)',async()=>{
  const p=mk('held'),fail=()=>({ok:false,reason:'no_published_editorial_contact',detail:'no_email_published'});
  const state={prospects:{p},reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}};
  const s=await screenQueue({state,mailer:{screenRecipient:async()=>fail()}});
  assert.equal(s.held,1);assert.equal(p.status,'ready');assert.ok(p.screen_strike);
  const f=fixture({p},{authorize:fail});f.args.state=state;
  const r=await runOutreach(f.args);
  assert.equal(f.checks.length,0);assert.equal(r.cooling,1);assert.equal(p.status,'ready','the second look a day later decides');
});

test('F5: the Sent check reads the whole 90 days, paging past 1000 messages, and fails when it cannot',async()=>{
  const pitchAt=older(20),calls=[];
  const page1=Array.from({length:500},(_,i)=>({to:`friend${i}@x.example`,at:older(i%10)})),page2=[{to:'ed@pub.example',at:pitchAt}];
  const imap={sentRecipients:async(since,{before,max}={})=>{calls.push({since,before,max});return before?Object.assign(page2,{complete:true}):Object.assign(page1.slice(),{complete:false})}};
  const p=mk('pub',{email:'ed@pub.example'}),state={prospects:{p},contacted:{}},index=new Map();
  const r=await reconcileSent({state,imap,index});
  assert.ok(Math.abs(Date.parse(calls[0].since)-(Date.now()-90*864e5))<5e3,'90 days, not 30');assert.equal(calls.length,2,'paged back with BEFORE');
  assert.equal(r.restored,1);assert.ok(state.contacted['pub.example']);assert.equal(p.status,'sent');assert.ok(index.has('ed@pub.example'));assert.ok(state.sent_reconciled_at);
  // Truncated with no way to page back: the stage fails (nothing is sent) and no timestamp says otherwise.
  const stuck={sentRecipients:async()=>Object.assign([{to:'a@b.example',at:older(1)}],{complete:false})},s2={prospects:{},sent_reconciled_at:iso()};
  await assert.rejects(reconcileSent({state:s2,imap:stuck}),/could not be read back 90 days/);assert.equal(s2.sent_reconciled_at,undefined);
});

test('E2E-3: pre-verification buys no proof for a page that already has its 2 first emails that day',async()=>{
  const at=Date.parse('2026-11-30T05:00:00Z'),day='2026-11-30',asked=[];
  const prospects={};for(let i=0;i<6;i++)prospects['p'+i]=mk('p'+i,{domain:`p${i}.co.uk`,email:`editor@p${i}.co.uk`,score:90-i});
  const state={prospects};
  await preverify({state,mailer:{authorizeRecipient:async q=>{asked.push(q.id);return {ok:true,email:q.email,evidence:{source:`https://${q.domain}/contact/`,email:q.email,rank:95,observed_at:iso()},
    verification:verifaliaVerdict({inputData:q.email,emailAddress:q.email,classification:'Deliverable',status:'Success',isDisposableEmailAddress:false},q.email,Date.now())}}},max:10,cap:12,now:()=>new Date(at)});
  assert.equal(asked.length,2,'one page: 2 first emails a day, so 2 proofs');
  // A page that already sent 2 today gets none; another page still does.
  const s2={prospects:{done1:mk('d1',{status:'sent',history:[{type:'initial',mode:'send',at:`${day}T04:00:00Z`}]}),done2:mk('d2',{status:'sent',history:[{type:'initial',mode:'send',at:`${day}T04:10:00Z`}]}),
    q:mk('q',{domain:'q.co.uk',email:'editor@q.co.uk'}),o:mk('o',{domain:'o.co.uk',email:'editor@o.co.uk',asset_url:'https://owned.example/other/'})}},asked2=[];
  const r=await preverify({state:s2,mailer:{authorizeRecipient:async q=>{asked2.push(q.id);return {ok:false,reason:'x',detail:'mailbox_unknown'}}},max:10,cap:12,now:()=>new Date(at)});
  assert.deepEqual(asked2,['o']);assert.equal(r.asset_full,1);
});

test('COV-F5: the first real send of a page records its search demand as the baseline, once',async()=>{
  const key='https://owned.example/planner';
  const demand={[key]:{source:'dataforseo',url:asset.url,etv:120.5,keywords:40,striking:6,top3:2}};
  const f=fixture({a:mk('a')},{config:{demand}});await runOutreach(f.args);
  const b=f.state.asset_baseline?.[key];assert.ok(b,'baseline stored');assert.deepEqual({etv:b.etv,keywords:b.keywords,striking:b.striking,source:b.source},{etv:120.5,keywords:40,striking:6,source:'dataforseo'});
  assert.equal(noteBaseline(f.state,asset.url,{[key]:{source:'gsc',clicks:9}}),false,'kept from the first send');
  const d=fixture({a:mk('a')},{config:{mode:'draft',demand}});await runOutreach(d.args);assert.equal(d.state.asset_baseline,undefined,'drafts are not sends');
});

test('F2: in draft mode too, one address gets one pitch per run', async()=>{
  const a=mk('one-blog',{email:'sam.writes@gmail.com',score:90}),b=mk('two-blog',{email:'sam.writes@gmail.com',score:80});
  const drafts=[],f=fixture({a,b},{config:{mode:'draft'}});f.args.mailer.draft=async raw=>drafts.push(raw);
  const r=await runOutreach(f.args);
  assert.equal(r.drafted,1);assert.equal(drafts.length,1);assert.equal(b.status,'skipped_duplicate');
});
