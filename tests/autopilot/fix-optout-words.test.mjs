// Review fixes for opt-out reading: the answers the closing sentence invites ("please don't follow up", "thanks, but no",
// "no deal", "not relevant"), a yes that mentions "not a fit" for a part of the page, and stored replies read again with
// the current rules (safety F2, F5; coverage F1, F4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyReply} from '../../scripts/autopilot/mail.mjs';
import {OPT_OUT} from '../../scripts/autopilot/pitch.mjs';
import {processReplies,checkLinks} from '../../scripts/autopilot/outreach.mjs';
import {answerReplies} from '../../scripts/autopilot/replies.mjs';
import {hunterVerdict,isSuppressed} from '../../scripts/autopilot/recipient-policy.mjs';

const iso=(ms=Date.now())=>new Date(ms).toISOString(),older=(d=8)=>iso(Date.now()-d*864e5);
const MID='<lf-ow1@owned.example>',ASSET={url:'https://owned.example/tool/',title:'Shoe Finder',description:'Matches runners to shoes.'};
const c=body=>classifyReply({from:'ed@pub.example',subject:'Re: Resource for your page',body});
const quoted=body=>`${body}\n\nOn Tue, 24 Nov 2026 at 10:00, Alex <owner@gmail.com> wrote:\n> Would you consider adding Shoe Finder?\n> ${OPT_OUT}`;
const conv=(extra={})=>({id:'a',site:'owned.example',domain:'pub.example',page_url:'https://pub.example/r/',email:'ed@pub.example',status:'sent',qv:99,asset_url:ASSET.url,asset_title:'Shoe Finder',
  exchange:{partner_site:'other.example',partner_page:'https://other.example/x/',partner_title:'Marathon recovery',their_url:'https://pub.example/r/',their_title:'R',status:'offered',offered_at:older(3),via:'email'},
  history:[{type:'initial',mode:'send',to:'ed@pub.example',at:older(3),message_id:MID,sender_name:'Alex',subject:'Resource for your page'}],...extra});
