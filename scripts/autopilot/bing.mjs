/**
 * Bing Webmaster Tools URL Submission (JSON API, key from BING_WEBMASTER_API_KEY).
 * Bing's index also feeds Copilot, DuckDuckGo, Yahoo and ChatGPT's web search, so getting new and
 * changed pages into it quickly is the most direct free lever on AI-answer visibility.
 *
 * Once a day per site: read the daily quota, then submit (most valuable first) pages that are new,
 * changed since their last submission, or not indexed by Google. Bing's API takes the key as a query
 * parameter by design; it is never logged or published.
 */
import {normUrl,NOW,ageDays} from './util.mjs';
import {publishedUrl} from './searchconsole.mjs';

const BASE='https://ssl.bing.com/webmaster/api.svc/json/';
const scrub=(s,key)=>String(s||'').split(key||'\u0000').join('[key]').slice(0,160);

export async function bingCall(method,{key,fetchImpl=fetch,query={},body}){
  const url=BASE+method+'?'+new URLSearchParams({...query,apikey:key});
  const r=await fetchImpl(url,{method:body?'POST':'GET',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json; charset=utf-8'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const data=await r.json().catch(()=>null);
  return {status:r.status,data};
}

/** Pick the URLs worth a submission today, most valuable first. */
export function bingCandidates({site,crawl,submitted={},indexStatus={},ranked=[]}){
  const promo=new Map(ranked.filter(a=>a.site===site).map(a=>[normUrl(a.url),a.promotion||0]));
  const pages=(crawl.find(c=>c.site===site)?.pages||[]).filter(p=>p.status===200&&!p.noindex&&(!p.canonical||normUrl(p.canonical)===normUrl(p.final_url||p.url)));
  const out=[];
  for(const p of pages){
    const url=publishedUrl(p,site),key=normUrl(url),prev=submitted[key],changed=p.lastmod||p.modified||'';
    const notIndexed=indexStatus[key]&&indexStatus[key].class!=='indexed';
    const due=!prev||(changed&&changed>prev.lastmod)||(notIndexed&&ageDays(prev.at)>30);
    if(!due)continue;
    out.push({url,key,lastmod:changed,score:(notIndexed?1000:0)+(prev?0:300)+(promo.get(key)||0)+(changed?Math.max(0,60-ageDays(changed)):0)});
  }
  return out.sort((a,b)=>b.score-a.score);
}

export async function submitToBing({state,env,sites,crawl,ranked=[],fetchImpl=fetch,perSiteMax=100,deadline=Infinity,log=()=>{}}){
  const key=env.BING_WEBMASTER_API_KEY;if(!key)return {skipped:'BING_WEBMASTER_API_KEY not set'};
  state.bing??={submitted:{},days:{},errors:{}};
  const today=NOW().slice(0,10),stats={sites:0,submitted:0,quota_left:{},errors:{}};
  for(const s of sites){
    if(Date.now()>deadline)break;
    if(state.bing.days[s.domain]===today)continue; // once a day per site
    // Bing registers sites by the URL they were added with; try the common forms.
    let siteUrl=null,quota=null,lastErr='';
    for(const cand of [`https://${s.domain}/`,`https://www.${s.domain}/`]){
      try{const q=await bingCall('GetUrlSubmissionQuota',{key,fetchImpl,query:{siteUrl:cand}});
        if(q.status===200&&q.data?.d){siteUrl=cand;quota=Number(q.data.d.DailyQuota)||0;break}
        lastErr=`HTTP ${q.status} ${scrub(q.data?.Message||q.data?.ErrorCode,key)}`;
      }catch(e){lastErr=scrub(e.message,key)}
    }
    if(!siteUrl){state.bing.errors[s.domain]={error:lastErr||'site not found in Bing Webmaster Tools',at:NOW()};stats.errors[s.domain]=state.bing.errors[s.domain].error;continue}
    stats.quota_left[s.domain]=quota;delete state.bing.errors[s.domain];
    const picks=bingCandidates({site:s.domain,crawl,submitted:state.bing.submitted,indexStatus:state.index_status||{},ranked}).slice(0,Math.min(quota,perSiteMax,500));
    state.bing.days[s.domain]=today;stats.sites++;
    if(!picks.length)continue;
    const body={siteUrl,urlList:picks.map(p=>p.url)};
    // Microsoft's docs spell the method both ways; the JSON service is tried with each.
    let res=await bingCall('SubmitUrlBatch',{key,fetchImpl,body}).catch(()=>null);
    if(!res||res.status===404)res=await bingCall('SubmitUrlbatch',{key,fetchImpl,body}).catch(()=>null);
    if(res?.status===200){for(const p of picks)state.bing.submitted[p.key]={at:NOW(),lastmod:p.lastmod||''};stats.submitted+=picks.length;stats.quota_left[s.domain]=quota-picks.length}
    else{const e=`submit HTTP ${res?.status||'network'} ${scrub(res?.data?.Message||res?.data?.ErrorCode,key)}`.trim();state.bing.errors[s.domain]={error:e,at:NOW()};stats.errors[s.domain]=e;delete state.bing.days[s.domain]}
  }
  for(const [u,x] of Object.entries(state.bing.submitted))if(ageDays(x.at)>400)delete state.bing.submitted[u];
  log(`bing url submission: ${stats.submitted} URLs submitted across ${stats.sites} sites${Object.keys(stats.errors).length?`; issues: ${Object.entries(stats.errors).map(([d,e])=>d+' ('+e+')').join(', ')}`:''}`);
  return stats;
}
