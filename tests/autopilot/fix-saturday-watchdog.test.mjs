// Review fix (coverage F5): with Saturday mornings as send windows, Saturday is a send day for the outcome watchdog too.
// A Saturday on which nothing could be sent is noticed; Sunday stays quiet; with SATURDAY_SENDS=NO Saturday stays quiet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnose,watchdogStatus,isSendDay} from '../../scripts/autopilot/health.mjs';
import {sendWindowOpen,setSendPolicy} from '../../scripts/autopilot/outreach.mjs';

const SAT='2026-11-28T10:00:00Z';
const stalled=(signals={},history)=>({capabilities:{verifier:{ready:true,used_today:25,daily_limit:25},daily_send_cap:12},
  outreach:{mode:'send',verified_ready:0,holds:{mailbox_unknown:3}},funnel:{ready:60,contacted:49},held:false,
  history:history||[{date:'2026-11-26',contacted:49,in_window_cycles:3,sent:2,cap:12},{date:'2026-11-27',contacted:49,in_window_cycles:3,sent:0,cap:12,verifier_used:25},
    {date:'2026-11-28',contacted:49,in_window_cycles:2,sent:0,cap:12,verifier_used:25}],
  signals:{now:'2026-11-29T09:00:00Z',mode:'send',hold:false,dry_run:false,vault:{key:true,open:true},...signals}});

test('watchdogStatus: a Saturday is not "weekend" while Saturday mornings send; Sunday is',()=>{
  setSendPolicy({saturday:true});
  assert.equal(sendWindowOpen('blog.de',new Date(SAT)),true);
  assert.deepEqual(watchdogStatus({signals:{now:SAT,mode:'send',vault:{open:true}}}),{quiet:false,vault_open:true,send_attempted:false});
  assert.equal(watchdogStatus({signals:{now:SAT,mode:'send',saturday:false,vault:{open:true}}}).reason,'weekend');
  assert.equal(watchdogStatus({signals:{now:'2026-11-29T10:00:00Z',mode:'send',vault:{open:true}}}).reason,'weekend');
  assert.equal(isSendDay('2026-11-28'),true);assert.equal(isSendDay('2026-11-28',false),false);assert.equal(isSendDay('2026-11-29'),false);assert.equal(isSendDay('2026-11-27',false),true);
});

test('sending_stalled counts a Saturday with open windows as a day that could have sent, and says "send days"',()=>{
  // Monday 11-30: Friday and Saturday had in-window cycles and nobody new was emailed.
  const d=diagnose(stalled({now:'2026-11-30T09:00:00Z'},[{date:'2026-11-26',contacted:49,in_window_cycles:3,sent:2,cap:12},
    {date:'2026-11-27',contacted:49,in_window_cycles:3,sent:0,cap:12,verifier_used:25},{date:'2026-11-28',contacted:49,in_window_cycles:2,sent:0,cap:12,verifier_used:25},{date:'2026-11-29',contacted:49}]));
  const s=d.find(x=>x.code==='sending_stalled');assert.ok(s,d.map(x=>x.code).join());assert.match(s.message,/last 2 send days/);
  // With Saturday sending off the same history has only one stalled weekday (Friday), so nothing is raised yet.
  assert.ok(!diagnose(stalled({now:'2026-11-30T09:00:00Z',saturday:false},[{date:'2026-11-26',contacted:49,in_window_cycles:3,sent:2,cap:12},
    {date:'2026-11-27',contacted:49,in_window_cycles:3,sent:0,cap:12,verifier_used:25},{date:'2026-11-28',contacted:49,in_window_cycles:2,sent:0,cap:12,verifier_used:25},{date:'2026-11-29',contacted:49}])).some(x=>x.code==='sending_stalled'));
  // Sunday itself never raises it.
  assert.ok(!diagnose(stalled()).some(x=>x.code==='sending_stalled'),'Sunday');
});
