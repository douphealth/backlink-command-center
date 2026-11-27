import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {planWake,sundaySlot,WAKER} from '../../scripts/autopilot/waker.mjs';

// ---- Sunday verification cycles ----
const H=36e5;
const sunday=(over={})=>({generated_at:'2026-11-29T08:00:00Z',capabilities:{outreach_mode:'send'},
  outreach:{ready:40,next_send_at:'2026-11-30T07:00:00.000Z',reply_health:'ok'},...over});

test('Sunday: queued inboxes get verification cycles at 11, 15 and 19 UTC instead of the plain keep-alive',()=>{
  assert.deepEqual(WAKER.sundayHours,[11,15,19]);
  const p=planWake(sunday(),Date.parse('2026-11-29T08:01:00Z'));
  assert.equal(p.at,'2026-11-29T11:00:00.000Z');assert.match(p.reason,/Sunday verification cycle \(11:00Z\)/);
  assert.equal(planWake(sunday({generated_at:'2026-11-29T11:00:00Z'}),Date.parse('2026-11-29T11:05:00Z')).at,'2026-11-29T15:00:00.000Z');
  assert.equal(planWake(sunday({generated_at:'2026-11-29T15:00:00Z'}),Date.parse('2026-11-29T15:05:00Z')).at,'2026-11-29T19:00:00.000Z');
  const last=planWake(sunday({generated_at:'2026-11-29T19:00:00Z'}),Date.parse('2026-11-29T19:05:00Z'));
  assert.equal(last.at,'2026-11-30T00:00:00.000Z');assert.match(last.reason,/keep-alive/,'after the last slot: keep-alive as usual');
});

test('Sunday slots keep every existing guarantee: 2 h gap, the waker\'s own spacing, the 5 h keep-alive',()=>{
  // A slot sooner than 2 h after the last cycle is skipped for the next one; a slot later than the keep-alive loses to it.
  assert.equal(planWake(sunday({generated_at:'2026-11-29T10:30:00Z'}),Date.parse('2026-11-29T10:31:00Z')).at,'2026-11-29T15:00:00.000Z');
  assert.equal(planWake(sunday({generated_at:'2026-11-29T09:30:00Z'}),Date.parse('2026-11-29T09:31:00Z')).at,'2026-11-29T14:30:00.000Z','keep-alive first');
  assert.equal(planWake(sunday(),Date.parse('2026-11-29T08:01:00Z'),{after:'2026-11-29T08:30:00Z'}).at,'2026-11-29T11:00:00.000Z');
  const spaced=planWake(sunday(),Date.parse('2026-11-29T08:01:00Z'),{after:'2026-11-29T09:30:00Z'});
  assert.equal(spaced.at,'2026-11-29T13:00:00.000Z','the 11:00 slot is inside 2 h of a cycle the waker started: the keep-alive comes first');assert.match(spaced.reason,/keep-alive/);
  for(let m=0;m<24*60;m+=17){
    const g=new Date(Date.parse('2026-11-29T00:00:00Z')+m*60e3).toISOString(),p=planWake(sunday({generated_at:g}),Date.parse(g)+60e3),d=Date.parse(p.at)-Date.parse(g);
    assert.ok(d>=2*H&&d<=5*H,`${g}: next cycle ${d/H} h later`);
  }
  // Nothing queued, sending off, or not Sunday: unchanged behaviour.
  for(const s of [sunday({outreach:{ready:0,next_send_at:null,reply_health:'ok'}}),sunday({capabilities:{outreach_mode:'off'}}),sunday({generated_at:'2026-11-28T08:00:00Z'})])
    assert.match(planWake(s,Date.parse(s.generated_at)+60e3).reason,/keep-alive/);
  // A real send window (AU/NZ Monday opens Sunday 21:00 UTC) still wins.
  assert.match(planWake(sunday({generated_at:'2026-11-29T19:00:00Z',outreach:{ready:5,next_send_at:'2026-11-29T21:00:00Z',reply_health:'ok'}}),Date.parse('2026-11-29T19:01:00Z')).reason,/send window/);
  assert.equal(sundaySlot(Date.parse('2026-11-28T12:00:00Z')),null);assert.equal(sundaySlot(Date.parse('2026-11-29T19:00:01Z')),null);assert.equal(sundaySlot(NaN),null);
});

test('a whole weekend of chained cycles spends Sunday\'s credits in about 3 cycles from 11:00 UTC',()=>{
  let t=Date.parse('2026-11-28T21:40:00Z');const cycles=[];
  while(t<Date.parse('2026-11-30T00:30:00Z')){const p=planWake(sunday({generated_at:new Date(t).toISOString()}),t+60e3);t=Date.parse(p.at);cycles.push(new Date(t).toISOString().slice(0,16))}
  const fromEleven=cycles.filter(c=>c>='2026-11-29T11:00'&&c<'2026-11-30T00:00');
  assert.deepEqual(fromEleven,['2026-11-29T11:00','2026-11-29T15:00','2026-11-29T19:00']);
});

