/**
 * Cloudflare-only LinkForge scheduled worker. No VPS, Python process or local SQLite.
 * Side effects are durable D1 records. Paid API and outbound email are disabled by
 * default, and no ambiguous billable request is automatically retried.
 */
import {ACTIONS,SPENDING,ensureDb,query,first,run,flags,log,workerSummary,NOW,isDomain} from '../functions/_lib/db.js';
import {SITES} from '../functions/_lib/sites.js';
import {collectSite} from '../functions/_lib/gsc.js';

const API='https://api.dataforseo.com/v3/';
const day=()=>new Date().toISOString().slice(0,10);
const month=()=>day().slice(0,7);
const asMicro=x=>Math.ceil(Number(x)*1e6);
const delay=(n)=>new Promise(resolve=>setTimeout(resolve,n));
const encode=(s)=>new TextEncoder().encode(s);
const hash=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encode(s)))].map(v=>v.toString(16).padStart(2,'0')).join('');

async function heartbeat(db,action,error='',stage=''){
  const stamp=NOW();
  await run(db,'INSERT OR IGNORE INTO worker_status(id,started_at,last_seen_at,last_action,updated_at) VALUES(1,?,?,?,?)',stamp,stamp,action,stamp);
  await run(db,`UPDATE worker_status SET last_seen_at=?,last_action=?,updated_at=?,last_error=CASE WHEN ?!='' THEN ? ELSE last_error END,
    last_research_at=CASE WHEN ?='research' THEN ? ELSE last_research_at END,
    last_monitor_at=CASE WHEN ?='monitor' THEN ? ELSE last_monitor_at END WHERE id=1`,
    stamp,action,stamp,error,error,stage,stamp,stage,stamp);
}
async function claim(db){
  const row=await first(db,"SELECT id,action FROM worker_commands WHERE status='queued' ORDER BY id LIMIT 1");
  if(!row)return null;
  const result=await run(db,"UPDATE worker_commands SET status='running',started_at=? WHERE id=? AND status='queued'",NOW(),row.id);
  return result.meta?.changes===1?row:null;
}
async function complete(db,id,ok,outcome,error=''){
  await run(db,'UPDATE worker_commands SET status=?,finished_at=?,outcome=?,error=? WHERE id=?',ok?'completed':'failed',NOW(),outcome.slice(0,1200),error.slice(0,240),id);
}
function allowUrl(input){
  try{const u=new URL(input);if(u.protocol!=='https:'&&u.protocol!=='http:')return false;
    if(u.username||u.password||!isDomain(u.hostname)||/(^|\.)localhost$/.test(u.hostname))return false;
    return !/(^|\.)((?:local|internal|invalid|test))$/.test(u.hostname);
  }catch{return false;}
}
async function requestPublic(url,{maxChars=75000}={}){
  if(!allowUrl(url))return {status:0,error:'Unsupported or unsafe URL'};
  try{
    const resp=await fetch(url,{method:'GET',redirect:'manual',headers:{'User-Agent':'LinkForge-Source-Verification/1.0'}});
    if(resp.status>=300&&resp.status<400)return {status:resp.status,error:'Page redirects; exact target not verified'};
    const type=resp.headers.get('content-type')||'';
    if(!/text\/html|text\/plain/.test(type))return {status:resp.status,error:'Non-text source'};
    const text=(await resp.text()).slice(0,maxChars);
    return {status:resp.status,text};
  }catch{return {status:0,error:'Source could not be fetched'};}
}

export async function auditAssets(db,limit=4){
  const verified=[];let attempted=0,failed=0;
  const items=SITES.flatMap(s=>s.assets.map(url=>({domain:s.domain,url})));
  // Pick the oldest/unseen resources rather than repeatedly checking the first site.
  const existing=await query(db,'SELECT domain,url,checked_at FROM portfolio_assets');
  const dates=new Map(existing.map(x=>[x.domain+'|'+x.url,x.checked_at||'']));
  items.sort((a,b)=>(dates.get(a.domain+'|'+a.url)||'').localeCompare(dates.get(b.domain+'|'+b.url)||''));
  for(const item of items.slice(0,limit)){
    const result=await requestPublic(item.url,{maxChars:18000});attempted++;
    const ok=result.status===200&&result.text?.length>100;
    if(!ok)failed++;
    await run(db,`INSERT INTO portfolio_assets(domain,url,http_status,status,checked_at) VALUES(?,?,?,?,?)
      ON CONFLICT(domain,url) DO UPDATE SET http_status=excluded.http_status,status=excluded.status,checked_at=excluded.checked_at`,
      item.domain,item.url,result.status,ok?'verified':'unverified',NOW());
    verified.push({url:item.url,status:result.status,verified:ok});
  }
  await log(db,'asset_verification',{attempted,failed,verified:verified.length});
  return {attempted,verified:verified.filter(x=>x.verified).length,failed};
}

