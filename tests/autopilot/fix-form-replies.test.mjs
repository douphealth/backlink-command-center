// Review fixes for replies to contact-form messages: a form system's acknowledgement is an automatic reply (it never takes
// the match), a colleague's later reply or an answer to our answer is still recorded, and a reply from a webmail address
// that quotes our message is matched (e2e E2E-2; coverage F2, F3).
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyReply} from '../../scripts/autopilot/mail.mjs';
import {processReplies} from '../../scripts/autopilot/outreach.mjs';
import {isSuppressed} from '../../scripts/autopilot/recipient-policy.mjs';

const iso=(ms=Date.now())=>new Date(ms).toISOString(),ago=d=>iso(Date.now()-d*864e5);
const ASSET='https://gearuptofit.com/shoe-finder/';
const BODY=`Hi there,\n\nI'm Alex from gearuptofit.com, a site about running shoes. Would you consider adding Running Shoe Finder to "Trail shoes for beginners"?\n\n${ASSET}\n\nIf it's not a fit, just say so and I won't follow up.\n\nBest,\nAlex\ngearuptofit.com\nReply to: owner@gmail.com`;
const form=(id,domain,extra={})=>({id,domain,site:'gearuptofit.com',email:null,page_url:`https://${domain}/trail/`,title:'Trail shoes for beginners',asset_url:ASSET,status:'form_ready',
  form_message:{subject:'Suggestion for "Trail shoes for beginners"',body:BODY,form_url:`https://${domain}/contact/`,at:ago(2)},history:[{type:'form_prepared',at:ago(2)}],
  exchange:{partner_site:'gearuptogrow.com',partner_page:'https://gearuptogrow.com/x/',their_url:`https://${domain}/trail/`,status:'offered',offered_at:ago(2),via:'form'},...extra});
const stateOf=(...ps)=>({prospects:Object.fromEntries(ps.map(p=>[p.id,p])),suppression:{},contacted:Object.fromEntries(ps.map(p=>[p.domain,ago(2)])),migrations:{reply_class_v4:ago(9),reply_status_v2:ago(9)}});
const inbox=(...msgs)=>({recentHeaders:async()=>Object.assign(msgs,{complete:true})});
let n=0;const mail=(from,body,extra={})=>({uid:String(++n),messageId:`<m${n}@${from.split('@')[1]}>`,from,subject:'Re: New message from your contact form',date:new Date().toUTCString(),autoSubmitted:'',body,...extra});

test('E2E-2: a contact form\'s acknowledgement is an automatic reply: robot senders, "we received your message" subjects or bodies',()=>{
  for(const m of [mail('wordpress@formack.example','Thank you for contacting us. We have received your message and will get back to you soon.'),
    mail('noreply@formack.example','Your message was sent.'),mail('no-reply@pub.example','x'),mail('forms@pub.example','Submission received'),
    mail('kim@formack.example','Hello, this is an automatic confirmation.',{subject:'Thank you for contacting us'}),
    mail('info@formack.example','Thanks for reaching out! We have received your message and will get back to you within 2 business days.',{subject:'Re: Contact'})])
    assert.equal(classifyReply(m),'auto',`${m.from}: ${m.subject}`);
  // A person's yes or no is never swallowed as an acknowledgement.
  assert.equal(classifyReply(mail('kim@formack.example','Thanks for reaching out! Sure, happy to add it.',{subject:'Thank you for contacting us'})),'positive');
  assert.equal(classifyReply(mail('kim@formack.example','Thanks for contacting us. Not interested, please remove us.',{subject:'Thank you for contacting us'})),'negative');
});

test('E2E-2: the acknowledgement does not take the form match; the editor\'s real reply later from another address is recorded',async()=>{
  const fa=form('fa','formack.example'),state=stateOf(fa);
  const r1=await processReplies({state,imap:inbox(mail('wordpress@formack.example','Thank you for contacting us. We have received your message and will get back to you soon.'))});
  assert.equal(r1.replies,0);assert.equal(fa.status,'form_ready');assert.equal(fa.awaiting_us,undefined);assert.ok(!fa.history.some(h=>h.type==='reply'));
  const r2=await processReplies({state,imap:inbox(mail('kim@formack.example','Hi Alex, yes, happy to add it to the trail shoes article. Kim'))});
  assert.equal(r2.form_replies,1);assert.equal(fa.status,'positive');assert.equal(fa.history.at(-1).from,'kim@formack.example');assert.equal(fa.form_contact,'kim@formack.example');
});

