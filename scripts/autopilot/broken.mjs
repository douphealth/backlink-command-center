/**
 * Broken-link building: find dead outbound links on a prospect's page that our
 * asset can replace. An editor told about a real dead link on their own page has
 * a concrete reason to reply and edit, so these pitches convert far better
 * than a cold "please add our resource" request.
 *
 * Conservative by design. A link counts as dead only on HTTP 404/410 or a
 * domain that no longer resolves (NXDOMAIN). 401/403/429/5xx, timeouts and
 * soft-404 redirects are never treated as broken, because a pitch must never
 * claim a link is dead when it is not. The claim is checked again right before
 * the email is written.
 */
import {Resolver} from 'node:dns/promises';
import {fetchPage,links,hostOf,sameSite,tokens,safePublicUrl,pool,NOW} from './util.mjs';

// Hosts whose URLs are never useful replacement targets (social, shorteners, stores, ads, CDNs).
const SKIP_HOST=/(^|\.)(facebook|twitter|x|instagram|pinterest|linkedin|youtube|youtu|tiktok|reddit|t|bit|goo|ow|buff|amzn|amazon|ebay|etsy|walmart|google|googleapis|gstatic|apple|microsoft|cloudflare|doubleclick|wordpress|gravatar|wp|feedburner|addtoany|sharethis|disqus|paypal|patreon|ko-fi|buymeacoffee)\.[a-z.]+$/i;
const SKIP_PATH=/\.(?:jpe?g|png|gif|webp|svg|pdf|zip|mp[34]|css|js)(?:$|\?)|\/(?:share|sharer|intent|login|signin|cart|checkout|wp-login)\b/i;

/** Main-content HTML only: links in nav, header, footer, sidebars and comments are not editorial. */
export function contentHtml(html){
  let h=String(html||'').replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi,' ');
  const main=h.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);if(main&&main[2].length>800)h=main[2];
  return h.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi,' ')
    .replace(/<(section|div|ol|ul)\b[^>]*(?:id|class)=["'][^"']*(?:comment|related|sidebar|widget|share|social|footer)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,' ');
}

/** External editorial links on the page, most relevant to our asset first. */
export function outboundCandidates(html,pageUrl,{terms=[],ourDomains=[],max=10}={}){
  const host=hostOf(pageUrl),want=new Set(terms),seen=new Set(),out=[];
  for(const l of links(contentHtml(html),pageUrl)){
    const h=hostOf(l.url);
    if(!h||sameSite(h,host)||sameSite(host,h)||SKIP_HOST.test(h)||SKIP_PATH.test(l.url)||ourDomains.some(d=>sameSite(h,d))||!safePublicUrl(l.url))continue;
    if(seen.has(l.url))continue;seen.add(l.url);
    let path='';try{path=new URL(l.url).pathname}catch{}
    const words=new Set(tokens(`${l.anchor} ${path.replace(/[-_/.]/g,' ')}`));
    const relevance=[...want].filter(w=>words.has(w)).length;
    out.push({url:l.url,anchor:l.anchor,relevance});
  }
  return out.sort((a,b)=>b.relevance-a.relevance).slice(0,max);
}

const defaultResolve=host=>new Resolver({timeout:4000,tries:2}).resolve4(host);
/**
 * Is this URL really dead? Returns {dead, reason, status}.
 * `resolveHost` must reject with code ENOTFOUND when the domain does not exist.
 */
export async function checkDead(url,{fetchImpl=fetch,resolveHost=defaultResolve}={}){
  const res=await fetchPage(url,{fetchImpl,timeout:10000,maxBytes:2000,accept:'text/html,*/*;q=0.8'});
  if(res.status===404||res.status===410)return {dead:true,status:res.status,reason:res.status===410?'gone':'not_found'};
  if(res.status===0&&res.error==='network'){
    try{await resolveHost(new URL(res.url||url).hostname);return {dead:false,status:0,reason:'unreachable_but_resolves'}}
    catch(e){return e?.code==='ENOTFOUND'?{dead:true,status:0,reason:'domain_gone'}:{dead:false,status:0,reason:'dns_uncertain'}}
  }
  return {dead:false,status:res.status,reason:res.error||'ok'};
}

/**
 * Find the most relevant dead link on a page. Only links that share at least one
 * topical term with our asset qualify, so the replacement offer makes sense.
 */
export async function findBrokenLink(html,pageUrl,{terms=[],ourDomains=[],fetchImpl=fetch,resolveHost=defaultResolve,max=8,deadline=Infinity}={}){
  const candidates=outboundCandidates(html,pageUrl,{terms,ourDomains,max}).filter(c=>c.relevance>0);
  if(!candidates.length)return null;
  const results=await pool(candidates,4,async c=>Date.now()>deadline?null:{...c,...await checkDead(c.url,{fetchImpl,resolveHost})});
  const hit=results.find(r=>r?.dead);
  return hit?{url:hit.url,anchor:hit.anchor.slice(0,120),host:hostOf(hit.url),reason:hit.reason,status:hit.status,relevance:hit.relevance,checked_at:NOW()}:null;
}

/** Terms that describe what our asset covers (for matching dead links to it). */
export function assetTerms(asset,site){
  const fromTerms=(asset?.terms||[]).slice(0,30).flatMap(t=>String(t).split(/\s+/));
  return [...new Set([...tokens(site?.topic||''),...tokens(`${asset?.h1||''} ${asset?.title||''}`),...fromTerms])];
}
