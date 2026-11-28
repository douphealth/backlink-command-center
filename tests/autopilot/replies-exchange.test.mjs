// Replies to a 3-way (ABC) link exchange: acceptance without an owner flag, the owner cases (fee, guest post, a link back
// from the pitched site A or a site we did not offer), declines, and the reply answers that confirm the exact deal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {processReplies,reconcileSent} from '../../scripts/autopilot/outreach.mjs';
import {classifyReply,exchangeIntent,replyConditions,replyText,isQuestion} from '../../scripts/autopilot/mail.mjs';
import {answerReplies,answerKind,exchangeProblem,offerProblem,templateAnswer} from '../../scripts/autopilot/replies.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';
import {SITES} from '../../functions/_lib/sites.js';

const iso=(ms=Date.now())=>new Date(ms).toISOString(),older=(d=8)=>iso(Date.now()-d*864e5);
const MID='<lf-ex1@owned.example>',C=SITES[1].domain;
const OFFER={partner_site:C,partner_page:`https://${C}/plants-that-look-like-spider-plants/`,partner_title:'Plants That Look Like Spider Plants',
  their_url:'https://pub.example/r/',their_title:'Houseplant resources',score:0.8};
const ASSET={url:'https://owned.example/tool/',title:'Mouse Proofing Planner | Owned',description:'A free planner that shows which gaps to seal first, room by room.'};
const pros=(extra={})=>({id:'a',site:'owned.example',domain:'pub.example',page_url:'https://pub.example/r/',email:'ed@pub.example',author:'Jane Doe',status:'sent',qv:99,
  asset_url:ASSET.url,asset_title:'Mouse Proofing Planner',last_subject:'Resource for your page',
  exchange:{...OFFER,status:'offered',offered_at:older(3),via:'email'},
  history:[{type:'initial',mode:'send',to:'ed@pub.example',at:older(3),message_id:MID,sender_name:'Alex',subject:'Resource for your page'}],...extra});
const inbox=(...msgs)=>({recentHeaders:async()=>Object.assign(msgs,{complete:true,cursor:{mailbox:'x',uidvalidity:'1',uid:msgs.length}})});
const msg=(body,extra={})=>({uid:'5',messageId:`<r${Math.random().toString(36).slice(2)}@pub.example>`,from:'ed@pub.example',subject:'Re: Resource for your page',
  date:new Date().toUTCString(),inReplyTo:MID,references:MID,autoSubmitted:'',body,...extra});
