import test from 'node:test';
import assert from 'node:assert/strict';
import {processReplies,checkLinks,reconcileSent} from '../../scripts/autopilot/outreach.mjs';
import {classifyReply,replyCondition} from '../../scripts/autopilot/mail.mjs';
import {answerReplies,answerProblem} from '../../scripts/autopilot/replies.mjs';
import {replySignals} from '../../scripts/autopilot/health.mjs';
import {hunterVerdict,isSuppressed} from '../../scripts/autopilot/recipient-policy.mjs';
import {funnel} from '../../scripts/autopilot/run.mjs';

const iso=(ms=Date.now())=>new Date(ms).toISOString(),older=(d=8)=>iso(Date.now()-d*864e5);
const MID='<lf-1@owned.example>';
const ASSET={url:'https://owned.example/tool/',title:'Tool',description:''};
const conv=(extra={})=>({id:'a',site:'owned.example',domain:'pub.example',page_url:'https://pub.example/r/',email:'ed@pub.example',author:'Jane Doe',status:'sent',asset_url:ASSET.url,asset_title:'Tool',qv:99,
  last_subject:'Resource for your running page',
  history:[{type:'initial',mode:'send',to:'ed@pub.example',at:older(3),message_id:MID,sender_name:'Alex',subject:'Resource for your running page'}],...extra});
const inbox=(...msgs)=>({recentHeaders:async()=>Object.assign(msgs,{complete:true,cursor:{mailbox:'x',uidvalidity:'1',uid:msgs.length}})});
const msg=(body,extra={})=>({uid:'5',messageId:`<r${Math.random().toString(36).slice(2)}@pub.example>`,from:'ed@pub.example',subject:'Re: Resource for your running page',
  date:new Date().toUTCString(),inReplyTo:MID,references:MID,autoSubmitted:'',body,...extra});
function proof(q){const t=Date.now(),email=q.email;return {ok:true,email,evidence:{source:`https://${q.domain}/contact/`,email,rank:95,observed_at:iso(t)},
  verification:hunterVerdict({data:{email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},email,t)}}
const transport=()=>{const m={drafts:[],sent:[]};m.draft=async r=>{m.drafts.push(r)};m.send=async x=>{m.sent.push(x)};m.authorizeRecipient=async q=>proof(q);return m};
const sendCfg={replyMode:'send',mode:'send',fromAddress:'me@owned.example',senderName:'Sam'};
const ready=state=>Object.assign(state,{reply_health:{status:'ok',checked_at:iso()},sent_reconciled_at:iso()});

test('F1: "no" with a signature, "no, thanks", "remove us", "opt me out" and similar are opt-outs; a negated yes is never positive',()=>{
  const c=body=>classifyReply({from:'ed@pub.example',subject:'Re: Resource',body});
  for(const b of ['No\r\n\r\nSent from my iPhone','No.\r\n\r\n--\r\nJane Doe\r\nEditor, Pub','No, thanks.','STOP\r\n\r\nSent from my iPhone','Hi Alex,\n\nNo.\n\nBest, Jane','Hi Alex, no thanks.',
    'Please remove us from your list.','Take us off your mailing list','Please stop sending us these emails','Opt me out',"We'll pass. Please don't send further emails.",
    'We have never linked to commercial sites','Nope','No Sent from my iPhone'])assert.equal(c(b),'negative',b);
  // Not opt-outs: "no problem", a delay, or a yes. A negated "linked/added" is never positive.
  for(const [b,k] of [['No problem, I added it!','positive'],['Sure, happy to add it.','positive'],['I haven\'t added it yet, will look next week','neutral'],
    ['Of course not.','neutral'],['Yes, but we don\'t link to commercial sites.','neutral'],['I can\'t add it until Monday.','neutral'],['Thanks, I will review it next week.','neutral']])assert.equal(c(b),k,b);
  // Quoted text (our own P.S. says 'reply "no"') is still never read.
  assert.equal(c('Thanks!\n\nOn Mon, Nov 23, 2026 at 8:39 PM Alex <a@b.com> wrote:\n> Not relevant? Just reply "no".'),'neutral');
});

test('F1: a signed "No" is suppressed and declined, and REPLY_MODE=send never emails it; a neutral reply is never auto-answered',async()=>{
  const p=conv(),state={prospects:{a:p},suppression:{},contacted:{'pub.example':older(3)}};
  const r=await processReplies({state,imap:inbox(msg('No\r\n\r\nSent from my iPhone'))});
  assert.equal(r.negative,1);assert.equal(p.status,'declined');assert.equal(p.awaiting_us,false);assert.ok(isSuppressed(state,'ed@pub.example','pub.example'));
  const m=transport();const a=await answerReplies({state:ready(state),mailer:m,assets:[ASSET],config:sendCfg});
  assert.equal(a.sent+a.drafted,0);assert.equal(m.sent.length,0);
  // A neutral reply from a verified address gets a draft only, never an automatic email.
  const q=conv({status:'replied',awaiting_us:true}),s2=ready({prospects:{a:q},suppression:{},contacted:{}});
  q.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'neutral',question:false,message_id:'<t1@pub.example>',in_reply_to:MID,subject:'Re: Resource for your running page',excerpt:'Thanks for getting in touch.'});
  const m2=transport();const b=await answerReplies({state:s2,mailer:m2,assets:[ASSET],config:sendCfg});
  assert.equal(b.sent,0);assert.equal(m2.sent.length,0);assert.equal(b.drafted,1);assert.equal(q.reply_draft.reason,'not_positive');
});

