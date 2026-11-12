/**
 * Google Search Console intelligence (service account, read-only scope):
 *  - index monitor: real index status of important pages via the URL Inspection API
 *    (quota: 2,000 inspections/day per property; we use a small, rotating share),
 *  - search performance: clicks / impressions / position per site, tracked over time.
 * Everything published is about the owner's own URLs; no credentials or private data.
 */
import {getToken} from '../../functions/_lib/gsc.js';
import {pool,normUrl,ageDays,NOW,sameSite,hostOf} from './util.mjs';
/**
 * The exact URL the site publishes (its canonical when it is on the same site). Google and Bing treat
 * /page and /page/ as different URLs, so the normalised form (no trailing slash) is only a lookup key.
 */
export function publishedUrl(p,domain){
  const c=p.canonical;if(c&&sameSite(hostOf(c),domain))return c;
  return p.final_url||p.url;
}

const API='https://searchconsole.googleapis.com';

export async function gscClient(env,{fetchImpl=fetch}={}){
  if(!env.GSC_SERVICE_ACCOUNT_JSON)return null;
  const token=await getToken(env);
  const call=async(path,body)=>{
    const r=await fetchImpl(API+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Object.assign(Error('GSC HTTP '+r.status),{status:r.status});
    return r.json();
  };
  const entries=(await call('/webmasters/v3/sites')).siteEntry||[];
  return {
    property(domain){return ['sc-domain:'+domain,`https://${domain}/`,`https://www.${domain}/`].find(x=>entries.some(p=>p.siteUrl===x&&p.permissionLevel!=='siteUnverifiedUser'))||null},
    query:(prop,body)=>call(`/webmasters/v3/sites/${encodeURIComponent(prop)}/searchAnalytics/query`,body),
    inspect:(prop,url)=>call('/v1/urlInspection/index:inspect',{inspectionUrl:url,siteUrl:prop}),
  };
}

/** Google's coverage text -> one of a few actionable classes. */
export function indexClass(r){
  if(!r)return 'unchecked';
  if(r.verdict==='PASS')return 'indexed';
  const c=String(r.coverageState||'').toLowerCase();
  if(c.includes('unknown to google'))return 'unknown';
  if(c.includes('discovered'))return 'discovered_not_indexed';
  if(c.includes('crawled'))return 'crawled_not_indexed';
  if(c.includes('noindex'))return 'noindex';
  if(c.includes('canonical')||c.includes('duplicate'))return 'canonical_elsewhere';
  if(c.includes('redirect'))return 'redirect';
  if(c.includes('404')||c.includes('not found')||c.includes('soft 404'))return 'not_found';
  return 'not_indexed_other';
}
export const INDEX_FIX={
  unknown:'Google has never found this URL. Add contextual links to it from indexed pages (see the internal link plan); it is submitted to Bing automatically.',
  discovered_not_indexed:'Google knows the URL but has not crawled it yet: a crawl-priority signal. Link to it from your strongest indexed pages.',
  crawled_not_indexed:'Google crawled it and chose not to index it: a quality/uniqueness signal. Make it clearly better than the pages ranking for its topic, merge thin overlaps, and add internal links.',
  noindex:'Blocked by a noindex directive. Remove it if the page should rank.',
  canonical_elsewhere:'Google treats another URL as the canonical. Make the canonical self-referencing or consolidate the duplicates.',
  redirect:'The URL redirects. Link to and list the final URL instead.',
  not_found:'Google sees a 404. Restore the page or 301 it to the closest live page.',
  not_indexed_other:'Not indexed. Check it with URL Inspection in Search Console.',
};

/**
 * Rotating index monitor. Important pages first (promoted assets, then recently changed pages);
 * re-checks indexed pages every 14 days and non-indexed ones every 3 days; at most `perSiteDaily`.
 */
export async function monitorIndex({state,client,sites,priority=new Map(),crawl=[],perSiteDaily=60,deadline=Infinity,log=()=>{}}){
  state.index_status??={};state.index_quota??={};
  const day=NOW().slice(0,10);if(state.index_quota.day!==day)state.index_quota={day,used:{}};
  const stats={inspected:0,indexed:0,not_indexed:0,errors:0,no_property:[]};
  const jobs=[];
  for(const s of sites){
    const prop=client.property(s.domain);if(!prop){stats.no_property.push(s.domain);continue}
    const room=perSiteDaily-(state.index_quota.used[s.domain]||0);if(room<=0)continue;
    const pages=(crawl.find(c=>c.site===s.domain)?.pages||[]).filter(p=>p.status===200&&!p.noindex)
      .sort((a,b)=>String(b.lastmod||b.modified||'').localeCompare(String(a.lastmod||a.modified||''))).map(p=>publishedUrl(p,s.domain));
    // Exact published URLs, de-duplicated by their normalised key; a crawled page's own URL wins over a configured one.
    const byKey=new Map();for(const u of [...pages,...(priority.get(s.domain)||[])]){const k=normUrl(u);if(k&&!byKey.has(k))byKey.set(k,u)}
    const order=[...new Set([...(priority.get(s.domain)||[]).map(u=>normUrl(u)),...pages.map(u=>normUrl(u))])].filter(k=>byKey.has(k));
    const due=order.filter(k=>{const x=state.index_status[k];return !x||ageDays(x.checked_at)>(x.class==='indexed'?14:3)}).slice(0,room);
    for(const k of due)jobs.push({site:s.domain,prop,key:k,url:byKey.get(k)});
  }
  await pool(jobs,4,async j=>{
    if(Date.now()>deadline)return;
    state.index_quota.used[j.site]=(state.index_quota.used[j.site]||0)+1;
    try{
      const r=(await client.inspect(j.prop,j.url))?.inspectionResult?.indexStatusResult;
      const cls=indexClass(r);
      state.index_status[j.key]={site:j.site,url:j.url,class:cls,coverage:String(r?.coverageState||'').slice(0,80),last_crawl:r?.lastCrawlTime||null,google_canonical:r?.googleCanonical||null,checked_at:NOW()};
      stats.inspected++;cls==='indexed'?stats.indexed++:stats.not_indexed++;
    }catch{stats.errors++}
  });
  log(`google index monitor: ${stats.inspected} pages inspected, ${stats.indexed} indexed, ${stats.not_indexed} not indexed${stats.errors?`, ${stats.errors} errors`:''}${stats.no_property.length?`; no Search Console access: ${stats.no_property.join(', ')}`:''}`);
  return stats;
}

/** Public index report: per-site coverage and the most valuable pages Google is ignoring. */
export function indexReport(state,sites,ranked=[],{limit=60}={}){
  const promo=new Map(ranked.map(a=>[normUrl(a.url),a])),entries=Object.entries(state.index_status||{});
  const bySite=sites.map(s=>{
    const mine=entries.filter(([,x])=>x.site===s.domain),c={};for(const [,x] of mine)c[x.class]=(c[x.class]||0)+1;
    return {site:s.domain,checked:mine.length,indexed:c.indexed||0,not_indexed:mine.length-(c.indexed||0),...c};
  });
  const pages=entries.filter(([,x])=>x.class!=='indexed').map(([key,x])=>({url:x.url||key,site:x.site,class:x.class,coverage:x.coverage,last_crawl:x.last_crawl,
    promotion:promo.get(key)?.promotion??0,title:promo.get(key)?.title||null,fix:INDEX_FIX[x.class]||INDEX_FIX.not_indexed_other,checked_at:x.checked_at}))
    .sort((a,b)=>b.promotion-a.promotion||a.url.localeCompare(b.url)).slice(0,limit);
  return {sites:bySite,pages};
}

/** Last-7-days performance per site (data lags ~3 days), so progress is measurable over time. */
export async function searchPerformance({client,sites,log=()=>{}}){
  const end=new Date(Date.now()-3*864e5),start=new Date(end.getTime()-6*864e5),out=[];
  const range={startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10),type:'web'};
  for(const s of sites){
    const prop=client.property(s.domain);if(!prop)continue;
    try{
      const tot=(await client.query(prop,range)).rows?.[0]||{};
      const pages=(await client.query(prop,{...range,dimensions:['page'],rowLimit:5000})).rows||[];
      out.push({site:s.domain,clicks:tot.clicks||0,impressions:tot.impressions||0,ctr:Number((tot.ctr||0).toFixed(4)),position:Number((tot.position||0).toFixed(1)),
        pages_with_impressions:pages.length,striking_distance:pages.filter(r=>r.position>=4&&r.position<=20&&r.impressions>=10).length,from:range.startDate,to:range.endDate});
    }catch(e){log(`gsc performance ${s.domain}: ${e.message}`)}
  }
  log(`search performance (7 days to ${range.endDate}): ${out.reduce((n,x)=>n+x.clicks,0)} clicks, ${out.reduce((n,x)=>n+x.impressions,0)} impressions across ${out.length} sites`);
  return out;
}
