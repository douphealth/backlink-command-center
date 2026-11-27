import test from 'node:test';
import assert from 'node:assert/strict';
import {processReplies} from '../../scripts/autopilot/outreach.mjs';
import {classifyReply,replyCondition,isQuestion,optOutSubject,lfIds,parseFetch} from '../../scripts/autopilot/mail.mjs';

const older=(d=8)=>new Date(Date.now()-d*86400000).toISOString();
const MID='<lf-abc-1@owned.example>';
const prospect=(id='one',extra={})=>({id,domain:id+'.example',site:'owned.example',page_url:'https://'+id+'.example/r/',asset_url:'https://owned.example/tool',email:'editor@'+id+'.example',status:'sent',qv:2,
  history:[{type:'initial',mode:'send',to:'editor@'+id+'.example',at:older(),message_id:MID}],...extra});
const run=(state,msgs)=>processReplies({state,imap:{recentHeaders:async()=>msgs}});
const msg=(body,extra={})=>({from:'editor@one.example',subject:'Re: Resource for your page',inReplyTo:MID,references:MID,body,messageId:'<r'+Math.random().toString(36).slice(2)+'@one.example>',...extra});

test('a later neutral or question reply never downgrades a positive conversation',async()=>{
  const p=prospect(),state={prospects:{p}};
  await run(state,[msg('Sure, happy to add it.')]);
  assert.equal(p.status,'positive');
  await run(state,[msg('Thanks, I will look at it next week.')]);
  assert.equal(p.status,'positive','neutral does not downgrade');
  await run(state,[msg('Which anchor text would you prefer?')]);
  assert.equal(p.status,'positive','a question does not downgrade');
  for(const s of ['won','lost']){const q=prospect('two',{status:s}),st={prospects:{q}};
    await run(st,[msg('Thanks, I will review it.',{from:'editor@two.example',inReplyTo:MID})]);assert.equal(q.status,s,`${s} stays ${s}`)}
});

test('an opt-out after a positive reply declines the conversation and suppresses domain and address',async()=>{
  const p=prospect(),state={prospects:{p}};
  await run(state,[msg('Yes, I can do that.')]);
  assert.equal(p.status,'positive');assert.equal(p.awaiting_us,true);
  const r=await run(state,[msg('Actually, please remove me from your list.')]);
  assert.equal(r.negative,1);assert.equal(p.status,'declined');assert.equal(p.awaiting_us,false);
  assert.ok(state.suppression['one.example']);assert.ok(state.suppression['editor@one.example']);
  await run(state,[msg('Sure, added it!')]);
  assert.equal(p.status,'declined','an opt-out is final');assert.equal(p.awaiting_us,false,'a declined conversation never waits for an answer');
});

test('condition and owner flag stay set; replies record thread ids, question cue and when they were written',async()=>{
  const p=prospect(),state={prospects:{p}};
  const written='Tue, 24 Nov 2026 14:07:00 +0000';
  await run(state,[msg('Yes, if you link back to us from your blog.',{messageId:'<their-1@one.example>',date:written})]);
  assert.equal(p.condition,'reciprocal');assert.equal(p.needs_owner,true);assert.equal(p.status,'positive');
  const h=p.history.at(-1);
  assert.equal(h.message_id,'<their-1@one.example>');assert.equal(h.in_reply_to,MID);assert.equal(h.question,false);
  assert.equal(p.last_reply_at,new Date(written).toISOString());assert.equal(p.awaiting_us,true);
  await run(state,[msg('Did you see my last email? What do you think?',{messageId:'<their-2@one.example>',inReplyTo:'<their-1@one.example>',references:`${MID} <their-1@one.example>`})]);
  assert.equal(p.condition,'reciprocal','condition is sticky');assert.equal(p.needs_owner,true,'owner flag is sticky');
  assert.equal(p.history.at(-1).question,true);assert.equal(p.history.at(-1).sentiment,'neutral','a question does not change sentiment');
  assert.equal(p.history.at(-1).in_reply_to,MID,'matched through References');
  // A fee raised later outranks the link-back condition and re-opens a decision the owner had made.
  p.owner_decided_at=older(1);
  await run(state,[msg('Also, our fee is $80 per link.',{messageId:'<their-3@one.example>'})]);
  assert.equal(p.condition,'paid');assert.equal(p.owner_decided_at,undefined);
});

test("plural 'guest posts' is a guest-post condition and questions are cued without changing sentiment",()=>{
  const m=b=>({from:'a@b.com',subject:'Re: x',body:b});
  assert.equal(replyCondition(m('We only accept guest posts at the moment.')),'guest_post');
  assert.equal(replyCondition(m('Happy to consider guest posting.')),'guest_post');
  assert.equal(replyCondition(m('Please send a guest post instead.')),'guest_post');
  assert.equal(replyCondition(m('Our fees start at 50 euros.')),'paid');
  assert.equal(replyCondition(m('Thanks, I will review it next week.')),null);
  assert.equal(isQuestion(m('Could you send me the exact URL')),true);
  assert.equal(isQuestion(m('Hi Alex, how much traffic does it get')),true);
  assert.equal(isQuestion(m('Do you have a shorter version?')),true);
  assert.equal(isQuestion(m('Added it, thanks!\n\nOn Mon, Nov 23, 2026 Alex <a@b.com> wrote:\n> Would you consider it?')),false,'quoted text is ignored');
  assert.equal(isQuestion(m('Done, see https://pub.example/page?id=4')),false,'a URL query string is not a question');
  assert.equal(classifyReply(m('Sure! Which page should I link?')),'positive');
});

