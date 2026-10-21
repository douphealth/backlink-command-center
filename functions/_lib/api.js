import {operatorReady,authenticateCode,clearOperatorCookie} from './operator-auth.js';
import {ACTIONS,SPENDING,CONTROL_DEFAULTS,ensureDb,query,first,run,count,flags,log,workerSummary,NOW,csvSafe,isDomain} from './db.js';
import {SITES} from './sites.js';
import {gmailConfigured,probeGmail,sendingAuthorized,sendGmailMessage} from './gmail.js';
import {getToken} from './gsc.js';
import {accessReady,verifyAccess,checkCsrf} from './auth.js';

const HEADERS={'Cache-Control':'no-store, private','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{...HEADERS,'Content-Type':'application/json; charset=utf-8'}});}
function error(detail,status=400){return json({detail},status);}
const num=(text,def,cap)=>Number.isFinite(Number(text))?Math.max(1,Math.min(cap,Math.floor(Number(text)))):def;
const validAction=action=>Object.prototype.hasOwnProperty.call(ACTIONS,action);
const allowStatus=new Set(['found','research','rejected','hold','retry','verified_ready','qualified']);
async function addEvent(db,type,detail,id=null){try{await log(db,type,detail,id);}catch{ /* Never misreport primary action because audit insert failed */ }}
function pages(items,page,page_size,total){return {items,total,page,page_size};}
const onlyOneLine=(s,max=250)=>String(s??'').trim().slice(0,max).replace(/[\u0000-\u001f]/g,' ');

const EXPORTS={
 prospects:{table:'candidates',columns:['site','publisher_domain','source_url','asset_url','kind','status','score','contact_email','source_checked_at','editorial_policy_url','spam_score','traffic_monthly','domain_rank','competitor_count','excluded_reason']},
 outreach:{table:'messages',columns:['candidate_id','to_address','subject','status','gmail_id','gmail_draft_id','created_at','sent_at','followup_at']},
 placements:{table:'verified_links',columns:['candidate_id','placement_url','target_url','rel','observed_at']},
 submissions:{table:'submissions',columns:['site','publisher','form_url','asset_url','status','blocker','needs_login','needs_captcha','receipt','listing_url','checked_at']},
 spend:{table:'dfs_requests',columns:['request_id','site','endpoint','status','day_utc','reserved_micro','actual_micro','created_at','error_type']},
 suppression:{table:'suppression',columns:['identity','reason','source','created_at']},
};

export async function handleApi(request,env) {
  const url=new URL(request.url),path=url.pathname.replace(/^\/api\/?/,'');
  if(!url.pathname.startsWith('/api/')&&url.pathname!=='/api')return error('Not found',404);
  if(request.method==='GET'&&path==='setup')return json({
    mode:env?.DB && (operatorReady(env)||accessReady(env))?'configured':'setup_required',
    database_bound:!!env?.DB,
    admin_login_ready:operatorReady(env),
    auth_ready:operatorReady(env)||accessReady(env),
    cloudflare_access_configured:accessReady(env),
    login_method:operatorReady(env)?'deployment_code':accessReady(env)?'cloudflare_access':'not_provisioned',
    no_manual_cloudflare_setup:true,
    message:env?.DB && operatorReady(env)?'One Cloudflare Worker is ready. Sign in using the automatically generated access code.':'Deploy the unified Cloudflare Worker to connect dashboard, database and scheduled tasks.',
  });
  if(request.method==='POST'&&path==='login'){
    if(!operatorReady(env))return error('Use Cloudflare Access or deploy the unified Worker to enable code sign-in',410);
    if(!env?.DB)return error('Database is not connected',503);
    try {await ensureDb(env.DB);return await authenticateCode(request,env,env.DB);}catch{return error('Authentication database unavailable',503);}
  }
  if(request.method==='GET'&&path==='logout')return Response.redirect('/cdn-cgi/access/logout',302);
  const identity=await verifyAccess(request,env);
  if(!identity.ok)return error(identity.error,identity.status);
  if(!checkCsrf(request,identity))return error('Invalid request confirmation',403);
  if(!env?.DB)return error('Cloudflare D1 binding DB is not configured',503);
  const db=env.DB;
  try{await ensureDb(db);}catch{return error('Cloudflare D1 could not initialize. Check the DB binding.',503);}
  const now=NOW();const day=now.slice(0,10),month=now.slice(0,7);
  try{
    if(request.method==='GET'&&path==='session')return json({authenticated:true,csrf:identity.csrf,identity:identity.email,provider:identity.provider||'Cloudflare Access'});
    if(request.method==='POST'&&path==='logout'&&operatorReady(env))return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json','Set-Cookie':clearOperatorCookie(),'Cache-Control':'no-store'}});
    if(request.method==='POST'&&path==='logout')return json({ok:true,logout_url:'/cdn-cgi/access/logout'});
    if(request.method==='GET'&&path==='overview'){
      const [prospects,qualified,drafts,sent,links,pending,ledger,events,alerts,by_state,by_site,ws,daily]=await Promise.all([
        count(db,'candidates'),count(db,'candidates',"status IN ('verified_ready','qualified')"),count(db,'messages',"status IN ('draft','draft_uncertain')"),
        count(db,'messages',"status='sent'"),count(db,'verified_links'),count(db,'submissions',"status IN ('researched','eligible','ready')"),
        first(db,`SELECT COALESCE(SUM(CASE WHEN day_utc=? THEN COALESCE(actual_micro,reserved_micro) ELSE 0 END),0) today,
        COALESCE(SUM(CASE WHEN month_utc=? THEN COALESCE(actual_micro,reserved_micro) ELSE 0 END),0) month,
        SUM(CASE WHEN status IN ('uncertain','reserved') THEN 1 ELSE 0 END) unreconciled,COUNT(*) requests FROM dfs_requests`,day,month),
        query(db,'SELECT id,time_utc,type,detail,candidate_id FROM activity ORDER BY id DESC LIMIT 9'),
        query(db,'SELECT id,kind,observed_utc FROM dfs_spend_alerts WHERE cleared_utc IS NULL ORDER BY id DESC LIMIT 5'),
        query(db,'SELECT status,COUNT(*) AS count FROM candidates GROUP BY status ORDER BY count DESC'),
        query(db,"SELECT site,COUNT(*) AS prospects,SUM(CASE WHEN status='verified_ready' THEN 1 ELSE 0 END) AS qualified FROM candidates GROUP BY site ORDER BY prospects DESC"),
        first(db,'SELECT * FROM worker_status WHERE id=1'),
        query(db,'SELECT day_utc,SUM(COALESCE(actual_micro,reserved_micro)) AS micro FROM dfs_requests GROUP BY day_utc ORDER BY day_utc DESC LIMIT 14')
      ]);
      const worker=workerSummary(ws);
      return json({generated_at:now,counts:{prospects,qualified,drafts,sent,links,pending_forms:pending},
        spend:{today_usd:Number(ledger?.today||0)/1e6,month_usd:Number(ledger?.month||0)/1e6,today_limit:SPENDING.dayMicro/1e6,month_limit:SPENDING.monthMicro/1e6,
          requests_observed:ledger?.requests||0,unreconciled:ledger?.unreconciled||0,alerts,daily:daily.reverse()},
        by_state,by_site,events,last_activity:events[0]||null,sites_configured:SITES.length,links_verified:links,
        data_source:'Cloudflare D1 — verified records only',worker_status:worker.label,dfs_configured:false,paid_enabled:false});
    }
    if(request.method==='GET'&&path==='best-urls'){
      const items=await query(db,"SELECT site,url,score,impressions,clicks,position,kind,state,measured_at FROM url_opportunities ORDER BY score DESC LIMIT 120");
      return json({items,total:items.length,source:'Direct Search Console API',note:'These are candidates, not verified editorial placements. Validate live URL, canonical and editor fit before outreach.'});
    }
    if(request.method==='GET'&&path==='prospects'){
      const page=num(url.searchParams.get('page'),1,10000),size=num(url.searchParams.get('page_size'),25,100);
      const filters=[],args=[];for(const [param,field] of [['status','status'],['site','site']]){const v=url.searchParams.get(param);if(v&&v!=='all'){filters.push(`${field}=?`);args.push(v.slice(0,200));}}
      const q=url.searchParams.get('q');if(q){filters.push('(publisher_domain LIKE ? OR title LIKE ? OR source_url LIKE ?)');args.push(...Array(3).fill('%'+q.slice(0,100)+'%'));}
      const where=filters.length?'WHERE '+filters.join(' AND '):'';
      const sort={score:'score',site:'site',publisher:'publisher_domain',updated:'last_updated'}[url.searchParams.get('sort')]||'score';
      const total=(await first(db,`SELECT COUNT(*) AS n FROM candidates ${where}`,...args))?.n||0;
      const items=await query(db,`SELECT id,site,publisher_domain,source_url,asset_url,kind,title,status,score,contact_email,source_checked_at,
        traffic_monthly,spam_score,domain_rank,competitor_count,excluded_reason,explicit_invitation,last_updated,editorial_policy_url
        FROM candidates ${where} ORDER BY ${sort} DESC,id DESC LIMIT ? OFFSET ?`,...args,size,(page-1)*size);
      return json(pages(items,page,size,total));
    }
    const patch=path.match(/^prospects\/(\d+)$/);
    if(request.method==='PATCH'&&patch){
      const body=await request.json().catch(()=>({}));
      if(!allowStatus.has(body.status))return error('Unsupported status',422);
      const old=await first(db,'SELECT id,status FROM candidates WHERE id=?',Number(patch[1]));if(!old)return error('Prospect not found',404);
      if(['qualified','verified_ready'].includes(body.status)&&!['qualified','verified_ready'].includes(old.status))return error('Run source verification before claiming a qualified prospect',409);
      await run(db,'UPDATE candidates SET status=?,last_updated=? WHERE id=?',body.status,now,old.id);
      await addEvent(db,'admin_status_changed',{from:old.status,to:body.status,note:onlyOneLine(body.note,400)},old.id);return json({ok:true});
    }
    if(request.method==='GET'&&path==='outreach'){
      const page=num(url.searchParams.get('page'),1,10000),size=num(url.searchParams.get('page_size'),60,100);
      const items=await query(db,`SELECT m.id,m.to_address,m.subject,m.status,m.gmail_id,m.gmail_draft_id,m.sent_at,m.created_at,m.followup_at,
        c.site,c.publisher_domain,c.asset_url FROM messages m JOIN candidates c ON c.id=m.candidate_id ORDER BY m.id DESC LIMIT ? OFFSET ?`,size,(page-1)*size);
      return json(pages(items,page,size,await count(db,'messages')));
    }
    if(request.method==='GET'&&path==='placements'){
      const items=await query(db,'SELECT v.*,c.site,c.publisher_domain,c.kind FROM verified_links v JOIN candidates c ON c.id=v.candidate_id ORDER BY v.observed_at DESC LIMIT 250');
      return json({items,total:await count(db,'verified_links')});
    }
    if(request.method==='GET'&&path==='forms'){
      const items=await query(db,'SELECT id,site,publisher,form_url,asset_url,status,blocker,needs_login,needs_captcha,rights_confirmed,receipt,listing_url,checked_at FROM submissions ORDER BY id DESC LIMIT 200');
      return json({items,total:await count(db,'submissions')});
    }
    if(request.method==='GET'&&path==='spend'){
      const [items,alerts,gaps]=await Promise.all([
        query(db,'SELECT request_id,site,endpoint,status,day_utc,reserved_micro,actual_micro,created_at,error_type FROM dfs_requests ORDER BY created_at DESC LIMIT 150'),
        query(db,'SELECT kind,observed_utc,detail,cleared_utc FROM dfs_spend_alerts ORDER BY id DESC LIMIT 30'),
        query(db,'SELECT owned_site,publisher_domain,last_seen_utc,competitor_json,rank_1000,spam_score,nofollow_share,sample_status FROM dfs_gap_domains ORDER BY last_seen_utc DESC LIMIT 100')]);
      return json({items,alerts,gaps});
    }
    if(request.method==='GET'&&path==='activity')return json({items:await query(db,'SELECT id,time_utc,type,candidate_id,detail FROM activity ORDER BY id DESC LIMIT ?',num(url.searchParams.get('limit'),80,300))});
    if(request.method==='GET'&&path==='suppression')return json({items:await query(db,'SELECT identity,reason,source,created_at FROM suppression ORDER BY created_at DESC LIMIT 350'),total:await count(db,'suppression')});
    if(request.method==='POST'&&path==='suppression'){
      const body=await request.json().catch(()=>({})),v=onlyOneLine(body.identity).toLowerCase();
      const email=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      if(!(email||isDomain(v))||onlyOneLine(body.reason).length<5)return error('Provide a valid publisher domain or address and a reason',422);
      const reason=onlyOneLine(body.reason,280);
      await run(db,'INSERT INTO suppression(identity,reason,source,created_at) VALUES(?,?,?,?) ON CONFLICT(identity) DO UPDATE SET reason=excluded.reason,source=excluded.source',v,reason,'Cloudflare Command Center',now);
      await addEvent(db,'admin_suppressed',{identity:v,reason});return json({ok:true});
    }
    if(request.method==='GET'&&path==='sites'){
      const items=[];for(const s of SITES){const checks=await query(db,'SELECT url,http_status,status,checked_at FROM portfolio_assets WHERE domain=? ORDER BY checked_at DESC LIMIT 3',s.domain);
        items.push({domain:s.domain,topic:s.topic,assets_total:s.assets.length,verified_assets:(await first(db,"SELECT COUNT(*) AS n FROM portfolio_assets WHERE domain=? AND status='verified'",s.domain))?.n||0,asset_checks:checks});}
      return json({items});
    }
    if(request.method==='GET'&&path==='health'){
      const row=await first(db,'SELECT * FROM worker_status WHERE id=1'),controls=await flags(db);
      return json({database:'Cloudflare D1 connected',worker:workerSummary(row),
        gmail:gmailConfigured(env)?'OAuth credentials configured; not independently verified':'OAuth credentials missing',
        worker_outbound_authorized:sendingAuthorized(env,controls),
        gsc:env.GSC_SERVICE_ACCOUNT_JSON?'Service-account credential configured; not independently verified':'Service-account credential missing',
        dataforseo:'Paid requests disabled by default',automation:'Cron operational only when recent Worker heartbeat is present'});
    }
    if(request.method==='GET'&&path==='integrations/probe'){
      const state={tested_at:NOW(),database:{status:'connected'},gmail:{status:'credentials_missing'},gsc:{status:'credentials_missing'},worker:{status:'unknown'}};
      const heartbeat=await first(db,'SELECT * FROM worker_status WHERE id=1');
      const summary=workerSummary(heartbeat);state.worker={status:summary.running?'recent_heartbeat':'heartbeat_missing_or_stale',last_seen_at:summary.last_seen_at};
      state.gmail=await probeGmail(env);
      if(env.GSC_SERVICE_ACCOUNT_JSON){
        try{
          const token=await getToken(env);
          const response=await fetch('https://searchconsole.googleapis.com/webmasters/v3/sites',{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
          if(!response.ok)state.gsc={status:'api_rejected',http_status:response.status};
          else{
            const result=await response.json();
            const sites=Array.isArray(result.siteEntry)?result.siteEntry:[];
            state.gsc={status:sites.length?'authenticated':'authenticated_no_properties',readable_properties:sites.filter(x=>x.permissionLevel!=='siteUnverifiedUser').length};
          }
        }catch{state.gsc={status:'authentication_failed'};}
      }
      return json(state);
    }
    if(request.method==='POST'&&path==='integrations/gmail-self-test'){
      // Only an authenticated operator can initiate this operation; existing
      // CSRF checks apply. Never contact any publisher as a test.
      if(!gmailConfigured(env))return error('Worker Gmail OAuth credentials not configured',409);
      const probe=await probeGmail(env);
      if(!probe.ok)return json({ok:false,stage:'authentication',status:probe.status},409);
      const now=NOW(),subject='LinkForge private Worker delivery self-test '+now;
      try{
        const receipt=await sendGmailMessage(env,{to:env.GMAIL_SENDER_ADDRESS,subject,body:'Internal delivery test only. No publisher was contacted and this is not editorial outreach.'});
        await addEvent(db,'gmail_self_test',{at:now,gmail_id:receipt.gmail_id,recipient:'self'});
        return json({ok:true,status:'gmail_api_accepted',gmail_id:receipt.gmail_id,thread_id:receipt.thread_id,note:'Gmail API accepted a message to the configured sender; downstream delivery is not guaranteed.'});
      }catch{
        return json({ok:false,stage:'send',status:'gmail_api_rejected'},502);
      }
    }
    if(request.method==='GET'&&path==='operations'){
      const [ws,commands,controls]=await Promise.all([
        first(db,'SELECT * FROM worker_status WHERE id=1'),
        query(db,'SELECT id,action,status,requested_at,started_at,finished_at,outcome,error FROM worker_commands ORDER BY id DESC LIMIT 30'),
        flags(db)]);
      return json({worker:workerSummary(ws),controls,commands,actions:ACTIONS,policy:{dataforseo_hard_month_usd:1,dataforseo_hard_day_usd:.12,dataforseo_max_request_usd:.06,
        outbound_note:'Sending disabled until OAuth, suppression import and governance checks are connected.',
        research_note:'Scheduled Cloudflare Worker handles background execution; paid DataForSEO is paused by default.'}});
    }
    if(request.method==='POST'&&path==='operations/control'){
      const body=await request.json().catch(()=>({}));
      if(!Object.prototype.hasOwnProperty.call(CONTROL_DEFAULTS,body.key)||typeof body.paused!=='boolean')return error('Unsupported control',422);
      if(!body.paused&&['dataforseo_paused','outreach_paused'].includes(body.key)&&body.acknowledge_risk!==true)return error('Explicit acknowledgement required',409);
      await run(db,'UPDATE operator_controls SET value=?,updated_at=?,updated_by=? WHERE key=?',body.paused?1:0,now,identity.email,body.key);
      await addEvent(db,'operator_control',{key:body.key,paused:body.paused});return json({ok:true,key:body.key,paused:body.paused,effective_note:'Separate Worker environment and spending controls remain mandatory.'});
    }
    if(request.method==='POST'&&path==='operations/commands'){
      const body=await request.json().catch(()=>({}));if(!validAction(body.action))return error('Unknown action',422);
      const f=await flags(db);
      if(body.action==='research'&&f.research_paused)return error('Research is paused in Operations',409);
      const prior=await first(db,"SELECT id FROM worker_commands WHERE action=? AND status IN ('queued','running')",body.action);
      if(prior)return json({id:prior.id,created:false,status:'queued'});
      let inserted;
      try{inserted=await run(db,"INSERT INTO worker_commands(action,status,requested_at,requested_by) VALUES(?,'queued',?,?)",body.action,now,identity.email);}catch(err){
        const winner=await first(db,"SELECT id FROM worker_commands WHERE action=? AND status IN ('queued','running')",body.action);
        if(winner)return json({id:winner.id,created:false,status:'queued'});
        throw err;
      }
      await addEvent(db,'operator_queued_command',{action:body.action,id:inserted.meta?.last_row_id});return json({id:inserted.meta?.last_row_id,created:true,status:'queued'});
    }
    if(request.method==='GET'&&path==='learning'){
      const [outcomes,searches,referrals,counts]=await Promise.all([
        query(db,'SELECT o.candidate_id,o.outcome,o.evidence,o.time_utc,c.site,c.kind,c.publisher_domain FROM outcomes o JOIN candidates c ON c.id=o.candidate_id ORDER BY o.id DESC LIMIT 150'),
        query(db,'SELECT site,query,attempted_at,result_count,inserted_count,error FROM search_history ORDER BY id DESC LIMIT 50'),
        query(db,'SELECT site,referrer_domain,date,sessions,engaged_sessions,conversions,source FROM referral_metrics ORDER BY date DESC LIMIT 100'),
        query(db,'SELECT outcome,COUNT(*) AS total FROM outcomes GROUP BY outcome')]);
      return json({outcomes,referrals,searches,outcome_counts:counts,referral_sessions_in_latest_rows:referrals.reduce((n,x)=>n+Number(x.sessions||0),0),notes:'Only imported and verified analytics count; missing data is unknown.'});
    }
    const exportType=path.match(/^export\/(\w+)$/);
    if(request.method==='GET'&&exportType&&EXPORTS[exportType[1]]){
      const {table,columns}=EXPORTS[exportType[1]],rows=await query(db,`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid DESC LIMIT 5000`);
      const escape=v=>'"'+csvSafe(v).replaceAll('"','""')+'"';
      const csv=[columns.join(','),...rows.map(r=>columns.map(c=>escape(r[c])).join(','))].join('\r\n');
      return new Response(csv,{headers:{...HEADERS,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="linkforge-${exportType[1]}.csv"`}});
    }
    return error('Unknown endpoint',404);
  }catch(e){
    // Avoid returning SQL, configuration, external provider details or secrets to browsers.
    console.error('LinkForge API internal error',e?.name||'Error');
    return error('Unable to load verified records. Check the unified Cloudflare Worker logs and D1 binding.',500);
  }
}