// ---- The workflow ----
const YML=readFileSync(new URL('../../.github/workflows/autopilot-waker.yml',import.meta.url),'utf8');
/** The `run: |` script of a named step, de-indented. */
function stepScript(name){
  const lines=YML.split('\n');let i=lines.findIndex(l=>l.trim()==='- name: '+name);assert.ok(i>=0,name);
  while(!/^\s+run: \|\s*$/.test(lines[i]))i++;
  const ind=lines[i].match(/^\s*/)[0].length,body=[];
  for(i++;i<lines.length;i++){const l=lines[i];if(l.trim()&&l.match(/^\s*/)[0].length<=ind)break;body.push(l)}
  const cut=Math.min(...body.filter(l=>l.trim()).map(l=>l.match(/^\s*/)[0].length));
  return body.map(l=>l.slice(cut)).join('\n');
}

test('waker workflow: job-level concurrency that never cancels, so a skipped or failed waker cannot kill the live chain',()=>{
  assert.ok(!/^concurrency:/m.test(YML),'no workflow-level concurrency (a run with a skipped job used to cancel the live chain)');
  assert.match(YML,/\n  wake:\n    if: github\.event_name == 'workflow_dispatch' \|\| \(github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(YML,/\n    concurrency:\n      group: linkforge-waker\n      cancel-in-progress: false\n/);
  assert.ok(!/cancel-in-progress: true/.test(YML));
  const start=stepScript('Start an Autopilot cycle and the next waker');
  assert.match(start,/retry gh workflow run autopilot\.yml --ref main/);assert.match(start,/retry gh workflow run autopilot-waker\.yml --ref main -f after="\$STARTED"/);
  assert.match(stepScript('Wait until the next cycle is due (re-planned every 10 minutes from the newest results)'),/sleep \$\(\( WAIT < 600 \? WAIT : 600 \)\)/);
});

// The two scripts run under bash -e (as on GitHub) with gh, git, node, date and sleep replaced by local stubs.
const noBash=spawnSync('bash',['-c','exit 0']).status!==0&&'bash is not available';
function harness(){
  const dir=mkdtempSync(join(tmpdir(),'waker-')),bin=join(dir,'bin'),log=join(dir,'calls.log');
  mkdirSync(bin,{recursive:true});
  const stub=(name,body)=>{writeFileSync(join(bin,name),`#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);chmodSync(join(bin,name),0o755)};
  // Each counter file holds how many more calls fail.
  const failing=f=>`n=$(cat "${dir}/${f}" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then echo $((n-1)) > "${dir}/${f}"; exit 1; fi; exit 0`;
  stub('gh',`case "$*" in\n  "workflow run autopilot.yml"*) ${failing('ap_fail')} ;;\n  "workflow run autopilot-waker.yml"*) ${failing('wk_fail')} ;;\n  api*) cat "${dir}/state" 2>/dev/null; exit 0 ;;\nesac\nexit 1`);
  stub('git','exit 0');stub('sleep','exit 0');
  stub('date',`case "$1" in\n  +%s) n=$(cat "${dir}/clock" 2>/dev/null || echo 1000); s=$(cat "${dir}/step" 2>/dev/null || echo 1); echo $((n+s)) > "${dir}/clock"; echo "$n" ;;\n  *) echo 2026-11-29T11:00:00Z ;;\nesac`);
  stub('node',`case "$*" in\n  *recheck*) exit $(cat "${dir}/recheck" 2>/dev/null || echo 0) ;;\n  *plan*) n=$(cat "${dir}/plans_read" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/plans_read"; sed -n "\${n}p" "${dir}/plans" | tr ';' '\\n' ;;\nesac`);
  const run=(script,env={},files={})=>{
    for(const [f,v] of Object.entries(files))writeFileSync(join(dir,f),String(v));
    writeFileSync(join(dir,'out'),'');writeFileSync(log,'');
    const r=spawnSync('bash',['-e','-c',script],{env:{PATH:`${bin}:/usr/bin:/bin`,GITHUB_OUTPUT:join(dir,'out'),RUNNER_TEMP:dir,GITHUB_REPOSITORY:'owner/repo',...env},encoding:'utf8'});
    return {code:r.status,stdout:r.stdout,out:readFileSync(join(dir,'out'),'utf8'),calls:readFileSync(log,'utf8').trim().split('\n').filter(Boolean)};
  };
  return {run,done:()=>rmSync(dir,{recursive:true,force:true})};
}

