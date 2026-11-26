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
export const WAKER={minGapHours:2,maxWaitHours:5.5,recentHours:1.5,keepaliveHours:5};

/**
 * When should the next cycle start? At the next recipient send window if pitches are queued (but at least
 * minGapHours after the last cycle), and never later than keepaliveHours after it, so prospecting, reply
 * reading and link checks keep running even when GitHub skips the schedule.
 */
export function planWake(summary,now=Date.now(),{minGapHours=WAKER.minGapHours,keepaliveHours=WAKER.keepaliveHours,after=null}={}){
  if(!summary?.generated_at)return {wake:false,reason:'no published summary'};
  if(summary.dry_run)return {wake:false,reason:'last cycle was a dry run'};
  const last=Date.parse(summary.generated_at),base=Number.isFinite(last)?last:now;
  const o=summary.outreach||{},next=Date.parse(o.next_send_at||'');
  const sending=summary.capabilities?.outreach_mode==='send'&&o.ready>0&&(!o.reply_health||o.reply_health==='ok')&&Number.isFinite(next);
  const keepalive=base+keepaliveHours*36e5;
  const window=sending&&next<keepalive;
  // `after`: when the waker itself started the previous cycle. Even if that cycle published nothing (it failed),
  // the next one is never started sooner than minGapHours after it, so the chain cannot spin.
  const started=Date.parse(after||''),notBefore=Number.isFinite(started)?started+minGapHours*36e5:0;
  const at=Math.max(window?next:keepalive,base+minGapHours*36e5,notBefore,now);
  return {wake:true,at:new Date(at).toISOString(),wait_s:Math.max(0,Math.round((at-now)/1000)),
    reason:window?`${o.ready} pitches queued; next send window ${new Date(next).toISOString().slice(0,16)}Z`:`keep-alive: next cycle ${keepaliveHours} h after the last one`};
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
