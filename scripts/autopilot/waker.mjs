#!/usr/bin/env node
/**
 * Send-window waker. GitHub runs the hourly schedule only 2–3 times a day at random hours
 * (measured Nov 2026), so verified pitches waited for a cycle that happened to land inside the
 * recipient's business hours. After each cycle, .github/workflows/autopilot-waker.yml asks this
 * module when the next send window opens, waits (free on public repositories) and starts a cycle.
 *
 *   node scripts/autopilot/waker.mjs plan     -> prints wake=true|false, wait_s, at, reason (GITHUB_OUTPUT format)
 *   node scripts/autopilot/waker.mjs recheck  -> exit 0 to start the cycle, 1 to skip (a cycle ran meanwhile)
 */
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// keepaliveHours: GitHub dropped every scheduled slot for 10+ hours on 2026-11-25, so the waker is now the
// primary scheduler: the next cycle always starts within this many hours of the last one (cron is the backup).
// Saturday mornings (09-13 in the recipient's own time zones, DST included: in winter UK 09-13, Germany 08-12, US 17-18 UTC, where
// 09-13 holds on both coasts) are send windows unless the owner turned them off, so
// Saturday cycles come from next_send_at like any weekday's; Friday's and Saturday's credits back those sends.
// sundayHours: Sunday never sends, but its free credits can verify inboxes whose Monday window opens within 20 h.
// Pre-verify runs every cycle, so a few Sunday cycles from 11:00 UTC (EU Monday 07:00 is then 20 h away; the 19:00
// cycle reaches the US Monday window) spend them.
export const WAKER={minGapHours:2,maxWaitHours:5.5,recentHours:1.5,keepaliveHours:5,sundayHours:[11,15,19]};

/** The first Sunday verification slot (UTC) at or after `from` on the same Sunday, or null. */
export function sundaySlot(from,hours=WAKER.sundayHours){
  const d=new Date(from);if(!Number.isFinite(d.getTime())||d.getUTCDay()!==0)return null;
  for(const h of hours){const t=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),h);if(t>=from)return t}
  return null;
}

/**
 * When should the next cycle start? At the next recipient send window if pitches are queued (but at least
 * minGapHours after the last cycle), and never later than keepaliveHours after it, so prospecting, reply
 * reading and link checks keep running even when GitHub skips the schedule. The window comes from the cycle's own
 * next_send_at, so a Saturday-morning window is planned like a weekday one (and not at all once the owner turns
 * Saturday sending off). On Sundays with inboxes queued, the next Sunday verification slot is used instead of the
 * keep-alive when it comes first.
 */
export function planWake(summary,now=Date.now(),{minGapHours=WAKER.minGapHours,keepaliveHours=WAKER.keepaliveHours,after=null,sundayHours=WAKER.sundayHours}={}){
  if(!summary?.generated_at)return {wake:false,reason:'no published summary'};
  if(summary.dry_run)return {wake:false,reason:'last cycle was a dry run'};
  const last=Date.parse(summary.generated_at),base=Number.isFinite(last)?last:now;
  const o=summary.outreach||{},next=Date.parse(o.next_send_at||'');
  const sending=summary.capabilities?.outreach_mode==='send'&&o.ready>0&&(!o.reply_health||o.reply_health==='ok')&&Number.isFinite(next);
  const keepalive=base+keepaliveHours*36e5;
  // The reply scan failed (mailbox timeout): sending was blocked, so try again at the minimum gap.
  const retry=summary.capabilities?.outreach_mode==='send'&&o.ready>0&&o.reply_health==='failed';
  const window=(sending&&next<keepalive)||retry;
  // `after`: when the waker itself started the previous cycle. Even if that cycle published nothing (it failed),
  // the next one is never started sooner than minGapHours after it, so the chain cannot spin.
  const started=Date.parse(after||''),notBefore=Number.isFinite(started)?started+minGapHours*36e5:0;
  // Sunday: with inboxes queued, the next verification slot replaces the keep-alive when it comes first (gaps unchanged).
  const sunday=!window&&!retry&&summary.capabilities?.outreach_mode==='send'&&o.ready>0?sundaySlot(Math.max(base+minGapHours*36e5,notBefore,now),sundayHours):null;
  const onSunday=sunday!=null&&sunday<keepalive;
  const at=Math.max(retry?0:window?next:onSunday?sunday:keepalive,base+minGapHours*36e5,notBefore,now);
  return {wake:true,at:new Date(at).toISOString(),wait_s:Math.max(0,Math.round((at-now)/1000)),
    reason:retry?`${o.ready} pitches queued; the last reply scan failed, retrying`:window?`${o.ready} pitches queued; next send window ${new Date(next).toISOString().slice(0,16)}Z`
      :onSunday?`Sunday verification cycle (${new Date(sunday).toISOString().slice(11,16)}Z): today's free checks prepare Monday's send windows`:`keep-alive: next cycle ${keepaliveHours} h after the last one`};
}

/** Has a cycle published results since `after` (ISO time)? */
export function isFresh(summary,after){
  const a=Date.parse(after||''),g=Date.parse(summary?.generated_at||'');
  return Number.isFinite(a)&&Number.isFinite(g)&&g>a;
}
/** After waiting: skip if another cycle already ran meanwhile (e.g. the backup schedule fired). */
export function shouldStillWake(summary,now=Date.now(),{recentHours=WAKER.recentHours}={}){
  if(!summary?.generated_at||summary.dry_run)return false;
  return now-Date.parse(summary.generated_at)>=recentHours*36e5;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  let summary=null;try{summary=JSON.parse(readFileSync(resolve(root,'public/data/autopilot.json'),'utf8'))}catch{}
  if(process.argv[2]==='recheck'){
    const go=shouldStillWake(summary);console.error(go?'Starting a send-window cycle':'Skipped: a cycle ran meanwhile or sending is off');process.exit(go?0:1);
  }
  if(process.argv[2]==='fresh')process.exit(isFresh(summary,process.argv[3])?0:1);
  const p=planWake(summary,Date.now(),{after:process.env.WAKER_AFTER||null});
  console.error(`waker: ${p.wake?`wake at ${p.at} (in ${Math.round(p.wait_s/60)} min)`:'no wake'}: ${p.reason}`);
  console.log(`wake=${p.wake}\nwait_s=${p.wait_s||0}\nat=${p.at||''}`);
}
