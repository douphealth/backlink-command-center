import test from 'node:test';
import assert from 'node:assert/strict';
import {preverify,setSendPolicy} from '../../scripts/autopilot/outreach.mjs';
import {verifaliaVerdict,usableVerification} from '../../scripts/autopilot/recipient-policy.mjs';

const iso=ms=>new Date(ms).toISOString();
const mk=(id,domain,extra={})=>({id,status:'ready',email:`editor@${domain}`,domain,page_url:`https://${domain}/a`,qv:2,score:60,history:[],...extra});
const proofFor=p=>({ok:true,email:p.email,evidence:{source:`https://${p.domain}/contact/`,email:p.email,rank:95,observed_at:iso(Date.now())},
  verification:verifaliaVerdict({inputData:p.email,emailAddress:p.email,classification:'Deliverable',status:'Success',isDisposableEmailAddress:false},p.email,Date.now())});
/** Records every check: plain id = send-proof check, fu: = follow-up proof, screen: = screen-only (never a proof). */
const recorder=({credits=()=>10}={})=>{const asked=[];return {asked,mailer:{
  authorizeRecipient:async(p,o)=>{asked.push((o.followup?'fu:':'')+p.id);return proofFor(p)},
  verifierCredits:async o=>credits(o),
  prescreenRecipient:async p=>{asked.push('screen:'+p.id);return {ok:false,reason:'screen_only',screened:'valid',email:p.email}}}}};
const queue=()=>({prospects:{uk:mk('uk','uk-blog.co.uk',{score:90}),us:mk('us','us-blog.com',{score:80})}});
const run=async(when,{state=queue(),...o}={})=>{const r=recorder();const stats=await preverify({state,mailer:r.mailer,max:10,now:()=>new Date(when),...o});return {asked:r.asked.sort(),stats,state}};
const withSaturday=async(on,fn)=>{try{setSendPolicy({saturday:on});return await fn()}finally{setSendPolicy({saturday:true})}};

test('Friday night credits back Saturday-morning sends (EU 08:00, US 14:00 UTC); with Saturdays off they screen, as before',async()=>{
  setSendPolicy({saturday:true});
  let r=await run('2026-11-27T21:00:00Z');
  assert.deepEqual(r.asked,['uk','us'],'real send-proof checks, no screening');assert.equal(r.stats.verified,2);assert.equal(r.stats.screened,undefined);
  // The proofs are good for the Saturday window: under 24 h old when it opens (EU 11 h, US 17 h later).
  for(const p of Object.values(r.state.prospects)){const v=p.recipient_proof.verification;
    assert.ok(Date.parse(v.expires_at)-Date.parse(v.checked_at)<=864e5);assert.ok(usableVerification(v,p.email))}
  await withSaturday(false,async()=>{r=await run('2026-11-27T21:00:00Z');assert.deepEqual(r.asked,['screen:uk','screen:us']);assert.equal(r.stats.checked,0)});
});

test('the horizon still holds: a Saturday window more than 20 h away gets no proof yet',async()=>{
  setSendPolicy({saturday:true});
  // Friday 10:00 UTC: the UK window is open now, the US one opens at 13:00; both get today's proofs. With today's cap
  // used up, the next send day is Saturday: 08:00 is 22 h away (too far for a proof), so nothing is bought.
  const full=()=>{const s=queue();s.prospects.done=mk('done','done.co.uk',{status:'sent',history:[1,2].map(i=>({type:'initial',at:iso(Date.parse('2026-11-27T08:00:00Z')+i*60e3),mode:'send'}))});return s};
  let r=await run('2026-11-27T10:00:00Z',{cap:2,state:full()});
  assert.deepEqual(r.asked,[]);assert.equal(r.stats.capacity_full,2);
  // Two hours later Saturday 08:00 is exactly 20 h away: the UK inbox is verified for Saturday; the US one (14:00) still waits.
  r=await run('2026-11-27T12:00:00Z',{cap:2,state:full()});
  assert.deepEqual(r.asked,['uk']);assert.equal(r.stats.capacity_full,1);
  // Weekdays only: Friday's full cap means Monday, far beyond the horizon.
  await withSaturday(false,async()=>{r=await run('2026-11-27T12:00:00Z',{cap:2,state:full()});assert.deepEqual(r.asked,[]);assert.equal(r.stats.capacity_full,2)});
});

test('a follow-up due over the weekend is verified for its Saturday window',async()=>{
  setSendPolicy({saturday:true});
  const s={prospects:{fu:mk('fu','fu-blog.co.uk',{status:'sent',history:[{type:'initial',at:'2026-11-21T20:00:00.000Z',mode:'send',to:'editor@fu-blog.co.uk',message_id:'<lf-a-b@sender.example>'}]})}};
  let r=await run('2026-11-27T22:00:00Z',{state:s});
  assert.deepEqual(r.asked,['fu:fu']);assert.equal(r.stats.followups_verified,1);
  delete s.prospects.fu.recipient_proof;
  await withSaturday(false,async()=>{r=await run('2026-11-27T22:00:00Z',{state:s});assert.deepEqual(r.asked,[],'Monday is too far; follow-ups are never screened')});
});

test('screen-only applies only when no queued window comes within the horizon before the credits reset',async()=>{
  setSendPolicy({saturday:true});
  const cases=[
    ['2026-11-28T09:00:00Z',['uk','us'],'Saturday morning: the UK window is open, the US one opens at 14:00'],
    ['2026-11-28T12:30:00Z',['us'],'Saturday after the UK window: the US one still opens today, the UK inbox waits for Monday (no screen)'],
    ['2026-11-28T18:00:00Z',['screen:uk','screen:us'],'Saturday afternoon, every Saturday window closed: today\'s credits would expire'],
    ['2026-11-28T23:30:00Z',['screen:uk','screen:us'],'Saturday night'],
    ['2026-11-29T05:00:00Z',[],'Sunday morning: credits are kept for Monday\'s windows (they come within 20 h later today)'],
    ['2026-11-29T11:00:00Z',['uk'],'Sunday 11:00: Monday 07:00 UTC is 20 h away'],
    ['2026-11-29T17:00:00Z',['uk','us'],'Sunday 17:00: the US Monday window too']];
  for(const [when,expect,why] of cases){const r=await run(when);assert.deepEqual(r.asked,expect,`${when}: ${why}`)}
  // A queue with only US inboxes keeps Saturday's credits for the US window until it closes.
  const us=()=>({prospects:{us:mk('us','us-blog.com')}});
  assert.deepEqual((await run('2026-11-28T06:00:00Z',{state:us()})).asked,['us']);
  assert.deepEqual((await run('2026-11-28T18:30:00Z',{state:us()})).asked,['screen:us']);
});

test('a screen never becomes a send proof, also on Saturday afternoon',async()=>{
  setSendPolicy({saturday:true});
  const r=await run('2026-11-28T19:00:00Z');
  for(const p of Object.values(r.state.prospects)){assert.equal(p.recipient_proof,undefined);assert.equal(p.prescreen.result,'valid');assert.equal(p.status,'ready')}
  assert.equal(r.stats.screened,2);assert.equal(r.stats.checked,0);
});