const run=(state,...msgs)=>processReplies({state,imap:inbox(...msgs)});
const stateOf=(...ps)=>({prospects:Object.fromEntries(ps.map((p,i)=>[p.id+i,p])),suppression:{},contacted:{}});
const decode=raw=>{const i=raw.indexOf('\r\n\r\n'),head=raw.slice(0,i);return {head,body:Buffer.from(raw.slice(i+4).replace(/\r\n/g,''),'base64').toString('utf8').replace(/\r\n/g,'\n')}};
function proof(q){const t=Date.now(),email=q.email;return {ok:true,email,evidence:{source:`https://${q.domain}/contact/`,email,rank:95,observed_at:iso(t)},
  verification:hunterVerdict({data:{email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},email,t)}}
const transport=()=>{const m={drafts:[],sent:[],checks:0};m.draft=async r=>{m.drafts.push(r)};m.send=async x=>{m.sent.push(x)};m.authorizeRecipient=async q=>{m.checks++;return proof(q)};return m};
const CFG={replyMode:'draft',mode:'send',fromAddress:'me@owned.example',senderName:'Sam'};
const current=state=>Object.assign(state,{reply_health:{status:'ok',checked_at:iso()},sent_reconciled_at:iso()});
const answer=(state,m,config={},extra={})=>answerReplies({state:current(state),mailer:m,writer:null,assets:[ASSET],config:{...CFG,...config},...extra});

test('an offered 3-way exchange is accepted by a yes or by the link back we offered, with no owner flag',async()=>{
  for(const body of ['Sure, if you link back to us.','Deal.','Happy to swap, go ahead.',"We'd add it if you link back to us",'Yes, a link back from your other site works for me.',
    `Sure, a link back from ${C} is fine.`,'Sure, happy to add it.']){
    const p=pros(),state=stateOf(p);
    const r=await run(state,msg(body));
    assert.equal(p.exchange.status,'accepted',body);assert.ok(Date.parse(p.exchange.accepted_at),body);
    assert.equal(p.status,'positive',body);assert.ok(p.next_link_check,body);assert.equal(p.awaiting_us,true,body);
    assert.equal(p.needs_owner,undefined,`${body}: the owner approved ABC exchanges in advance`);assert.equal(p.condition,undefined,body);
    assert.equal(p.history.at(-1).exchange,'accepted',body);assert.equal(r.exchange_accepted,1,body);assert.equal(r.conditional,undefined,body);
  }
  // The link-back words themselves are still recorded on the reply (vault only).
  const p=pros(),state=stateOf(p);await run(state,msg('Sure, if you link back to us.'));assert.equal(p.history.at(-1).condition,'reciprocal');
});

test('a fee, a guest post, or a link back from the pitched site A or a site we did not offer still needs the owner',async()=>{
  const cases=[
    ['Sure, but only if you link back from owned.example itself.','reciprocal','counter'],
    ['Sure, but please link to us from Owned directly.','reciprocal','counter'],
    ['Yes, if the link comes from your site.','reciprocal','counter'],
    ['Yes, but I would prefer a direct link back from the same site.','reciprocal','counter'],
    ['Happy to, if you link back to us from mycoolblog.example instead.','reciprocal','counter'],
    ['Sure, we charge $50 for that.','paid',undefined],
    // A guest post (or a fee) raised next to the swap is the owner's call; the link back itself was our own offer.
    ['We accept guest posts, happy to swap.','guest_post',undefined],
  ];
  for(const [body,cond,mark] of cases){
    const p=pros(),state=stateOf(p);await run(state,msg(body));
    assert.equal(p.needs_owner,true,body);assert.equal(p.condition,cond,body);assert.equal(p.exchange.status,'offered',`${body}: not accepted while the owner decides`);
    assert.equal(p.history.at(-1).exchange,mark,body);
  }
  assert.deepEqual(replyConditions({body:'We accept guest posts, happy to swap.'}),['reciprocal','guest_post'],'both conditions are seen');
  // The answer to a guest-post ask on an open offer asks for the guidelines, never restates or confirms the swap.
  const g=pros({awaiting_us:true}),s2=stateOf(g),m=transport();await run(s2,msg('We accept guest posts, happy to swap.'));
  await answer(s2,m);assert.match(decode(m.drafts[0]).body,/contributor guidelines/);assert.equal(g.history.at(-1).kind,'guest_post');
});

test('a question about the link back keeps the offer open without an owner flag; a plain reply changes nothing',async()=>{
  const p=pros(),state=stateOf(p);await run(state,msg('Would the link back be dofollow?'));
  assert.equal(p.exchange.status,'offered');assert.equal(p.history.at(-1).exchange,'question');assert.equal(p.needs_owner,undefined);assert.equal(p.status,'replied');
  const q=pros(),s2=stateOf(q);await run(s2,msg("Thanks, I'll look at it next week."));
  assert.equal(q.exchange.status,'offered');assert.equal(q.history.at(-1).exchange,undefined);assert.equal(q.status,'replied');assert.equal(q.needs_owner,undefined);
});

test('a yes that wants nothing back declines the exchange and keeps the yes',async()=>{
  const p=pros(),state=stateOf(p);const r=await run(state,msg('Happy to add it, no need for a link back.'));
  assert.equal(p.exchange.status,'declined');assert.ok(p.exchange.declined_at);assert.equal(r.exchange_declined,1);
  assert.equal(p.status,'positive');assert.equal(p.needs_owner,undefined);assert.equal(p.history.at(-1).exchange,'declined');
  assert.ok(!state.suppression['pub.example'],'declining the exchange is not an opt-out');
  const m=transport();await answer(state,m);const body=decode(m.drafts[0]).body;
  assert.equal(p.history.at(-1).kind,'positive');assert.doesNotMatch(body,/separate site|in return|link to your article/i,'no exchange is confirmed after they declined it');
});

test('after acceptance, talk about the agreed link back is not a new condition; status only moves forward',async()=>{
  const p=pros(),state=stateOf(p);
  await run(state,msg('Deal.'));
  await run(state,msg('Great, just make sure you link back to us, thanks.'));
  assert.equal(p.history.at(-1).exchange,'agreed');assert.equal(p.needs_owner,undefined);assert.equal(p.exchange.status,'accepted');
  const won=pros({status:'won'}),s2=stateOf(won);await run(s2,msg('Sure, if you link back to us.'));
  assert.equal(won.status,'won','a won conversation stays won');assert.equal(won.exchange.status,'accepted');
});

test('an opt-out declines an open exchange and suppresses; a link they already placed is still owed',async()=>{
  const p=pros(),state=stateOf(p);
  const r=await run(state,msg('No thanks, please remove us from your list.'));
  assert.equal(r.negative,1);assert.equal(p.status,'declined');assert.equal(p.exchange.status,'declined');assert.ok(p.exchange.declined_at);
  assert.ok(state.suppression['pub.example']&&state.suppression['ed@pub.example']);
  const q=pros(),s2=stateOf(q);q.exchange.status='accepted';await run(s2,msg('Not a fit for us after all.'));assert.equal(q.exchange.status,'declined');
  const live=pros(),s3=stateOf(live);live.exchange.status='their_link_live';await run(s3,msg('Please stop emailing me.'));
  assert.equal(live.exchange.status,'their_link_live','their link is live: the return link is still owed');assert.equal(live.status,'declined');
});

test('the new closing sentence: "not a fit" answers opt out, our own conditional wording and Outlook-quoted copies do not',()=>{
  const c=body=>classifyReply({from:'a@pub.example',subject:'Re: x',body});
  for(const b of ['Not a fit, thanks.',"It's not a fit for us.","This isn't really a fit.","It doesn't fit our page.",'No'])assert.equal(c(b),'negative',b);
  assert.equal(c("If it's not a fit, just say so and I won't follow up."),'neutral','our own sentence is not their opt-out');
  const outlook="Sure, happy to add it.\r\n\r\nFrom: Alex <me@owned.example>\r\nSent: Monday, 23 November 2026 10:00\r\nTo: ed@pub.example\r\nSubject: Resource\r\n\r\nHi Jane, not a fit? Just say so.";
  assert.equal(replyText({body:outlook}),'Sure, happy to add it.');assert.equal(c(outlook),'positive');
  for(const b of ['Deal!','Agreed, go ahead.','Happy to swap.','That works for me.'])assert.equal(c(b),'positive',b);
  assert.equal(c('not happy to swap'),'neutral','a negated yes is never positive');
  assert.deepEqual(replyConditions({body:'Happy to swap.'}),['reciprocal'],'a swap is a link-back condition on a pitch without an offer');
  const intent=(b,o={})=>{const m={from:'ed@pub.example',subject:'Re: x',body:b};return exchangeIntent(m,{offer:OFFER,site:'owned.example',domain:'pub.example',sentiment:c(b),question:isQuestion(m),...o})};
  assert.equal(intent('Sure, I added the link to owned.example.'),'accept','linking to A is the deal, not a request for a link from A');
  assert.equal(intent("Sure, I'll add the link from my article to owned.example."),'accept');
  assert.equal(intent("Sure, I'll put the link on my article about Owned."),'accept');
  assert.equal(intent('Sure, but I want a link from owned.example in return, not from the other one.'),'counter');
  assert.equal(intent(`Sure, link back from ${C}, or on owned.example would be better.`),'counter','a link from A wins over naming the offered site');
  assert.equal(intent('Happy to add it, no need for a link back.'),'decline');
  assert.equal(intent('Sure, if you link back. Jane -- twitter.example/jane'),'accept','a signature is not read');
  assert.equal(intent('Thanks, will check.'),null);
});

test('a reply from an address at the domain of a contact-form prospect is recorded on it when nothing else matches',async()=>{
  const prepared=older(2);
  const form=(extra={})=>({id:'f',site:'owned.example',domain:'form.example',page_url:'https://form.example/p/',status:'form_ready',asset_url:ASSET.url,
    form_message:{subject:'Resource',body:'...',form_url:'https://form.example/contact/',at:prepared,variant:'template:pitch'},history:[],...extra});
  const f=form(),other=pros(),state=stateOf(f,other);
  const r=await run(state,msg('Sure, happy to add it.',{from:'jane@form.example',inReplyTo:'',references:'',subject:'Your message'}));
  assert.equal(r.replies,1);assert.equal(r.form_replies,1);assert.equal(r.matched_indirectly,undefined);
  assert.equal(f.status,'positive');assert.equal(f.awaiting_us,true);assert.equal(f.history.at(-1).type,'reply');assert.equal(f.history.at(-1).from,'jane@form.example');
  assert.equal(other.history.length,1,'the emailed prospect is untouched');
  // The answer is a draft to whoever wrote: nobody at that publisher was emailed or verified, so nothing goes out by itself.
  const fm=transport();const fr=await answer(state,fm,{replyMode:'send'});
  assert.equal(fm.sent.length,0);assert.equal(fr.drafted,1);assert.match(decode(fm.drafts[0]).head,/To: <jane@form\.example>/);assert.equal(f.reply_draft.reason,'different_address');
  // A subdomain address matches too; an unrelated domain, an earlier message and an automatic reply do not.
  const g=form(),s2=stateOf(g);await run(s2,msg('Thanks, will review.',{from:'ed@mail.form.example',inReplyTo:'',references:''}));assert.equal(g.status,'replied');
  const h=form(),s3=stateOf(h);
  await run(s3,msg('Sure!',{from:'ed@elsewhere.example',inReplyTo:'',references:''}),msg('Sure!',{from:'ed@form.example',inReplyTo:'',references:'',date:new Date(Date.now()-5*864e5).toUTCString()}),
    msg('I am out of office',{from:'ed@form.example',inReplyTo:'',references:'',subject:'Automatic reply'}));
  assert.equal(h.status,'form_ready');assert.equal(h.history.length,0);
  // An opt-out from that domain declines and suppresses it; an exchange offered on the form is accepted like an emailed one.
  const o=form(),s4=stateOf(o);await run(s4,msg('Please do not contact us again.',{from:'ed@form.example',inReplyTo:'',references:''}));
  assert.equal(o.status,'declined');assert.ok(s4.suppression['form.example']);
  const x=form({exchange:{...OFFER,their_url:'https://form.example/p/',status:'offered',offered_at:prepared,via:'form'}}),s5=stateOf(x);
  await run(s5,msg('Deal, if you link back to us.',{from:'ed@form.example',inReplyTo:'',references:''}));
  assert.equal(x.exchange.status,'accepted');assert.equal(x.needs_owner,undefined);assert.equal(x.status,'positive');
});

const accepted=(extra={})=>{const p=pros(extra);p.status='positive';p.awaiting_us=true;p.exchange={...p.exchange,status:'accepted',accepted_at:iso()};
  p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',condition:'reciprocal',exchange:'accepted',question:false,message_id:'<their-1@pub.example>',in_reply_to:MID,
    subject:'Re: Resource for your page',excerpt:'Sure, if you link back to us.'});return p};

