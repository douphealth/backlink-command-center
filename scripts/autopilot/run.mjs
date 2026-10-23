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
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SITES} from '../../functions/_lib/sites.js';
import {crawlPortfolio} from './crawl.mjs';
import {rankPortfolio,internalLinkPlan} from './score.mjs';
import {DataForSEO} from './dataforseo.mjs';
import {gscDemand,dfsDemand} from './demand.mjs';
import {discoverProspects} from './prospect.mjs';
import {PitchWriter} from './pitch.mjs';
import {processReplies,runOutreach,checkLinks,gmailTransport,dailyCap} from './outreach.mjs';
import {seal,open} from './vault.mjs';
import {NOW,ageDays} from './util.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const P={summary:resolve(ROOT,'public/data/autopilot.json'),vault:resolve(ROOT,'public/data/vault.json'),cache:resolve(ROOT,'.autopilot-cache/crawl.json')};
const readJson=async(f,fallback)=>{try{return JSON.parse(await readFile(f,'utf8'))}catch{return fallback}};
const num=(v,d)=>Number.isFinite(Number(v))&&String(v).trim()!==''?Number(v):d;

const DASHBOARD_SETTINGS=['SENDER_NAME','OUTREACH_MODE','OUTREACH_DAILY_LIMIT'];
/** The dashboard saves these as one JSON secret; it takes precedence over older repo variables. */
export function withDashboardSettings(env){
  let s={};try{s=JSON.parse(env.LINKFORGE_SETTINGS||'{}')}catch{}
  const picked=Object.fromEntries(DASHBOARD_SETTINGS.filter(k=>typeof s?.[k]==='string'&&s[k].trim()).map(k=>[k,s[k].trim()]));
  return {...env,...picked};
}
export function loadConfig(env=process.env,argv=process.argv){
  env=withDashboardSettings(env);
  const gmail=!!(env.GMAIL_ADDRESS&&env.GMAIL_APP_PASSWORD);
  const dryRun=argv.includes('--dry-run')||env.AUTOPILOT_DRY_RUN==='1';
  const mode=['off','draft','send'].includes(env.OUTREACH_MODE)?env.OUTREACH_MODE:gmail?'draft':'off';
  return {
    dryRun,
    minutes:num(env.AUTOPILOT_MINUTES,22),maxUrlsPerSite:num(env.AUTOPILOT_MAX_URLS_PER_SITE,300),
    assetsPerSite:num(env.AUTOPILOT_ASSETS_PER_SITE,3),queriesPerAsset:num(env.AUTOPILOT_QUERIES_PER_ASSET,2),maxNewProspects:num(env.AUTOPILOT_MAX_NEW_PROSPECTS,60),
    dataKey:env.LINKFORGE_DATA_KEY||'',vaultResetAt:env.LINKFORGE_VAULT_RESET_AT||'',
    dfs:{login:env.DATAFORSEO_LOGIN||'',password:env.DATAFORSEO_PASSWORD||'',dailyUsd:num(env.DATAFORSEO_DAILY_USD,0.5),monthlyUsd:num(env.DATAFORSEO_MONTHLY_USD,10)},
    outreach:{mode,gmail,fromAddress:env.GMAIL_ADDRESS||(dryRun?'dry-run@linkforge.invalid':''),senderName:env.SENDER_NAME||'',postalAddress:env.SENDER_POSTAL_ADDRESS||'',
      dailyLimit:num(env.OUTREACH_DAILY_LIMIT,12),followupDays:num(env.FOLLOWUP_DAYS,6),gapMs:()=>15000+Math.floor(Math.random()*30000)},
    claude:{apiKey:env.ANTHROPIC_API_KEY||'',model:env.LINKFORGE_CLAUDE_MODEL||'claude-opus-5-5'},
    gsc:!!env.GSC_SERVICE_ACCOUNT_JSON,
  };
}

export function setupChecklist(cfg){
  const items=[
    {key:'LINKFORGE_DATA_KEY',label:'Private vault key',done:!!cfg.dataKey,unlocks:'Stores prospects, contacts and outreach history encrypted in the repo',required:true},
    {key:'DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD',label:'DataForSEO API',done:!!(cfg.dfs.login&&cfg.dfs.password),unlocks:'Finds link prospects in Google and estimates page traffic',required:true},
    {key:'GMAIL_ADDRESS + GMAIL_APP_PASSWORD',label:'Gmail app password',done:cfg.outreach.gmail,unlocks:'Writes pitches into Gmail Drafts, reads replies, detects bounces',required:true},
    {key:'SENDER_NAME',label:'Sender name',done:!!cfg.outreach.senderName,unlocks:'Signs every pitch with your real name',required:true},
    {key:'OUTREACH_MODE = send',label:'Hands-free sending',done:cfg.outreach.mode==='send',unlocks:'Sends pitches and one follow-up automatically (warm-up ramp, daily cap)',required:false},
    {key:'ANTHROPIC_API_KEY',label:'Claude pitch writer',done:!!cfg.claude.apiKey,unlocks:'Writes a unique, page-specific email for every prospect',required:false},
    {key:'GSC_SERVICE_ACCOUNT_JSON',label:'Search Console',done:cfg.gsc,unlocks:'Exact impressions/positions to target striking-distance pages',required:false},
  ];
  return items;
}

