#!/usr/bin/env node
/**
 * Owner alerts as GitHub issues: GitHub emails the repository owner for free, so a stall reaches someone within a
 * cycle instead of lasting until someone opens the dashboard.
 *
 * Reads only the public summary (public/data/autopilot.json) and keeps one open issue per attention code that needs
 * the owner: every 'action', plus the early warnings in WARN_CODES. Labelled LABEL, titled "LinkForge: <code>".
 *  - a new code opens an issue (body = message + fix + time; LINKFORGE_ALERT_MENTION, a GitHub login, is @mentioned on open only);
 *  - a changed message or level rewrites the body (no new comment, so no new notification);
 *  - an escalation (warn -> action) adds exactly one comment;
 *  - a code absent for 2 consecutive cycles gets a short comment and the issue is closed. A cycle whose summary.watchdog
 *    says the code's rule did not run (weekend, hold, locked vault, no send attempted) does not count as an absence.
 * The only memory is a hidden marker in each issue body, so this script is otherwise stateless and safe to re-run on
 * the same summary. Issues are public: only codes, levels, messages and fixes are posted (counts, never prospect data;
 * any address is masked anyway). API errors are logged and never fail the workflow.
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const LABEL='linkforge-alert';
// Warnings that still need the owner: a reply waiting for an answer (often a draft only the owner can send) and email going
// out without the postal-address footer are told by email too, not only on the dashboard.
export const WARN_CODES=new Set(['vault_size','prospect_inflow_low','replies_waiting','sender_identity_incomplete']);
const RANK={info:0,warn:1,action:2};
const EMAIL=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const MARK=/<!--\s*linkforge-alert\s+(\{[^<>]*?\})\s*-->/,MARKS=new RegExp(MARK.source,'g');
const API='https://api.github.com';
/**
 * Public text: no addresses, no accidental @mentions, no HTML at all (angle brackets become ‹ ›, so nothing can open or
 * close a comment marker however it is nested), and nothing that renders as a link or image: "](" is split, and URLs and
 * "www." lose their auto-link form.
 */
export const clean=s=>String(s??'').replace(EMAIL,'[email]').replace(/@/g,'@\u200b').replace(/</g,'\u2039').replace(/>/g,'\u203a')
  .replace(/\]\s*\(/g,'] (').replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\//gi,'$1\u200b://').replace(/\bwww\./gi,'www\u200b.').replace(/\s+/g,' ').trim().slice(0,1500);
export const titleOf=code=>`LinkForge: ${code}`;
const sig=a=>createHash('sha256').update(`${a.level}|${a.message}|${a.fix}`).digest('hex').slice(0,16);
/** The issue's own marker is the last one in the body (it is always written last; message text can never form one). */
export const parseMarker=body=>{try{const m=[...String(body||'').matchAll(MARKS)].at(-1);return m?JSON.parse(m[1]):null}catch{return null}};
const markerText=m=>`<!-- linkforge-alert ${JSON.stringify(m)} -->`;
/** Replace the last marker (the issue's own), or append one. */
export const withMarker=(body,m)=>{body=String(body||'');const last=[...body.matchAll(MARKS)].at(-1);
  return last?body.slice(0,last.index)+markerText(m)+body.slice(last.index+last[0].length):`${body}\n\n${markerText(m)}`};
// Rules that run only in some cycles: when summary.watchdog says one did not run, its code's absence proves nothing.
const OUTCOME_RULES=new Set(['sending_stalled','low_throughput']);
const VAULT_RULES=new Set(['prospect_inflow_low','owner_decision_pending','replies_waiting','mailbox_rebuild_pending']);
/** Did this cycle evaluate the rule behind `code`? Summaries without a watchdog record (older cycles): yes. */
export function evaluated(code,w){
  if(!w||typeof w!=='object')return true;
  if(OUTCOME_RULES.has(code))return !w.quiet;
  if(code==='gmail_send_blocked')return w.send_attempted===true;
  if(VAULT_RULES.has(code))return w.vault_open!==false;
  return true;
}
const when=t=>String(t||'').slice(0,16).replace('T',' ')+' UTC';

/** The alerts that deserve an issue, keyed by code (first occurrence wins). */
export function alertsOf(summary){
  const m=new Map();
  for(const a of summary?.attention||[]){
    const code=String(a?.code||'');if(!/^[a-z0-9_]{1,60}$/.test(code)||m.has(code))continue;
    if(a.level==='action'||(a.level==='warn'&&WARN_CODES.has(code)))m.set(code,{code,level:a.level,message:clean(a.message),fix:clean(a.fix)});
  }
  return m;
}
export function issueBody(alert,marker,{mention=''}={}){
  return [`**${alert.message}**`,'',`**Fix:** ${alert.fix}`,'',`Level: ${alert.level} · first seen ${when(marker.since)} · last changed ${when(marker.updated)}`,
    ...(mention?['',`@${mention}`]:[]),'',
    '_Opened by LinkForge Autopilot. This issue is updated when the problem changes and closed after 2 cycles without it. Counts only: no prospect data is posted here._',
    '',markerText(marker)].join('\n');
}