test('F1/F6: replies stored under the old rules are read again once: hidden opt-outs are suppressed, missed fees flag the owner',async()=>{
  const optOut=conv({status:'replied',awaiting_us:true});
  optOut.history.push({type:'reply',at:older(1),from:'ed@pub.example',sentiment:'neutral',question:false,message_id:'<o1@pub.example>',subject:'Re: x',excerpt:'No Sent from my iPhone'});
  const fee=conv({id:'b',domain:'fee.example',email:'ed@fee.example',status:'positive',awaiting_us:true});
  fee.history.push({type:'reply',at:older(5),from:'ed@fee.example',sentiment:'positive',question:false,message_id:'<f1@fee.example>',subject:'Re: x',excerpt:'Sure, we can add it. Our fees start at 50 EUR.'});
  const state={prospects:{a:optOut,b:fee},suppression:{},contacted:{},migrations:{reply_status_v2:older(1)}},logs=[];
  await processReplies({state,imap:inbox(),log:m=>logs.push(m)});
  assert.equal(optOut.status,'declined');assert.ok(isSuppressed(state,'ed@pub.example','pub.example'));assert.equal(optOut.history.at(-1).sentiment,'negative');
  assert.equal(fee.needs_owner,true);assert.equal(fee.condition,'paid');assert.equal(fee.history.at(-1).condition,'paid');
  assert.ok(state.migrations.reply_class_v3);assert.ok(logs.some(l=>/1 earlier replies re-read as opt-outs.*1 as replies with a condition/.test(l)));
  // The fee reply gets no draft and no automatic email, only the owner flag.
  const m=transport();const r=await answerReplies({state:ready(state),mailer:m,assets:[ASSET],config:sendCfg});
  assert.equal(m.drafts.length+m.sent.length,0);assert.equal(r.owner_needed,1);assert.equal(fee.reply_draft.reason,'paid_placement');
});

test('F6: an answer is never written from a stale condition, even before the one-time repair ran',async()=>{
  const p=conv({status:'positive',awaiting_us:true});
  p.history.push({type:'reply',at:older(5),from:'ed@pub.example',sentiment:'positive',question:false,message_id:'<f1@pub.example>',subject:'Re: x',excerpt:'Sure, we can add it. Our fees start at 50 EUR.'});
  const state=ready({prospects:{a:p},suppression:{},contacted:{}}),m=transport();
  const r=await answerReplies({state,mailer:m,assets:[ASSET],config:{...sendCfg,replyMode:'draft'}});
  assert.equal(r.drafted,0);assert.equal(r.owner_needed,1);assert.equal(p.needs_owner,true);assert.equal(p.condition,'paid');assert.equal(m.drafts.length,0);
});

test('F4: price, cost, rate, pay, contribution and "link to our site" are conditions; a numbered reply is never auto-answered',async()=>{
  for(const [b,k] of [['Sure, the price for a dofollow link is 120.','paid'],['Yes - placement costs 80 per year.','paid'],['Sure. My rate for a link insertion is 60.','paid'],
    ['Sure, but only if you pay for it.','paid'],['Yes, for a small contribution of 50.','paid'],['Happy to, it is 40 bucks.','paid'],['We can add it if you link to our site from yours.','reciprocal'],
    ['Sure, if you add us to your resources too.','reciprocal'],['Sure, happy to add it.',null]])assert.equal(replyCondition({body:b}),k,b);
  // A positive reply with any number in it stays a draft for the owner.
  const p=conv({status:'positive',awaiting_us:true});
  p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',question:false,message_id:'<n1@pub.example>',in_reply_to:MID,subject:'Re: x',excerpt:'Sure, I will add it in 2 weeks.'});
  const m=transport();await answerReplies({state:ready({prospects:{a:p},suppression:{},contacted:{}}),mailer:m,assets:[ASSET],config:sendCfg});
  assert.equal(m.sent.length,0);assert.equal(p.reply_draft.reason,'contains_numbers');
});

