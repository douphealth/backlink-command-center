/**
 * Real demand signals per owned URL. Search Console (free, exact) wins; DataForSEO
 * page-traffic estimates fill sites without GSC access. Results are cached in the
 * private state so paid lookups run at most weekly per site.
 */
import {getToken} from '../../functions/_lib/gsc.js';
import {normUrl,ageDays,NOW} from './util.mjs';

const GSC='https://searchconsole.googleapis.com/webmasters/v3';
async function google(url,token,body){
  const res=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  if(!res.ok)throw Error('GSC HTTP '+res.status);
  return res.json();
}
export async function gscDemand(sites,env,log=()=>{}){
  if(!env.GSC_SERVICE_ACCOUNT_JSON)return {};
  const out={};
  let token,props;
  try{token=await getToken(env);props=(await google(GSC+'/sites',token)).siteEntry||[]}catch(e){log('gsc: '+e.message);return {}}
  const end=new Date(Date.now()-3*864e5),start=new Date(end.getTime()-89*864e5);
  for(const s of sites){
    const prop=['sc-domain:'+s.domain,`https://${s.domain}/`,`https://www.${s.domain}/`].find(x=>props.some(p=>p.siteUrl===x&&p.permissionLevel!=='siteUnverifiedUser'));
    if(!prop){log(`gsc: no access to ${s.domain}`);continue}
    try{
      const data=await google(`${GSC}/sites/${encodeURIComponent(prop)}/searchAnalytics/query`,token,{startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10),dimensions:['page'],rowLimit:5000,type:'web'});
      let n=0;for(const r of data.rows||[]){const url=normUrl(r.keys?.[0]);if(!url)continue;out[url]={source:'gsc',impressions:r.impressions,clicks:r.clicks,ctr:r.ctr,position:r.position};n++}
      log(`gsc: ${s.domain} ${n} pages`);
    }catch(e){log(`gsc: ${s.domain} ${e.message}`)}
  }
  return out;
}
export async function dfsDemand(sites,dfs,state,{covered=new Set(),maxAgeDays=7,log=()=>{}}={}){
  state.demand_cache??={};
  const out={};
  for(const s of sites){
    if(covered.has(s.domain))continue;
    let entry=state.demand_cache[s.domain];
    if((!entry||ageDays(entry.at)>maxAgeDays)&&dfs.canSpend('relevant_pages')){
      const items=await dfs.relevantPages(s.domain);
      if(items){entry={at:NOW(),items:items.slice(0,150)};state.demand_cache[s.domain]=entry;log(`dataforseo demand: ${s.domain} ${items.length} ranking pages`)}
    }
    for(const x of entry?.items||[]){const url=normUrl(x.url);if(url)out[url]={source:'dataforseo',...x}}
  }
  return out;
}
