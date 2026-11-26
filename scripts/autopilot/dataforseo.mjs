/**
 * DataForSEO client with a persistent spend ledger and hard daily/monthly caps.
 * Every billed call is recorded with the provider-reported cost. Endpoints the
 * account cannot access are parked for 7 days instead of failing every run.
 */
import {sleep,NOW,ageDays} from './util.mjs';
import {unwrapItem,carouselItems,isGoogleHost} from './serp-unwrap.mjs';

const API='https://api.dataforseo.com/v3/';
/** A bare ASCII hostname DataForSEO accepts as a bulk target, or '' to drop it. */
export function validTarget(d){
  const h=String(d||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/[/:?#].*$/,'').replace(/\.$/,'');
  return h.length<=253&&/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)?h:'';
}
/** Below this balance (USD) no paid call can succeed. */
export const MIN_BALANCE=0.05;
/**
 * How much of the account balance was spent by something other than Autopilot since the previous cycle.
 * The ledger matches the provider's balance to the cent on quiet days, so a larger drop means another tool
 * or session shares this DataForSEO account. A top-up (balance rose) resets the comparison.
 */
export function trackExternalSpend(state,balance,now=NOW()){
  if(!Number.isFinite(balance))return null;
  const total=(state.ledger||[]).reduce((n,x)=>n+Number(x.cost||0),0),prev=state.dfs_watch;
  state.dfs_external=(state.dfs_external||[]).filter(x=>ageDays(x.at)<30);
  let external=0;
  if(prev&&Number.isFinite(prev.balance)&&balance<=prev.balance){
    external=Number(((prev.balance-balance)-(total-prev.ledger_total)).toFixed(4));
    if(external>=0.05)state.dfs_external.push({at:now,usd:external});else external=0;
  }
  state.dfs_watch={balance,ledger_total:total,at:now};
  const sum=days=>Number(state.dfs_external.filter(x=>ageDays(x.at)<days).reduce((n,x)=>n+x.usd,0).toFixed(2));
  return {since_last_cycle_usd:external,last_7d_usd:sum(7),last_30d_usd:sum(30)};
}
const ESTIMATE={serp:0.006,relevant_pages:0.025,traffic:0.03,backlinks:0.03}; // calibrated from the ledger's real averages

export class DataForSEO{
  constructor({login,password,state,dailyUsd=0.5,monthlyUsd=10,fetchImpl=fetch,log=()=>{}}){
    this.auth=login&&password?Buffer.from(`${login}:${password}`).toString('base64'):'';
    this.state=state;state.ledger??=[];state.dfs_blocked??={};
    this.dailyUsd=dailyUsd;this.monthlyUsd=monthlyUsd;this.fetch=fetchImpl;this.log=log;this.calls=0;this.spent=0;
  }
  get enabled(){return !!this.auth}
  reject(status,body){
    const msg=String(body?.status_message||body?.tasks?.[0]?.status_message||'').slice(0,140);
    this.authError=status===403?`DataForSEO refused access (HTTP 403${msg?': '+msg:''}). If IP allow-listing is on in your DataForSEO account, turn it off — GitHub's servers use changing IPs.`
      :`DataForSEO rejected the login (HTTP ${status}${msg?': '+msg:''}). Use the API login and the API password from app.dataforseo.com/api-access — not your website password.`;
    this.log('dataforseo: '+this.authError);this.auth='';
  }
  /** Free account check (no charge): confirms the login works and reads the balance. */
  async verify(){
    if(!this.auth)return {status:'missing'};
    try{
      const res=await this.fetch(API+'appendix/user_data',{headers:{Authorization:'Basic '+this.auth},signal:AbortSignal.timeout(30000)});
      const body=await res.json().catch(()=>null);
      if(res.status===401||res.status===403||body?.status_code===40100){this.reject(res.status===200?401:res.status,body);return {status:'rejected',error:this.authError}}
      const r=body?.tasks?.[0]?.result?.[0];
      if(!res.ok||!r)return {status:'unverified',error:`DataForSEO account check failed (HTTP ${res.status})`};
      this.balance=Number(r.money?.balance??NaN);
      // No money left: make no paid call at all this cycle (each would only fail), and say so on the dashboard.
      if(Number.isFinite(this.balance)&&this.balance<MIN_BALANCE)this.outOfFunds=true;
      return {status:'connected',balance_usd:this.balance,...(this.outOfFunds?{out_of_funds:true}:{})};
    }catch{return {status:'unverified',error:'DataForSEO could not be reached'}}
  }
  spend(period){const key=period==='day'?NOW().slice(0,10):NOW().slice(0,7);
    return this.state.ledger.filter(x=>x.at.startsWith(key)).reduce((n,x)=>n+Number(x.cost||0),0)}
  /** Expected cost of one call: the average of the last 20 real charges of this kind, else the calibrated default. */
  estimate(kind){
    const recent=this.state.ledger.filter(x=>x.kind===kind).slice(-20);
    return recent.length>=3?recent.reduce((n,x)=>n+Number(x.cost||0),0)/recent.length:(ESTIMATE[kind]??0.05);
  }
  canSpend(kind){
    if(!this.enabled||this.outOfFunds||this.costCapped)return false;
    const b=this.state.dfs_blocked[kind];if(b&&ageDays(b)<7)return false;
    const est=this.estimate(kind);
    return this.spend('day')+est<=this.dailyUsd&&this.spend('month')+est<=this.monthlyUsd;
  }
  /** How many calls of this kind fit under both spend caps right now (for parallel batches). */
  affordable(kind){
    if(!this.canSpend(kind))return 0;
    const est=Math.max(1e-4,this.estimate(kind));
    return Math.max(0,Math.floor(Math.min(this.dailyUsd-this.spend('day'),this.monthlyUsd-this.spend('month'))/est));
  }
  async post(kind,endpoint,task){
    if(!this.canSpend(kind))return null;
    for(let attempt=0;attempt<2;attempt++){
      let body;
      try{
        const res=await this.fetch(API+endpoint,{method:'POST',headers:{Authorization:'Basic '+this.auth,'Content-Type':'application/json'},body:JSON.stringify([task]),signal:AbortSignal.timeout(60000)});
        body=await res.json().catch(()=>null);
        if(res.status===401||res.status===403){this.reject(res.status,body);return null}
      }catch{body=null}
      const cost=Number(body?.cost||0);
      if(cost>0){this.state.ledger.push({at:NOW(),kind,endpoint,cost});this.spent+=cost}
      this.calls++;
      const t=body?.tasks?.[0],code=Number(t?.status_code||body?.status_code||0);
      if(code===20000)return t.result||[];
      if(code===40102)return [{items:[]}]; // 'No Search Results' is a real (empty) answer, not a failure
      if(code===40106&&t.result)return t.result; // partial results: keep what was returned (unreturned pages aren't billed)
      const msg=String(t?.status_message||body?.status_message||'');
      // An empty balance is not "this endpoint is unavailable": on 2026-11-26 it parked every lookup for 7 days,
      // which would have kept prospecting off for a week after a top-up. Stop for this cycle only.
      if(code===40200||code===40210||/payment required|insufficient funds|not enough (money|funds)/i.test(msg)){
        if(!this.outOfFunds)this.log('dataforseo: the account balance is used up; paid lookups stop until it is topped up');this.outOfFunds=true;return null}
      if(code===40203||/cost limit/i.test(msg)){if(!this.costCapped)this.log('dataforseo: the daily cost limit set in the DataForSEO account is reached; lookups resume tomorrow');this.costCapped=true;return null}
      if(code===40202||code===40209||/rate limit|too many/i.test(msg)){if(attempt===0){await sleep(4000);continue}this.log(`dataforseo: ${kind} rate-limited; retried next cycle`);return null}
      if(code>=40200&&code<40300||code===40104){this.state.dfs_blocked[kind]=NOW();this.log(`dataforseo: ${kind} not available on this account (${code}); parked 7 days`);return null}
      if(attempt===0&&(!body||code>=50000||code===40101)){await sleep(3000);continue}
      this.log(`dataforseo: ${endpoint} failed ${code} ${t?.status_message||body?.status_message||''}`.trim());
      return null;
    }
    return null;
  }
  async serp(keyword,{depth=20,location=2840,language='en'}={}){
    const r=await this.post('serp','serp/google/organic/live/advanced',{keyword,location_code:location,language_code:language,depth});
    if(!r)return null; // failed or not allowed: the caller should retry later, not mark the query as done
    const items=r[0]?.items||[];
    // Google now wraps result links (google.com/goto?url=…); the publisher is recovered from the breadcrumb.
    const organic=items.filter(x=>x.type==='organic').map(unwrapItem);
    const usable=organic.filter(x=>x.domain&&!isGoogleHost(x.domain));
    if(organic.length>=3&&!usable.length){this.log(`dataforseo: "${keyword}" returned only unrecoverable Google redirect links; retried next run`);return null}
    this.wrapped=(this.wrapped||0)+organic.filter(x=>x.goto).length;
    const seen=new Set(usable.map(x=>x.domain));
    return [...usable,...carouselItems(items).filter(x=>!seen.has(x.domain)&&seen.add(x.domain))];
  }
  /**
   * Pages that link to a competitor from inside their content (one per referring domain): proven
   * in-niche linkers. `offset` pages through big link profiles across runs.
   */
  async backlinks(target,{limit=200,offset=0}={}){
    const r=await this.post('backlinks','backlinks/backlinks/live',{target,mode:'one_per_domain',limit,offset,
      // In one_per_domain mode the filters choose WHICH link represents each domain. Filtering in-content
      // placement and 3+ outbound links here made 100 of 100 returned rows usable instead of 33 (measured 2026-11-25).
      filters:[['dofollow','=',true],'and',['item_type','=','anchor'],'and',['page_from_language','=','en'],'and',['is_lost','=',false],
        'and',['page_from_external_links','>=',3],'and',['semantic_location','in',['article','main','section','details']]],
      order_by:['rank,desc'],include_subdomains:true,exclude_internal_backlinks:true});
    if(!r)return null;
    const res=r[0]||{};
    return {total:Number(res.total_count||0),items:(res.items||[]).map(x=>({url_from:x.url_from,domain_from:x.domain_from,title:x.page_from_title||'',url_to:x.url_to,anchor:x.anchor||'',
      text_pre:x.text_pre||'',text_post:x.text_post||'',location:x.semantic_location||'',spam:x.backlink_spam_score??null,external_links:x.page_from_external_links??null,
      broken_to:[404,410].includes(Number(x.url_to_status_code)),domain_rank:Number.isFinite(x.domain_from_rank)?x.domain_from_rank:null,page_rank:Number.isFinite(x.page_from_rank)?x.page_from_rank:null,platform:x.domain_from_platform_type||[]}))};
  }
  /** Estimated monthly organic visits per domain (one request for up to 1,000 domains). */
  async domainTraffic(domains,{location=2840,language='en'}={}){
    // One malformed target (IDN, port, trailing dot, uppercase) fails the whole task with 40501 "Invalid Field: 'targets'".
    const targets=[...new Set(domains.map(validTarget).filter(Boolean))].slice(0,1000);
    if(!targets.length)return {};
    const r=await this.post('traffic','dataforseo_labs/google/bulk_traffic_estimation/live',{targets,location_code:location,language_code:language,item_types:['organic']});
    if(!r)return null;
    return Object.fromEntries((r[0]?.items||[]).map(x=>[String(x.target).replace(/^www\./,''),Number(x.metrics?.organic?.etv||0)]));
  }
  async relevantPages(domain,{limit=100,location=2840,language='en'}={}){
    const r=await this.post('relevant_pages','dataforseo_labs/google/relevant_pages/live',{target:domain,location_code:location,language_code:language,limit,order_by:['metrics.organic.etv,desc'],exclude_top_domains:false});
    return (r?.[0]?.items||[]).map(x=>{const o=x.metrics?.organic||{};
      return {url:x.page_address,etv:o.etv||0,keywords:o.count||0,striking:(o.pos_4_10||0)+(o.pos_11_20||0),top3:(o.pos_1||0)+(o.pos_2_3||0)}});
  }
}