export async function checkLiveLinks(db,limit=8){
  const rows=await query(db,'SELECT id,placement_url,target_url FROM verified_links ORDER BY observed_at ASC LIMIT ?',limit);
  let checked=0,confirmed=0,lost=0;
  for(const row of rows){
    const res=await requestPublic(row.placement_url,{maxChars:160000});checked++;
    if(res.status!==200){await log(db,'link_recheck_blocked',{id:row.id,status:res.status});continue;}
    // Deliberately no blind substring acceptance: HTML anchor must contain a target URL.
    const urls=[...res.text.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(x=>x[1]);
    const match=urls.some(u=>{try{const a=new URL(u,row.placement_url),b=new URL(row.target_url);return a.hostname===b.hostname&&a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'');}catch{return false;}});
    if(match){confirmed++;await run(db,'UPDATE verified_links SET observed_at=? WHERE id=?',NOW(),row.id)}else{
      lost++;await log(db,'link_may_be_missing',{id:row.id,source:row.placement_url});
      // Keep the historical placement record, don't fabricate successful rechecks.
    }
  }
  return {checked,confirmed,lost};
}

function accountRate(account,endpoint){
  const key=endpoint.split('/')[1];
  const entries=account?.price?.backlinks?.[key]?.live?.priority_normal;
  if(!Array.isArray(entries)||entries.length<2)throw Error('Provider account-specific price unavailable');
  let request=null,row=null;
  for(const x of entries){const cost=Number(x?.cost);if(!Number.isFinite(cost)||cost<0)throw Error('Invalid provider pricing');
    if(x.cost_type==='perrequest')request=(request??0)+cost;
    if(x.cost_type==='perresult')row=(row??0)+cost;
  }
  if(request==null||row==null)throw Error('Full request and row rates must be verified');
  return {request,row};
}
async function providerAccount(auth){
  const resp=await fetch(API+'appendix/user_data',{method:'GET',headers:{Authorization:'Basic '+auth,Accept:'application/json'},redirect:'error'});
  if(!resp.ok)throw Error('DataForSEO free account check failed');
  const body=await resp.json();
  const task=body?.tasks?.[0];if(body.status_code!==20000||task?.status_code!==20000||!task.result?.[0])throw Error('Provider account verification incomplete');
  const result=task.result[0];
  if(!Number.isFinite(Number(result.money?.balance))||Number(result.money.balance)<0)throw Error('Provider balance unknown');
  return result;
}
async function reservePaid(db,site,endpoint,payload,price,balance){
  const requested=payload.limit;
  const predicted=asMicro((price.request+price.row*requested)*1.25);
  if(!(predicted>0)||predicted>SPENDING.requestMicro)throw Error('Predicted API charge exceeds per-request guardrail');
  const ident=await hash(JSON.stringify({endpoint,payload})),id=await hash(day()+':'+ident);
  const old=await first(db,'SELECT request_id FROM dfs_requests WHERE request_id=?',id);
  if(old)throw Error('This request was attempted today; automatic retry blocked');
  const problem=await first(db,"SELECT COUNT(*) AS n FROM dfs_requests WHERE status IN ('uncertain','reserved')");
  if(problem?.n)throw Error('Uncertain previous charge; automatic billable calls paused');
  const issue=await first(db,'SELECT COUNT(*) AS n FROM dfs_spend_alerts WHERE cleared_utc IS NULL');
  if(issue?.n)throw Error('Unresolved DataForSEO spending anomaly');
  const costs=await first(db,`SELECT COALESCE(SUM(CASE WHEN day_utc=? THEN COALESCE(actual_micro,reserved_micro) ELSE 0 END),0) today,
      COALESCE(SUM(CASE WHEN month_utc=? THEN COALESCE(actual_micro,reserved_micro) ELSE 0 END),0) month,
      SUM(CASE WHEN day_utc=? THEN 1 ELSE 0 END) calls,
      SUM(CASE WHEN day_utc=? AND site=? THEN 1 ELSE 0 END) site_calls
      FROM dfs_requests`,day(),month(),day(),day(),site);
  if(Number(costs.today)+predicted>SPENDING.dayMicro||Number(costs.month)+predicted>SPENDING.monthMicro||
    Number(costs.calls)>=SPENDING.requestsPerDay||Number(costs.site_calls)>=SPENDING.sitePerDay)throw Error('DataForSEO budget or frequency ceiling reached');
  const watch=await first(db,'SELECT balance_micro,accounted_micro FROM dfs_account_watch ORDER BY id DESC LIMIT 1');
  const accounted=(await first(db,'SELECT COALESCE(SUM(COALESCE(actual_micro,reserved_micro)),0) AS n FROM dfs_requests'))?.n||0;
  const current=asMicro(balance);
  if(watch){const drop=Math.max(0,Number(watch.balance_micro)-current);const explained=Math.max(0,Number(accounted)-Number(watch.accounted_micro));
    if(drop-explained>5000){await run(db,'INSERT INTO dfs_spend_alerts(kind,observed_utc,detail) VALUES(?,?,?)','unexplained_provider_spend',NOW(),'Additional DataForSEO spending detected outside LinkForge.');throw Error('Unexplained DataForSEO account spending; paid queries stopped');}
  }
  await run(db,'INSERT INTO dfs_account_watch(balance_micro,accounted_micro,checked_utc) VALUES(?,?,?)',current,accounted,NOW());
  // A unique global lock permits only one paid caller. Never retry ambiguous lock errors.
  const lock=await run(db,"INSERT OR IGNORE INTO cron_locks(name,owner,claimed_at,expires_at) VALUES('dataforseo',?,?,?)",id,NOW(),new Date(Date.now()+24*3600e3).toISOString());
  if(lock.meta?.changes!==1)throw Error('Another charged request or unresolved lock exists');
  try{
    await run(db,`INSERT INTO dfs_requests(request_id,key_hash,site,endpoint,status,day_utc,month_utc,reserved_micro,created_at)
      VALUES(?,?,?,?,'reserved',?,?,?,?)`,id,ident,site,endpoint,day(),month(),predicted,NOW());
  }catch(e){ /* Fail closed: leave paid lock for explicit operator investigation. */throw e;}
  return {id,ident,predicted};
}

