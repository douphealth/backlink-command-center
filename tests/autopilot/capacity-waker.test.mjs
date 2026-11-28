import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {planWake} from '../../scripts/autopilot/waker.mjs';
import {outreachStatus,setSendPolicy} from '../../scripts/autopilot/outreach.mjs';

const H=36e5;
const summary=(generated_at,next_send_at,over={})=>({generated_at,capabilities:{outreach_mode:'send'},outreach:{ready:12,next_send_at,reply_health:'ok'},...over});

test('waker: a Saturday-morning send window is planned like a weekday one',()=>{
  // Saturday 05:30 UTC, the UK window opens at 08:00: wake then (2 h gap and 5 h keep-alive both allow it).
  let p=planWake(summary('2026-11-28T05:30:00Z','2026-11-28T08:00:00.000Z'),Date.parse('2026-11-28T05:31:00Z'));
  assert.equal(p.at,'2026-11-28T08:00:00.000Z');assert.match(p.reason,/send window 2026-11-28T08:00Z/);
  // After the UK window, the US Saturday window (14:00 UTC).
  p=planWake(summary('2026-11-28T11:00:00Z','2026-11-28T14:00:00.000Z'),Date.parse('2026-11-28T11:01:00Z'));
  assert.equal(p.at,'2026-11-28T14:00:00.000Z');assert.match(p.reason,/send window/);
  // A window open now still waits for the 2 h gap.
  assert.equal(planWake(summary('2026-11-28T09:10:00Z','2026-11-28T09:10:00.000Z'),Date.parse('2026-11-28T09:11:00Z')).at,'2026-11-28T11:10:00.000Z');
});

// One cycle every time the waker says so: the published status comes from outreachStatus, exactly as run.mjs builds it.
const chain=(state,from,until)=>{const cycles=[];let t=Date.parse(from);
  while(t<Date.parse(until)){const o=outreachStatus(state,{limit:12,mode:'send',qualifyVersion:2,now:new Date(t)});
    const p=planWake(summary(new Date(t).toISOString(),o.next_send_at,{outreach:{...o}}),t+60e3);t=Date.parse(p.at);cycles.push({at:new Date(t).toISOString().slice(0,16),reason:p.reason})}
  return cycles};
const queued=()=>({reply_health:{status:'ok'},prospects:{uk:{status:'ready',email:'e@uk.co.uk',domain:'uk.co.uk',qv:2},us:{status:'ready',email:'e@us.com',domain:'us.com',qv:2}}});
const inside=(cycles,a,b)=>cycles.filter(c=>c.at>=a&&c.at<b);

test('waker: a chained weekend reaches both Saturday-morning windows and keeps the Sunday verification slots',()=>{
  setSendPolicy({saturday:true});
  const cycles=chain(queued(),'2026-11-27T20:30:00Z','2026-11-30T00:30:00Z');
  const forWindow=c=>/next send window/.test(c.reason);
  assert.ok(inside(cycles,'2026-11-28T08:00','2026-11-28T12:00').some(forWindow),'a cycle inside the EU Saturday window (08-12 UTC)');
  assert.ok(inside(cycles,'2026-11-28T14:00','2026-11-28T18:00').some(forWindow),'a cycle inside the US Saturday window (14-18 UTC)');
  assert.ok(!inside(cycles,'2026-11-29T00:00','2026-11-30T00:00').some(forWindow),'Sunday never has a send window');
  const sunday=inside(cycles,'2026-11-29T10:00','2026-11-29T20:00').map(c=>c.at.slice(11));
  for(const h of ['11:00','15:00','19:00'])assert.ok(sunday.includes(h),`Sunday verification slot ${h}: ${sunday}`);
  for(let i=1;i<cycles.length;i++){const d=(Date.parse(cycles[i].at)-Date.parse(cycles[i-1].at))/H;assert.ok(d>=2-1/60&&d<=5,`${cycles[i].at}: ${d} h after the last cycle`)}
});

test('waker: with Saturday sending off, Saturday has only keep-alive cycles',()=>{
  try{setSendPolicy({saturday:false});
    const sat=inside(chain(queued(),'2026-11-27T21:30:00Z','2026-11-29T00:00:00Z'),'2026-11-28T00:00','2026-11-29T00:00');
    assert.ok(sat.length>0);assert.ok(sat.every(c=>/keep-alive/.test(c.reason)),JSON.stringify(sat));
  }finally{setSendPolicy({saturday:true})}
});

