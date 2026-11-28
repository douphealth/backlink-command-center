// Review fixes for replies to a 3-way offer: a yes that puts a condition on where the link back comes from is a counter for
// the owner (fail closed), a neutral reply never accepts, a countered offer starts no obligation from C when they link, and
// the confirmation is worded for a link their reply says is live (safety F3, F4; e2e E2E-1, E2E-3, E2E-5).
import test from 'node:test';
import assert from 'node:assert/strict';
import {exchangeIntent,exchangeAutoOk,classifyReply,isQuestion} from '../../scripts/autopilot/mail.mjs';
import {processReplies,reconcileSent,checkLinks} from '../../scripts/autopilot/outreach.mjs';
import {answerReplies,saysLinkUp} from '../../scripts/autopilot/replies.mjs';
import {trackExchanges,noteTheirLink} from '../../scripts/autopilot/exchange.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';
import {SITES} from '../../functions/_lib/sites.js';

const iso=(ms=Date.now())=>new Date(ms).toISOString(),older=(d=8)=>iso(Date.now()-d*864e5);
const A='gearuptofit.com',C=SITES.find(s=>s.domain==='gearuptogrow.com')?.domain||SITES[2].domain,MID='<lf-xi1@owned.example>';
const OFFER={partner_site:C,partner_page:`https://${C}/learning/marathon-recovery/`,partner_title:'Marathon recovery: sleep, stretching and foam rolling',
  their_url:'https://runnerblog.example/x/',their_title:'Recovery runs',score:12};
const ASSET={url:`https://${A}/shoe-finder/`,title:'Running Shoe Finder',description:'Matches runners to shoes by gait and terrain.'};
const intent=(body,status='offered')=>{const m={from:'sam@runnerblog.example',subject:'Re: x',body};
  return exchangeIntent(m,{offer:{...OFFER,status},site:A,domain:'runnerblog.example',sentiment:classifyReply(m),question:isQuestion(m),assetTitle:ASSET.title})};
const pros=(extra={})=>({id:'x1',site:A,domain:'runnerblog.example',page_url:'https://runnerblog.example/x/',email:'sam@runnerblog.example',status:'sent',qv:99,
  asset_url:ASSET.url,asset_title:'Running Shoe Finder',last_subject:'Resource for your page',exchange:{...OFFER,status:'offered',offered_at:older(3),via:'email'},
  history:[{type:'initial',mode:'send',to:'sam@runnerblog.example',at:older(3),message_id:MID,sender_name:'Alex',subject:'Resource for your page'}],...extra});
const inbox=(...msgs)=>({recentHeaders:async()=>Object.assign(msgs,{complete:true,cursor:{mailbox:'x',uidvalidity:'1',uid:msgs.length}})});
const msg=body=>({uid:'7',messageId:`<r${Math.random().toString(36).slice(2)}@runnerblog.example>`,from:'sam@runnerblog.example',subject:'Re: Resource for your page',
  date:new Date().toUTCString(),inReplyTo:MID,references:MID,autoSubmitted:'',body});
