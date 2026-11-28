import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnose} from '../../scripts/autopilot/health.mjs';

// 2026-11-23 is a Monday, 11-25 a Wednesday, 11-28 a Saturday.
const MiB=1048576;
const codes=d=>d.map(x=>x.code);
const find=(d,code)=>d.find(x=>x.code===code);
/** Send mode, verifier ready, 60 ready, and nobody new emailed on Mon 11-23 and Tue 11-24 (both had in-window cycles). */
const stalled=(over={})=>({
  capabilities:{verifier:{ready:true,used_today:25,daily_limit:25},daily_send_cap:12},
  outreach:{mode:'send',verified_ready:0,holds:{catch_all_domain:12,mailbox_unknown:3}},
  funnel:{ready:60,contacted:49},held:false,
  history:[{date:'2026-11-20',contacted:47,in_window_cycles:3,sent:2,cap:12},{date:'2026-11-21',contacted:49},{date:'2026-11-22',contacted:49},
    {date:'2026-11-23',contacted:49,in_window_cycles:3,verifier_used:25,sent:0,cap:12},{date:'2026-11-24',contacted:49,in_window_cycles:4,verifier_used:24,sent:0,cap:12}],
  signals:{now:'2026-11-25T14:00:00Z',mode:'send',hold:false,dry_run:false,vault:{key:true,open:true}},...over});
const withSignals=(extra,over={})=>{const b=stalled(over);return {...b,signals:{...b.signals,...extra}}};

test('sending_stalled fires after 2 in-window weekdays with no new publisher, naming the top hold and the credits used',()=>{
  const d=diagnose(stalled()),s=find(d,'sending_stalled');
  assert.ok(s,codes(d).join());assert.equal(s.level,'action');
  assert.match(s.message,/last 2 weekdays/);assert.match(s.message,/60 prospects are ready/);
  assert.match(s.message,/mail server accepts every address.*\(12\)/,'names the top hold reason');
  assert.match(s.message,/49 verification credits were used on those days \(daily limit 25\)/);
  assert.match(s.fix,/OUTREACH_HOLD=YES/);
  assert.ok(!find(d,'low_throughput'),'a stall is not also reported as low throughput');
  // The outreach stage's own skip reason is the most useful clue.
  assert.match(find(diagnose({...stalled(),stages:{outreach:{ok:null,skipped:'SENDER_NAME not set'}}}),'sending_stalled').message,/skipped: SENDER_NAME not set/);
});
test('sending_stalled stays quiet on weekends, deliberate holds, dry runs, other modes and a locked vault',()=>{
  assert.ok(!find(diagnose(withSignals({now:'2026-11-28T14:00:00Z',saturday:false})),'sending_stalled'),'Saturday with Saturday sending off (with it on, Saturday is a send day: fix-saturday-watchdog)');
  assert.ok(!find(diagnose(withSignals({now:'2026-11-29T14:00:00Z'})),'sending_stalled'),'Sunday');
  assert.ok(!find(diagnose(withSignals({hold:true})),'sending_stalled'),'OUTREACH_HOLD');
  assert.ok(!find(diagnose(withSignals({mode:'off'})),'sending_stalled'),'outreach off');
  assert.ok(!find(diagnose(withSignals({mode:'draft'})),'sending_stalled'),'draft mode');
  assert.ok(!find(diagnose(withSignals({dry_run:true})),'sending_stalled'),'dry run');
  assert.ok(!find(diagnose(withSignals({vault:{key:true,open:false}})),'sending_stalled'),'locked vault: numbers are stale');
});
test('sending_stalled needs real evidence: a new pitch, held days, an old stretch or a cap used by follow-ups do not fire',()=>{
  assert.ok(!find(diagnose(stalled({funnel:{ready:60,contacted:50}})),'sending_stalled'),'someone new was emailed');
  const heldDays=stalled();heldDays.history=heldDays.history.map(h=>h.date>='2026-11-23'?{...h,in_window_cycles:0}:h);
  assert.ok(!find(diagnose(heldDays),'sending_stalled'),'days without an in-window send-mode cycle (e.g. held) are not counted');
  assert.ok(!find(diagnose(withSignals({now:'2026-12-02T14:00:00Z'})),'sending_stalled'),'the last counted day must be recent');
  const capped=stalled();capped.history=capped.history.map(h=>h.date>='2026-11-23'?{...h,sent:12}:h);
  assert.ok(!find(diagnose(capped),'sending_stalled'),'follow-ups filled the daily cap');
  assert.ok(!find(diagnose(stalled({funnel:{ready:0,contacted:49}})),'sending_stalled'),'nothing is ready');
  assert.ok(!find(diagnose(stalled({capabilities:{verifier:{ready:false}}})),'sending_stalled'),'verifier not ready (verifier_off covers it)');
  assert.ok(!find(diagnose(stalled({history:stalled().history.slice(3)})),'sending_stalled'),'no baseline day before the stretch');
  assert.ok(find(diagnose(withSignals({now:'2026-11-30T09:00:00Z'},{history:[...stalled().history.slice(0,3),{date:'2026-11-26',contacted:49,in_window_cycles:2},{date:'2026-11-27',contacted:49,in_window_cycles:2}]})),'sending_stalled'),'Thursday and Friday stall is raised on Monday');
});

