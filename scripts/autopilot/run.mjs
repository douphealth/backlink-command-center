#!/usr/bin/env node
/**
 * LinkForge Autopilot — one autonomous growth cycle.
 *
 *   crawl owned sites -> measure demand -> rank best URLs -> plan internal links
 *   -> find & qualify link prospects -> find contacts -> pitch (send or draft)
 *   -> handle replies/bounces/opt-outs -> follow up -> verify won backlinks
 *
 * Runs in GitHub Actions twice a day. Each stage is isolated: a failing stage is
 * reported and the rest still run. Public results go to public/data/autopilot.json
 * (served by Cloudflare Pages); private state is AES-GCM sealed in public/data/vault.json.
 */
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SITES} from '../../functions/_lib/sites.js';
import {crawlPortfolio} from './crawl.mjs';
import {rankPortfolio,internalLinkPlan} from './score.mjs';
import {DataForSEO,trackExternalSpend} from './dataforseo.mjs';
import {BraveSearch} from './search.mjs';
import {pitchable,pitchableAssets,bestPitchAsset} from './assets.mjs';
import {gscDemand,dfsDemand} from './demand.mjs';
import {discoverProspects,requalify,recontact,enrichBrokenLinks,freshQueryCount,QUALIFY_VERSION} from './prospect.mjs';
import {indexationReport} from './indexation.mjs';
import {autotune,diagnose,TUNING} from './health.mjs';
import {gscClient,monitorIndex,indexReport,searchPerformance} from './searchconsole.mjs';
import {submitToBing} from './bing.mjs';
import {PitchWriter,aiProviders} from './pitch.mjs';
import {processReplies,reconcileSent,runOutreach,preverify,screenQueue,checkLinks,gmailTransport,dailyCap,outreachStatus} from './outreach.mjs';
import {assetStats,learningSummary} from './learn.mjs';
import {sealJson,open,vaultFormat} from './vault.mjs';
import {requireRebuild,rebuildHold,rebuildFromMailbox,linkRestoredSends,pruneRestoredSends} from './rebuild.mjs';
import {verifyLedger} from './recipient-policy.mjs';
import {NOW,ageDays,normUrl} from './util.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const P={summary:resolve(ROOT,'public/data/autopilot.json'),vault:resolve(ROOT,'public/data/vault.json'),cache:resolve(ROOT,'.autopilot-cache/crawl.json')};
const readJson=async(f,fallback)=>{try{return JSON.parse(await readFile(f,'utf8'))}catch{return fallback}};
const num=(v,d)=>Number.isFinite(Number(v))&&String(v).trim()!==''?Number(v):d;

// The verifier opt-in and budget are read by the recipient gate (recipient-policy.mjs).
const DASHBOARD_SETTINGS=['SENDER_NAME','SENDER_NAMES','SENDER_POSTAL_ADDRESS','OUTREACH_MODE','OUTREACH_DAILY_LIMIT','REPLY_MODE','EMAIL_VERIFICATION_ENABLED','EMAIL_VERIFY_DAILY_LIMIT','HUNTER_DAILY_LIMIT','OUTREACH_DACH'];
/** The dashboard saves these as one JSON secret; it takes precedence over older repo variables. */
export function withDashboardSettings(env){
  let s={};try{s=JSON.parse(env.LINKFORGE_SETTINGS||'{}')}catch{}
  const picked=Object.fromEntries(DASHBOARD_SETTINGS.filter(k=>typeof s?.[k]==='string'&&s[k].trim()).map(k=>[k,s[k].trim()]));
  return {...env,...picked};
}
/**
 * Saving a Verifalia login is the opt-in: in free-credits-only mode verification cannot cost money,
 * so it starts at 25 checks/day (the Verifalia free plan's daily credits) unless the dashboard explicitly set a limit (0 = off).
 */
export function verifierDefaults(env){
  let s={};try{s=JSON.parse(env.LINKFORGE_SETTINGS||'{}')}catch{}
  const explicit=['YES','NO'].includes(s.EMAIL_VERIFICATION_ENABLED)||env.EMAIL_VERIFICATION_ENABLED==='YES';
  if(explicit||!(env.VERIFALIA_USERNAME&&env.VERIFALIA_PASSWORD)||env.VERIFALIA_ALLOW_PAID==='YES')return env;
  return {...env,EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:Number(env.EMAIL_VERIFY_DAILY_LIMIT)>0?env.EMAIL_VERIFY_DAILY_LIMIT:'25'};
}
/**
 * Per-site sender names, so a pitch for one site is never signed with another site's name.
 * Accepts a JSON object or one "domain = Name" (or "domain: Name") pair per line; unknown or empty values are ignored.
 */