test('an accepted exchange gets an answer that confirms the exact deal: their page, our page and anchor, and the page on C',async()=>{
  const p=accepted(),state=stateOf(p),m=transport();
  const r=await answer(state,m);
  assert.equal(r.drafted,1);assert.equal(r.owner_needed,0);assert.equal(r.exchange_confirmations,1);assert.equal(p.needs_owner,undefined);
  const {head,body}=decode(m.drafts[0]);
  for(const s of [OFFER.their_url,ASSET.url,OFFER.partner_page,`"${OFFER.partner_title}"`,` on ${C}, a separate site I run`,'"Mouse Proofing Planner"','as soon as yours is live'])assert.ok(body.includes(s),s);
  assert.match(body,/I'll add the link to your article from "Plants That Look Like Spider Plants" \(https:\/\/\S+\) on \S+, a separate site I run, as soon as yours is live\./);
  assert.doesNotMatch(body,/\$|\bfee|\bpay|guest|already|independent|today|tomorrow/i);
  assert.doesNotMatch(head,/List-Unsubscribe/,'no List-Unsubscribe header by default');
  assert.equal(p.history.at(-1).kind,'exchange');
  // With their link already live the wording follows; the header is added only when the owner turns it on.
  const q=accepted(),s2=stateOf(q),m2=transport();q.exchange.status='their_link_live';
  await answer(s2,m2,{listUnsubscribe:true});const d=decode(m2.drafts[0]);
  assert.match(d.body,/now that yours is live/);assert.match(d.head,/List-Unsubscribe: <mailto:me@owned\.example\?subject=unsubscribe%20lf-/);
  assert.equal(answerKind(q,q.history.at(-1)),'exchange');
});

test('REPLY_MODE=send: an accepted exchange may go out automatically; counters, fees, guest posts and old-pitch swaps never do',async()=>{
  const p=accepted(),state=stateOf(p),m=transport();
  const r=await answer(state,m,{replyMode:'send'});
  assert.equal(r.sent,1,'the link back we offered no longer blocks the automatic answer');assert.equal(m.checks,1);assert.equal(m.sent[0].to,'ed@pub.example');
  assert.ok(decode(m.sent[0].raw).body.includes(OFFER.partner_page));assert.equal(p.reply_draft.mode,'send');assert.equal(p.awaiting_us,false);
  assert.doesNotMatch(decode(m.sent[0].raw).head,/List-Unsubscribe/);
  // Every other gate still applies: a question, a number, another address, a stale scan.
  for(const [mut,reason] of [[q=>{q.history.at(-1).question=true},'question'],[q=>{q.history.at(-1).excerpt='Sure, link back to us within 3 days.'},'contains_numbers'],
    [q=>{q.history.at(-1).from='boss@pub.example'},'different_address'],[q=>{q.history.at(-1).sentiment='neutral';q.history.at(-1).excerpt='We would add it if you link back to us.'},'not_positive']]){
    const q=accepted();mut(q);const m2=transport();await answer(stateOf(q),m2,{replyMode:'send'});
    assert.equal(m2.sent.length,0,reason);assert.equal(q.reply_draft.reason,reason);
  }
  const stale=accepted(),s3=stateOf(stale),m3=transport();current(s3);s3.reply_health.status='backlog';
  await answerReplies({state:s3,mailer:m3,assets:[ASSET],config:{...CFG,replyMode:'send'}});assert.equal(m3.sent.length,0);assert.equal(stale.reply_draft.reason,'reply_scan_not_current');
  // Asks that need the owner: a link back from A (counter), a fee, a guest post, and a link-back request on a pitch that offered nothing.
  const counter=pros({status:'positive',awaiting_us:true,needs_owner:true,condition:'reciprocal'});
  counter.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',condition:'reciprocal',exchange:'counter',question:false,message_id:'<their-2@pub.example>',subject:'Re: x',excerpt:'Sure, only if you link back from owned.example.'});
  const paid=accepted({needs_owner:true,condition:'paid'});paid.history.at(-1).condition='paid';paid.history.at(-1).excerpt='Sure, $40 and a link back.';
  const guest=accepted();guest.history.at(-1).condition='guest_post';guest.history.at(-1).excerpt='Sure, and send us a guest post.';
  const old=pros({exchange:undefined,status:'positive',awaiting_us:true,needs_owner:true,condition:'reciprocal'});
  old.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',condition:'reciprocal',question:false,message_id:'<their-3@pub.example>',subject:'Re: x',excerpt:'Sure, if you link back to us.'});
  for(const [q,mode,reason] of [[counter,'draft','needs_owner'],[paid,'none','paid_placement'],[guest,'draft','needs_owner'],[old,'draft','needs_owner']]){
    const m4=transport();const r4=await answer(stateOf(q),m4,{replyMode:'send'});
    assert.equal(m4.sent.length,0,reason);assert.equal(q.reply_draft.mode,mode,reason);assert.equal(q.reply_draft.reason,reason);assert.equal(r4.owner_needed,1,reason);
  }
});

test('a request for the link back from A gets a questions-only draft that restates our offer; an exchange question gets a recap',async()=>{
  const p=pros({status:'positive',awaiting_us:true,needs_owner:true,condition:'reciprocal'});
  p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',condition:'reciprocal',exchange:'counter',question:false,message_id:'<their-2@pub.example>',subject:'Re: x',excerpt:'Only from owned.example.'});
  const m=transport();await answer(stateOf(p),m);
  const body=decode(m.drafts[0]).body;
  assert.match(body,/which site and which page would you want the link to your article to come from\?/);assert.ok(body.includes(OFFER.partner_page));assert.match(body,/a separate site I run/);
  assert.doesNotMatch(body,/\bagree|\bdeal\b|I'll add/i);assert.equal(answerKind(p,p.history.at(-1)),'exchange_counter');
  const q=pros({status:'replied',awaiting_us:true});
  q.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'neutral',condition:'reciprocal',exchange:'question',question:true,message_id:'<their-4@pub.example>',subject:'Re: x',excerpt:'Would the link back be dofollow?'});
  const m2=transport();await answer(stateOf(q),m2,{replyMode:'send'});
  assert.equal(m2.sent.length,0);assert.equal(q.reply_draft.reason,'question');assert.equal(q.needs_owner,undefined,'a question about our own offer is not an owner decision');
  const b2=decode(m2.drafts[0]).body;assert.match(b2,/To recap what I suggested/);for(const u of [OFFER.their_url,ASSET.url,OFFER.partner_page])assert.ok(b2.includes(u),u);
});