test('F4: an AI answer that talks money is rejected even when our page is about prices; the exact page title is still allowed',()=>{
  const url='https://owned.example/price-tool/',facts={our_page:{title:'Price Comparison Tool',url,description:'Compare prices and costs.'},suggested_anchor:'Price Comparison Tool'};
  assert.equal(answerProblem(`That price works for us. The page is ${url} and the link text could be "Price Comparison Tool".`,{url,facts}),'mentions_money');
  assert.equal(answerProblem(`Thanks for adding it. The page is ${url} and "Price Comparison Tool" works well as the link text.`,{url,facts}),null);
  assert.equal(answerProblem(`Thanks. The cost is fine, the page is ${url}.`,{url,facts}),'mentions_money');
});

test('F3/E2E-1: an opt-out from a colleague (same domain) or from a forwarded copy declines the pitched publisher and stops the follow-up',async()=>{
  // Colleague, a new message: no ids, no reply subject.
  const p=conv(),state={prospects:{a:p},suppression:{},contacted:{'pub.example':older(8)}};
  const r=await processReplies({state,imap:inbox(msg('Please unsubscribe us and do not contact our writers again.',{from:'managing.editor@pub.example',subject:'Your emails',inReplyTo:'',references:''}))});
  assert.equal(r.negative,1);assert.equal(p.status,'declined');assert.equal(p.no_followup,true);
  for(const k of ['pub.example','ed@pub.example','managing.editor@pub.example'])assert.ok(state.suppression[k],k);
  // Forwarded copy answered from a personal gmail: the quoted header names the pitched address.
  const q=conv({id:'f',domain:'fwdpub.com',email:'editor@fwdpub.com',history:[{type:'initial',mode:'send',to:'editor@fwdpub.com',at:older(4),message_id:'<lf-f@owned.example>',subject:'Shoe finder for your running resources'}]});
  const s2={prospects:{f:q},suppression:{},contacted:{'fwdpub.com':older(4)}};
  await processReplies({state:s2,imap:inbox(msg('Please remove me from your list.\n\n---------- Forwarded message ---------\nFrom: Alex <me@owned.example>\nTo: editor@fwdpub.com\nSubject: Shoe finder for your running resources',
    {from:'jane.personal@gmail.com',subject:'Re: Fwd: Shoe finder for your running resources',inReplyTo:'<CAfwd42@mail.gmail.com>',references:'<CAfwd42@mail.gmail.com>'}))});
  assert.equal(q.status,'declined');assert.ok(s2.suppression['fwdpub.com']);assert.ok(s2.suppression['jane.personal@gmail.com']);assert.ok(!s2.suppression['gmail.com'],'a webmail domain is never suppressed');
});

test('F3: an unmatched opt-out that answers our outreach suppresses its sender; unrelated newsletters are left alone; a non-negative is tied only by our subject',async()=>{
  const p=conv(),state={prospects:{a:p},suppression:{},contacted:{}};
  const r=await processReplies({state,self:'me@owned.example',imap:inbox(
    msg('Please stop.',{from:'stranger@elsewhere.example',subject:'Re: Something',inReplyTo:'',references:''}),
    msg('Great stories this week. Unsubscribe here.',{from:'news@digest.example',subject:'Weekly digest',inReplyTo:'',references:''}),
    msg('Thanks, we will add it.',{from:'other@pub.example',subject:'Hello there',inReplyTo:'',references:''}))});
  assert.equal(r.unmatched_optouts,1);assert.ok(state.suppression['stranger@elsewhere.example']);assert.ok(!state.suppression['news@digest.example']);
  assert.equal(p.status,'sent','a same-domain message about something else is not taken as a reply');
  // Same domain and our subject: it is that publisher's reply.
  await processReplies({state,imap:inbox(msg('Thanks, we will add it.',{from:'other@pub.example',subject:'Re: Resource for your running page',inReplyTo:'',references:''}))});
  assert.equal(p.status,'positive');
});