/** Perform at most ONE metered lookup, only when all independent gates allow it. */
export async function researchGap(db,env){
  const c=await flags(db);
  if(c.research_paused)return {blocked:'Research paused'};
  if(c.dataforseo_paused||env.DATAFORSEO_PAID_ENABLED!=='YES'||!env.DATAFORSEO_BASIC_AUTH)return {blocked:'DataForSEO paid calls paused or credentials not connected'};
  const choices=SITES.filter(s=>s.competitors.length>=2);
  // A paid lookup must have at least one previously verified source asset.
  let chosen=null;
  for(const s of choices){if((await first(db,"SELECT COUNT(*) AS n FROM portfolio_assets WHERE domain=? AND status='verified'",s.domain))?.n){chosen=s;break;}}
  if(!chosen)return {blocked:'Verify existing website assets before paid prospect research'};
  const payload={targets:{1:chosen.competitors[0],2:chosen.competitors[1]},exclude_targets:[chosen.domain],include_subdomains:false,
    exclude_internal_backlinks:true,backlinks_status_type:'live',limit:Math.min(SPENDING.rows,25)};
  const endpoint='backlinks/domain_intersection/live',key=await hash(JSON.stringify({endpoint,payload}));
  const cached=await first(db,'SELECT json_result FROM dfs_cache WHERE key_hash=? AND expires_utc>?',key,NOW());
  if(cached)return {cached:true,site:chosen.domain};
  const account=await providerAccount(env.DATAFORSEO_BASIC_AUTH); // Free call; check actual account price.
  const price=accountRate(account,endpoint);
  const reservation=await reservePaid(db,chosen.domain,endpoint,payload,price,account.money.balance);
  try{
    const response=await fetch(API+endpoint,{method:'POST',headers:{Authorization:'Basic '+env.DATAFORSEO_BASIC_AUTH,'Content-Type':'application/json'},body:JSON.stringify([payload]),redirect:'error'});
    if(!response.ok)throw Error('Metered endpoint responded with an error');
    const data=await response.json(),task=data?.tasks?.[0];
    if(data.status_code!==20000||task?.status_code!==20000)throw Error('Metered provider task failed');
    const actual=asMicro(task.cost??data.cost);
    if(!Number.isFinite(actual)||actual>reservation.predicted){
      await run(db,'INSERT INTO dfs_spend_alerts(kind,observed_utc,detail) VALUES(?,?,?)','provider_price_overrun',NOW(),'Returned price exceeded worst-case reservation');
      throw Error('Cost exceeded reservation; further paid calls blocked');
    }
    await run(db,"UPDATE dfs_requests SET status='completed',actual_micro=?,finished_at=?,task_id=? WHERE request_id=?",actual,NOW(),String(task.id||''),reservation.id);
    await run(db,'INSERT OR REPLACE INTO dfs_cache(key_hash,json_result,expires_utc,actual_micro,task_id) VALUES(?,?,?,?,?)',key,JSON.stringify(task.result??[]),new Date(Date.now()+21*86400e3).toISOString(),actual,String(task.id||''));
    const dataRows=task.result??[];let found=0;
    for(const result of dataRows){for(const item of (result.items??[])){
      const slots=item.domain_intersection??{};
      if(Object.keys(slots).length<2)continue;
      const publisher=String(item.domain||item.domain_from||'').replace(/^www\./,'').toLowerCase();
      if(!isDomain(publisher)||publisher===chosen.domain||chosen.competitors.includes(publisher))continue;
      if(await first(db,'SELECT identity FROM suppression WHERE identity=?',publisher))continue;
      await run(db,`INSERT OR IGNORE INTO dfs_gap_domains(owned_site,publisher_domain,first_seen_utc,last_seen_utc,competitor_json,rank_1000,spam_score,nofollow_share,sample_status)
        VALUES(?,?,?,?,?,?,?,?,?)`,chosen.domain,publisher,NOW(),NOW(),JSON.stringify(chosen.competitors),item.rank??null,null,null,'research_only_not_verified');
      found++;
    }}
    await log(db,'dataforseo_gap_lookup',{site:chosen.domain,candidates:found,task_id:task.id,cost_usd:actual/1e6});
    await run(db,"DELETE FROM cron_locks WHERE name='dataforseo' AND owner=?",reservation.id);
    return {site:chosen.domain,lookup:true,candidates:found,spent_usd:actual/1e6};
  }catch{
    await run(db,"UPDATE dfs_requests SET status='uncertain',error_type='unknown_charge',finished_at=? WHERE request_id=?",NOW(),reservation.id);
    // Keep lock permanently: don't auto-retry or spend again after uncertainty.
    throw Error('Paid request outcome uncertain; no automatic retries or further charges');
  }
}