function proof(q){const t=Date.now(),email=q.email;return {ok:true,email,evidence:{source:`https://${q.domain}/contact/`,email,rank:95,observed_at:iso(t)},
  verification:hunterVerdict({data:{email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},email,t)}}
const transport=()=>{const m={drafts:[],sent:[]};m.draft=async r=>{m.drafts.push(r)};m.send=async x=>{m.sent.push(x)};m.authorizeRecipient=async q=>proof(q);return m};
const ready=state=>Object.assign(state,{reply_health:{status:'ok',checked_at:iso()},sent_reconciled_at:iso()});
const SEND={replyMode:'send',mode:'send',fromAddress:'me@owned.example',senderName:'Alex'};
const decode=raw=>Buffer.from(raw.slice(raw.indexOf('\r\n\r\n')+4).replace(/\r\n/g,''),'base64').toString('utf8');

const COUNTERS=['Sure, sounds good, but I would prefer the link from your shoe guide.','Sure, deal. But link to us from the running one, not the plant one.',
  'Yes, works for me as long as the link back is from the shoe finder page you sent.','Sure, but the link back has to come from Gear Up To Fit, not some other site.',
  'Sure, if you link back from the shoe finder site rather than the study one.','Sure thing, as long as the link to us goes on gearuptofit and not gearuptogrow.',
  'Yes, happy to swap, but I only do swaps with the site I am linking to.','Sure, happy to if you link back to us from the shoe finder page itself.',
  'Deal, as long as the return link is on GearUpToFit.','OK, we can do a swap, but the link to us must be on the same domain as the shoe finder.',
  'Sure. I would prefer a link from your running site though.','Sure, happy to if you link back from the site you are promoting.'];

test('safety F3 / E2E-1: a yes that says where the link back must come from (A by domain, name or "Gear Up To Fit", our page, "your site") is a counter',()=>{
  for(const b of COUNTERS)assert.equal(intent(b),'counter',b);
});

test('the link back we offered is still accepted in plain words, and C named (or "your other site") is the offer itself',()=>{
  for(const b of ['Sure, if you link back to us.','Deal!','Happy to swap.','Sure, if you link back, happy to add it.',"I'll add it if you link back to us.","We'd add it if you link back to us",
    `Sure! Looking forward to the link from ${C}.`,'Yes, a link back from your other site works for me.',"Sure, I've added the link on my resources page.",'Sure, as long as you link back to us.'])
    assert.equal(intent(b),'accept',b);
  // A question about where the link back comes from is a question (the recap names C), unless it insists on something.
  assert.equal(intent('Sure! Which page would the link come from?'),'question');
});

test('safety F4: a neutral reply never accepts an open offer; on a deal already agreed, mentioning the link back is the deal',()=>{
  for(const b of ["We're open to a link swap but need to check with our editor first.",'We only do link exchanges with sites in our niche.','Link exchanges are something we look at case by case.'])
    assert.equal(intent(b),'question',b);
  assert.equal(intent('Thanks, I will take a look.'),null);
  assert.equal(intent('Great, just make sure you link back to us, thanks.','accepted'),'accept');
});

test('safety F4 end to end: a neutral reply about a swap leaves the offer open, the conversation "replied" and nothing counted as accepted',async()=>{
  const p=pros(),state={prospects:{a:p},suppression:{},contacted:{}};
  const r=await processReplies({state,imap:inbox(msg("We're open to a link swap but need to check with our editor first."))});
  assert.equal(p.exchange.status,'offered');assert.equal(p.status,'replied');assert.equal(r.exchange_accepted,undefined);assert.equal(p.needs_owner,undefined);
  assert.equal(p.history.at(-1).exchange,'question');
  const m=transport(),a=await answerReplies({state:ready(state),mailer:m,assets:[ASSET],config:{...SEND,replyMode:'draft'}});
  assert.equal(a.drafted,1);const body=decode(m.drafts[0]);
  assert.match(body,/To recap what I suggested/);assert.doesNotMatch(body,/glad this works for you|check your question/);
});

test('safety F3 / E2E-1 end to end: a counter is flagged for the owner and never confirmed automatically, even with REPLY_MODE=send',async()=>{
  for(const b of COUNTERS.slice(0,4)){
    const p=pros(),state={prospects:{a:p},suppression:{},contacted:{}};
    await processReplies({state,imap:inbox(msg(b))});
    assert.equal(p.history.at(-1).exchange,'counter',b);assert.equal(p.exchange.status,'offered',b);assert.equal(p.needs_owner,true,b);assert.ok(p.exchange.countered_at,b);
    const m=transport(),a=await answerReplies({state:ready(state),mailer:m,assets:[ASSET],config:SEND});
    assert.equal(a.sent,0,b);assert.equal(m.sent.length,0,b);assert.doesNotMatch(decode(m.drafts[0]),/glad this works for you/,b);
  }
});

test('an automatic confirmation needs a plain yes or one naming C: any "but", "prefer", "only", "must" or "as long as" leaves it a draft',async()=>{
  assert.equal(exchangeAutoOk('Sure, if you link back to us.',OFFER),true);assert.equal(exchangeAutoOk(`Deal, as long as it is ${C}.`,OFFER),true);
  for(const t of ['Sure, but quickly please.','Deal, as long as you link back.','Sure, I only need the link back.','Sure, though I would prefer a dofollow link back.'])assert.equal(exchangeAutoOk(t,OFFER),false,t);
  // Naming C does not carry terms of their own through: an attribute, a placement, a deadline or who goes first stays a draft.
  for(const t of [`Deal, as long as the link from ${C} is dofollow.`,`Sure, the link from ${C} should go in the sidebar.`,`Deal, add the ${C} link first and I will follow.`])assert.equal(exchangeAutoOk(t,OFFER),false,t);
  // A plain yes goes out by itself; a yes with "as long as" is drafted for the owner, the exchange still accepted.
  for(const [b,sent] of [['Sure, if you link back to us.',1],['Deal, as long as you link back to us.',0]]){
    const p=pros(),state={prospects:{a:p},suppression:{},contacted:{}};
    await processReplies({state,imap:inbox(msg(b))});assert.equal(p.exchange.status,'accepted',b);
    const m=transport(),a=await answerReplies({state:ready(state),mailer:m,assets:[ASSET],config:SEND});
    assert.equal(a.sent,sent,b);if(!sent)assert.equal(p.reply_draft.reason,'exchange_conditions')
  }
});

test('E2E-3: after a counter the owner settles in Gmail; when they link, no return link is owed from the C page they refused',async()=>{
  const p=pros(),state={prospects:{a:p},suppression:{},contacted:{}};
  await processReplies({state,imap:inbox(msg('Happy to add it, but the link back would have to come from gearuptofit.com itself, not another site.'))});
  assert.equal(p.history.at(-1).exchange,'counter');
  // The owner answers in Gmail (Sent folder), then the publisher links to A.
  const sent=[{to:'sam@runnerblog.example',at:iso(Date.now()+60e3),message_id:'<own-answer@gmail.com>'}];
  await reconcileSent({state,imap:{sentRecipients:async()=>Object.assign(sent.slice(),{complete:true})},now:()=>Date.now()+120e3});
  assert.equal(p.owner_decision,'answered_in_gmail');
  p.next_link_check=null;
  const page='<html><body><main><p>Shoes: <a href="https://gearuptofit.com/shoe-finder/">finder</a></p></main></body></html>';
  await checkLinks({state,ourDomains:[A,C],fetchImpl:async()=>new Response(page,{status:200,headers:{'content-type':'text/html'}})});
  assert.equal(p.status,'won');assert.equal(p.exchange.status,'lapsed');assert.equal(p.exchange.lapse_reason,'countered');assert.equal(p.exchange.owed_by,undefined);
  const t=await trackExchanges({state,fetchImpl:async()=>{throw Error('no fetch')}});assert.equal(t.owed,0);
  // A lapse for a counter is final: their link does not revive it later.
  assert.equal(noteTheirLink(p),false);assert.equal(p.exchange.status,'lapsed');
  // A later plain yes to the offer as made clears the counter, and then their link starts the obligation.
  const q=pros(),s2={prospects:{a:q},suppression:{},contacted:{}};
  await processReplies({state:s2,imap:inbox(msg('Sure, but the link back has to come from Gear Up To Fit.'))});
  await processReplies({state:s2,imap:inbox(msg(`OK, fine, a link from ${C} works for me.`))});
  assert.equal(q.exchange.status,'accepted');assert.equal(q.exchange.countered_at,undefined);
  assert.equal(noteTheirLink(q),true);assert.equal(q.exchange.status,'their_link_live');
});

test('E2E-5: a yes that says their link is up gets the "now that yours is live" wording, before this cycle\'s link check',async()=>{
  assert.equal(saysLinkUp('Deal! The link is up now.'),true);assert.equal(saysLinkUp('Done, I added it.'),true);
  for(const t of ['I will add it next week.',"I haven't added it yet.",'The link is not live yet.','Sure, sounds good.'])assert.equal(saysLinkUp(t),false,t);
  const p=pros(),state={prospects:{a:p},suppression:{},contacted:{}};
  await processReplies({state,imap:inbox(msg('Deal! The link is up now.'))});assert.equal(p.exchange.status,'accepted');
  const m=transport();await answerReplies({state:ready(state),mailer:m,assets:[ASSET],config:{...SEND,replyMode:'draft'}});
  const body=decode(m.drafts[0]);assert.match(body,/Thanks for adding the link\./);assert.match(body,/a separate site I run, now that yours is live/);
  assert.equal(p.exchange.status,'accepted','the obligation itself starts only once the link check verifies it');
});

test('where their own link goes ("on my resources page", "from our resources section") is not a counter: only where ours comes from is',()=>{
  for(const b of ["Happy to swap, I'll add it on my resources page.",'Thanks for the tool on your website, happy to add it.',"Deal. I'll put the link on our gear page this week.",
    "Sure, I've added the link from our resources section.",'Sure, add the link from your side whenever.',"Sounds good, I'll link to your finder from my article."])
    assert.equal(intent(b),'accept',b);
  // "instead" next to their own link is no counter either, but it is not a plain yes: the confirmation stays a draft.
  assert.equal(intent('Sure, I replaced the dead link with yours instead.'),'accept');assert.equal(exchangeAutoOk('Sure, I replaced the dead link with yours instead.',OFFER),false);
});