// ---- The Autopilot workflow's "Is a cycle due?" step (the backup cron's 2-hour cadence) ----
const YML=readFileSync(new URL('../../.github/workflows/autopilot.yml',import.meta.url),'utf8');
function stepScript(name){
  const lines=YML.split('\n');let i=lines.findIndex(l=>l.trim()==='- name: '+name);assert.ok(i>=0,name);
  while(!/^\s+run: \|\s*$/.test(lines[i]))i++;
  const ind=lines[i].match(/^\s*/)[0].length,body=[];
  for(i++;i<lines.length;i++){const l=lines[i];if(l.trim()&&l.match(/^\s*/)[0].length<=ind)break;body.push(l)}
  const cut=Math.min(...body.filter(l=>l.trim()).map(l=>l.match(/^\s*/)[0].length));
  return body.map(l=>l.slice(cut)).join('\n');
}
const noBash=spawnSync('bash',['-c','exit 0']).status!==0&&'bash is not available';

test('"Is a cycle due?": 2-hourly extra cycles on weekdays 07-21 and Saturdays 07-18 UTC, never on Sundays',{skip:noBash},()=>{
  const script=stepScript('Is a cycle due?'),dir=mkdtempSync(join(tmpdir(),'due-'));
  // The step reads the clock with new Date() and Date.now(): a preloaded file pins both to FAKE_NOW.
  writeFileSync(join(dir,'clock.cjs'),"const T=Date.parse(process.env.FAKE_NOW),R=Date;globalThis.Date=class extends R{constructor(...a){super(...(a.length?a:[T]))}static now(){return T}};");
  mkdirSync(join(dir,'public/data'),{recursive:true});
  const due=(now,{ago=2.5,event='schedule',sender={saturday:true},file=true}={})=>{
    if(file)writeFileSync(join(dir,'public/data/autopilot.json'),JSON.stringify({generated_at:new Date(Date.parse(now)-ago*H).toISOString(),...(sender?{sender}:{})}));
    else rmSync(join(dir,'public/data/autopilot.json'),{force:true});
    writeFileSync(join(dir,'out'),'');
    const r=spawnSync('bash',['-e','-c',script],{cwd:dir,encoding:'utf8',env:{PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,GITHUB_OUTPUT:join(dir,'out'),
      EVENT:event,DRY_RUN:'0',MIN_HOURS:'5',FAKE_NOW:now,NODE_OPTIONS:`--require ${join(dir,'clock.cjs')}`}});
    assert.equal(r.status,0,r.stderr);return readFileSync(join(dir,'out'),'utf8').trim();
  };
  try{
    assert.equal(due('2026-11-28T10:00:00Z'),'due=true','Saturday morning (EU window)');
    assert.equal(due('2026-11-28T15:00:00Z'),'due=true','Saturday, US window');
    assert.equal(due('2026-11-28T07:00:00Z'),'due=true');assert.equal(due('2026-11-28T17:59:00Z'),'due=true');
    assert.equal(due('2026-11-28T18:00:00Z'),'due=false','after the last Saturday window');assert.equal(due('2026-11-28T06:59:00Z'),'due=false');
    assert.equal(due('2026-11-28T10:00:00Z',{ago:1.5}),'due=false','still at least 2 h apart');
    assert.equal(due('2026-11-28T10:00:00Z',{sender:{saturday:false}}),'due=false','Saturday sending turned off');
    assert.equal(due('2026-11-28T10:00:00Z',{sender:null}),'due=true','an older summary without the setting: Saturday is on by default');
    assert.equal(due('2026-11-29T10:00:00Z'),'due=false','Sunday: no extra cadence');
    assert.equal(due('2026-11-29T10:00:00Z',{ago:5.2}),'due=true','the 5 h rule holds every day');
    assert.equal(due('2026-11-25T20:30:00Z'),'due=true','weekdays unchanged (07-21 UTC)');assert.equal(due('2026-11-25T21:00:00Z'),'due=false');
    assert.equal(due('2026-11-28T10:00:00Z',{event:'workflow_dispatch',ago:0.1}),'due=false','a started run never follows a cycle within 10 minutes');
    assert.equal(due('2026-11-28T10:00:00Z',{event:'workflow_dispatch',ago:0.2}),'due=true');
    assert.equal(due('2026-11-28T10:00:00Z',{file:false}),'due=true','no summary yet');
  }finally{rmSync(dir,{recursive:true,force:true})}
});