async function verifyCandidates(db){
  const rows=await query(db,"SELECT id,source_url FROM candidates WHERE status IN ('found','research','retry') ORDER BY last_updated ASC LIMIT 5");
  let verified=0,blocked=0;
  for(const c of rows){const resp=await requestPublic(c.source_url);if(resp.status===200){
      await run(db,"UPDATE candidates SET status='research',source_checked_at=?,last_updated=? WHERE id=?",NOW(),NOW(),c.id);verified++;
    }else{blocked++;await run(db,"UPDATE candidates SET excluded_reason=?,last_updated=? WHERE id=?",'Source unreachable or redirected',NOW(),c.id);}}
  return {checked:rows.length,reached:verified,blocked,note:'Reaching a page does not automatically qualify its editorial policy or contact'};
}
async function doAction(db,env,action){
  if(action==='sync_gsc'){
    if(!env.GSC_SERVICE_ACCOUNT_JSON)return {blocked:'Service account not configured'};
    const records=await query(db,"SELECT site,last_attempt_at FROM gsc_sync_state");
    const checks=new Map(records.map(x=>[x.site,x.last_attempt_at]));
    const candidate=[...SITES].sort((a,b)=>(checks.get(a.domain)||'').localeCompare(checks.get(b.domain)||''))[0];
    const output=await collectSite(db,env,candidate.domain);
    await run(db,"INSERT INTO gsc_sync_state(site,last_attempt_at,last_result) VALUES(?,?,?) ON CONFLICT(site) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_result=excluded.last_result",candidate.domain,NOW(),output.blocked?'blocked':'completed');
    return output;
  }
  if(action==='audit_assets')return auditAssets(db);
  if(action==='research'){
    const assets=await auditAssets(db,2);
    let gaps;try{gaps=await researchGap(db,env);}catch(e){gaps={blocked:e.message};}
    await run(db,'INSERT INTO search_history(site,query,attempted_at,result_count,inserted_count,error) VALUES(?,?,?,?,?,?)',
      '', 'DataForSEO verified competitor link gap', NOW(),gaps.candidates??0,0,gaps.blocked||'');
    return {asset_checks:assets,link_gap:gaps};
  }
  if(action==='verify')return verifyCandidates(db);
  if(action==='check_links')return checkLiveLinks(db);
  if(action==='monitor')return {blocked:'Gmail OAuth not connected to scheduled Worker; no email read or send attempted'};
  if(action==='weekly')return {link_checks:await checkLiveLinks(db),learning:'Only verified editor responses and placements influence future work'};
  throw Error('Unknown action');
}
export async function runTick(env,{maxJobs=2}={}){
  if(!env?.DB)throw Error('D1 binding DB is missing');
  const db=env.DB;await ensureDb(db);await heartbeat(db,'scheduled');
  const results=[];
  // Queue one free, read-only Search Console rotation per scheduled cycle.
  if(env.GSC_SERVICE_ACCOUNT_JSON){
    const last=await first(db,"SELECT requested_at FROM worker_commands WHERE action='sync_gsc' ORDER BY id DESC LIMIT 1");
    if(!last||Date.now()-Date.parse(last.requested_at)>55*60*1000)
      await run(db,"INSERT OR IGNORE INTO worker_commands(action,status,requested_at,requested_by) VALUES('sync_gsc','queued',?,'scheduled-worker')",NOW());
  }
  // Automatic daily research: fixed cadence, not a perpetual spend loop.
  const utcHour=new Date().getUTCHours();
  if(utcHour%8===0 && !(await flags(db)).research_paused){
    const last=await first(db,"SELECT requested_at FROM worker_commands WHERE action='research' ORDER BY id DESC LIMIT 1");
    if(!last||Date.now()-Date.parse(last.requested_at)>7*3600*1000){
      await run(db,"INSERT OR IGNORE INTO worker_commands(action,status,requested_at,requested_by) VALUES('research','queued',?,'scheduled-worker')",NOW());
    }
  }
  for(let i=0;i<maxJobs;i++){
    const work=await claim(db);if(!work)break;
    try{
      const output=await doAction(db,env,work.action);
      // A blocked job is not reported as completed successfully.
      const blocked=Boolean(output?.blocked||(output?.link_gap?.blocked&&output.asset_checks?.verified===0));
      await complete(db,work.id,!blocked,JSON.stringify(output),blocked?String(output.blocked||output.link_gap.blocked):'');
      await heartbeat(db,'scheduled','',work.action==='research'?'research':work.action==='monitor'?'monitor':'');
      await log(db,blocked?'job_blocked':'job_completed',{id:work.id,action:work.action,output});
      results.push({id:work.id,action:work.action,blocked,output});
    }catch(e){await complete(db,work.id,false,'',e.message);await heartbeat(db,'scheduled',e.message);results.push({id:work.id,error:e.message});}
  }
  return results;
}
export default {
  async scheduled(_controller,env,ctx){ctx.waitUntil(runTick(env).catch(e=>console.error('LinkForge scheduled run failed',e.message)));},
};