test('F3: an opt-out quoting an id restored from the Sent folder suppresses that recipient and its publisher',async()=>{
  const state={prospects:{},suppression:{},contacted:{},restored_ids:{'<lf-old@owned.example>':{to:'editor@pub.com',at:older(120)}}};
  const r=await processReplies({state,imap:inbox(msg('',{from:'fwd.box@gmail.com',subject:'unsubscribe lf-old@owned.example',inReplyTo:'',references:''}))});
  assert.equal(r.unmatched_optouts,1);for(const k of ['fwd.box@gmail.com','editor@pub.com','pub.com'])assert.ok(state.suppression[k],k);
});

test('ST-F2: a delivery notice for a later email never undoes positive, won or declined; won links are still re-checked',async()=>{
  for(const s of ['positive','won','declined','replied']){
    const p=conv({status:s,...(s==='won'?{won:{checked_at:older(20),found_at:older(30)}}:{})}),state={prospects:{a:p},suppression:{},contacted:{}};
    p.history.push({type:'answer',at:older(1),message_id:'<lf-2@owned.example>',to:'ed@pub.example',via:'send'});
    await processReplies({state,imap:inbox(msg('Delivery incomplete, will retry. <lf-2@owned.example>',{from:'mailer-daemon@googlemail.com',subject:'Delivery Status Notification (Delay)'}))});
    assert.equal(p.status,s,s);assert.equal(p.history.at(-1).type,'delivery_delay');
  }
  const w=conv({status:'won',page_url:'https://pub.example/r/',won:{checked_at:older(20),found_at:older(30)}}),state={prospects:{a:w},suppression:{},contacted:{}};
  w.history.push({type:'answer',at:older(1),message_id:'<lf-3@owned.example>',to:'ed@pub.example',via:'send'});
  await processReplies({state,imap:inbox(msg("Address not found. <lf-3@owned.example> ed@pub.example",{from:'mailer-daemon@googlemail.com',subject:'Delivery Status Notification (Failure)'}))});
  assert.equal(w.status,'won');assert.ok(state.suppression['ed@pub.example'],'the failed address is still suppressed');
  let fetched=0;await checkLinks({state,ourDomains:['owned.example'],fetchImpl:async()=>{fetched++;return new Response('<a href="https://owned.example/tool/">Tool</a>',{status:200,headers:{'content-type':'text/html'}})}});
  assert.equal(fetched,1);assert.equal(w.status,'won');assert.equal(funnel(state).won,1);
});

test('ST-F4: an automatic answer refused before DATA becomes a draft; only real drafts count as drafted',async()=>{
  const p=conv({status:'positive',awaiting_us:true});
  p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',question:false,message_id:'<p1@pub.example>',in_reply_to:MID,subject:'Re: x',excerpt:'Sure, happy to add it.'});
  const state=ready({prospects:{a:p},suppression:{},contacted:{}}),m=transport();m.send=async()=>{throw Object.assign(Error('connect ECONNRESET'),{stage:'connect',code:'ECONNRESET'})};
  const r=await answerReplies({state,mailer:m,assets:[ASSET],config:sendCfg});
  assert.equal(r.sent,0);assert.equal(r.drafted,1);assert.equal(r.send_failed,1);assert.equal(m.drafts.length,1);
  assert.equal(p.reply_draft.mode,'draft');assert.equal(p.reply_draft.reason,'send_failed_connect');assert.ok(!p.history.some(h=>h.delivery_uncertain));
  assert.deepEqual({u:replySignals(state).replies_unanswered,d:replySignals(state).replies_drafted},{u:1,d:1});
  // An uncertain automatic send (no draft) is not counted as drafted.
  p.reply_draft={for:'<p1@pub.example>',at:iso(),mode:'send',reason:'delivery_uncertain'};
  assert.equal(replySignals(state).replies_drafted,0);
});

test('F9: a failed Sent check leaves no current timestamp behind, so automatic answers stop that cycle',async()=>{
  const p=conv({status:'positive',awaiting_us:true});
  p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',question:false,message_id:'<p1@pub.example>',in_reply_to:MID,subject:'Re: x',excerpt:'Sure, happy to add it.'});
  const state=ready({prospects:{a:p},suppression:{},contacted:{}});state.sent_reconciled_at=iso(Date.now()-15*60e3);
  await assert.rejects(reconcileSent({state,imap:{sentRecipients:async()=>{throw Error('IMAP EXAMINE NO')}}}),/EXAMINE/);
  assert.equal(state.sent_reconciled_at,undefined);
  const m=transport();await answerReplies({state,mailer:m,assets:[ASSET],config:sendCfg});
  assert.equal(m.sent.length,0);assert.equal(p.reply_draft.reason,'sent_check_not_current');
});