export async function syncAlerts({summary,token,repo,mention='',fetchImpl=fetch,log=()=>{}}={}){
  const res={opened:0,updated:0,escalated:0,closed:0,errors:0,skipped:null};
  if(!token||!/^[\w.-]+\/[\w.-]+$/.test(repo||'')){res.skipped='GITHUB_TOKEN or GITHUB_REPOSITORY not set';return res}
  if(!summary?.generated_at||!Array.isArray(summary.attention)){res.skipped='no readable summary';return res}
  if(summary.dry_run){res.skipped='dry run';return res}
  mention=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(mention||''))?String(mention):'';
  const api=async(method,path,body)=>{
    const r=await fetchImpl(`${API}/repos/${repo}${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'linkforge-autopilot',...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    if(!r.ok){const e=Error(`GitHub API ${method} ${path.split('?')[0]}: HTTP ${r.status}`);e.status=r.status;throw e}
    return r.status===204?null:r.json().catch(()=>null);
  };
  const fail=(what,e)=>{res.errors++;log(`notify: ${what} failed (${String(e?.message||e).slice(0,160)})`)};
  let labelReady=false;
  const ensureLabel=async()=>{if(labelReady)return;labelReady=true;
    try{await api('GET',`/labels/${LABEL}`)}catch(e){if(e.status!==404)return;
      try{await api('POST','/labels',{name:LABEL,color:'d93f0b',description:'Autopilot needs the owner (opened and closed automatically)'})}catch(e2){fail('creating the label',e2)}}};
  const cycle=summary.generated_at,alerts=alertsOf(summary);
  let open;
  try{open=(await api('GET',`/issues?state=open&labels=${LABEL}&per_page=100`)||[]).filter(i=>i&&!i.pull_request)}catch(e){fail('listing open alerts',e);return res}
  const byCode=new Map();
  for(const issue of open){
    const m=parseMarker(issue.body),code=m?.code||String(issue.title||'').match(/^LinkForge: ([a-z0-9_]+)$/)?.[1];
    if(code&&!byCode.has(code))byCode.set(code,{issue,marker:{code,level:'warn',sig:'',since:issue.created_at||cycle,updated:issue.created_at||cycle,absent:0,cycle:null,...(m||{})}});
  }
  for(const a of alerts.values()){
    const cur=byCode.get(a.code),s=sig(a);
    try{
      if(!cur){
        await ensureLabel();
        await api('POST','/issues',{title:titleOf(a.code),body:issueBody(a,{code:a.code,level:a.level,sig:s,since:cycle,updated:cycle,absent:0,cycle},{mention}),labels:[LABEL]});
        res.opened++;log(`notify: opened an alert for ${a.code}`);continue;
      }
      const m=cur.marker,n=cur.issue.number;
      if(m.sig===s&&!m.absent)continue; // unchanged and still present: nothing to say
      const marker={...m,level:a.level,sig:s,updated:m.sig===s?m.updated:cycle,absent:0,cycle};
      // A changed message rewrites the body; a code that merely came back keeps its text and only resets the absence count.
      await api('PATCH',`/issues/${n}`,{body:m.sig===s&&MARK.test(cur.issue.body||'')?withMarker(cur.issue.body,marker):issueBody(a,marker)});res.updated++;
      if(RANK[a.level]>(RANK[m.level]??0)){await api('POST',`/issues/${n}/comments`,{body:`Escalated from ${m.level} to ${a.level}: ${a.message}`});res.escalated++}
    }catch(e){fail(`updating ${a.code}`,e)}
  }
  for(const [code,{issue,marker}] of byCode){
    if(alerts.has(code)||marker.cycle===cycle)continue; // still reported, or this cycle was already counted
    if(!evaluated(code,summary.watchdog)){res.paused=(res.paused||0)+1;continue} // its rule did not run this cycle (weekend, hold, locked vault, nothing sent)
    const absent=(Number(marker.absent)||0)+1,n=issue.number;
    try{
      if(absent>=2){
        await api('POST',`/issues/${n}/comments`,{body:`Cleared: Autopilot has not reported this for 2 consecutive cycles (last checked ${when(cycle)}). Closing; it reopens as a new issue if it comes back.`});
        await api('PATCH',`/issues/${n}`,{state:'closed',state_reason:'completed'});res.closed++;log(`notify: closed the alert for ${code}`);
      }else{
        const next={...marker,absent,cycle};
        await api('PATCH',`/issues/${n}`,{body:withMarker(issue.body,next)});res.updated++;
      }
    }catch(e){fail(`clearing ${code}`,e)}
  }
  return res;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.argv[2]||resolve(dirname(fileURLToPath(import.meta.url)),'../../public/data/autopilot.json');
  let summary=null;try{summary=JSON.parse(await readFile(file,'utf8'))}catch{console.log('notify: no readable summary')}
  try{
    const r=await syncAlerts({summary,token:process.env.GITHUB_TOKEN,repo:process.env.GITHUB_REPOSITORY,mention:process.env.LINKFORGE_ALERT_MENTION,log:m=>console.log(m)});
    console.log(r.skipped?`notify: skipped (${r.skipped})`:`notify: ${r.opened} opened, ${r.updated} updated, ${r.escalated} escalated, ${r.closed} closed, ${r.errors} errors`);
  }catch(e){console.log(`notify: ${String(e?.message||e).slice(0,200)}`)}
  process.exitCode=0; // alerts are best-effort: never turn the cycle red
}
