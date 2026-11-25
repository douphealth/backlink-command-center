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

export const WAKER={minGapHours:2,maxWaitHours:5.5,recentHours:1.5};

/** When should the next cycle start so queued pitches go out inside their send window? */
export function planWake(summary,now=Date.now(),{minGapHours=WAKER.minGapHours,maxWaitHours=WAKER.maxWaitHours}={}){
  const no=reason=>({wake:false,reason});
  if(!summary?.generated_at)return no('no published summary');
  if(summary.dry_run)return no('last cycle was a dry run');
  if(summary.capabilities?.outreach_mode!=='send')return no('outreach is not in hands-free send mode');
  const o=summary.outreach||{};
  if(!o.ready)return no('no pitch is queued');
  if(o.reply_health&&o.reply_health!=='ok')return no(`mailbox review is ${o.reply_health}`);
  const next=Date.parse(o.next_send_at||'');
  if(!Number.isFinite(next))return no('no send window ahead');
  const last=Date.parse(summary.generated_at);
  const at=Math.max(next,(Number.isFinite(last)?last:now)+minGapHours*36e5,now);
  const wait=at-now;
  if(wait>maxWaitHours*36e5)return no(`next send window (${new Date(at).toISOString().slice(0,16)}Z) is over ${maxWaitHours} h away; the schedule covers it`);
  return {wake:true,at:new Date(at).toISOString(),wait_s:Math.max(0,Math.round(wait/1000)),reason:`${o.ready} pitches queued; next send window ${new Date(next).toISOString().slice(0,16)}Z`};
}

/** After waiting: skip if another cycle already ran meanwhile, or sending was switched off. */
export function shouldStillWake(summary,now=Date.now(),{recentHours=WAKER.recentHours}={}){
  if(!summary?.generated_at||summary.capabilities?.outreach_mode!=='send')return false;
  return now-Date.parse(summary.generated_at)>=recentHours*36e5;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  let summary=null;try{summary=JSON.parse(readFileSync(resolve(root,'public/data/autopilot.json'),'utf8'))}catch{}
  if(process.argv[2]==='recheck'){
    const go=shouldStillWake(summary);console.error(go?'Starting a send-window cycle':'Skipped: a cycle ran meanwhile or sending is off');process.exit(go?0:1);
  }
  const p=planWake(summary);
  console.error(`waker: ${p.wake?`wake at ${p.at} (in ${Math.round(p.wait_s/60)} min)`:'no wake'}: ${p.reason}`);
  console.log(`wake=${p.wake}\nwait_s=${p.wait_s||0}\nat=${p.at||''}`);
}