test('unsubscribe subjects and our token in the subject are opt-outs; tokens are read from the subject',()=>{
  assert.equal(optOutSubject('unsubscribe'),true);
  assert.equal(optOutSubject('Re: Unsubscribe'),true);
  assert.equal(optOutSubject('Fwd: unsubscribe'),true);
  assert.equal(optOutSubject(`unsubscribe ${MID}`),true);
  assert.equal(optOutSubject('unsubscribe%20%3Clf-abc-1%40owned.example%3E'),true);
  assert.equal(optOutSubject('Re: Resource for your page'),false);
  assert.deepEqual(lfIds('unsubscribe%20%3Clf-abc-1%40owned.example%3E'),[MID]);
  assert.equal(classifyReply({from:'x@y.com',subject:`unsubscribe ${MID}`,body:'This message was sent by the unsubscribe button.'}),'negative');
  assert.equal(classifyReply({from:'x@y.com',subject:'Re: unsubscribe',body:''}),'negative');
});

test('an unsubscribe from a different (forwarding) address with our token in the subject suppresses the prospect',async()=>{
  const p=prospect(),state={prospects:{p}};
  const r=await run(state,[{from:'owner.personal@mailbox.example',subject:`unsubscribe ${MID}`,body:'',messageId:'<u1@mailbox.example>'}]);
  assert.equal(r.negative,1);assert.equal(r.unsubscribe_links,1);assert.equal(p.status,'declined');
  assert.ok(state.suppression['one.example'],'publisher domain suppressed');assert.ok(state.suppression['editor@one.example'],'pitched address suppressed');
  assert.ok(state.suppression['owner.personal@mailbox.example'],'the forwarding sender is suppressed too');
});

test('an opt-out that matches no prospect is counted, its sender suppressed, and no address reaches the log',async()=>{
  const state={prospects:{p:prospect()}},lines=[];
  const r=await processReplies({state,log:l=>lines.push(l),imap:{recentHeaders:async()=>[
    {from:'stranger@elsewhere.example',subject:'Re: unsubscribe',body:'',messageId:'<s1@elsewhere.example>'},
    {from:'other@lost.example',subject:'Re: hello',inReplyTo:'<lf-gone@owned.example>',body:'Not interested, please stop.',messageId:'<s2@lost.example>'},
    {from:'news@letter.example',subject:'Weekly digest',body:'Click here to unsubscribe.',messageId:'<n1@letter.example>'}]}});
  assert.equal(r.unmatched_optouts,2,'a newsletter footer is not an opt-out');
  assert.ok(state.suppression['stranger@elsewhere.example']);assert.ok(state.suppression['other@lost.example']);
  assert.equal(state.suppression['news@letter.example'],undefined);
  assert.ok(lines.some(l=>/2 opt-outs not matched/.test(l)));assert.ok(!lines.some(l=>/@/.test(l)));
});

test('the reply scan asks for the Date header and parses it',()=>{
  const raw='* 1 FETCH (UID 5 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {90}\r\nFrom: Ed <ed@pub.com>\r\nSubject: Re: tool\r\nDate: Tue, 24 Nov 2026 14:07:00 +0000\r\n\r\n BODY[TEXT]<0> {6}\r\nthanks)\r\n';
  assert.equal(parseFetch(raw)[0].date,'Tue, 24 Nov 2026 14:07:00 +0000');
});

test('one-time repair restores an overwritten positive reply and marks recent replies as waiting',async()=>{
  const p=prospect('one',{status:'replied',needs_owner:true,condition:'reciprocal',replied_at:older(2),history:[
    {type:'initial',mode:'send',to:'editor@one.example',at:older(9),message_id:MID},
    {type:'reply',at:older(3),from:'editor@one.example',sentiment:'positive',condition:'reciprocal'},
    {type:'reply',at:older(2),from:'editor@one.example',sentiment:'neutral'}]});
  const gone=prospect('two',{status:'declined',history:[{type:'initial',mode:'send',to:'editor@two.example',at:older(9)},{type:'reply',at:older(2),sentiment:'negative'}]});
  const state={prospects:{p,gone}},lines=[];
  await processReplies({state,log:l=>lines.push(l),imap:{recentHeaders:async()=>[]}});
  assert.equal(p.status,'positive');assert.equal(p.awaiting_us,true);assert.equal(p.last_reply_at,p.history[2].at);assert.equal(p.condition,'reciprocal');
  assert.equal(gone.awaiting_us,undefined);
  assert.ok(lines.some(l=>/1 positive replies restored/.test(l)));
  p.status='replied';await processReplies({state,imap:{recentHeaders:async()=>[]}});assert.equal(p.status,'replied','the repair runs once');
});
