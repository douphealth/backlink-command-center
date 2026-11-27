/**
 * Owned-site crawler: full sitemap discovery (robots.txt + nested indexes),
 * incremental fetching (skip fresh pages, conditional GET), and on-page feature
 * extraction used for linkability scoring and internal-link planning.
 */
import {fetchPage,pool,normUrl,sameSite,rootDomain,mainText,tagText,metaContent,links,jsonLd,topTerms,ageDays,NOW,attr,sleep} from './util.mjs';
import {evaluatePublicPage} from '../refresh-public-intelligence.mjs';
import {outboundCandidates} from './broken.mjs';

const SKIP_PATH=/(?:^|\/)(?:wp-admin|wp-json|wp-content|wp-includes|tag|tags|author|category|categories|feed|page\/\d+|privacy(?:-policy)?|terms(?:-of-(?:service|use)|-and-conditions|-conditions)?|cookie(?:-policy)?|disclaimer|disclosure|affiliate-disclosure|editorial-policy|contact(?:-us)?|about(?:-us|-me)?|cart|checkout|my-account|login|register|search|sitemap|html-sitemap|thank-you|thanks)(?:\/|$)|\.(?:xml|json|jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js)$/i;
const AUTHORITY=/(?:\.gov|\.edu|\.ac\.[a-z]{2}|\.nhs\.uk|who\.int|nih\.gov|ncbi\.nlm|pubmed|doi\.org|sciencedirect|springer|nature\.com|wiley\.com|jamanetwork|bmj\.com|thelancet|cdc\.gov|wikipedia\.org|arxiv\.org|acm\.org|ieee\.org|extension\.)/i;

/** Owned pages are read up to this size: some app pages carry 1 MB+ of inline data before their content. */
const PAGE_BYTES=2_000_000;
/** After this many 5xx/429 answers, when they are at least half of all answers, the site is left alone for the cycle. */
const OUTAGE_AFTER=12;
/** What the server itself says about a failure (an application outage header), kept short. */
const serverHint=res=>String(res.headers?.get?.('x-outage-guard')||res.headers?.get?.('x-error')||'').replace(/[^\w .:-]/g,'').slice(0,60);

export function crawlable(url,domain){
  try{const u=new URL(url);return /^https?:$/.test(u.protocol)&&sameSite(u.hostname,domain)&&u.pathname!=='/'&&!SKIP_PATH.test(u.pathname)&&!u.search}catch{return false}
}
function locs(xml){
  return [...xml.matchAll(/<(?:url|sitemap)\b[^>]*>([\s\S]*?)<\/(?:url|sitemap)>/gi)].map(m=>{
    const loc=(m[1].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i)||[])[1];
    const lastmod=(m[1].match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i)||[])[1];
    return loc?{loc:loc.replace(/&amp;/g,'&').replace(/<!\[CDATA\[|\]\]>/g,'').trim(),lastmod:lastmod||null}:null;
  }).filter(Boolean);
}
/** Discover up to `limit` content URLs with lastmod, newest first. */
export async function discoverSite(site,{fetchImpl,limit=300,maxSitemaps=30,retryMs=1500}={}){
  const domain=site.domain,queue=[],seenMaps=new Set(),urls=new Map(),sources=[],failed=[];
  const robots=await fetchPage(`https://${domain}/robots.txt`,{accept:'text/plain',fetchImpl,timeout:8000});
  if(robots.status===200)for(const m of robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim))queue.push(m[1].trim());
  queue.push(`https://${domain}/sitemap_index.xml`,`https://${domain}/sitemap.xml`,`https://${domain}/wp-sitemap.xml`);
  while(queue.length&&seenMaps.size<maxSitemaps){
    const map=queue.shift();if(seenMaps.has(map))continue;seenMaps.add(map);
    const get=()=>fetchPage(map,{accept:'application/xml,text/xml',fetchImpl,timeout:10000,maxBytes:3_000_000});
    let res=await get();
    // A 5xx or 429 on a sitemap is often momentary (cold cache, busy origin): one retry before giving up on it.
    if(res.status>=500||res.status===429){await sleep(retryMs);res=await get()}
    if(res.status!==200||!/<(urlset|sitemapindex)\b/i.test(res.body)){if(res.status>=500||res.status===429)failed.push({url:map,status:res.status});continue}
    sources.push(map);
    const isIndex=/<sitemapindex\b/i.test(res.body);
    for(const x of locs(res.body)){
      if(isIndex||/\.xml(\.gz)?$/i.test(new URL(x.loc,map).pathname)){
        // Skip taxonomy/author/media sitemaps: they never contain linkable assets.
        if(!/(tag|category|author|attachment|media|image|video|product_cat|post_tag)[-_]?sitemap|sitemap[-_]?(tag|category|author|image)/i.test(x.loc))queue.push(x.loc);
        continue;
      }
      const url=normUrl(x.loc);if(url&&crawlable(url,domain)&&!urls.has(url))urls.set(url,{lastmod:x.lastmod,fetch:x.loc});
    }
    if(urls.size>=limit*3)break;
  }
  for(const a of site.assets||[]){const url=normUrl(a);if(url)urls.set(url,urls.get(url)||{lastmod:null,fetch:a})}
  const configured=new Set((site.assets||[]).map(a=>normUrl(a)));
  const list=[...urls].map(([url,x])=>({url,fetch:x.fetch,lastmod:x.lastmod,configured:configured.has(url)}))
    .sort((a,b)=>(b.configured-a.configured)||String(b.lastmod||'').localeCompare(String(a.lastmod||'')))
    .slice(0,limit);
  return {site:domain,urls:list,sitemaps:sources,discovered:urls.size,sitemap_errors:failed};
}

