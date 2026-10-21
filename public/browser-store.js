/**
 * LinkForge Pages workspace — no server secrets, billable calls or false outcomes.
 * Data lives in this browser's IndexedDB. An authenticated D1-backed Worker can
 * still supply the same API when the owner explicitly deploys it.
 */
const STORAGE_NAME='linkforge-browser-workspace';
const STORAGE_KEY='portfolio-v1';
const DEFAULT_CONTROLS=Object.freeze({research_paused:true,dataforseo_paused:true,outreach_paused:true});
const ACTIONS=Object.freeze({research:'Plan publisher research',audit_assets:'Plan owned-site audit',verify:'Plan publisher verification',check_links:'Plan backlink recheck',monitor:'Plan reply review',weekly:'Plan outcome review'});
const CAP={day:0.12,month:1,request:0.06};
const NOW=()=>new Date().toISOString();
const blank=()=>({version:1,candidates:[],messages:[],verified_links:[],submissions:[],dfs_requests:[],dfs_spend_alerts:[],dfs_gap_domains:[],portfolio_assets:[],activity:[],suppression:[],worker_commands:[],outcomes:[],search_history:[],referral_metrics:[],operator_controls:{...DEFAULT_CONTROLS},ids:{}});
const validDomain=v=>/^(?=.{4,255}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z]{2,}$/i.test(String(v||''));
const validUrl=v=>{try{const u=new URL(v);return /^https?:$/.test(u.protocol)&&validDomain(u.hostname)&&!u.username&&!u.password;}catch{return false;}};
const clone=value=>JSON.parse(JSON.stringify(value));
const int=(v,def=0)=>Number.isFinite(Number(v))?Math.round(Number(v)):def;
const norm=(v,max=300)=>String(v??'').trim().slice(0,max).replace(/[\u0000-\u001f]/g,' ');
const sortDesc=(rows,key)=>[...rows].sort((a,b)=>String(b[key]??'').localeCompare(String(a[key]??'')));
const csvSafe=v=>{const s=String(v??'');return /^\s*[=+@-]/.test(s)?"'"+s:s;};
const CSV_COLUMNS={
 prospects:['site','publisher_domain','source_url','asset_url','kind','status','score','contact_email','source_checked_at','editorial_policy_url','spam_score','traffic_monthly','domain_rank','competitor_count','excluded_reason'],
 outreach:['candidate_id','to_address','subject','status','gmail_id','gmail_draft_id','created_at','sent_at','followup_at'],
 placements:['candidate_id','placement_url','target_url','rel','observed_at'],
 submissions:['site','publisher','form_url','asset_url','status','blocker','needs_login','needs_captcha','receipt','listing_url','checked_at'],
 spend:['request_id','site','endpoint','status','day_utc','reserved_micro','actual_micro','created_at','error_type'],
 suppression:['identity','reason','source','created_at']
};
const DATASETS={prospects:'candidates',outreach:'messages',placements:'verified_links',submissions:'submissions',spend:'dfs_requests',suppression:'suppression'};
function csvEscape(v){return '"'+csvSafe(v).replaceAll('"','""')+'"';}
export function csvRows(text){
  if(text.length>5_000_000)throw Error('CSV exceeds the 5 MB local import limit');
  const lines=[];let row=[],part='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){part+='"';i++;}else if(c==='"')quoted=false;else part+=c;}
    else if(c==='"')quoted=true;else if(c===','){row.push(part);part='';}
    else if(c==='\n'){row.push(part.replace(/\r$/,''));if(row.some(x=>x.trim()))lines.push(row);row=[];part='';if(lines.length>5001)throw Error('CSV exceeds the 5,000-row import limit');}
    else part+=c;
  }
  if(quoted)throw Error('Malformed CSV: unclosed quote');
  row.push(part.replace(/\r$/,''));if(row.some(x=>x.trim()))lines.push(row);
  if(!lines.length)return [];
  const keys=lines.shift().map(x=>x.replace(/^\ufeff/,'').trim().toLowerCase());
  if(new Set(keys).size!==keys.length)throw Error('CSV has duplicate column names');
  return lines.map(items=>Object.fromEntries(keys.map((key,i)=>[key,(items[i]||'').trim()])));
}
function openStore(idb){
  if(!idb)return Promise.resolve(null);
  return new Promise(resolve=>{
    let request;try{request=idb.open(STORAGE_NAME,1);}catch{resolve(null);return;}
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('documents'))db.createObjectStore('documents');};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>resolve(null);
    request.onblocked=()=>resolve(null);
  });
}
function getRecord(db){return new Promise(resolve=>{
  if(!db){resolve(null);return;}
  try{const tx=db.transaction('documents','readonly');const request=tx.objectStore('documents').get(STORAGE_KEY);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>resolve(null);}catch{resolve(null);}
});}
function putRecord(db,record){return new Promise((resolve,reject)=>{
  if(!db){resolve(false);return;}
  try{const tx=db.transaction('documents','readwrite');tx.objectStore('documents').put(record,STORAGE_KEY);tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(Error('Browser storage is full or blocked'));}catch(err){reject(err);}
});}
function secureRecord(persisted){
  if(!persisted||typeof persisted!=='object')return blank();
  const result=blank();
  for(const key of Object.keys(result)){
    if(Array.isArray(result[key])&&Array.isArray(persisted[key]))result[key]=persisted[key].slice(0,5000).filter(x=>x&&typeof x==='object');
  }
  for(const k of Object.keys(DEFAULT_CONTROLS))result.operator_controls[k]=persisted.operator_controls?.[k]===undefined?DEFAULT_CONTROLS[k]:!!persisted.operator_controls[k];
  if(persisted.ids&&typeof persisted.ids==='object')result.ids=persisted.ids;
  return result;
}
function event(doc,type,detail,candidate_id=null){doc.activity.unshift({id:nextId(doc,'activity'),time_utc:NOW(),type,detail:JSON.stringify(detail),candidate_id});doc.activity=doc.activity.slice(0,1000);}
function nextId(doc,collection){const old=doc.ids[collection]||Math.max(0,...doc[collection].map(x=>Number(x.id)||0));doc.ids[collection]=old+1;return old+1;}
function filterProspects(doc,params){let data=[...doc.candidates];for(const key of ['site','status']){const value=params.get(key);if(value&&value!=='all')data=data.filter(x=>x[key]===value);}
 const q=(params.get('q')||'').trim().toLowerCase();if(q)data=data.filter(x=>[x.publisher_domain,x.title,x.source_url].some(y=>String(y||'').toLowerCase().includes(q)));
 const order={score:'score',site:'site',publisher:'publisher_domain',updated:'last_updated'}[params.get('sort')]||'score';
 data.sort((a,b)=>order==='score'?int(b.score)-int(a.score):String(b[order]??'').localeCompare(String(a[order]??'')));
 const page=Math.max(1,Math.min(10000,int(params.get('page'),1)||1)),size=Math.max(1,Math.min(100,int(params.get('page_size'),25)||25));
 return {items:data.slice((page-1)*size,page*size),total:data.length,page,page_size:size};
}
export class BrowserStore {
  constructor({idb=globalThis.indexedDB,sites}={}){
    this.doc=blank();this.sites=sites||[];this.persistent=false;this.persistenceWarning='';this.queue=Promise.resolve();
    this.ready=this.initialize(idb,sites);
  }
  async initialize(idb,sites){
    this.db=await openStore(idb);this.persistent=!!this.db;
    if(this.db)this.doc=secureRecord(await getRecord(this.db));
    if(!sites){try{const response=await fetch('/portfolio.json',{cache:'force-cache'});if(response.ok){const data=await response.json();if(Array.isArray(data.sites))this.sites=data.sites;}}catch{ /* Missing portfolio asset is non-fatal */ }}
    if(!this.db)this.persistenceWarning='Browser storage is blocked. Changes will not survive closing this tab.';
    return this;
  }
  async update(fn){await this.ready;const work=this.queue.then(async()=>{
    const result=await fn(this.doc);
    if(this.db)await putRecord(this.db,this.doc);
    return result;
  });this.queue=work.catch(()=>{});return work;}
  async read(fn){await this.ready;await this.queue;return clone(fn(this.doc));}
  async api(path,options={}){
    await this.ready;const u=new URL(path,'https://workspace.example/'),p=u.pathname.replace(/^\//,''),method=(options.method||'GET').toUpperCase();
    const body=typeof options.body==='string'?JSON.parse(options.body):options.body||{};
    const siteNames=new Set(this.sites.map(x=>x.domain));
    if(method==='GET'&&p==='session')return {authenticated:true,csrf:'browser-only',identity:'Current browser',provider:'IndexedDB browser workspace',local_only:true};
    if(method==='GET'&&p==='overview')return this.read(doc=>{
      const today=NOW().slice(0,10),month=today.slice(0,7);
      const spend=rows=>rows.reduce((s,r)=>s+Number(r.actual_micro??r.reserved_micro??0),0)/1e6;
      const statusMap=new Map();const siteMap=new Map();
      for(const c of doc.candidates){statusMap.set(c.status,(statusMap.get(c.status)||0)+1);const s=siteMap.get(c.site)||{site:c.site,prospects:0,qualified:0};s.prospects++;if(c.status==='verified_ready')s.qualified++;siteMap.set(c.site,s);}
      return {generated_at:NOW(),counts:{prospects:doc.candidates.length,qualified:doc.candidates.filter(x=>x.status==='verified_ready').length,drafts:doc.messages.filter(x=>['draft','draft_uncertain'].includes(x.status)).length,sent:doc.messages.filter(x=>x.status==='sent'&&x.gmail_id).length,links:doc.verified_links.filter(x=>x.evidence_checked===true).length,pending_forms:doc.submissions.filter(x=>['researched','eligible','ready'].includes(x.status)).length},
        spend:{today_usd:spend(doc.dfs_requests.filter(x=>x.day_utc===today)),month_usd:spend(doc.dfs_requests.filter(x=>x.month_utc===month)),today_limit:CAP.day,month_limit:CAP.month,requests_observed:doc.dfs_requests.length,unreconciled:doc.dfs_requests.filter(x=>['uncertain','reserved'].includes(x.status)).length,alerts:doc.dfs_spend_alerts.filter(x=>!x.cleared_utc),daily:[]},
        by_state:[...statusMap].map(([status,count])=>({status,count})),by_site:[...siteMap.values()],events:sortDesc(doc.activity,'time_utc').slice(0,9),last_activity:doc.activity[0]||null,sites_configured:this.sites.length,links_verified:doc.verified_links.filter(x=>x.evidence_checked===true).length,
        data_source:'Browser IndexedDB — private to this device',worker_status:'Browser workspace — no scheduled Worker',dfs_configured:false,paid_enabled:false};
    });
    if(method==='GET'&&p==='prospects')return this.read(doc=>filterProspects(doc,u.searchParams));
    if(method==='POST'&&p==='prospects')return this.update(doc=>{
      const site=norm(body.site),domain=norm(body.publisher_domain,255).toLowerCase(),source=norm(body.source_url,1000);
      if(!siteNames.has(site)||!validDomain(domain)||!validUrl(source))throw Error('Select a portfolio site, valid publisher domain and HTTPS source URL');
      if(doc.candidates.some(c=>c.site===site&&c.publisher_domain===domain&&c.source_url===source))throw Error('This prospect is already in your workspace');
      const id=nextId(doc,'candidates');doc.candidates.unshift({id,site,publisher_domain:domain,source_url:source,asset_url:'',kind:'editorial',title:norm(body.title),status:'found',score:null,contact_email:null,source_checked_at:null,traffic_monthly:null,spam_score:null,domain_rank:null,competitor_count:null,excluded_reason:null,explicit_invitation:0,last_updated:NOW(),editorial_policy_url:null});
      event(doc,'local_prospect_added',{id,site,domain});return {ok:true,id};
    });
    const patch=p.match(/^prospects\/(\d+)$/);
    if(method==='PATCH'&&patch)return this.update(doc=>{
      const candidate=doc.candidates.find(x=>x.id===Number(patch[1]));if(!candidate)throw Error('Prospect not found');
      if(!['found','research','rejected','hold','retry'].includes(body.status))throw Error('Only independent source verification can mark a prospect verified');
      const before=candidate.status;candidate.status=body.status;candidate.last_updated=NOW();event(doc,'local_prospect_status',{id:candidate.id,from:before,to:body.status,note:norm(body.note)});return {ok:true};
    });
    if(method==='GET'&&p==='outreach')return this.read(doc=>({items:sortDesc(doc.messages,'created_at').slice(0,60).map(m=>({...(doc.candidates.find(c=>c.id===m.candidate_id)||{}),...m})),total:doc.messages.length,page:1}));
    if(method==='GET'&&p==='placements')return this.read(doc=>({items:sortDesc(doc.verified_links.filter(x=>x.evidence_checked===true),'observed_at').slice(0,250).map(x=>({...x,...(doc.candidates.find(c=>c.id===x.candidate_id)||{})})),total:doc.verified_links.filter(x=>x.evidence_checked===true).length}));
    if(method==='GET'&&p==='forms')return this.read(doc=>({items:sortDesc(doc.submissions,'checked_at').slice(0,200),total:doc.submissions.length}));
    if(method==='GET'&&p==='spend')return this.read(doc=>({items:sortDesc(doc.dfs_requests,'created_at').slice(0,150),alerts:doc.dfs_spend_alerts,gaps:doc.dfs_gap_domains}));
    if(method==='GET'&&p==='activity')return this.read(doc=>({items:sortDesc(doc.activity,'time_utc').slice(0,Math.min(300,int(u.searchParams.get('limit'),80)||80))}));
    if(method==='GET'&&p==='suppression')return this.read(doc=>({items:sortDesc(doc.suppression,'created_at').slice(0,350),total:doc.suppression.length}));
    if(method==='POST'&&p==='suppression')return this.update(doc=>{
      const identity=norm(body.identity,255).toLowerCase(),reason=norm(body.reason,280);
      if(!(validDomain(identity)||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity))||reason.length<5)throw Error('Enter a valid email or domain and an explanatory reason');
      const item=doc.suppression.find(x=>x.identity===identity);if(item)item.reason=reason;else doc.suppression.unshift({identity,reason,source:'Browser workspace',created_at:NOW()});
      event(doc,'local_suppression_added',{identity,reason});return {ok:true};
    });
    if(method==='GET'&&p==='sites')return this.read(doc=>({items:this.sites.map(site=>{
      const checks=doc.portfolio_assets.filter(x=>x.domain===site.domain);
      return {domain:site.domain,topic:site.topic,assets_total:site.assets.length,verified_assets:checks.filter(x=>['verified','reachable'].includes(x.status)).length,asset_checks:sortDesc(checks,'checked_at').slice(0,3)};
    })}));
    if(method==='GET'&&p==='health')return {database:this.persistent?'IndexedDB on current device':'Temporary browser memory',worker:{running:false,label:'No scheduled Cloudflare Worker connected'},gmail:'Not configured',dataforseo:'No paid requests enabled',automation:'Manual task plans only in browser mode'};
    if(method==='GET'&&p==='operations')return this.read(doc=>({worker:{running:false,label:'Browser workspace — no background worker',last_seen_at:null,last_research_at:null,last_monitor_at:null,last_error:null},controls:doc.operator_controls,commands:doc.worker_commands.slice(0,30),actions:ACTIONS,policy:{dataforseo_hard_month_usd:CAP.month,dataforseo_hard_day_usd:CAP.day,dataforseo_max_request_usd:CAP.request,outbound_note:'Browser mode never sends email or uses paid DataForSEO.',research_note:'Saved plans require an explicitly connected scheduled Worker; they do not execute on their own.'}}));
    if(method==='POST'&&p==='operations/control')return this.update(doc=>{
      if(!(body.key in DEFAULT_CONTROLS)||typeof body.paused!=='boolean')throw Error('Invalid operation control');
      if(body.key!=='research_paused'&&!body.paused)throw Error('Paid research and outgoing outreach require a private Cloudflare backend');
      doc.operator_controls[body.key]=body.paused;event(doc,'local_operator_control',{key:body.key,paused:body.paused});return {ok:true,key:body.key,paused:body.paused,effective_note:'This browser cannot execute paid or outgoing jobs.'};
    });
    if(method==='POST'&&p==='operations/commands')return this.update(doc=>{
      if(!(body.action in ACTIONS))throw Error('Unsupported task type');
      const old=doc.worker_commands.find(x=>x.action===body.action&&x.status==='planned');if(old)return {created:false,id:old.id,status:'planned',local_only:true};
      const id=nextId(doc,'worker_commands');doc.worker_commands.unshift({id,action:body.action,status:'planned',requested_at:NOW(),started_at:null,finished_at:null,outcome:'Saved on this browser only. Connect a scheduled worker to run it.',error:'',requested_by:'Browser workspace'});
      event(doc,'local_task_planned',{id,action:body.action});return {created:true,id,status:'planned',local_only:true};
    });
    if(method==='GET'&&p==='learning')return this.read(doc=>({outcomes:[],searches:doc.search_history,referrals:doc.referral_metrics,outcome_counts:[],referral_sessions_in_latest_rows:doc.referral_metrics.reduce((s,r)=>s+int(r.sessions),0),notes:'Browser workspace only. No inferred metrics.'}));
    throw Error(`Browser workspace does not support this operation: ${p}`);
  }
  async exportCsv(kind){await this.ready;const cols=CSV_COLUMNS[kind];if(!cols)throw Error('Unsupported CSV export');const items=await this.read(doc=>doc[DATASETS[kind]]);return [cols.join(','),...items.map(r=>cols.map(c=>csvEscape(r[c])).join(','))].join('\r\n');}
  async exportBackup(){return this.read(doc=>({schema:'linkforge-browser-backup',version:1,exported_at:NOW(),storage:'browser-only',data:doc}));}
  async importFile(file){
    await this.ready;
    if(file.size>5_000_000)throw Error('Import file must be under 5 MB');
    const text=await file.text();const name=file.name.toLowerCase();
    if(name.endsWith('.json')){
      const payload=JSON.parse(text);if(payload?.schema!=='linkforge-browser-backup'||payload?.version!==1)throw Error('Only LinkForge browser backup JSON files are accepted');
      return this.update(doc=>{const restored=secureRecord(payload.data);Object.assign(doc,restored);event(doc,'local_backup_restored',{created_at:payload.exported_at||'unknown'});return {kind:'backup',count:restored.candidates.length+restored.suppression.length};});
    }
    if(name.endsWith('.csv')){
      const records=csvRows(text);if(!records.length)return {kind:'csv',count:0};
      const columns=Object.keys(records[0]);const isProspects=columns.includes('publisher_domain')&&columns.includes('source_url')&&columns.includes('site');
      const isSuppression=columns.includes('identity')&&columns.includes('reason');
      if(!isProspects&&!isSuppression)throw Error('CSV import supports prospect lists or suppression lists. Use Backup JSON to restore the complete workspace.');
      return this.update(doc=>{let inserted=0,skipped=0;
        for(const r of records){
          if(isProspects){const site=norm(r.site),publisher=norm(r.publisher_domain,255).toLowerCase(),source=norm(r.source_url,1000);
            if(!this.sites.some(s=>s.domain===site)||!validDomain(publisher)||!validUrl(source)||doc.candidates.some(x=>x.site===site&&x.publisher_domain===publisher&&x.source_url===source)){skipped++;continue;}
            const id=nextId(doc,'candidates');doc.candidates.unshift({id,site,publisher_domain:publisher,source_url:source,asset_url:validUrl(r.asset_url)?r.asset_url:'',kind:norm(r.kind,60)||'imported',title:norm(r.title,300),status:'research',score:null,contact_email:null,source_checked_at:null,traffic_monthly:null,spam_score:null,domain_rank:null,competitor_count:null,excluded_reason:null,explicit_invitation:0,last_updated:NOW(),editorial_policy_url:null});inserted++;
          }else {const identity=norm(r.identity,255).toLowerCase(),reason=norm(r.reason,280)||'Imported suppression';
            if(!(validDomain(identity)||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity))){skipped++;continue;}
            if(doc.suppression.some(x=>x.identity===identity)){skipped++;continue;}
            doc.suppression.unshift({identity,reason,source:'Imported CSV',created_at:NOW()});inserted++;
          }
        }
        event(doc,'local_csv_imported',{kind:isProspects?'prospects':'suppression',inserted,skipped});return {kind:isProspects?'prospects':'suppression',count:inserted,skipped};
      });
    }
    throw Error('Select a CSV or LinkForge JSON backup file');
  }
  async recordSiteChecks(domain,checks){return this.update(doc=>{
    if(!this.sites.some(x=>x.domain===domain))throw Error('Site is not in your portfolio');
    for(const result of checks){const url=norm(result.url,1000);if(!validUrl(url))continue;
      const item=doc.portfolio_assets.find(x=>x.domain===domain&&x.url===url);
      // An HTTP response does not independently establish usefulness or backlink proof.
      const next={domain,url,http_status:int(result.status),status:result.status===200?'reachable':'unverified',checked_at:NOW()};
      if(item)Object.assign(item,next);else doc.portfolio_assets.push(next);
    }
    event(doc,'local_site_check',{domain,checked:checks.length});return {saved:checks.length};
  });}
}