test('an offer whose partner site is the pitched site, or not one of ours, is never written into an answer',async()=>{
  for(const [o,why] of [[{partner_site:'owned.example',partner_page:'https://owned.example/other/'},'partner_is_target'],[{partner_site:'stranger.example',partner_page:'https://stranger.example/x/'},'partner_not_ours'],
    [{partner_page:'https://elsewhere.example/x/'},'partner_page_elsewhere'],[{their_url:'https://other.example/a/'},'their_url_elsewhere']]){
    const p=accepted();Object.assign(p.exchange,o);
    assert.equal(offerProblem(p.exchange,p),why);
    const m=transport();const r=await answer(stateOf(p),m,{replyMode:'send'});
    assert.equal(m.drafts.length+m.sent.length,0,why);assert.equal(p.reply_draft.reason,'exchange_offer_invalid');assert.equal(p.needs_owner,true);assert.equal(r.owner_needed,1);
  }
  assert.equal(offerProblem({...OFFER,partner_site:'sub.owned.example',partner_page:'https://sub.owned.example/p/'},{site:'owned.example',domain:'pub.example'},[...SITES,{domain:'owned.example'}]),'partner_is_target');
  assert.equal(offerProblem(OFFER,{site:'owned.example',domain:'pub.example'}),null);
});