/** Contacted grows, but only 12 of a possible 60 emails went out over the last 5 in-window weekdays. */
const slow=(over={})=>({capabilities:{verifier:{ready:true,daily_limit:25},daily_send_cap:12},outreach:{mode:'send'},funnel:{ready:40,contacted:49},held:false,
  history:[{date:'2026-11-16',contacted:40,in_window_cycles:2,sent:1,cap:12},{date:'2026-11-17',contacted:42,in_window_cycles:3,sent:3,cap:12,verifier_used:25},{date:'2026-11-18',contacted:44,in_window_cycles:3,sent:2,cap:12,verifier_used:25},
    {date:'2026-11-19',contacted:45,in_window_cycles:3,sent:2,cap:12,verifier_used:20},{date:'2026-11-20',contacted:47,in_window_cycles:3,sent:3,cap:12,verifier_used:25},{date:'2026-11-21',contacted:47},{date:'2026-11-22',contacted:47},
    {date:'2026-11-23',contacted:49,in_window_cycles:3,sent:2,cap:12,verifier_used:24}],
  signals:{now:'2026-11-24T10:00:00Z',mode:'send',vault:{key:true,open:true}},...over});
test('low_throughput warns when 5 weekdays sent under 40% of the cap while prospects are ready',()=>{
  const d=diagnose(slow()),w=find(d,'low_throughput');
  assert.ok(w,codes(d).join());assert.equal(w.level,'warn');
  assert.match(w.message,/^12 emails went out over the last 5 weekdays, 20% of the 60/);
  assert.match(w.message,/credits ran out on 3 of those days/);
  assert.ok(!find(d,'sending_stalled'));
  const busier=slow();busier.history=busier.history.map(h=>Number.isFinite(h.sent)?{...h,sent:5}:h);
  assert.ok(!find(diagnose(busier),'low_throughput'),'25 of 60 is above 40%');
});
test('low_throughput stays quiet on weekends, holds, dry runs, with too little history or nothing ready',()=>{
  const sig=x=>{const b=slow();return {...b,signals:{...b.signals,...x}}};
  assert.ok(!find(diagnose(sig({now:'2026-11-29T10:00:00Z'})),'low_throughput'),'Sunday');
  assert.ok(!find(diagnose(sig({hold:true})),'low_throughput'),'hold');
  assert.ok(!find(diagnose(sig({mode:'off'})),'low_throughput'),'outreach off');
  assert.ok(!find(diagnose(sig({dry_run:true})),'low_throughput'),'dry run');
  assert.ok(!find(diagnose(slow({history:slow().history.slice(-4)})),'low_throughput'),'fewer than 5 counted weekdays');
  assert.ok(!find(diagnose(slow({funnel:{ready:0,contacted:49}})),'low_throughput'),'nothing ready');
});