test('coverage F2: after the first reply, later messages from that publisher (an answer to our answer, a colleague) are still recorded',async()=>{
  const fp=form('fp','formpub.example'),state=stateOf(fp);
  await processReplies({state,imap:inbox(mail('jo@formpub.example','Thanks, what would the link back look like?'))});
  assert.equal(fp.status,'replied');assert.equal(fp.awaiting_us,true);
  // The owner sends our answer draft; Jo answers it in the same thread.
  fp.history.push({type:'answer',at:iso(),message_id:'<lf-ans1@gmail.com>',to:'jo@formpub.example',subject:'Re: x',via:'draft',kind:'exchange_question'});fp.awaiting_us=false;
  const r=await processReplies({state,imap:inbox(mail('jo@formpub.example',"Deal, sounds good. I'll add it this week, please add yours too.",{inReplyTo:'<lf-ans1@gmail.com>',references:'<lf-ans1@gmail.com>'}))});
  assert.equal(r.replies,1);assert.equal(fp.awaiting_us,true);assert.equal(fp.exchange.status,'accepted');assert.equal(fp.history.filter(h=>h.type==='reply').length,2);
  // A colleague at the same domain, with no thread ids, is tied to it by the domain (form conversations stay matchable).
  const r3=await processReplies({state,imap:inbox(mail('lee@formpub.example','Lee here, Jo is away. The link is in the article now.'))});
  assert.equal(r3.replies,1);assert.equal(fp.history.filter(h=>h.type==='reply').length,3);
  // An opt-out from the colleague is honoured for the whole publisher.
  await processReplies({state,imap:inbox(mail('lee@formpub.example','Actually, please remove us from your list.'))});
  assert.equal(fp.status,'declined');assert.ok(isSuppressed(state,'x@formpub.example','formpub.example'));
});

test('coverage F3: a reply from a webmail address that quotes our form message is matched; its opt-out suppresses the publisher domain',async()=>{
  const quoted=b=>`${b}\n\nOn Mon, Nov 23, 2026 at 8:39 PM Contact form <wordpress@formpub.example> wrote:\n> ${BODY.replace(/\n/g,'\n> ')}`;
  const fp=form('fp','formpub.example'),other=form('fo','otherpub.example',{title:'Road shoes',page_url:'https://otherpub.example/road/'}),state=stateOf(fp,other);
  const r=await processReplies({state,imap:inbox(mail('jo.formpub@gmail.com',quoted('Hi Alex, sure, happy to add it, and thanks for the link back!'),{subject:'Re: New message from formpub.example contact form'}))});
  assert.equal(r.form_replies,1);assert.equal(fp.status,'positive');assert.equal(fp.exchange.status,'accepted');assert.equal(fp.form_contact,'jo.formpub@gmail.com');
  assert.equal(other.status,'form_ready','only the publisher the quote names');
  // The next message from that webmail address matches by address; an opt-out suppresses the publisher's domain too.
  await processReplies({state,imap:inbox(mail('jo.formpub@gmail.com','On second thought, not interested.'))});
  assert.equal(fp.status,'declined');assert.ok(state.suppression['formpub.example']);assert.ok(state.suppression['jo.formpub@gmail.com']);
  // A webmail reply that quotes nothing of ours matches nothing.
  const s2=stateOf(form('fq','quietpub.example'));const r2=await processReplies({state:s2,imap:inbox(mail('someone@gmail.com','Sure, happy to add it.'))});
  assert.equal(r2.replies,0);
});

test('E2E-2: an acknowledgement stored before the fix is never answered and stops waiting for the owner',async()=>{
  const {answerReplies}=await import('../../scripts/autopilot/replies.mjs');
  const fa=form('fa','formack.example',{status:'replied',awaiting_us:true});
  fa.history.push({type:'reply',at:iso(),from:'wordpress@formack.example',sentiment:'neutral',message_id:'<ack@formack.example>',subject:'Thank you for contacting us',
    excerpt:'Thank you for contacting us. We have received your message and will get back to you soon.'});
  const state={...stateOf(fa),reply_health:{status:'ok',checked_at:iso()},sent_reconciled_at:iso()},drafts=[];
  const r=await answerReplies({state,mailer:{draft:async d=>drafts.push(d)},assets:[{url:ASSET,title:'Running Shoe Finder'}],config:{replyMode:'draft',mode:'send',fromAddress:'owner@gmail.com',senderName:'Alex'}});
  assert.equal(drafts.length,0);assert.equal(r.skipped,1);assert.equal(fa.awaiting_us,false);assert.equal(fa.reply_draft.reason,'automatic_reply');
  // The editor's real reply later is still matched by the domain (the prospect is no longer form_ready).
  const r2=await processReplies({state,imap:inbox(mail('kim@formack.example','Hi Alex, yes, happy to add it.'))});
  assert.equal(r2.form_replies,1);assert.equal(fa.status,'positive');assert.equal(fa.awaiting_us,true);
});
