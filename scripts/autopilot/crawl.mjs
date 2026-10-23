/**
 * Owned-site crawler: full sitemap discovery (robots.txt + nested indexes),
 * incremental fetching (skip fresh pages, conditional GET), and on-page feature
 * extraction used for linkability scoring and internal-link planning.
 */
import {fetchPage,pool,normUrl,sameSite,rootDomain,mainText,tagText,metaContent,links,jsonLd,topTerms,ageDays,NOW,attr} from './util.mjs';
import {evaluatePublicPage} from '../refresh-public-intelligence.mjs';

const SKIP_PATH=/(?:^|\/)(?:wp-admin|wp-json|wp-content|wp-includes|tag|tags|author|category|categories|feed|page\/\d+|privacy(?:-policy)?|terms(?:-of-(?:service|use)|-and-conditions|-conditions)?|cookie(?:-policy)?|disclaimer|disclosure|affiliate-disclosure|editorial-policy|contact(?:-us)?|about(?:-us|-me)?|cart|checkout|my-account|login|register|search|sitemap|html-sitemap|thank-you|thanks)(?:\/|$)|\.(?:xml|json|jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js)$/i;
const AUTHORITY=/(?:\.gov|\.edu|\.ac\.[a-z]{2}|\.nhs\.uk|who\.int|nih\.gov|ncbi\.nlm|pubmed|doi\.org|sciencedirect|springer|nature\.com|wiley\.com|jamanetwork|bmj\.com|thelancet|cdc\.gov|wikipedia\.org|arxiv\.org|acm\.org|ieee\.org|extension\.)/i;

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
export async function discoverSite(site,{fetchImpl,limit=300,maxSitemaps=30}={}){
  const domain=site.domain,queue=[],seenMaps=new Set(),urls=new Map(),sources=[];
  const robots=await fetchPage(`https://${domain}/robots.txt`,{accept:'text/plain',fetchImpl,timeout:8000});
  if(robots.status===200)for(const m of robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim))queue.push(m[1].trim());
  queue.push(`https://${domain}/sitemap_index.xml`,`https://${domain}/sitemap.xml`,`https://${domain}/wp-sitemap.xml`);
  while(queue.length&&seenMaps.size<maxSitemaps){
    const map=queue.shift();if(seenMaps.has(map))continue;seenMaps.add(map);
    const res=await fetchPage(map,{accept:'application/xml,text/xml',fetchImpl,timeout:10000,maxBytes:3_000_000});
    if(res.status!==200||!/<(urlset|sitemapindex)\b/i.test(res.body))continue;
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
  return {site:domain,urls:list,sitemaps:sources,discovered:urls.size};
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
  const interactive=inputs>=3||/<canvas\b|data-calculator|class=["'][^"']*(calculator|quiz|finder|tool-app)/i.test(html)||types.some(t=>/WebApplication|SoftwareApplication/.test(t));
  return {
    title,h1,description:(metaContent(html,'description')||metaContent(html,'og:description')).slice(0,300),
    words,h2_count:h2.length,h3_count:h3,h2:h2.slice(0,12),
    tables:(html.match(/<table\b/gi)||[]).length,lists:(html.match(/<(ul|ol)\b/gi)||[]).length,
    images:(html.match(/<img\b/gi)||[]).length,videos:(html.match(/<(video|iframe)\b[^>]*(youtube|vimeo|video)/gi)||[]).length,
    interactive,schema:types,modified,external_domains:externalDomains.size,authority_citations:authority,
    internal_links:[...internal].slice(0,400),terms:topTerms(`${title} ${h1} ${h1} ${h2.join(' ')} ${text}`,60),
    og_image:attr((html.match(/<meta\b[^>]*property=["']og:image["'][^>]*>/i)||[''])[0],'content')||null,
  };
}

/**
 * Crawl every site incrementally. `cache` maps url -> previous record; pages
 * fetched within `refetchDays` (and not changed per sitemap lastmod) are reused.
 */
export async function crawlPortfolio(sites,{cache={},fetchImpl=fetch,limitPerSite=300,perHost=4,refetchDays=3,deadline=Infinity,log=()=>{}}={}){
  const results=await pool(sites,4,async site=>{
    const found=await discoverSite(site,{fetchImpl,limit:limitPerSite});
    let fetched=0,reused=0,notModified=0;
    const pages=await pool(found.urls,perHost,async item=>{
      const prev=cache[item.url];
      const fresh=prev&&prev.status===200&&ageDays(prev.fetched_at)<refetchDays&&!(item.lastmod&&prev.fetched_at<item.lastmod);
      if(fresh||Date.now()>deadline){reused++;return prev?{...prev,lastmod:item.lastmod,configured:item.configured}:null}
      const res=await fetchPage(item.fetch||item.url,{fetchImpl,etag:prev?.etag,lastModified:prev?.last_modified});
      if(res.status===304&&prev){notModified++;return {...prev,fetched_at:NOW(),lastmod:item.lastmod,configured:item.configured}}
      fetched++;
      const tech=evaluatePublicPage(res.url,{status:res.status,contentType:res.type||'',headers:res.headers||{},body:res.body||''});
      const rec={site:site.domain,url:item.url,final_url:res.url,status:res.status,technical_status:res.redirected&&res.status===200?'redirect_requires_review':tech.technical_status,
        canonical:tech.canonical,noindex:tech.noindex,lastmod:item.lastmod,configured:item.configured,fetched_at:NOW(),etag:res.etag||'',last_modified:res.lastModified||''};
      if(res.status===200&&res.body)Object.assign(rec,extractFeatures(res.url,res.body,site.domain));
      return rec;
    });
    log(`crawl ${site.domain}: ${found.urls.length}/${found.discovered} urls, fetched ${fetched}, 304 ${notModified}, reused ${reused}`);
    return {site:site.domain,sitemaps:found.sitemaps,discovered:found.discovered,pages:pages.filter(p=>p&&!p.error)};
  });
  return results.filter(r=>r&&!r.error);
}