test('a link-back request on a pitch without an offer: the 3-way offer when a partner is free, else the clarifying questions',async()=>{
  const old=()=>{const p=pros({exchange:undefined,status:'positive',awaiting_us:true,needs_owner:true,condition:'reciprocal'});
    p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',condition:'reciprocal',question:false,message_id:'<their-3@pub.example>',in_reply_to:MID,subject:'Re: x',excerpt:'Sure, if you link back to us.'});return p};
  const calls=[];const partner=(p,site)=>{calls.push([p.id,site.domain]);return {...OFFER}};
  const p=old(),state=stateOf(p),m=transport();
  const r=await answer(state,m,{replyMode:'send'},{exchangePartner:partner});
  assert.deepEqual(calls,[['a','owned.example']]);assert.equal(m.sent.length,0,'an offer the owner has not approved for this conversation is a draft');
  assert.equal(r.owner_needed,1);assert.equal(r.exchange_offers_drafted,1);assert.equal(p.reply_draft.reason,'needs_owner');
  const body=decode(m.drafts[0]).body;
  assert.match(body,/I don't swap links between the same two sites, but \S+ is a separate site I run/);
  for(const s of [OFFER.their_url,ASSET.url,OFFER.partner_page,'as soon as yours is live','Would that work for you?'])assert.ok(body.includes(s),s);
  assert.equal(p.exchange,undefined,'not offered until the owner sends it');assert.equal(p.exchange_draft.partner_page,OFFER.partner_page);assert.ok(p.exchange_draft.message_id);
  // No partner function, a partner that returns nothing, or an offer that points at A: today's clarifying questions.
  for(const extra of [{},{exchangePartner:()=>null},{exchangePartner:()=>({...OFFER,partner_site:'owned.example',partner_page:'https://owned.example/x/'})},{exchangePartner:()=>{throw Error('index not built')}}]){
    const q=old(),m2=transport();await answer(stateOf(q),m2,{},extra);
    assert.match(decode(m2.drafts[0]).body,/which site and which page you have in mind for a link back/);assert.equal(q.exchange_draft,undefined);
  }
  const off=old(),m3=transport();await answer(stateOf(off),m3,{exchangeMode:'off'},{exchangePartner:partner});assert.match(decode(m3.drafts[0]).body,/which site and which page you have in mind/);
});

test('an exchange offer drafted for the owner is on record once sent: from the Sent folder or their reply to it',async()=>{
  const draftId='<lf-offer7@owned.example>';
  const withDraft=()=>pros({exchange:undefined,status:'positive',awaiting_us:true,last_reply_at:older(1),exchange_draft:{...OFFER,message_id:draftId,at:older(1)},
    history:[{type:'initial',mode:'send',to:'ed@pub.example',at:older(3),message_id:MID},{type:'reply',at:older(1),from:'ed@pub.example',sentiment:'positive',condition:'reciprocal'},
      {type:'answer',via:'draft',to:'ed@pub.example',at:older(1),message_id:draftId,kind:'exchange_offer'}]});
  const p=withDraft(),state=stateOf(p),sentAt=iso(Date.now()-3600e3);
  const r=await reconcileSent({state,imap:{sentRecipients:async()=>[{to:'ed@pub.example',at:sentAt,message_id:draftId}]}});
  assert.equal(r.exchange_offers_sent,1);assert.deepEqual({status:p.exchange.status,via:p.exchange.via,page:p.exchange.partner_page,at:p.exchange.offered_at},{status:'offered',via:'email',page:OFFER.partner_page,at:sentAt});
  assert.equal(p.exchange_draft,undefined);assert.equal(p.exchange.message_id,undefined);
  // Their answer to the draft's id proves it was sent, and the same reply can accept it.
  const q=withDraft(),s2=stateOf(q);
  const r2=await run(s2,msg('Deal, thanks!',{inReplyTo:draftId,references:`${MID} ${draftId}`}));
  assert.equal(r2.exchange_offers_sent,1);assert.equal(q.exchange.status,'accepted');assert.equal(q.needs_owner,undefined);
  // The link-back request the draft answered is settled by sending our offer: the confirmation is not a questions-only draft.
  const o=withDraft();Object.assign(o,{needs_owner:true,condition:'reciprocal'});o.history[1].excerpt='Sure, if you link back to us.';const s4=stateOf(o);
  await run(s4,msg('Deal, thanks!',{inReplyTo:draftId,references:`${MID} ${draftId}`}));
  assert.equal(o.exchange.status,'accepted');assert.equal(o.owner_decision,'exchange_offer_sent');
  const m=transport();await answer(s4,m);assert.equal(o.history.at(-1).kind,'exchange');assert.match(decode(m.drafts[0]).body,/To confirm the details/);
  // A fee still pending is never settled by the offer.
  const f=withDraft();Object.assign(f,{needs_owner:true,condition:'paid'});await reconcileSent({state:stateOf(f),imap:{sentRecipients:async()=>[{to:'ed@pub.example',at:sentAt,message_id:draftId}]}});
  assert.equal(f.exchange.status,'offered');assert.notEqual(f.owner_decision,'exchange_offer_sent');
  // A draft that was never sent stays a draft.
  const n=withDraft(),s3=stateOf(n);await reconcileSent({state:s3,imap:{sentRecipients:async()=>[{to:'ed@pub.example',at:sentAt,message_id:'<lf-other@owned.example>'}]}});
  assert.equal(n.exchange,undefined);assert.ok(n.exchange_draft);
});

test('an AI-written confirmation is used only when it states exactly the offered deal',async()=>{
  const good=`Thanks, that works. To confirm: you add a link from your article (${OFFER.their_url}) to ${ASSET.url} with "Mouse Proofing Planner" as the link text, and I'll add the link to your article from "${OFFER.partner_title}" (${OFFER.partner_page}) on ${C}, a separate site I run, as soon as yours is live.`;
  const fake=text=>({complete:async({system,user,check})=>{assert.match(system,/a separate site I run/);assert.doesNotMatch(user,/ed@pub\.example/);const why=check(text);return why?{why}:{text,writer:'groq'}}});
  const p=accepted(),m=transport();const r=await answer(stateOf(p),m,{},{writer:fake(good)});
  assert.equal(r.ai,1);assert.equal(p.history.at(-1).writer,'groq');assert.ok(decode(m.drafts[0]).body.includes(OFFER.partner_page));
  const facts={our_page:{title:'Mouse Proofing Planner',url:ASSET.url},suggested_anchor:'Mouse Proofing Planner'},o={url:ASSET.url,offer:OFFER,site:'owned.example',facts};
  assert.equal(exchangeProblem(good,o),null);
  const bad={
    missing_url:good.replace(` (${OFFER.partner_page})`,''),
    extra_url:good+' See also https://evil.example/.',
    mentions_money:good+' No fee needed.',
    new_promise:good.replace('as soon as yours is live','as soon as yours is live, within 2 days'),
    claims_placed:good+" I've already added it.",
    implies_independent:good.replace('a separate site I run','an independent site'),
    no_disclosure:good.replace('a separate site I run','my site'),
    wrong_site:good+' It sits next to my owned.example tools.',
    no_condition:good.replace(', as soon as yours is live',''),
    commits_to_terms:good+' A guest post is fine too.',
    contains_email:good+' Mail me at me@owned.example.',
    number_not_in_facts:good+' It gets 5000 visits.',
  };
  for(const [why,text] of Object.entries(bad))assert.equal(exchangeProblem(text,o),why,why);
  assert.equal(exchangeProblem(good+" I'll also link to your homepage.",o),'new_promise','one promise only: the return link');
  for(const text of Object.values(bad)){const q=accepted(),m2=transport();const r2=await answer(stateOf(q),m2,{},{writer:fake(text)});
    assert.equal(r2.ai,undefined);assert.equal(q.history.at(-1).writer,'template');assert.ok(decode(m2.drafts[0]).body.includes(OFFER.partner_page))}
});

test('answer kinds for exchanges; the templates promise nothing beyond the offer',()=>{
  const ex=s=>({exchange:{...OFFER,status:s}});
  assert.equal(answerKind(ex('accepted'),{sentiment:'positive',condition:'reciprocal',exchange:'accepted'}),'exchange');
  assert.equal(answerKind(ex('accepted'),{sentiment:'positive'}),'exchange','a later yes on an agreed deal confirms it again');
  assert.equal(answerKind(ex('offered'),{sentiment:'neutral',excerpt:'Thanks, will look.'}),'neutral');
  assert.equal(answerKind(ex('offered'),{sentiment:'neutral',condition:'reciprocal',exchange:'question',question:true}),'exchange_question');
  assert.equal(answerKind(ex('offered'),{sentiment:'positive',condition:'reciprocal',exchange:'counter'}),'exchange_counter');
  assert.equal(answerKind(ex('offered'),{sentiment:'positive',excerpt:'Sure, if you link back to us.'}),'exchange_counter','an unread link-back ask on an open offer goes to the owner');
  assert.equal(answerKind(ex('accepted'),{sentiment:'positive',condition:'paid',exchange:'accepted'}),'paid');
  assert.equal(answerKind(ex('fulfilled'),{sentiment:'positive'}),'positive','a fulfilled exchange is never described as placed');
  assert.equal(answerKind({},{sentiment:'positive',condition:'reciprocal'}),'reciprocal');
  for(const k of ['exchange','exchange_question','exchange_counter','exchange_offer']){
    const t=templateAnswer(k,{anchor:'Planner',url:ASSET.url,description:'',offer:OFFER});
    assert.match(t,/a separate site I run/,k);assert.ok(t.includes(OFFER.partner_page),k);assert.doesNotMatch(t,/\$|\bfee|\bpay|guest|already|independent|today|tomorrow|owned\.example\b(?!\/tool)/i,k);
  }
});