test('waker workflow: a transient dispatch error is retried, a stopped Autopilot ends the chain, a lasting error keeps it',{skip:noBash},()=>{
  const h=harness(),start=stepScript('Start an Autopilot cycle and the next waker');
  try{
    const gh=r=>r.calls.filter(c=>c.startsWith('gh '));
    // Two transient failures, then the cycle starts; the successor waits for that cycle.
    let r=h.run(start,{WAKE:'true',WAKER_AFTER:''},{ap_fail:2,wk_fail:0,recheck:0});
    assert.equal(r.code,0);assert.equal(gh(r).filter(c=>c.includes('autopilot.yml')).length,3);
    assert.deepEqual(gh(r).filter(c=>c.includes('autopilot-waker.yml')),['gh workflow run autopilot-waker.yml --ref main -f after=2026-11-29T11:00:00Z']);
    // Stop pressed (workflow disabled): three tries, one state lookup, and the chain ends without a successor.
    r=h.run(start,{WAKE:'true',WAKER_AFTER:''},{ap_fail:9,wk_fail:0,recheck:0,state:'disabled_manually'});
    assert.equal(r.code,0);assert.match(r.stdout,/the chain ends here/);assert.ok(gh(r).some(c=>c.startsWith('gh api repos/owner/repo/actions/workflows/autopilot.yml')));
    assert.ok(!gh(r).some(c=>c.includes('autopilot-waker.yml')));
    // Still active but GitHub keeps failing: the chain survives and the successor keeps the 2 h gap (no spinning).
    r=h.run(start,{WAKE:'true',WAKER_AFTER:''},{ap_fail:9,wk_fail:0,recheck:0,state:'active'});
    assert.equal(r.code,0);assert.deepEqual(gh(r).filter(c=>c.includes('autopilot-waker.yml')),['gh workflow run autopilot-waker.yml --ref main -f after=2026-11-29T11:00:00Z']);
    // A cycle ran meanwhile: none is started, the successor plans from the newest results.
    r=h.run(start,{WAKE:'true',WAKER_AFTER:'2026-11-29T08:00:00Z'},{ap_fail:0,wk_fail:0,recheck:1});
    assert.ok(!gh(r).some(c=>c.includes('autopilot.yml --ref')));assert.deepEqual(gh(r).filter(c=>c.includes('waker')),['gh workflow run autopilot-waker.yml --ref main -f after=']);
    // Hand-over before the job's time limit: no cycle, and the successor keeps this run's spacing.
    r=h.run(start,{WAKE:'handover',WAKER_AFTER:'2026-11-29T08:00:00Z'},{ap_fail:0,wk_fail:0});
    assert.deepEqual(gh(r),['gh workflow run autopilot-waker.yml --ref main -f after=2026-11-29T08:00:00Z']);
    // The successor dispatch is retried too; only three failures in a row fail the job (visible in Actions).
    r=h.run(start,{WAKE:'handover',WAKER_AFTER:''},{wk_fail:2});assert.equal(r.code,0);assert.equal(gh(r).length,3);
    r=h.run(start,{WAKE:'handover',WAKER_AFTER:''},{wk_fail:3});assert.notEqual(r.code,0);
  }finally{h.done()}
});

test('waker workflow: the live chain re-plans from fresh results while it waits, and hands over before its time limit',{skip:noBash},()=>{
  const h=harness(),plan=stepScript('Wait until the next cycle is due (re-planned every 10 minutes from the newest results)');
  try{
    // 50 min to wait, then a new result moves the start to now.
    let r=h.run(plan,{},{plans:'wake=true;wait_s=3000;at=x\nwake=true;wait_s=0;at=y\n',plans_read:0,clock:1000,step:1});
    assert.equal(r.code,0);assert.equal(r.out.trim(),'wake=true');
    assert.equal(r.calls.filter(c=>c==='node scripts/autopilot/waker.mjs plan').length,2);assert.ok(r.calls.includes('sleep 600'),'checks again within 10 minutes');
    assert.ok(r.calls.filter(c=>c.startsWith('git fetch')).length>=2,'fresh results before every plan');
    // A short wait sleeps exactly that long.
    r=h.run(plan,{},{plans:'wake=true;wait_s=90;at=x\nwake=true;wait_s=0;at=y\n',plans_read:0,clock:1000});
    assert.ok(r.calls.includes('sleep 90'));
    // No published summary (or a dry run): no wake, the chain ends.
    r=h.run(plan,{},{plans:'wake=false;wait_s=0;at=\n',plans_read:0,clock:1000});assert.equal(r.out.trim(),'wake=false');
    // Past the hand-over time (4.5 h into the wait): a successor continues waiting instead of the job hitting its limit.
    r=h.run(plan,{},{plans:'wake=true;wait_s=18000;at=x\n'.repeat(5),plans_read:0,clock:1000,step:6000});
    assert.equal(r.out.trim(),'wake=handover');assert.equal(r.calls.filter(c=>c==='node scripts/autopilot/waker.mjs plan').length,3);
  }finally{h.done()}
});