/** Pick assets to promote this run: top per site, rotating toward assets with the fewest prospects. */
export function chooseAssets(ranked,state,{perSite=3,minLinkability=50}={}){
  const counts=new Map();for(const p of Object.values(state.prospects||{}))counts.set(p.asset_url,(counts.get(p.asset_url)||0)+(p.status==='rejected'?0:1));
  const bySite=new Map();
  for(const a of ranked){if(a.linkability<minLinkability)continue;const l=bySite.get(a.site)||[];if(l.length<perSite*2)l.push(a);bySite.set(a.site,l)}
  const out=[];
  for(const list of bySite.values())out.push(...list.sort((x,y)=>(counts.get(x.url)||0)-(counts.get(y.url)||0)||y.promotion-x.promotion).slice(0,perSite));
  return out.sort((a,b)=>b.promotion-a.promotion);
}

function prune(state){
  for(const [id,p] of Object.entries(state.prospects||{}))if(p.status==='rejected'&&ageDays(p.found_at)>60)delete state.prospects[id];
  state.ledger=(state.ledger||[]).filter(x=>ageDays(x.at)<400);
  for(const [k,t] of Object.entries(state.seen_replies||{}))if(ageDays(t)>60)delete state.seen_replies[k];
}

export function funnel(state){
  const ps=Object.values(state.prospects||{}),by=s=>ps.filter(p=>s.includes(p.status)).length;
  const contacted=ps.filter(p=>(p.history||[]).some(h=>h.type==='initial')).length;
  return {prospects_evaluated:Object.keys(state.domains||{}).length,qualified:ps.filter(p=>!['rejected','already_linked'].includes(p.status)).length,
    ready:by(['ready']),contact_form_only:by(['contact_form']),no_contact:by(['no_contact']),contacted,
    replied:ps.filter(p=>p.replied_at).length,positive:by(['positive']),won:by(['won']),existing_links:by(['already_linked']),
    declined:by(['declined']),bounced:by(['bounced'])};
}