export function extractFeatures(url,html,domain){
  const text=mainText(html),words=text?text.split(/\s+/).length:0;
  const title=(tagText(html,'title')[0]||'').slice(0,180);
  const h1=(tagText(html,'h1')[0]||'').slice(0,180);
  const h2=tagText(html,'h2').slice(0,40),h3=tagText(html,'h3').length;
  const ld=jsonLd(html),types=[...new Set(ld.flatMap(x=>[].concat(x['@type']||[])).map(String))].slice(0,12);
  const modified=ld.map(x=>x.dateModified||x.datePublished).find(Boolean)||metaContent(html,'article:modified_time')||metaContent(html,'article:published_time')||null;
  const all=links(html,url),internal=new Set(),externalDomains=new Set();let authority=0;
  for(const l of all){let h;try{h=new URL(l.url).hostname}catch{continue}
    if(sameSite(h,domain))internal.add(l.url);
    else{externalDomains.add(rootDomain(h));if(AUTHORITY.test(h))authority++}}
  // Newsletter, search, comment and login forms are not tools.
  const appHtml=html.replace(/<form\b[\s\S]*?<\/form>/gi,f=>/subscribe|newsletter|mailchimp|convertkit|comment|search|login|type=["']?email/i.test(f)?'':f);
  const inputs=(appHtml.match(/<(input|select|textarea)\b[^>]*>/gi)||[]).filter(t=>!/type\s*=\s*["']?(hidden|search|email|submit|checkbox)/i.test(t)).length;
  const interactive=inputs>=3||/<canvas\b|data-calculator|class=["'][^"']*(calculator|quiz|finder|tool-app)/i.test(html)||(types.some(t=>/WebApplication|SoftwareApplication/.test(t))&&!types.some(t=>/Review|Product/.test(t))); // a review describes someone else's software
  return {
    title,h1,description:(metaContent(html,'description')||metaContent(html,'og:description')).slice(0,300),
    words,h2_count:h2.length,h3_count:h3,h2:h2.slice(0,12),
    tables:(html.match(/<table\b/gi)||[]).length,lists:(html.match(/<(ul|ol)\b/gi)||[]).length,
    images:(html.match(/<img\b/gi)||[]).length,videos:(html.match(/<(video|iframe)\b[^>]*(youtube|vimeo|video)/gi)||[]).length,
    interactive,schema:types,modified,external_domains:externalDomains.size,authority_citations:authority,
    internal_links:[...internal].slice(0,400),terms:topTerms(`${title} ${h1} ${h1} ${h2.join(' ')} ${text}`,60),
    // Pages this article cites from its own content (no navigation, footer, social or shop links): free prospects for sites with no sends yet.
    external_links:outboundCandidates(html,url,{ourDomains:[domain],max:20}).map(l=>({url:l.url,anchor:l.anchor.slice(0,80)})),
    og_image:attr((html.match(/<meta\b[^>]*property=["']og:image["'][^>]*>/i)||[''])[0],'content')||null,
  };
}

/**
 * Crawl every site incrementally. `cache` maps url -> previous record; pages
 * fetched within `refetchDays` (and not changed per sitemap lastmod) are reused.
 */
export async function crawlPortfolio(sites,{cache={},fetchImpl=fetch,limitPerSite=300,perHost=4,refetchDays=3,deadline=Infinity,retryMs=1500,log=()=>{}}={}){
  const results=await pool(sites,4,async site=>{
    let found=await discoverSite(site,{fetchImpl,limit:limitPerSite,retryMs});
    // The sitemap did not answer: check the URLs known from earlier cycles instead of treating the site as a handful of pages.
    if(!found.sitemaps.length&&found.sitemap_errors.length){
      const have=new Set(found.urls.map(u=>u.url));
      const known=Object.values(cache).filter(r=>r?.site===site.domain&&r.url&&!have.has(r.url)).slice(0,Math.max(0,limitPerSite-found.urls.length));
      if(known.length)found={...found,urls:[...found.urls,...known.map(r=>({url:r.url,fetch:r.url,lastmod:r.lastmod||null,configured:false}))],discovered:found.urls.length+known.length,reused_known:known.length};
      log(`crawl ${site.domain}: sitemap answered HTTP ${found.sitemap_errors[0].status}; ${known.length} URLs known from earlier cycles are checked instead`);
    }
    let fetched=0,reused=0,notModified=0,failing=0,skipped=0,outage=null;
    const pages=await pool(found.urls,perHost,async item=>{
      const prev=cache[item.url];
      const fresh=prev&&prev.status===200&&ageDays(prev.fetched_at)<refetchDays&&!(item.lastmod&&prev.fetched_at<item.lastmod);
      if(fresh||Date.now()>deadline){reused++;return prev?{...prev,lastmod:item.lastmod,configured:item.configured}:null}
      // The site is failing most requests: stop asking for this cycle (more requests only add load) and keep what is known.
      if(outage?.stopped){skipped++;return prev?{...prev,lastmod:item.lastmod,configured:item.configured}:null}
      const res=await fetchPage(item.fetch||item.url,{fetchImpl,etag:prev?.etag,lastModified:prev?.last_modified,maxBytes:PAGE_BYTES});
      if(res.status===304&&prev){notModified++;return {...prev,fetched_at:NOW(),lastmod:item.lastmod,configured:item.configured}}
      fetched++;
      if(res.status>=500||res.status===429){
        failing++;outage??={status:res.status,hint:serverHint(res),failed:0};outage.failed=failing;
        if(failing>=OUTAGE_AFTER&&failing*2>=fetched)outage.stopped=true;
      }
      const tech=evaluatePublicPage(res.url,{status:res.status,contentType:res.type||'',headers:res.headers||{},body:res.body||''});
      const rec={site:site.domain,url:item.url,final_url:res.url,status:res.status,technical_status:res.redirected&&res.status===200?'redirect_requires_review':tech.technical_status,
        canonical:tech.canonical,noindex:tech.noindex,lastmod:item.lastmod,configured:item.configured,fetched_at:NOW(),etag:res.etag||'',last_modified:res.lastModified||''};
      if(res.status>=500||res.status===429){const hint=serverHint(res),after=res.headers?.get?.('retry-after');if(hint)rec.server_hint=hint;if(after)rec.retry_after=String(after).slice(0,40)}
      if(res.status===200&&res.body){Object.assign(rec,extractFeatures(res.url,res.body,site.domain));if(res.body.length>=PAGE_BYTES)rec.truncated=true}
      return rec;
    });
    // A handful of failures among hundreds of good answers is not an outage.
    if(outage&&!outage.stopped&&failing<10)outage=null;
    log(`crawl ${site.domain}: ${found.urls.length}/${found.discovered} urls, fetched ${fetched}, 304 ${notModified}, reused ${reused}`+
      (outage?`; ${failing} answered HTTP ${outage.status}${outage.hint?` (${outage.hint})`:''}${outage.stopped?`, crawl stopped early (${skipped} not requested)`:''}`:''));
    return {site:site.domain,sitemaps:found.sitemaps,discovered:found.discovered,pages:pages.filter(p=>p&&!p.error),
      ...(found.sitemap_errors.length?{sitemap_errors:found.sitemap_errors}:{}),...(found.reused_known?{reused_known:found.reused_known}:{}),...(outage?{outage}:{})};
  });
  return results.filter(r=>r&&!r.error);
}
