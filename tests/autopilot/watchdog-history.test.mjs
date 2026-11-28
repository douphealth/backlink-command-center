import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sendsOn,dailyEntry,recordDiscovery,paidDiscoveryBreaker,replySignals,inSendWindow,isWeekday} from '../../scripts/autopilot/health.mjs';
import {runAutopilot} from '../../scripts/autopilot/run.mjs';

const at=s=>new Date(s);
const sends={prospects:{
  a:{status:'followed_up',history:[{type:'initial',at:'2026-11-18T09:00:00Z',mode:'send'},{type:'followup',at:'2026-11-25T09:00:00Z',mode:'send'},{type:'reply',at:'2026-11-25T11:00:00Z'}]},
  b:{status:'sent',history:[{type:'initial',at:'2026-11-25T13:00:00Z',mode:'send'}]},
  c:{status:'drafted',history:[{type:'initial',at:'2026-11-25T13:00:00Z',mode:'draft'}]},
  d:{status:'sent',history:[{type:'initial',at:'2026-11-24T13:00:00Z',mode:'send',reconciled:true}]}}};

test('real sends are counted per UTC day; drafts never count',()=>{
  assert.deepEqual(sendsOn(sends,'2026-11-25'),{first_pitches:1,followups:1,sent:2});
  assert.deepEqual(sendsOn(sends,'2026-11-24'),{first_pitches:1,followups:0,sent:1});
  assert.equal(isWeekday('2026-11-27'),true);assert.equal(isWeekday('2026-11-28'),false);assert.equal(isWeekday(at('2026-11-29T23:00:00Z')),false);
});
test('the daily history entry is overwritten per cycle and adds up the day\'s cycles (counts only)',()=>{
  const base={date:'2026-11-25',ready:60,contacted:50,spend_usd:0};
  const first=dailyEntry(null,base,{state:sends,newWithEmail:3,readySendable:20,inWindow:false,cap:12,verifierUsed:6});
  assert.deepEqual(first,{...base,first_pitches:1,followups:1,sent:2,verifier_used:6,new_with_email:3,ready_sendable:20,cycles:1,in_window_cycles:0,cap:12});
  const second=dailyEntry(first,{...base,contacted:51},{state:sends,newWithEmail:2,readySendable:18,inWindow:true,cap:12,verifierUsed:14});
  assert.equal(second.cycles,2);assert.equal(second.in_window_cycles,1);assert.equal(second.new_with_email,5);assert.equal(second.verifier_used,14);assert.equal(second.contacted,51);
  const nextDay=dailyEntry(second,{...base,date:'2026-11-26'},{state:sends,inWindow:true});
  assert.equal(nextDay.cycles,1,'a new UTC day starts fresh');assert.equal(nextDay.new_with_email,0);assert.equal(nextDay.sent,0);assert.ok(!('cap' in nextDay));
  for(const v of Object.values(second))assert.ok(typeof v==='number'||typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v),String(v));
});
test('discovery is logged per cycle (last 12, counts only)',()=>{
  const state={};
  const e=recordDiscovery(state,{stages:{prospects:{ok:true,result:{queries:10,fallback_queries:2,candidates:7,new_domains:4,linkgap_calls:1,with_email:3}},second_look:{ok:true,result:{found:2}}},spentUsd:0.123456,now:at('2026-11-25T10:00:00Z')});
  assert.deepEqual(e,{at:'2026-11-25T10:00:00.000Z',paid_queries:8,candidates:7,serp_candidates:4,linkgap_calls:1,with_email:5,spend:0.1235});
  for(let i=0;i<14;i++)recordDiscovery(state,{now:at(`2026-11-26T${String(i).padStart(2,'0')}:00:00Z`)});
  assert.equal(state.discovery_log.length,12);assert.equal(state.discovery_log.at(-1).with_email,0,'a skipped prospects stage records zero inflow');
});
test('3 cycles of paid searches finding nothing pause paid search for 3 days, once',()=>{
  const state={},log=(t,q,c)=>recordDiscovery(state,{stages:{prospects:{ok:true,result:{queries:q,new_domains:c,candidates:c}}},spentUsd:0.12,now:at(t)});
  log('2026-11-24T08:00:00Z',8,0);log('2026-11-24T13:00:00Z',0,0);log('2026-11-24T18:00:00Z',8,0);
  assert.equal(paidDiscoveryBreaker(state,{now:at('2026-11-24T18:01:00Z')}).dead,false,'2 paid cycles are not enough; cycles without paid searches do not count');
  log('2026-11-25T08:00:00Z',8,0);
  const r=paidDiscoveryBreaker(state,{now:at('2026-11-25T08:01:00Z')});
  assert.deepEqual(r,{dead:true,paused_until:'2026-11-28T08:01:00.000Z',at:'2026-11-25T08:01:00.000Z',cycles:3,queries:24,spend_usd:0.36,paused_now:true});
  assert.equal(state.paid_serp_paused_until,'2026-11-28T08:01:00.000Z');
  const during=paidDiscoveryBreaker(state,{now:at('2026-11-26T10:00:00Z')});assert.equal(during.dead,true);assert.equal(during.paused_now,false);assert.equal(during.queries,24);
  assert.equal(paidDiscoveryBreaker(state,{now:at('2026-11-28T09:00:00Z')}).dead,false,'old evidence never re-arms an expired pause');
  assert.equal(state.paid_serp_paused_until,'2026-11-28T08:01:00.000Z');
});
test('a paid cycle that finds new sites breaks the run',()=>{
  const state={},log=(t,q,c)=>recordDiscovery(state,{stages:{prospects:{ok:true,result:{queries:q,new_domains:c}}},now:at(t)});
  log('2026-11-24T08:00:00Z',8,0);log('2026-11-24T13:00:00Z',8,3);log('2026-11-24T18:00:00Z',8,0);log('2026-11-25T08:00:00Z',8,0);
  assert.equal(paidDiscoveryBreaker(state,{now:at('2026-11-25T08:01:00Z')}).dead,false);assert.equal(state.paid_serp_paused_until,undefined);
});
test('reply signals count owner decisions by condition, their age, and unanswered replies',()=>{
  const state={prospects:{
    a:{needs_owner:true,condition:'paid',last_reply_at:'2026-11-24T14:07:00Z',awaiting_us:true},
    b:{needs_owner:true,condition:'guest_post',replied_at:'2026-11-26T09:00:00Z'},
    c:{needs_owner:true,condition:'paid',owner_decided_at:'2026-11-26T00:00:00Z',awaiting_us:true,last_reply_at:'2026-11-25T00:00:00Z'},
    d:{awaiting_us:true,last_reply_at:'2026-11-25T08:00:00Z',reply_draft:{for:'<m>',at:'2026-11-25T09:00:00Z',mode:'draft'}},
    e:{awaiting_us:true,last_reply_at:'2026-11-26T08:00:00Z',reply_draft:{for:'<m>',at:'2026-11-25T09:00:00Z',mode:'draft'}},
    f:{needs_owner:true,condition:'<b>weird</b>'}}};
  assert.deepEqual(replySignals(state,at('2026-11-27T15:00:00Z')),{owner_conditions:{paid:1,guest_post:1,other:1},owner_oldest_days:3,replies_unanswered:3,replies_drafted:1});
  assert.deepEqual(replySignals({},at('2026-11-27T15:00:00Z')),{owner_conditions:{},owner_oldest_days:null,replies_unanswered:0,replies_drafted:0});
});
test('a cycle is "in window" when a queued inbox is inside its business hours',()=>{
  const state={prospects:{a:{status:'ready',email:'e@a.co.uk',domain:'a.co.uk'},b:{status:'sent',email:'e@b.com',domain:'b.com'}}};
  assert.equal(inSendWindow(state,at('2026-11-25T10:00:00Z')),true);
  assert.equal(inSendWindow(state,at('2026-11-25T20:00:00Z')),false,'outside UK hours; the US prospect is not queued');
  assert.equal(inSendWindow(state,at('2026-11-28T10:00:00Z')),true,'Saturday morning in the UK');
  assert.equal(inSendWindow(state,at('2026-11-28T13:00:00Z')),false,'Saturday afternoon');
  assert.equal(inSendWindow(state,at('2026-11-29T10:00:00Z')),false,'Sunday');
});
test('the workflow alerts the owner after every real cycle from its own least-privilege job, without failing the cycle',()=>{
  const y=readFileSync(new URL('../../.github/workflows/autopilot.yml',import.meta.url),'utf8');
  // Workflow default is read-only; only the alert job's token may write issues (SEC-2), and the cycle job keeps what it uses.
  assert.match(y,/^permissions:\n\s+contents: read\n/m);
  const cycle=y.slice(y.indexOf('  autopilot:'),y.indexOf('  alert:')),alert=y.slice(y.indexOf('  alert:'));
  assert.match(cycle,/permissions:\n\s+contents: write\n\s+id-token: write/);assert.doesNotMatch(cycle,/issues: write/);
  assert.match(cycle,/due: \$\{\{ steps\.due\.outputs\.due \}\}/);
  const keep=cycle.slice(cycle.indexOf('- name: Keep the public summary'));
  assert.ok(cycle.indexOf('- name: Keep the public summary')>cycle.indexOf('- name: Commit results'),'kept after the commit step');
  assert.match(keep,/if: \$\{\{ always\(\) && steps\.due\.outputs\.due == 'true' && !inputs\.dry_run \}\}/);assert.match(keep,/path: public\/data\/autopilot\.json/);
  assert.match(alert,/needs: autopilot/);assert.match(alert,/if: \$\{\{ always\(\) && needs\.autopilot\.outputs\.due == 'true' && !inputs\.dry_run \}\}/);
  assert.match(alert,/permissions:\n\s+contents: read\n\s+issues: write/);assert.match(alert,/persist-credentials: false/);assert.doesNotMatch(alert,/npm ci|LINKFORGE_DATA_KEY/);
  const step=alert.slice(alert.indexOf('- name: Alert the owner'));
  assert.match(step,/continue-on-error: true/);assert.match(step,/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step,/LINKFORGE_ALERT_MENTION: \$\{\{ vars\.LINKFORGE_ALERT_MENTION \}\}/);assert.match(step,/run: node scripts\/autopilot\/notify\.mjs cycle-summary\/autopilot\.json/);
});
test('a full cycle publishes the outcome history, the outreach split and passes the watchdog inputs',async()=>{
  const resp=(body,{status=200,type='text/html'}={})=>new Response(body,{status,headers:{'content-type':type}});
  const f=async url=>{const u=new URL(url);if(u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${u.hostname}/guide/</loc></url></urlset>`,{type:'application/xml'});
    if(/\.(xml|txt)$/.test(u.pathname))return resp('',{status:404});return resp(`<html><head><title>Mouse proofing guide</title></head><body><main><h1>Guide</h1><p>${'word '.repeat(900)}</p></main></body></html>`)};
  const mailer={check:async()=>({status:'connected'}),send:async()=>{throw Error('must not send')},draft:async()=>{},imap:{recentHeaders:async()=>[],sentRecipients:async()=>[]},close:async()=>{}};
  const {summary,state}=await runAutopilot({env:{LINKFORGE_DATA_KEY:'k'.repeat(24),LINKFORGE_VAULT_RESET_AT:new Date(Date.now()+1e3).toISOString(),SENDER_NAME:'Alex',OUTREACH_MODE:'draft',OUTREACH_HOLD:'YES'},
    argv:[],fetchImpl:f,mailer,write:false,useCache:false});
  assert.equal(summary.funnel_stale,false);
  const h=summary.history.at(-1);assert.equal(h.date,new Date().toISOString().slice(0,10));
  for(const k of ['first_pitches','followups','sent','verifier_used','new_with_email','cycles','in_window_cycles','cap'])assert.equal(typeof h[k],'number',k);
  assert.equal(h.first_pitches,0);assert.ok(h.in_window_cycles>=0&&h.cycles>=1);
  for(const k of ['sendable_now','retry_later','held_permanent','to_verify'])assert.equal(summary.outreach[k],0,k);
  assert.deepEqual(summary.outreach.by_writer,{});assert.deepEqual(summary.outreach.retired_by_reason,{});
  assert.equal(state.discovery_log.length,1);
  assert.ok(!summary.attention.some(a=>['sending_stalled','low_throughput','vault_locked'].includes(a.code)),summary.attention.map(a=>a.code).join());
  assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(JSON.stringify(summary)),'no email in the public summary');
});
