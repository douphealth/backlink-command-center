import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileSent} from '../../scripts/autopilot/outreach.mjs';

const ago=h=>new Date(Date.now()-h*3600e3).toISOString();
const waiting=(extra={})=>({id:'a',domain:'pub.example',email:'ed@pub.example',status:'positive',awaiting_us:true,needs_owner:true,condition:'reciprocal',last_reply_at:ago(5),
  history:[{type:'initial',mode:'send',to:'ed@pub.example',at:ago(30),message_id:'<lf-1@owned.example>'},{type:'reply',at:ago(4),written_at:ago(5),from:'ed@pub.example',sentiment:'positive',condition:'reciprocal'}],...extra});

test("the owner's own answer in Sent clears awaiting_us and records the owner's decision",async()=>{
  const p=waiting(),state={prospects:{a:p},contacted:{}},lines=[];
  const stats=await reconcileSent({state,log:l=>lines.push(l),imap:{sentRecipients:async()=>[{to:'ed@pub.example',at:ago(30)},{to:'ed@pub.example',at:ago(2)}]}});
  assert.equal(p.awaiting_us,false);assert.ok(p.owner_decided_at);assert.equal(p.owner_decision,'answered_in_gmail');assert.ok(Math.abs(Date.parse(p.owner_answered_at)-Date.parse(ago(2)))<60e3);
  assert.equal(stats.owner_answered,1);assert.equal(stats.duplicates,0);assert.equal(p.duplicate_sent,undefined);
  assert.ok(lines.some(l=>/1 replies answered by you/.test(l)));
});

test('an answer to a forwarding address the publisher replied from also counts',async()=>{
  const p=waiting({needs_owner:false,condition:undefined});p.history[1].from='jane@personal.example';
  const state={prospects:{a:p}};
  await reconcileSent({state,imap:{sentRecipients:async()=>[{to:'jane@personal.example',at:ago(1)}]}});
  assert.equal(p.awaiting_us,false);assert.equal(p.owner_decided_at,undefined,'no decision is recorded when none was pending');
});

test('mail sent before their reply, our automatic sends and Autopilot ids are never taken for the owner',async()=>{
  const p=waiting();p.history.push({type:'answer',via:'send',to:'ed@pub.example',at:ago(1),message_id:'<lf-2@owned.example>'},{type:'answer',via:'draft',to:'ed@pub.example',at:ago(3)});
  const state={prospects:{a:p}};
  await reconcileSent({state,imap:{sentRecipients:async()=>[
    {to:'ed@pub.example',at:ago(6)},                                  // before their reply
    {to:'ed@pub.example',at:new Date(Date.parse(ago(1))-40e3).toISOString()}, // our automatic answer (Date header a few seconds earlier)
    {to:'ed@pub.example',at:ago(0.5),message_id:'<lf-3@owned.example>'}, // carries an Autopilot id
    {to:'ed@pub.example',at:null}]}});                                 // no usable date
  assert.equal(p.awaiting_us,true);assert.equal(p.owner_decided_at,undefined);
});

test('two cold emails within a day before any reply are still a duplicate',async()=>{
  const p=waiting({awaiting_us:false});
  const state={prospects:{a:p}};
  const stats=await reconcileSent({state,imap:{sentRecipients:async()=>[{to:'ed@pub.example',at:ago(30)},{to:'ed@pub.example',at:ago(29)}]}});
  assert.equal(stats.duplicates,1);assert.equal(p.duplicate_sent,true);
});

test('a quick answer within a day of the pitch still sets the duplicate hold, but is not counted as an accidental duplicate',async()=>{
  const p=waiting({last_reply_at:ago(5)});p.history[0].at=ago(10);
  const state={prospects:{a:p}};
  const stats=await reconcileSent({state,imap:{sentRecipients:async()=>[{to:'ed@pub.example',at:ago(10)},{to:'ed@pub.example',at:ago(2)}]}});
  assert.equal(p.duplicate_sent,true,'no further automatic email after two within a day');assert.equal(p.no_followup,true);
  assert.equal(stats.duplicates,0);assert.equal(stats.conversation_pairs,1);assert.equal(p.awaiting_us,false);
});
