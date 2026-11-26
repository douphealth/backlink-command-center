/**
 * Optional fallback search provider: Brave Search API. Used only when DataForSEO cannot serve a search
 * (no balance, daily or monthly cap reached), so prospecting does not stop.
 *
 * Why Brave: it returns the real result URLs (Google results arrive wrapped and ~40% of them cannot be
 * resolved), and each plan includes a monthly credit worth about 1,000 searches. Requests are counted here
 * and capped per month (default 900) so the included credit is not exceeded.
 */
import {sleep,NOW,hostOf} from './util.mjs';

const ENDPOINT='https://api.search.brave.com/res/v1/web/search';
const COUNTRY={2840:'us',2826:'gb',2124:'ca',2036:'au',2372:'ie',2276:'de'};
/** Brave has no inurl: operator; the word itself still steers the results. */
export const braveQuery=q=>String(q||'').replace(/\binurl:/gi,'').replace(/\s+/g,' ').trim();

export class BraveSearch{
  constructor({apiKey,state,monthlyRequests=900,fetchImpl=fetch,log=()=>{},gapMs=1100}){
    this.key=String(apiKey||'').trim();this.state=state;this.limit=Math.max(0,Math.floor(Number(monthlyRequests)||0));
    this.fetch=fetchImpl;this.log=log;this.gapMs=gapMs;this.calls=0;this.last=0;this.queue=Promise.resolve();
    state.brave_usage??={};
    for(const k of Object.keys(state.brave_usage).sort().slice(0,-13))delete state.brave_usage[k]; // keep a year of monthly counts
  }
  get enabled(){return !!this.key}
  used(){return this.state.brave_usage[NOW().slice(0,7)]||0}
  remaining(){return this.enabled&&!this.blocked?Math.max(0,this.limit-this.used()):0}
  canSearch(){return this.remaining()>0}
  /** Same result shape as DataForSEO.serp: [{url,domain,title,description,rank}] or null when the search could not run. */
  serp(keyword,{location=2840,language='en'}={}){
    // One request at a time, spaced out: the included plan allows about one query per second.
    const run=this.queue.then(()=>this.one(keyword,{location,language}));
    this.queue=run.catch(()=>null);
    return run;
  }
  async one(keyword,{location,language}){
    if(!this.canSearch())return null;
    const wait=this.last+this.gapMs-Date.now();if(wait>0)await sleep(wait);
    const month=NOW().slice(0,7);this.state.brave_usage[month]=(this.state.brave_usage[month]||0)+1;this.calls++;this.last=Date.now();
    const url=`${ENDPOINT}?q=${encodeURIComponent(braveQuery(keyword))}&count=20&country=${COUNTRY[location]||'us'}&search_lang=${encodeURIComponent(language||'en')}&text_decorations=false`;
    let res,body;
    try{res=await this.fetch(url,{headers:{Accept:'application/json','X-Subscription-Token':this.key},signal:AbortSignal.timeout(20000)});body=await res.json().catch(()=>null)}
    catch{this.log('brave: search could not be reached; retried next cycle');return null}
    if(res.status===401||res.status===403){this.blocked=true;this.log(`brave: the API key was rejected (HTTP ${res.status}); re-enter it under Connect`);return null}
    if(res.status===402||res.status===429){this.log(`brave: ${res.status===429?'rate or quota limit reached':'payment required'} (HTTP ${res.status}); searches resume later`);if(res.status===402)this.blocked=true;return null}
    if(!res.ok||!body)return null;
    return (body.web?.results||[]).filter(r=>r?.url).map((r,i)=>({url:r.url,domain:hostOf(r.url),title:r.title||'',description:r.description||'',rank:i+1}));
  }
}