export async function runAutopilot({env=process.env,argv=process.argv,fetchImpl=fetch,mailer:injectedMailer,write=true,useCache=true}={}){
  const cfg=loadConfig(env,argv),started=Date.now(),deadline=started+cfg.minutes*60e3;
  // Logs are published in the public summary: never let an address through.
  const logs=[],log=m=>{const line=String(m).replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,'[email]');logs.push(`${new Date().toISOString().slice(11,19)} ${line}`);console.log(line)};
  const stages={};
  const stage=async(name,enabled,fn,why='')=>{
    if(!enabled){stages[name]={ok:null,skipped:why};log(`- ${name}: skipped (${why})`);return null}
    const t=Date.now();
    try{const r=await fn();stages[name]={ok:true,ms:Date.now()-t,...(r&&typeof r==='object'&&!Array.isArray(r)?{result:r}:{})};return r}
    catch(e){stages[name]={ok:false,ms:Date.now()-t,error:String(e?.message||e).slice(0,200)};log(`! ${name} failed: ${e?.message}`);return null}
  };
  const previous=await readJson(P.summary,{});
  // ---- Private state ----
  let state={v:1,created_at:NOW(),prospects:{},domains:{},suppression:{},contacted:{},queries:{},ledger:[]},vaultOk=false;
  const box=await readJson(P.vault,null);
  if(cfg.dataKey){
    if(box){try{state={...state,...await open(box,cfg.dataKey)};vaultOk=true}catch(e){
      // The owner created a new key from the dashboard after this vault was sealed: start fresh.
      if(cfg.vaultResetAt&&Date.parse(cfg.vaultResetAt)>Date.parse(box.sealed_at||0)){vaultOk=true;log('vault: new key requested from the dashboard — starting a fresh vault')}
      else log('vault: '+e.message+' — private stages disabled, vault left untouched')}}
    else vaultOk=true;
  }
  const privateWhy=!cfg.dataKey?'LINKFORGE_DATA_KEY not set':'vault could not be opened';
  const dfs=new DataForSEO({...cfg.dfs,state,fetchImpl,log});
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
  const internal=crawl.length?internalLinkPlan(crawl,ranked):(previous.internal_links||[]);
  stages.rank={ok:true,result:{ranked:ranked.length,internal_suggestions:internal.length}};
  const chosen=chooseAssets(ranked,state,{perSite:cfg.assetsPerSite});
  // ---- 4. Prospects ----
  await stage('prospects',vaultOk&&dfs.enabled&&chosen.length>0,()=>discoverProspects({assets:chosen,sites:SITES,state,dfs,fetchImpl,perAsset:cfg.queriesPerAsset,maxNewPerRun:cfg.maxNewProspects,deadline:deadline-6*60e3,log}),
    !vaultOk?privateWhy:!dfs.enabled?'DataForSEO credentials not set':'no promotable assets');
  // ---- 5. Mail ----
  const mailer=injectedMailer||(cfg.dryRun?dryMailer(log):gmailTransport(env));
  const mailWhy=!vaultOk?privateWhy:!mailer?'Gmail app password not set':cfg.outreach.mode==='off'?'OUTREACH_MODE=off':'';
  try{
    await stage('replies',vaultOk&&!!mailer,()=>processReplies({state,imap:mailer.imap,log}),mailWhy||'Gmail not set');
    const writer=new PitchWriter({...cfg.claude,senderName:cfg.outreach.senderName||'The editorial team',log});
    await stage('outreach',vaultOk&&!!mailer&&cfg.outreach.mode!=='off'&&!!cfg.outreach.senderName,()=>runOutreach({state,assets:ranked,sites:SITES,writer,mailer,config:cfg.outreach,deadline:deadline-2*60e3,log}),mailWhy||'SENDER_NAME not set');
    if(stages.outreach?.ok)stages.outreach.writer={claude:writer.used,template_fallbacks:writer.fallbacks};
  }finally{await mailer?.close?.().catch(()=>{})}
  // ---- 6. Link verification ----
  await stage('link_checks',vaultOk,()=>checkLinks({state,ourDomains:SITES.map(s=>s.domain),fetchImpl,deadline,log}),privateWhy);
  // ---- Outputs ----
  if(vaultOk)prune(state);
  const f=vaultOk?funnel(state):previous.funnel||null;
  const today=NOW().slice(0,10);
  const history=(previous.history||[]).filter(h=>h.date!==today&&ageDays(h.date)<120);
  if(f)history.push({date:today,...f,spend_usd:Number(dfs.spend('day').toFixed(4))});
  const prospectsByAsset=new Map();for(const p of Object.values(state.prospects))if(p.status!=='rejected')prospectsByAsset.set(p.asset_url,(prospectsByAsset.get(p.asset_url)||0)+1);
  const internalByAsset=new Map();for(const s of internal)internalByAsset.set(s.to,(internalByAsset.get(s.to)||0)+1);
  const summary={
    schema:'linkforge-autopilot/1',generated_at:NOW(),duration_s:Math.round((Date.now()-started)/1000),dry_run:cfg.dryRun,
    schedule:'Twice daily (05:40 and 14:10 UTC) via GitHub Actions; every run redeploys Cloudflare Pages',
    capabilities:{vault:vaultOk,dataforseo:dfs.enabled,gmail:cfg.outreach.gmail,outreach_mode:cfg.outreach.mode,claude:!!cfg.claude.apiKey,gsc:cfg.gsc,
      daily_send_cap:cfg.outreach.mode==='send'?dailyCap(state,cfg.outreach.dailyLimit):cfg.outreach.dailyLimit},
    setup:setupChecklist(cfg),stages,
    totals:{sites:SITES.length,pages_crawled:crawl.reduce((n,s)=>n+s.pages.length,0),urls_discovered:crawl.reduce((n,s)=>n+(s.discovered||0),0),
      promotable:ranked.length,internal_suggestions:internal.length,promoting_now:chosen.length},
    spend:{today_usd:Number(dfs.spend('day').toFixed(4)),month_usd:Number(dfs.spend('month').toFixed(4)),daily_cap_usd:cfg.dfs.dailyUsd,monthly_cap_usd:cfg.dfs.monthlyUsd,calls_this_run:dfs.calls},
    funnel:f,history,
    sites:crawl.map(s=>({domain:s.site,pages:s.pages.length,discovered:s.discovered,sitemaps:s.sitemaps.length,
      eligible:ranked.filter(a=>a.site===s.site).length,top:ranked.find(a=>a.site===s.site)?.url||null})),
    best_urls:ranked.slice(0,80).map(({terms,...a})=>({...a,prospects:prospectsByAsset.get(a.url)||0,internal_link_suggestions:internalByAsset.get(a.url)||0,promoting:chosen.some(c=>c.url===a.url)})),
    internal_links:internal.slice(0,200),
    wins:Object.values(state.prospects).filter(p=>p.status==='won'||p.status==='already_linked').map(p=>({site:p.site,publisher:p.domain,page_url:p.page_url,title:p.title,
      kind:p.status==='won'?'won':'existing',target:p.won?.target||p.existing_link?.url||null,anchor:p.won?.anchor||p.existing_link?.anchor||'',rel:p.won?.rel||p.existing_link?.rel||'',found_at:p.won?.found_at||p.found_at})).sort((a,b)=>String(b.found_at).localeCompare(String(a.found_at))).slice(0,200),
    log:logs.slice(-80),
  };
  if(write&&!cfg.dryRun){
    await mkdir(dirname(P.summary),{recursive:true});
    await writeFile(P.summary,JSON.stringify(summary,null,1)+'\n');
    if(vaultOk)await writeFile(P.vault,JSON.stringify(await seal(state,cfg.dataKey))+'\n');
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