const inbox=(...msgs)=>({recentHeaders:async()=>Object.assign(msgs,{complete:true,cursor:{mailbox:'x',uidvalidity:'1',uid:msgs.length}})});
const msg=body=>({uid:'5',messageId:`<r${Math.random().toString(36).slice(2)}@pub.example>`,from:'ed@pub.example',subject:'Re: Resource for your page',date:new Date().toUTCString(),inReplyTo:MID,references:MID,autoSubmitted:'',body});
function proof(q){const t=Date.now(),email=q.email;return {ok:true,email,evidence:{source:`https://${q.domain}/contact/`,email,rank:95,observed_at:iso(t)},
  verification:hunterVerdict({data:{email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},email,t)}}
const transport=()=>{const m={drafts:[],sent:[]};m.draft=async r=>{m.drafts.push(r)};m.send=async x=>{m.sent.push(x)};m.authorizeRecipient=async q=>proof(q);return m};
const ready=state=>Object.assign(state,{reply_health:{status:'ok',checked_at:iso()},sent_reconciled_at:iso()});
const CFG={replyMode:'draft',mode:'send',fromAddress:'me@owned.example',senderName:'Sam'};

test('safety F2 / coverage F4: the refusals the closing sentence invites are opt-outs, in their own words or above our quoted email',()=>{
  for(const b of ["Please don't follow up.",'Hi Alex, please don\'t follow up.','No need to follow up, thanks.',"You don't need to follow up.",'Do not follow up please.','No follow up please.',
    'Thanks, but no.','Thanks but no.','Thanks but no thanks.','No deal.','No deal, sorry.','No swap, sorry.','Not for me.','Not for me, thanks.','Nah, not for me.','Pass.','Pass, thanks.',
    'No interest.','Not relevant, sorry.','Sorry, this isn\'t relevant to our readers.','Not suitable, thanks.','Not a good match for us.','Not a great fit for us right now.',
    "Doesn't suit our audience.","It's not really a fit.",'Not quite the right fit.'])
    {assert.equal(c(b),'negative',b);assert.equal(c(quoted(b)),'negative',`${b} (quoted pitch below)`)}
  // Our own sentence (quoted without markers) and the old P.S. are never their opt-out; "no problem" and "No?" are not refusals.
  for(const [b,k] of [[`Sure!\n\n${OPT_OUT}`,'positive'],['Sure! Not relevant for you? Just reply "no" and I won\'t email again.','positive'],['No problem, added it.','positive'],
    ['Sure, no worries!','positive'],['Is there a fee? No? Then sure.','neutral'],['Thanks, I will take a look next week.','neutral'],[quoted('Thanks for the note.'),'neutral']])assert.equal(c(b),k,b);
});

test('coverage F1: a yes that says a part of the page is "not a fit" is not an opt-out; with no yes it still is',()=>{
  for(const b of ["Done, I added it. It doesn't fit the intro so it's in the resources list."])assert.equal(c(b),'positive',b);
  for(const b of ["Thanks! It's not a fit for the intro, but I've added it to the resources section.",'Sure, happy to add it. Not a fit in the first paragraph, so I put it lower down.'])
    assert.equal(c(b),'neutral',`${b}: left to the owner, never suppressed`);
  for(const b of ['Not a fit, thanks.',"It's not a fit for us.","It doesn't fit our page.",'Not a fit for us after all.'])assert.equal(c(b),'negative',b);
  // A deal refused but a yes to the link ("no swap needed") stays a yes; the exchange is declined separately (exchangeIntent).
  assert.equal(c('Happy to add it, no swap needed.'),'positive');assert.equal(c('Happy to add it. No swap, though.'),'positive');
});

test('coverage F1 end to end: the publisher who placed the link "lower down" is not suppressed; the link is honoured and the return link owed',async()=>{
  const p=conv(),state={prospects:{a:p},suppression:{},contacted:{'pub.example':older(3)}};
  await processReplies({state,imap:inbox(msg("Thanks! It's not a fit for the intro, but I've added it to the resources section."))});
  assert.notEqual(p.status,'declined');assert.ok(!isSuppressed(state,'ed@pub.example','pub.example'));assert.notEqual(p.exchange.status,'declined');
  p.next_link_check=null;
  const fetchImpl=async()=>new Response('<html><body><main><p>Resources: <a href="https://owned.example/tool/">Shoe finder</a></p></main></body></html>',{status:200,headers:{'content-type':'text/html'}});
  const r=await checkLinks({state,ourDomains:['owned.example'],fetchImpl});
  assert.equal(r.won,1);assert.equal(p.exchange.status,'their_link_live');
});

test('safety F2 end to end: "please don\'t follow up" and "no deal" suppress the publisher, decline the open offer and get no answer',async()=>{
  for(const b of ["Please don't follow up.",'No need to follow up, thanks.','Thanks, but no.','No deal.']){
    const p=conv(),state={prospects:{a:p},suppression:{},contacted:{'pub.example':older(3)}};
    await processReplies({state,imap:inbox(msg(b))});
    assert.equal(p.status,'declined',b);assert.ok(isSuppressed(state,'ed@pub.example','pub.example'),b);assert.ok(state.suppression['pub.example'],b);assert.equal(p.exchange.status,'declined',b);
    const m=transport(),a=await answerReplies({state:ready(state),mailer:m,assets:[ASSET],config:CFG});
    assert.equal(a.drafted+a.sent,0,b);assert.equal(m.drafts.length,0,b);
  }
});

test('safety F5: replies stored under the earlier rules are read again once (reply_class_v4), also in a vault that already ran v3',async()=>{
  const p=conv({status:'replied',awaiting_us:true});
  p.history.push({type:'reply',at:older(2),from:'ed@pub.example',sentiment:'neutral',question:false,message_id:'<old@pub.example>',subject:'Re: x',excerpt:"Thanks Alex, but this isn't a fit."});
  const state={prospects:{a:p},suppression:{},contacted:{},migrations:{reply_status_v2:older(30),reply_class_v3:older(30)}},logs=[];
  await processReplies({state,imap:inbox(),log:x=>logs.push(x)});
  assert.equal(p.history.at(-1).sentiment,'negative');assert.equal(p.status,'declined');assert.ok(state.suppression['pub.example']);assert.equal(p.exchange.status,'declined');
  assert.ok(state.migrations.reply_class_v4);assert.ok(logs.some(l=>/1 earlier replies re-read as opt-outs/.test(l)));
  // Once only: a later cycle does not read them again.
  const again=[];await processReplies({state,imap:inbox(),log:x=>again.push(x)});assert.ok(!again.some(l=>/re-read/.test(l)));
});

test('safety F5: answerReplies reads a stored reply again before its "already answered" skip, so a draft waiting for the owner is withdrawn from the queue',async()=>{
  const p=conv({status:'replied',awaiting_us:true}),reply={type:'reply',at:older(1),from:'ed@pub.example',sentiment:'neutral',question:false,message_id:'<w1@pub.example>',subject:'Re: x',excerpt:'Please do not follow up.'};
  p.history.push(reply);p.reply_draft={for:'<w1@pub.example>',at:older(1),mode:'draft'};
  const state=ready({prospects:{a:p},suppression:{},contacted:{}}),m=transport(),r=await answerReplies({state,mailer:m,assets:[ASSET],config:CFG});
  assert.equal(r.opt_outs_reread,1);assert.equal(p.status,'declined');assert.equal(p.awaiting_us,false);assert.ok(state.suppression['pub.example']);assert.equal(m.drafts.length,0);
});

test('a no-reply or help-desk sender that relays an opt-out is honoured; a refusal on its own first line is one too',()=>{
  const m=(from,subject,body)=>classifyReply({from,subject,body});
  assert.equal(m('notifications@helpdesk.example','Re: Resource for your page','Please remove us from your list.'),'negative');
  assert.equal(m('noreply@pub.example','Thanks for contacting us','We received your message.'),'auto');
  // An acknowledgement subject over a person's question is their question, not a machine's receipt.
  assert.equal(m('ed@pub.example','Thank you for contacting us','We received your message. What would the link back look like?'),'neutral');
  for(const b of ['No need, thanks.','Not now.','Not right now, thanks.','Not at the moment.','Hi Alex,\nNot now, maybe next year.\nJane'])assert.equal(c(b),'negative',b);
  for(const b of ['No need to link back, happy to add it.','Not now, but I added it to the page anyway!'])assert.notEqual(c(b),'negative',b);
});

test('a relayed "not a fit" from a help-desk address is an opt-out too; a form acknowledgement quoting our closing sentence is not',()=>{
  assert.equal(classifyReply({from:'notifications@helpdesk.example',subject:'Re: Resource',body:'Not a fit for us, thanks.'}),'negative');
  assert.equal(classifyReply({from:'wordpress@pub.example',subject:'Your message',body:`Thanks, we got your message:\n\nWould you consider adding Shoe Finder? ${OPT_OUT}`}),'auto');
});