test('paid_discovery_dead reports the pause in counts and money only',()=>{
  const d=diagnose(withSignals({paid_discovery:{dead:true,cycles:3,queries:24,spend_usd:0.36,paused_until:'2026-11-28T14:00:00.000Z'}}));
  const a=find(d,'paid_discovery_dead');assert.equal(a.level,'action');
  assert.match(a.message,/last 3 cycles \(24 queries, 0\.36 USD\) found 0 new sites, so paid search is paused until 2026-11-28 14:00 UTC; free sources continue/);
  assert.ok(!find(diagnose(withSignals({paid_discovery:{dead:false}})),'paid_discovery_dead'));
});
test('vault_locked is an action and replaces the outcome rules',()=>{
  const d=diagnose(withSignals({vault:{key:true,open:false},discovery:[{with_email:0},{with_email:0},{with_email:0}]}));
  const a=find(d,'vault_locked');assert.equal(a.level,'action');assert.match(a.message,/published funnel is from an earlier cycle/);
  assert.match(a.fix,/LINKFORGE_DATA_KEY/);assert.match(a.fix,/only if the old key is truly lost/);
  assert.ok(!find(d,'prospect_inflow_low'),'inflow numbers are unknown while locked');
  assert.ok(!find(diagnose(withSignals({vault:{key:false,open:false}})),'vault_locked'),'no key at all is a setup item, not a lock');
});
test('gmail_send_blocked names the refusal without the address and picks the right fix',()=>{
  const auth=find(diagnose({...stalled(),stages:{outreach:{ok:true,result:{sent:1,send_blocked:'535 5.7.8 Username and Password not accepted for me@gmail.com'}}}}),'gmail_send_blocked');
  assert.equal(auth.level,'action');assert.doesNotMatch(auth.message,/@/);assert.match(auth.message,/\[email\]/);assert.match(auth.fix,/app password/);
  const limit=find(diagnose({stages:{outreach:{ok:true,result:{send_blocked:'daily sending limit exceeded'}}},funnel:{ready:30}}),'gmail_send_blocked');
  assert.match(limit.fix,/sending limit/);
  assert.ok(!find(diagnose({stages:{outreach:{ok:true,result:{sent:3}}},funnel:{ready:30}}),'gmail_send_blocked'));
});
test('owner_decision_pending comes first and carries counts only',()=>{
  const d=diagnose({...withSignals({owner_conditions:{paid:1,reciprocal:1},owner_oldest_days:3}),funnel:{ready:60,contacted:52,needs_owner:2}});
  assert.equal(d[0].code,'owner_decision_pending');assert.equal(d[0].level,'action');
  // Counts only: which condition each publisher attached never reaches the public summary or a GitHub issue.
  assert.match(d[0].message,/^2 publisher replies are waiting for your decision; the oldest has waited 3 days\./);assert.doesNotMatch(d[0].message,/fee|link back|guest post/i);
  assert.match(d[0].fix,/Gmail/);assert.match(d[0].fix,/Prospects tab/);
  assert.match(find(diagnose({funnel:{needs_owner:1,ready:30}}),'owner_decision_pending').message,/^1 publisher reply is waiting/);
  assert.ok(!find(diagnose({funnel:{needs_owner:0,ready:30}}),'owner_decision_pending'));
});
test('replies_waiting warns while a reply waits (also in the cycle that drafted its answer), and says why',()=>{
  const base={capabilities:{verifier:{ready:true}},funnel:{ready:30,awaiting_reply:2}};
  const none=find(diagnose(base),'replies_waiting');assert.equal(none.level,'warn');assert.match(none.message,/^2 publisher replies are waiting for an answer; no reply drafting ran this cycle\./);
  // A draft is not an answer until the owner sends it: the cycle that drafted it already tells the owner (it used to stay quiet).
  assert.match(find(diagnose({...base,signals:{replies_unanswered:2,replies_drafted:1},stages:{reply_drafts:{ok:true,result:{drafted:1,sent:0,skipped:0,owner_needed:0}}}}),'replies_waiting').message,/\(1 already drafted\)/);
  assert.match(find(diagnose({...base,signals:{reply_mode:'off'},stages:{reply_drafts:{ok:null,skipped:'REPLY_MODE=off'}}}),'replies_waiting').message,/REPLY_MODE=off/);
  assert.match(find(diagnose({...base,stages:{reply_drafts:{ok:false,error:'x'}}}),'replies_waiting').message,/drafting an answer failed/);
  assert.match(find(diagnose({...base,signals:{replies_unanswered:2,replies_drafted:2}}),'replies_waiting').message,/drafted in Gmail Drafts, waiting for you to send/);
  assert.ok(!find(diagnose({...base,signals:{replies_unanswered:0}}),'replies_waiting'),'replies that wait for an owner decision are reported there instead');
});
test('prospect_inflow_low: 3 cycles without new addresses, or fewer inboxes left than 2 days of credits',()=>{
  const zero=[{with_email:4},{with_email:0},{with_email:0},{with_email:0}];
  const a=find(diagnose(withSignals({discovery:zero})),'prospect_inflow_low');
  assert.equal(a.level,'warn');assert.match(a.message,/^No new publisher addresses were found in the last 3 cycles\./);assert.match(a.fix,/your decision/);
  assert.ok(!find(diagnose(withSignals({discovery:[...zero.slice(0,3),{with_email:2}]})),'prospect_inflow_low'));
  const pool=find(diagnose({...stalled({outreach:{mode:'send',to_verify:27}}),signals:{now:'2026-11-25T14:00:00Z',mode:'send',vault:{key:true,open:true},discovery:[{with_email:5}]}}),'prospect_inflow_low');
  assert.match(pool.message,/^Only 27 queued inboxes are left to verify, under 2 days of verification credits \(25 a day\)\./);
  assert.ok(!find(diagnose({...stalled({outreach:{mode:'send',to_verify:60}}),signals:{now:'2026-11-25T14:00:00Z',mode:'send',vault:{key:true,open:true}}}),'prospect_inflow_low'));
  assert.ok(!find(diagnose({...stalled({outreach:{mode:'off',to_verify:3}}),signals:{now:'2026-11-25T14:00:00Z',mode:'off',vault:{key:true,open:true}}}),'prospect_inflow_low'),'credits are not spent while outreach is off');
});
test('vault_size warns at 15 MiB and is an action at 22 MiB',()=>{
  assert.ok(!find(diagnose({capabilities:{verifier:{ready:true},vault_bytes:14*MiB},funnel:{ready:30}}),'vault_size'));
  const w=find(diagnose({capabilities:{verifier:{ready:true},vault_bytes:16*MiB},funnel:{ready:30}}),'vault_size');
  assert.equal(w.level,'warn');assert.match(w.message,/16\.0 MiB.*25 MiB/);
  assert.equal(find(diagnose({capabilities:{verifier:{ready:true},vault_bytes:23*MiB},funnel:{ready:30}}),'vault_size').level,'action');
});
test('sender_identity_incomplete: send mode without a postal address warns; without a sender name it is an action',()=>{
  const go=(sender,mode='send')=>find(diagnose({capabilities:{verifier:{ready:true}},funnel:{ready:30},sender,signals:{mode}}),'sender_identity_incomplete');
  const w=go({sender_name:true,postal_address:false});assert.equal(w.level,'warn');assert.match(w.message,/SENDER_POSTAL_ADDRESS/);
  assert.equal(go({sender_name:false,postal_address:false}).level,'action');
  assert.ok(!go({sender_name:true,postal_address:true}));assert.ok(!go({sender_name:true,postal_address:false},'draft'));
});
test('dataforseo_funds now says paid discovery is paused and free sources continue',()=>{
  const a=find(diagnose({capabilities:{verifier:{ready:true},connections:{dataforseo:{status:'connected',balance_usd:0}}},funnel:{ready:30}}),'dataforseo_funds');
  assert.equal(a.level,'action');assert.match(a.message,/paid search and link-gap discovery are paused; free sources .* continue/);
  assert.doesNotMatch(a.message,/no new prospects can be found/);
});
test('every new code is public-safe: no addresses, no @',()=>{
  const all=diagnose({...withSignals({owner_conditions:{paid:1},owner_oldest_days:1,paid_discovery:{dead:true,cycles:3,queries:9,spend_usd:0.1,paused_until:'2026-11-28T00:00:00Z'},
    discovery:[{with_email:0},{with_email:0},{with_email:0}],replies_unanswered:1,reply_mode:'draft',vault:{key:true,open:true}}),
    funnel:{ready:60,contacted:49,needs_owner:1,awaiting_reply:1},capabilities:{verifier:{ready:true,used_today:25,daily_limit:25},vault_bytes:23*MiB},sender:{sender_name:true,postal_address:false},
    stages:{outreach:{ok:true,result:{send_blocked:'quota for ed@pub.example exceeded'}}}});
  for(const c of ['owner_decision_pending','sending_stalled','paid_discovery_dead','prospect_inflow_low','vault_size','sender_identity_incomplete','replies_waiting','gmail_send_blocked'])assert.ok(find(all,c),c);
  assert.doesNotMatch(JSON.stringify(all),/@/);
});