export function parseSenderNames(value){
  const out={},put=(d,n)=>{d=String(d||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*$/,'');n=String(n||'').trim().slice(0,80);if(/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)&&n)out[d]=n};
  const text=String(value||'').trim();if(!text)return out;
  try{const j=JSON.parse(text);if(j&&typeof j==='object'&&!Array.isArray(j)){for(const [d,n] of Object.entries(j))if(typeof n==='string')put(d,n);return out}}catch{}
  for(const line of text.split(/\r?\n|;/)){const m=line.replace(/^\s*https?:\/\//i,'').match(/^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/);if(m)put(m[1],m[2])}
  return out;
}
export function loadConfig(env=process.env,argv=process.argv){
  env=verifierDefaults(withDashboardSettings(env));
  const gmail=!!(env.GMAIL_ADDRESS&&env.GMAIL_APP_PASSWORD);
  const dryRun=argv.includes('--dry-run')||env.AUTOPILOT_DRY_RUN==='1';
  const mode=['off','draft','send'].includes(env.OUTREACH_MODE)?env.OUTREACH_MODE:gmail?'draft':'off';
  return {
    dryRun,
    minutes:num(env.AUTOPILOT_MINUTES,22),maxUrlsPerSite:num(env.AUTOPILOT_MAX_URLS_PER_SITE,300),
    assetsPerSite:num(env.AUTOPILOT_ASSETS_PER_SITE,3),queriesPerAsset:num(env.AUTOPILOT_QUERIES_PER_ASSET,3),maxNewProspects:num(env.AUTOPILOT_MAX_NEW_PROSPECTS,60),
    dataKey:env.LINKFORGE_DATA_KEY||'',vaultResetAt:env.LINKFORGE_VAULT_RESET_AT||'',
    dfs:{login:env.DATAFORSEO_LOGIN||'',password:env.DATAFORSEO_PASSWORD||'',dailyUsd:num(env.DATAFORSEO_DAILY_USD,0.5),monthlyUsd:num(env.DATAFORSEO_MONTHLY_USD,10)},
    outreach:{mode,gmail,fromAddress:env.GMAIL_ADDRESS||(dryRun?'dry-run@linkforge.invalid':''),senderName:env.SENDER_NAME||'',postalAddress:String(env.SENDER_POSTAL_ADDRESS||'').trim(),senderNames:parseSenderNames(env.SENDER_NAMES),
      // Replies: 'draft' (default) saves an answer in Gmail Drafts for the owner; 'send' may auto-answer only unconditional replies; 'off' does neither.
      replyMode:['off','draft','send'].includes(env.REPLY_MODE)?env.REPLY_MODE:'draft',
      // DE/AT/CH recipients need prior consent for unsolicited business email: held unless the owner opts in.
      allowDach:env.OUTREACH_DACH==='YES',
      dailyLimit:num(env.OUTREACH_DAILY_LIMIT,12),followupDays:num(env.FOLLOWUP_DAYS,6),sendWindow:env.AUTOPILOT_SEND_WINDOW!=='off',gapMs:()=>15000+Math.floor(Math.random()*30000)},
    brave:{apiKey:env.BRAVE_SEARCH_API_KEY||'',monthlyRequests:num(env.BRAVE_MONTHLY_REQUESTS,900)},neighborPages:Math.max(0,Math.min(40,num(env.AUTOPILOT_NEIGHBOR_PAGES,12))),
    claude:{apiKey:env.ANTHROPIC_API_KEY||'',model:env.LINKFORGE_CLAUDE_MODEL||'claude-opus-5-5',
      providers:aiProviders(env)},
    linkGapCalls:Math.max(0,Math.min(4,num(env.AUTOPILOT_LINKGAP_CALLS,2))),secondLook:Math.max(0,Math.min(200,num(env.AUTOPILOT_SECOND_LOOK,60))),
    gsc:!!env.GSC_SERVICE_ACCOUNT_JSON,bing:!!env.BING_WEBMASTER_API_KEY,preverifyMax:num(env.AUTOPILOT_PREVERIFY,10),serpDepth:Math.min(100,Math.max(10,num(env.AUTOPILOT_SERP_DEPTH,50))),maxQueries:num(env.AUTOPILOT_MAX_QUERIES,null),
    verifier:{providers:[...(env.VERIFALIA_USERNAME&&env.VERIFALIA_PASSWORD?['verifalia']:[]),...(env.HUNTER_API_KEY&&env.HUNTER_API_KEY!=='test-api-key'?['hunter']:[])],
      enabled:env.EMAIL_VERIFICATION_ENABLED==='YES',dailyLimit:Math.min(100,Math.max(0,Math.floor(num(env.EMAIL_VERIFY_DAILY_LIMIT,0)))),
      // Hunter has its own budget (default 0 = never used): a second opinion, never a shared counter with Verifalia.
      hunterDailyLimit:Math.min(50,Math.max(0,Math.floor(num(env.HUNTER_DAILY_LIMIT,0))))},
  };
}
const verifierReady=cfg=>cfg.verifier.providers.length>0&&cfg.verifier.enabled&&cfg.verifier.dailyLimit>0;

export function setupChecklist(cfg){
  const items=[
    {key:'LINKFORGE_DATA_KEY',label:'Private vault key',done:!!cfg.dataKey,unlocks:'Stores prospects, contacts and outreach history encrypted in the repo',required:true},
    {key:'DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD',label:'DataForSEO API',done:!!(cfg.dfs.login&&cfg.dfs.password),unlocks:'Finds link prospects in Google and estimates page traffic',required:true},
    {key:'GMAIL_ADDRESS + GMAIL_APP_PASSWORD',label:'Gmail app password',done:cfg.outreach.gmail,unlocks:'Writes pitches into Gmail Drafts, reads replies, detects bounces',required:true},
    {key:'SENDER_NAME',label:'Sender name',done:!!cfg.outreach.senderName,unlocks:'Signs every pitch with your real name (one person, not a site name; per-site names go in SENDER_NAMES)',required:true},
    {key:'SENDER_POSTAL_ADDRESS',label:'Postal address in the email footer',done:!!cfg.outreach.postalAddress,unlocks:'Identifies the sender in every email, as commercial-email rules such as CAN-SPAM expect (a P.O. box or mailbox service works)',required:false},
    {key:'VERIFALIA_USERNAME + VERIFALIA_PASSWORD + EMAIL_VERIFY_DAILY_LIMIT',label:'Mailbox verifier (needed to send)',done:verifierReady(cfg),unlocks:'Proves each editor inbox exists before any email goes out, so nothing bounces. Verifalia free plan: 25 credits every day, free credits only (Hunter key optional as fallback)',required:false},
    {key:'OUTREACH_MODE = send',label:'Hands-free sending',done:cfg.outreach.mode==='send',unlocks:'Sends pitches and one follow-up automatically (warm-up ramp, daily cap)',required:false},
    {key:'ANTHROPIC_API_KEY',label:'Claude pitch writer',done:!!cfg.claude.apiKey,unlocks:'Writes a unique, page-specific email for every prospect',required:false},
    {key:'Cloudflare Workers AI (built in), or GROQ_API_KEY / GEMINI_API_KEY',label:'Free AI pitch writer',done:cfg.claude.providers.length>0,unlocks:'Writes a page-specific email for every prospect at no cost when no Anthropic key is set (templates otherwise)',required:false},
    {key:'GSC_SERVICE_ACCOUNT_JSON',label:'Search Console',done:cfg.gsc,unlocks:'Real index status of every important page, clicks/impressions tracking, striking-distance targeting',required:false},
    {key:'BRAVE_SEARCH_API_KEY',label:'Brave Search (fallback search)',done:!!cfg.brave.apiKey,unlocks:'Keeps prospect searches running when the DataForSEO balance or cap is used up (monthly request cap, default 900)',required:false},
    {key:'BING_WEBMASTER_API_KEY',label:'Bing Webmaster API',done:cfg.bing,unlocks:'Daily submission of new, changed and non-indexed pages to Bing (also feeds Copilot, DuckDuckGo and ChatGPT search)',required:false},
  ];
  return items;
}

/** Pick assets to promote this run: top per site, rotating toward assets with the fewest prospects. */
export function chooseAssets(ranked,state,{perSite=3,minLinkability=50,sites=null}={}){
  const counts=new Map();for(const p of Object.values(state.prospects||{}))counts.set(p.asset_url,(counts.get(p.asset_url)||0)+(p.status==='rejected'?0:1));
  // With sites given, skip assets whose searches are all on cooldown and rotate deeper into the ranking
  // (otherwise the same top pages are chosen forever and prospecting stalls at 0 queries).
  const siteBy=sites&&new Map(sites.map(x=>[x.domain,x]));
  const bySite=new Map();
  for(const a of ranked){if(a.linkability<minLinkability)continue;if(siteBy&&!freshQueryCount(a,siteBy.get(a.site),state))continue;
    const l=bySite.get(a.site)||[];if(l.length<perSite*(siteBy?4:2))l.push(a);bySite.set(a.site,l)}
  // Pages that earn replies get more prospecting; pages with a deep unused queue get less.
  const learned=assetStats(state);
  const value=a=>{const r=learned.get(a.url);return (r&&r.sent>=3?r.rate*3:1)/(1+(counts.get(a.url)||0)/10)};
  const out=[];
  for(const list of bySite.values())out.push(...list.sort((x,y)=>value(y)-value(x)||y.promotion-x.promotion).slice(0,perSite));
  return out.sort((a,b)=>b.promotion-a.promotion);
}

/**
 * From 2026-11-06 Google SERPs arrived with every result wrapped as google.com/goto, so all of them were
 * dropped as "google.com" while each query was still stamped as used (45-day cooldown), novelty learning
 * recorded zero new sites, and self-tuning cut searches to the minimum. Undo that once: reopen the queries,
 * forget the poisoned novelty data and restore the normal search volume.
 */
export const SERP_OUTAGE_FROM=Date.parse('2026-11-05T19:00:00Z');
export function repairSerpOutage(state){
  state.migrations??={};
  if(state.migrations.serp_goto_2026_11)return null;
  let reopened=0;
  for(const [k,t] of Object.entries(state.queries||{}))if(Date.parse(t)>=SERP_OUTAGE_FROM&&!k.includes('|linkgap:')){delete state.queries[k];reopened++}
  for(const [k,t] of Object.entries(state.mentions_at||{}))if(Date.parse(t)>=SERP_OUTAGE_FROM)delete state.mentions_at[k];
  state.fp_novelty={};
  if(state.tuning)state.tuning.max_queries=TUNING.start;
  state.migrations.serp_goto_2026_11=NOW();
  return {queries_reopened:reopened};
}

/** The URL resolver learned to ignore appended site names and to ask WordPress search: retry domains it gave up on. */
export function retryUnresolved(state){
  state.migrations??={};if(state.migrations.resolver_v2)return null;
  const n=Object.keys(state.unresolved||{}).length;state.unresolved={};state.migrations.resolver_v2=NOW();
  return {domains_retried:n};
}

/** Link-gap pulls are now filtered at the source, so paging positions from the old, mostly unusable result sets are void. */
export function resetLinkGapPaging(state){
  state.migrations??={};if(state.migrations.linkgap_filter_v2)return null;
  const n=Object.keys(state.linkgap||{}).length;state.linkgap={};state.migrations.linkgap_filter_v2=NOW();
  return {targets_reopened:n};
}

/** Lookups parked for 7 days on 2026-11-26 were parked by an empty balance, not by a missing subscription: reopen them. */
export function unparkAfterFundsOutage(state){
  state.migrations??={};if(state.migrations.dfs_park_v2)return null;
  const kinds=Object.keys(state.dfs_blocked||{});state.dfs_blocked={};state.migrations.dfs_park_v2=NOW();
  return kinds.length?{reopened:kinds}:null;
}

/**
 * Rejected prospects are deleted 7 days after they were found. Nothing reads them: deduplication lives in
 * state.domains and state.domain_rejections (both kept, so a rejected publisher is never re-evaluated early), and at
 * 60 days they made the vault grow ~0.5 MB a day toward Cloudflare's 25 MiB per-file limit. A record that ever
 * emailed or heard from someone is kept whatever its status.
 */
export const REJECTED_KEEP_DAYS=7;
export function prune(state,{rejectedDays=REJECTED_KEEP_DAYS}={}){
  let rejected=0;state.domains??={};
  for(const [id,p] of Object.entries(state.prospects||{})){
    if(p?.status!=='rejected'||!(ageDays(p.found_at)>rejectedDays)||(p.history||[]).some(h=>['initial','followup','reply','bounce','delivery_delay'].includes(h?.type)))continue;
    if(p.site&&p.domain)state.domains[`${p.site}|${p.domain}`]??=id; // dedup must survive the record
    delete state.prospects[id];rejected++;
  }
  state.ledger=(state.ledger||[]).filter(x=>ageDays(x.at)<400);
  for(const [k,t] of Object.entries(state.seen_replies||{}))if(ageDays(t)>60)delete state.seen_replies[k];
  pruneRestoredSends(state);
  return {rejected};
}

/**
 * Seals the vault for writing: once before self-diagnosis (so this cycle's size is published and checked against
 * Cloudflare's 25 MiB per-file limit), and again at write time only if something changed the state in between.
 */
export function vaultSealer(state,key){
  let from=null,out=null;
  return {async seal(){const json=JSON.stringify(state);if(json!==from){const box=await sealJson(json,key),text=JSON.stringify(box)+'\n';from=json;out={box,text,bytes:Buffer.byteLength(text)}}return out}};
}

export function funnel(state){
  const ps=Object.values(state.prospects||{}),by=s=>ps.filter(p=>s.includes(p.status)).length;
  const contacted=ps.filter(p=>(p.history||[]).some(h=>h.type==='initial')).length;
  return {prospects_evaluated:Object.keys(state.domains||{}).length,qualified:ps.filter(p=>!['rejected','already_linked'].includes(p.status)).length,
    ready:by(['ready']),broken_link_ready:ps.filter(p=>p.status==='ready'&&p.broken_link).length,contact_form_only:by(['contact_form']),no_contact:by(['no_contact']),contacted,
    replied:ps.filter(p=>p.replied_at).length,positive:by(['positive']),won:by(['won']),existing_links:by(['already_linked']),
    declined:by(['declined']),bounced:by(['bounced']),
    // Counts only (public): replies that wait for the owner's decision, and replies nobody has answered yet.
    needs_owner:ps.filter(p=>p.needs_owner&&!p.owner_decided_at).length,awaiting_reply:ps.filter(p=>p.awaiting_us).length};
}

export async function runAutopilot({env=process.env,argv=process.argv,fetchImpl=fetch,mailer:injectedMailer,write=true,useCache=true}={}){
  const cfg=loadConfig(env,argv),started=Date.now(),deadline=started+cfg.minutes*60e3;
  env=verifierDefaults(withDashboardSettings(env)); // the recipient verifier reads its opt-in and budget from here
  // Logs are published in the public summary: never let an address through.
  const logs=[],log=m=>{const line=String(m).replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,'[email]');logs.push(`${new Date().toISOString().slice(11,19)} ${line}`);console.log(line)};
  const stages={};
  // `until`: a hard end time for stages that only read or enrich state. The cycle always reaches
  // the output step, so one slow publisher or provider can never cost the whole run's results.
  const stage=async(name,enabled,fn,why='',{until}={})=>{
    if(!enabled){stages[name]={ok:null,skipped:why};log(`- ${name}: skipped (${why})`);return null}
    const t=Date.now();let timer;
    try{const work=fn();
      const r=until?await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`stopped at its time budget (${Math.round((Date.now()-t)/1000)} s); continues next cycle`)),Math.max(1000,until-Date.now()));timer.unref?.()})]):await work;
      clearTimeout(timer);stages[name]={ok:true,ms:Date.now()-t,...(r&&typeof r==='object'&&!Array.isArray(r)?{result:r}:{})};return r}
    catch(e){clearTimeout(timer);stages[name]={ok:false,ms:Date.now()-t,error:String(e?.message||e).slice(0,200)};log(`! ${name} failed: ${e?.message}`);return null}
  };
  const previous=await readJson(P.summary,{});
  // ---- Private state ----
  let state={v:1,created_at:NOW(),prospects:{},domains:{},suppression:{},contacted:{},queries:{},ledger:[]},vaultOk=false,freshVault='';
  const box=await readJson(P.vault,null);
  if(cfg.dataKey){
    if(box){try{state={...state,...await open(box,cfg.dataKey)};vaultOk=true}catch(e){
      // The owner created a new key from the dashboard after this vault was sealed: start fresh.
      if(cfg.vaultResetAt&&Date.parse(cfg.vaultResetAt)>Date.parse(box.sealed_at||0)){vaultOk=true;freshVault='dashboard_reset';log('vault: new key requested from the dashboard — starting a fresh vault')}
      else log('vault: '+e.message+' — private stages disabled, vault left untouched')}}
    else{vaultOk=true;freshVault='no_vault_file'}
  }
  // A new vault knows nobody who was emailed or opted out: sending waits for the mailbox rebuild (stage 'rebuild').
  if(freshVault){requireRebuild(state,freshVault);log('vault: new vault, so outreach and automatic replies are held until contact history and opt-outs are restored from Gmail')}
  const privateWhy=!cfg.dataKey?'LINKFORGE_DATA_KEY not set':'vault could not be opened';
  if(vaultOk){const r=resetLinkGapPaging(state);if(r?.targets_reopened)log(`repair: ${r.targets_reopened} competitor link profiles will be mined again with the stricter source filter`)}
  if(vaultOk){const r=retryUnresolved(state);if(r?.domains_retried)log(`repair: ${r.domains_retried} search results the old URL matcher gave up on will be retried`)}
  if(vaultOk){const fixed=repairSerpOutage(state);if(fixed)log(`repair: ${fixed.queries_reopened} searches burned by the Google redirect-link outage reopened; search volume restored to ${TUNING.start}`)}
  if(vaultOk){const r=unparkAfterFundsOutage(state);if(r)log(`repair: DataForSEO lookups (${r.reopened.join(', ')}) parked by the empty balance are reopened`)}
  const dfs=new DataForSEO({...cfg.dfs,state,fetchImpl,log});
  const brave=cfg.brave.apiKey?new BraveSearch({...cfg.brave,state,fetchImpl,log}):null;
  // ---- 0. Connections: free checks that saved credentials really work (nothing is charged or sent) ----
  const mailer=injectedMailer||(cfg.dryRun?dryMailer(log):gmailTransport(env));
  const connections={
    dataforseo:cfg.dfs.login&&cfg.dfs.password?await dfs.verify():{status:'missing'},
    gmail:!mailer?{status:'missing'}:mailer.check?await mailer.check():{status:'connected'}};
  for(const [k,v] of Object.entries(connections)){
    if(v.error)v.error=String(v.error).replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,'[email]'); // published in the public summary
    log(`connection ${k}: ${v.status}${v.error?' — '+v.error:''}`);
  }
  // Spending outside Autopilot's own ledger (another tool on the same DataForSEO account) is measured, not guessed.
  const externalSpend=vaultOk&&connections.dataforseo.status==='connected'?trackExternalSpend(state,connections.dataforseo.balance_usd):null;
  if(externalSpend?.since_last_cycle_usd)log(`dataforseo: balance fell ${externalSpend.since_last_cycle_usd.toFixed(2)} USD more than Autopilot spent since the last cycle (another tool is using this account)`);
  stages.connections={ok:!Object.values(connections).some(c=>c.status==='rejected'),result:Object.fromEntries(Object.entries(connections).map(([k,v])=>[k,v.status]))};
  const gmailOk=!!mailer&&connections.gmail.status!=='rejected';
  // ---- 0b. Fresh vault: restore who was emailed and who opted out from Gmail before anything is sent ----
  // No `until` race: the rebuild stops between mailbox pages at its own deadline, so it never shares the connection
  // with a later stage. An unfinished rebuild continues next cycle; sending stays held until it completes.
  if(vaultOk&&state.rebuild_required){
    const canRebuild=typeof mailer?.imap?.sentRecipients==='function'&&typeof mailer?.imap?.recentHeaders==='function';
    await stage('rebuild',gmailOk&&canRebuild,()=>rebuildFromMailbox({state,imap:mailer.imap,self:cfg.outreach.fromAddress,deadline:started+cfg.minutes*0.3*60e3,log}),
      !mailer?'Gmail app password not set':!gmailOk?connections.gmail.error:'transport cannot read the Sent folder and All Mail');
    try{await mailer?.reset?.()}catch{} // an idle connection times out: later stages open a fresh one
    // Automatic answers wait too (drafts are fine): the replies stage reads this mode.
    if(state.rebuild_required&&cfg.outreach.replyMode==='send'){cfg.outreach.replyMode='draft';log('replies: answers are saved as drafts until the mailbox rebuild finishes')}
  }
  // ---- 1. Crawl ----
  const cache=useCache?await readJson(P.cache,{}):{};
  const crawl=await stage('crawl',true,()=>crawlPortfolio(SITES,{cache,fetchImpl,limitPerSite:cfg.maxUrlsPerSite,deadline:started+cfg.minutes*0.45*60e3,log}))||[];
  if(stages.crawl?.ok)stages.crawl.result={sites:crawl.length,pages:crawl.reduce((n,s)=>n+s.pages.length,0)};
  if(write&&crawl.length){const next={};for(const s of crawl)for(const p of s.pages)next[p.url]=p;await mkdir(dirname(P.cache),{recursive:true});await writeFile(P.cache,JSON.stringify(next))}
  // ---- 2. Demand ----
  let demand={};
  await stage('demand',true,async()=>{
    const g=await gscDemand(SITES,env,log);
    const covered=new Set(Object.keys(g).map(u=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch{return ''}}));
    const d=vaultOk&&dfs.enabled?await dfsDemand(SITES,dfs,state,{covered,log}):{};
    demand={...d,...g};return {gsc_pages:Object.keys(g).length,dataforseo_pages:Object.keys(d).length};
  });
  // ---- 3. Rank + internal links ----
  const ranked=crawl.length?rankPortfolio(crawl,{demand}):(previous.best_urls||[]);
  // ---- 3b. Google index monitor + search performance (Search Console, read-only) ----
  let gsc=null,search=previous.search_performance||null;
  if(cfg.gsc){try{gsc=await gscClient(env,{fetchImpl})}catch(e){log('gsc: '+String(e.message).slice(0,120))}}
  const priority=new Map(SITES.map(s=>[s.domain,[...(s.assets||[]),...ranked.filter(a=>a.site===s.domain).slice(0,25).map(a=>a.url)]]));
  await stage('index_monitor',vaultOk&&!!gsc,()=>monitorIndex({state,client:gsc,sites:SITES,priority,crawl,deadline:started+cfg.minutes*0.55*60e3,log}),
    !vaultOk?privateWhy:'Search Console not connected (GSC_SERVICE_ACCOUNT_JSON)',{until:started+cfg.minutes*0.6*60e3});
  await stage('search_performance',!!gsc,async()=>{search=await searchPerformance({client:gsc,sites:SITES,log});return {sites:search.length,clicks_7d:search.reduce((n,x)=>n+x.clicks,0),impressions_7d:search.reduce((n,x)=>n+x.impressions,0)}},
    'Search Console not connected',{until:started+cfg.minutes*0.65*60e3});
  // Pages Google ignores get named in the reasons and go first in the internal link plan (the fastest free fix).
  const label={unknown:'unknown to Google',discovered_not_indexed:'discovered, not indexed',crawled_not_indexed:'crawled, not indexed'};
  for(const a of ranked){const x=state.index_status?.[normUrl(a.url)];if(!x)continue;a.google_index=x.class;
    if(x.class!=='indexed'&&label[x.class]&&!(a.reasons||[]).some(r=>/^Google:/.test(r)))(a.reasons??=[]).unshift(`Google: ${label[x.class]} (fix below)`)}
  const notIndexed=a=>a.google_index&&a.google_index!=='indexed'?1:0;
  const linkTargets=[...ranked].sort((a,b)=>notIndexed(b)-notIndexed(a)||b.promotion-a.promotion);
  const internal=crawl.length?internalLinkPlan(crawl,linkTargets):(previous.internal_links||[]);
  stages.rank={ok:true,result:{ranked:ranked.length,internal_suggestions:internal.length}};
  let noPitchSites=[];
  // A link to a page Google will not index as itself (noindex, canonical elsewhere, redirect, 404) is wasted:
  // such pages are neither promoted nor pitched until fixed. Unknown / not-yet-indexed pages stay eligible.
  const UNLINKABLE=new Set(['noindex','canonical_elsewhere','redirect','not_found']);
  const blockedAssets=new Set(Object.entries(state.index_status||{}).filter(([,x])=>UNLINKABLE.has(x.class)).map(([k])=>k));
  // Only pages an editor would actually link to are promoted or pitched (see assets.mjs).
  const siteByDomain=new Map(SITES.map(s=>[s.domain,s]));
  for(const a of ranked){const v=pitchable(a,siteByDomain.get(a.site));a.pitchable=v.ok;if(!v.ok)a.not_pitched_because=v.why}
  const linkable=ranked.filter(a=>a.pitchable&&!blockedAssets.has(normUrl(a.url)));
  const pitchBySite=new Map(SITES.map(s=>[s.domain,pitchableAssets(linkable,s)]));
  const pickAsset=(p,site)=>{const list=pitchBySite.get(site.domain)||[];if(!crawl.length)return undefined; // no crawl this cycle: keep the stored pairing
    if(list.some(a=>a.url===p.asset_url))return undefined;return bestPitchAsset(p,list,site)};
  const chosen=chooseAssets(linkable,state,{perSite:cfg.assetsPerSite,sites:SITES});
  // Only sites that were actually crawled this cycle: an unreachable site is a crawl problem, not a content problem.
  const crawledSites=new Set(crawl.filter(s=>s.pages.some(p=>p.status===200)).map(s=>s.site));
  noPitchSites=SITES.filter(s=>crawledSites.has(s.domain)&&!(pitchBySite.get(s.domain)||[]).length).map(s=>s.domain);
  stages.rank.result.pitchable=linkable.length;
  log(`pitch policy: ${linkable.length} of ${ranked.length} ranked pages are worth pitching (tools, original methods, in-depth guides, flagships)${noPitchSites.length?`; no such page yet on ${noPitchSites.join(', ')}`:''}`);
  const indexation=crawl.length?indexationReport(crawl):previous.indexation||null;
  if(indexation){log(`indexation: ${indexation.blocking??indexation.sites.reduce((n,x)=>n+x.critical,0)} sitemap URLs cannot be indexed, ${indexation.review??0} need a look, ${indexation.thin??0} are thin (${indexation.total_issues} in all)`);
    for(const s of indexation.sites)if(s.alert)log(`indexation: ${s.site}: ${s.alert}`)}
  // ---- 4. Prospects ----
  await stage('requalify',vaultOk,()=>requalify({state,dfs,fetchImpl,deadline:deadline-8*60e3,log}),privateWhy,{until:deadline-7*60e3});
  // Free: plain page fetches of prospects that already passed qualification but had no usable address.
  await stage('second_look',vaultOk,()=>recontact({state,fetchImpl,deadline:deadline-8*60e3,max:cfg.secondLook,log}),privateWhy,{until:deadline-7*60e3});
  // Runs even with no fresh asset searches: brand-mention searches have their own schedule.
  await stage('prospects',vaultOk&&(dfs.enabled||!!brave),()=>discoverProspects({assets:chosen,sites:SITES,state,dfs,fetchImpl,perAsset:cfg.queriesPerAsset,maxNewPerRun:cfg.maxNewProspects,linkGapCalls:cfg.linkGapCalls,
    neighborPages:cfg.neighborPages,altSearch:brave,crawl,
    pairPool:linkable,maxQueries:cfg.maxQueries??(state.tuning?.max_queries||TUNING.start),serpDepth:cfg.serpDepth,deadline:deadline-7*60e3,log}),
    !vaultOk?privateWhy:(dfs.authError||'DataForSEO credentials not set'),{until:deadline-5.5*60e3});
  await stage('bing_submit',vaultOk&&!!env.BING_WEBMASTER_API_KEY&&crawl.length>0,()=>submitToBing({state,env,sites:SITES,crawl,ranked,fetchImpl,deadline:deadline-6*60e3,log}),
    !vaultOk?privateWhy:'Bing Webmaster API key not set (BING_WEBMASTER_API_KEY)',{until:deadline-5.5*60e3});
  if(vaultOk&&stages.prospects&&stages.prospects.ok!==null)log(`self-tuning: next cycle runs up to ${autotune(state,stages.prospects,{envQueries:cfg.maxQueries})} searches`);
  await stage('broken_links',vaultOk,()=>enrichBrokenLinks({state,assets:ranked,sites:SITES,fetchImpl,deadline:deadline-5*60e3,log}),privateWhy,{until:deadline-4*60e3});
  // A prospect emailed before the vault was replaced (found again since) counts as contacted from that send.
  if(vaultOk){const n=linkRestoredSends(state);if(n)log(`rebuild: ${n} prospects matched to emails sent before the vault was replaced (marked contacted, or suppressed after an opt-out)`)}
  // ---- 5. Mail ----
  // The production transport demands verified-mailbox proof for every recipient: without a verifier nothing could go out.
  const noVerifier=typeof mailer?.authorizeRecipient==='function'&&!verifierReady(cfg);
  let aiWriter=cfg.claude.apiKey?'claude':cfg.claude.providers[0]?.name||null;
  const mailWhy=!vaultOk?privateWhy:!mailer?'Gmail app password not set':!gmailOk?connections.gmail.error
    :cfg.outreach.mode==='off'?'OUTREACH_MODE=off':noVerifier?'mailbox verifier not configured (Verifalia login or Hunter key, plus a verification daily limit)':'';
  try{
    // A stalled mailbox connection (30 s timeout, seen 2026-11-26) blocked that cycle's sending: retry once on a fresh connection.
    await stage('replies',vaultOk&&gmailOk,async()=>{
      try{return await processReplies({state,imap:mailer.imap,log})}
      catch(e){if(!/timeout|socket|ECONN|EPIPE|closed/i.test(String(e?.message))||typeof mailer.reset!=='function')throw e;
        log('replies: mailbox connection stalled; retrying once on a fresh connection');await mailer.reset();return processReplies({state,imap:mailer.imap,log})}
    },mailWhy||'Gmail not set');
    // Gmail's Sent folder is the ground truth for who was already emailed; a failed check blocks sending this cycle.
    const canReadSent=typeof mailer?.imap?.sentRecipients==='function';
    await stage('sent_check',vaultOk&&gmailOk&&canReadSent,()=>reconcileSent({state,imap:mailer.imap,log}),!vaultOk?privateWhy:!canReadSent?'transport cannot read the Sent folder':mailWhy||'Gmail not set');
    const sentUnknown=stages.sent_check?.ok===false;
    await stage('screen',vaultOk&&!!mailer,()=>screenQueue({state,mailer,deadline:deadline-4*60e3,log}),privateWhy,{until:deadline-3.5*60e3});
    const writer=new PitchWriter({...cfg.claude,senderName:cfg.outreach.senderName||'The editorial team',fetchImpl,log});
    await stage('outreach',vaultOk&&gmailOk&&cfg.outreach.mode!=='off'&&!noVerifier&&!!cfg.outreach.senderName&&!sentUnknown&&!state.rebuild_required,()=>runOutreach({state,assets:ranked,sites:SITES,writer,mailer,config:{...cfg.outreach,blockedAssets,pickAsset},deadline:deadline-2*60e3,log}),mailWhy||rebuildHold(state,stages.rebuild)||(sentUnknown?'Sent-folder check failed, so nothing is sent this cycle (prevents duplicate emails)':'SENDER_NAME not set'));
    if(stages.outreach?.ok)stages.outreach.writer={claude:writer.used,free_ai:writer.usedAi,template_fallbacks:writer.fallbacks,...(writer.aiModel?{ai_provider:writer.aiProvider,ai_model:writer.aiModel}:{}),...(Object.keys(writer.reasons||{}).length?{fallback_reasons:writer.reasons}:{})};
    aiWriter=writer.ai;
    if(stages.outreach?.ok&&(writer.used+writer.usedAi+writer.fallbacks)>0){const why=Object.entries(writer.reasons||{}).map(([k,n])=>`${k} x${n}`).join(', ');
      log(`pitch writer: ${writer.used+writer.usedAi} written by AI${writer.aiModel?` (${writer.aiProvider}: ${writer.aiModel})`:''}, ${writer.fallbacks} from the template${why?` (${why})`:''}`)}
    // Every cycle: spend today's leftover free verification credits on the best inboxes whose send window opens within 20 h
    // (due follow-ups first, never beyond the day's sending capacity), so the next in-window cycle (started by the send-window
    // waker) sends at once. Verification needs no Gmail login: only the vault, a ready verifier and the transport's recipient check.
    await stage('preverify',vaultOk&&!noVerifier&&typeof mailer?.authorizeRecipient==='function',
      ()=>preverify({state,mailer,max:cfg.preverifyMax,followups:cfg.outreach.mode==='send',followupDays:cfg.outreach.followupDays,
        cap:cfg.outreach.mode==='send'?dailyCap(state,cfg.outreach.dailyLimit):cfg.outreach.dailyLimit,deadline:deadline-90e3,log}),
      !vaultOk?privateWhy:noVerifier?'mailbox verifier not configured':'no Gmail transport',{until:deadline-30e3});
  }finally{await mailer?.close?.().catch(()=>{})}
  // ---- 6. Link verification ----
  await stage('link_checks',vaultOk,()=>checkLinks({state,ourDomains:SITES.map(s=>s.domain),fetchImpl,deadline,log}),privateWhy,{until:deadline+90e3});
  // ---- Outputs ----
  if(vaultOk){const r=prune(state);if(r.rejected)log(`vault: ${r.rejected} rejected prospects older than ${REJECTED_KEEP_DAYS} days removed (their domains stay deduplicated)`)}
  const f=vaultOk?funnel(state):previous.funnel||null;
  const today=NOW().slice(0,10);
  const history=(previous.history||[]).filter(h=>h.date!==today&&ageDays(h.date)<120);
  if(f)history.push({date:today,...f,spend_usd:Number(dfs.spend('day').toFixed(4)),
    ...(search?.length?{search_clicks_7d:search.reduce((n,x)=>n+x.clicks,0),search_impressions_7d:search.reduce((n,x)=>n+x.impressions,0),striking_distance_pages:search.reduce((n,x)=>n+x.striking_distance,0)}:{}),
    ...(state.index_status?{google_indexed:Object.values(state.index_status).filter(x=>x.class==='indexed').length,google_not_indexed:Object.values(state.index_status).filter(x=>x.class!=='indexed').length}:{})});
  const prospectsByAsset=new Map();for(const p of Object.values(state.prospects))if(p.status!=='rejected')prospectsByAsset.set(p.asset_url,(prospectsByAsset.get(p.asset_url)||0)+1);
  const internalByAsset=new Map();for(const s of internal)internalByAsset.set(s.to,(internalByAsset.get(s.to)||0)+1);
  // Verification ledger by day (counts only): what the credits bought and how many emails they backed.
  const vLedger=vaultOk?verifyLedger(state):{ledger:previous.capabilities?.verifier?.ledger||[],credits_per_email:previous.capabilities?.verifier?.credits_per_email??null};
  const summary={
    schema:'linkforge-autopilot/1',generated_at:NOW(),duration_s:Math.round((Date.now()-started)/1000),dry_run:cfg.dryRun,
    schedule:"Hourly check starts a cycle when the last one is 5+ hours old (about 4 a day); sends only in recipients' business hours",
    capabilities:{ai_writer:aiWriter,vault:vaultOk,dataforseo:dfs.enabled,gmail:cfg.outreach.gmail&&gmailOk,connections,outreach_mode:cfg.outreach.mode,claude:!!cfg.claude.apiKey,gsc:cfg.gsc,
      daily_send_cap:cfg.outreach.mode==='send'?dailyCap(state,cfg.outreach.dailyLimit):cfg.outreach.dailyLimit,
      verifier:{ready:verifierReady(cfg),providers:cfg.verifier.providers,key:cfg.verifier.providers.length>0,enabled:cfg.verifier.enabled,daily_limit:cfg.verifier.dailyLimit,
        used_today:state.email_verifier_usage?.[NOW().slice(0,10)]||0,balance:state.verifier_balance||null,catch_all_domains_skipped:Object.keys(state.catch_all_domains||{}).length,
        hunter_daily_limit:cfg.verifier.hunterDailyLimit,hunter_used_today:state.hunter_usage?.[NOW().slice(0,10)]||0,ledger:vLedger.ledger,credits_per_email:vLedger.credits_per_email}},
    // Booleans only, never the values: lets self-diagnosis flag a missing sender identity.
    sender:{sender_name:!!cfg.outreach.senderName,postal_address:!!cfg.outreach.postalAddress,per_site_names:Object.keys(cfg.outreach.senderNames).length,reply_mode:cfg.outreach.replyMode,allow_dach:cfg.outreach.allowDach},
    setup:setupChecklist(cfg),stages,
    totals:{sites:SITES.length,pages_crawled:crawl.reduce((n,s)=>n+s.pages.length,0),urls_discovered:crawl.reduce((n,s)=>n+(s.discovered||0),0),
      promotable:ranked.length,internal_suggestions:internal.length,promoting_now:chosen.length},
    spend:{today_usd:Number(dfs.spend('day').toFixed(4)),month_usd:Number(dfs.spend('month').toFixed(4)),daily_cap_usd:cfg.dfs.dailyUsd,monthly_cap_usd:cfg.dfs.monthlyUsd,calls_this_run:dfs.calls,
      ...(brave?{brave:{requests_this_month:brave.used(),monthly_cap:brave.limit,requests_this_run:brave.calls}}:{}),
      balance_usd:Number.isFinite(dfs.balance)?Number(dfs.balance.toFixed(2)):null,...(externalSpend?{external:externalSpend}:previous.spend?.external?{external:previous.spend.external}:{})},
    outreach:vaultOk?outreachStatus(state,{limit:cfg.outreach.dailyLimit,mode:cfg.outreach.mode,qualifyVersion:QUALIFY_VERSION}):previous.outreach||null,
    funnel:f,history,learning:vaultOk?learningSummary(state,SITES):previous.learning||null,
    sites:crawl.map(s=>({domain:s.site,pages:s.pages.length,discovered:s.discovered,sitemaps:s.sitemaps.length,
      eligible:ranked.filter(a=>a.site===s.site).length,top:ranked.find(a=>a.site===s.site)?.url||null})),
    best_urls:ranked.slice(0,80).map(({terms,...a})=>({...a,prospects:prospectsByAsset.get(a.url)||0,internal_link_suggestions:internalByAsset.get(a.url)||0,promoting:chosen.some(c=>c.url===a.url)})),
    internal_links:internal.slice(0,200),indexation,search_performance:search,
    google_index:vaultOk&&state.index_status?indexReport(state,SITES,ranked):previous.google_index||null,
    bing:vaultOk&&state.bing?{submitted_total:Object.keys(state.bing.submitted||{}).length,last_run:stages.bing_submit?.result||null,errors:state.bing.errors||{}}:previous.bing||null,tuning:vaultOk?state.tuning||null:previous.tuning||null,
    wins:Object.values(state.prospects).filter(p=>p.status==='won'||p.status==='already_linked').map(p=>({site:p.site,publisher:p.domain,page_url:p.page_url,title:p.title,
      kind:p.status==='won'?'won':'existing',target:p.won?.target||p.existing_link?.url||null,anchor:p.won?.anchor||p.existing_link?.anchor||'',rel:p.won?.rel||p.existing_link?.rel||'',found_at:p.won?.found_at||p.found_at})).sort((a,b)=>String(b.found_at).localeCompare(String(a.found_at))).slice(0,200),
    log:logs.slice(-80),
  };
  // The vault's size and format are published (numbers only): the sealed file written this cycle, else the one on disk.
  const sealer=write&&!cfg.dryRun&&vaultOk?vaultSealer(state,cfg.dataKey):null,sealed=sealer?await sealer.seal():null;
  Object.assign(summary.capabilities,{vault_bytes:sealed?sealed.bytes:await stat(P.vault).then(s=>s.size,()=>null),vault_format:vaultFormat(sealed?.box||box),rebuild_required:vaultOk&&!!state.rebuild_required});
  // Self-diagnosis: what Autopilot cannot fix by itself, with the exact fix.
  summary.attention=diagnose({stages,capabilities:summary.capabilities,outreach:summary.outreach||{},funnel:summary.funnel||{},spend:summary.spend,held:cfg.outreach.mode==='off',noPitchSites,indexation});
  if(write&&!cfg.dryRun){
    await mkdir(dirname(P.summary),{recursive:true});
    const vault=sealer?await sealer.seal():null;if(vault)summary.capabilities.vault_bytes=vault.bytes;
    await writeFile(P.summary,JSON.stringify(summary,null,1)+'\n');
    if(vault)await writeFile(P.vault,vault.text);
  }
  log(`autopilot finished in ${summary.duration_s}s`);
  return {summary,state};
}

function dryMailer(log){
  return {send:async({to})=>log(`[dry-run] would send to ${to}`),draft:async()=>log('[dry-run] would save Gmail draft'),
    imap:{recentHeaders:async()=>[]},close:async()=>{}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!existsSync(resolve(ROOT,'functions/_lib/sites.js'))){console.error('Run from the repository');process.exit(1)}
  runAutopilot().catch(e=>{console.error('autopilot crashed:',e);process.exitCode=1});
}
