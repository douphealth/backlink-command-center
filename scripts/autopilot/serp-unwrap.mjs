/**
 * Google SERP results from DataForSEO arrive wrapped since 2026-11-06:
 *   {domain:'google.com', url:'https://google.com/goto?url=<opaque>', breadcrumb:'https://publisher.com › blog › slug-prefi...'}
 * Taken at face value every result is "google.com" and is dropped as a platform, which silently
 * stopped all prospecting. This module recovers the publisher (always, from the breadcrumb) and its
 * page URL (goto redirect → exact breadcrumb path → slug match in the publisher's sitemap/homepage).
 */
import {fetchPage,hostOf,rootDomain,normUrl,tokens} from './util.mjs';

const GOOGLE_HOST=/(^|\.)google\.[a-z.]+$/i;
export const isGoogleHost=h=>GOOGLE_HOST.test(rootDomain(h));
/** True when a SERP item's url points at a Google redirect wrapper instead of the result itself. */
export function isWrapped(item){
  let u;try{u=new URL(item?.url||'')}catch{return false}
  return isGoogleHost(u.hostname)&&/^\/(goto|url)\b/.test(u.pathname);
}
const SLUG=/^[a-z0-9][a-z0-9._~%-]*(\/[a-z0-9][a-z0-9._~%-]*)*$/;
/** "https://pub.com › blog › my-post" → {origin, host, segments, truncated, slugLike}. */
export function parseBreadcrumb(b){
  const parts=String(b||'').split(/\s+›\s+/).map(s=>s.trim()).filter(Boolean);
  let origin;try{const u=new URL(parts[0]);if(!/^https?:$/.test(u.protocol))return null;origin=u.origin}catch{return null}
  const segs=parts.slice(1);
  const truncated=segs.some(s=>/(\.\.\.|…)$/.test(s));
  const clean=segs.map(s=>s.replace(/(\.\.\.|…)$/,''));
  return {origin,host:rootDomain(new URL(origin).hostname),segments:clean,truncated,slugLike:clean.every(s=>SLUG.test(s))};
}
/** Normalise one SERP organic item to {url|null, domain, title, goto?, crumb?}. Unwrapped items pass through. */
export function unwrapItem(x){
  if(!isWrapped(x))return {url:x.url,domain:rootDomain(x.domain||hostOf(x.url)),title:x.title,description:x.description,rank:x.rank_absolute};
  const c=parseBreadcrumb(x.breadcrumb);
  if(!c||isGoogleHost(c.host))return {url:null,domain:'',title:x.title,rank:x.rank_absolute,goto:x.url};
  // An untruncated, slug-shaped breadcrumb is usually the real path; it is still only a guess until fetched.
  const guess=!c.truncated&&c.slugLike?normUrl(c.origin+'/'+c.segments.join('/')+(c.segments.length?'/':'')):null;
  return {url:null,domain:c.host,title:x.title,description:x.description,rank:x.rank_absolute,goto:x.url,crumb:{origin:c.origin,segments:c.segments,truncated:c.truncated,slugLike:c.slugLike,guess}};
}
/** Real result pages that Google shows inside the image carousel (these carry unwrapped URLs). */
export function carouselItems(items){
  const out=[];
  for(const x of items||[])if(x?.type==='images')for(const el of x.items||[]){
    if(!el?.url||isWrapped(el))continue;const h=hostOf(el.url);if(!h||isGoogleHost(h))continue;
    out.push({url:el.url,domain:h,title:el.alt||'',rank:x.rank_absolute,source:'carousel'});
  }
  return out;
}

const locs=xml=>[...String(xml||'').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m=>m[1].replace(/&amp;/g,'&'));
const pathOf=u=>{try{return new URL(u).pathname.replace(/\/+$/,'')}catch{return ''}};
/** Score how well a URL's path matches the breadcrumb prefix and the result title. */
export function matchScore(url,{segments=[],title=''}={}){
  const p=pathOf(url).toLowerCase();if(!p||p==='')return 0;
  let s=0;
  if(segments.length&&segments.every(x=>SLUG.test(x))){
    const prefix='/'+segments.join('/').toLowerCase();
    if(p===prefix)s+=100;else if(p.startsWith(prefix))s+=60+Math.min(20,prefix.length);
  }
  const t=[...new Set(tokens(title))].filter(w=>w.length>2&&!w.includes(' '));
  if(t.length){const slug=new Set(p.split(/[^a-z0-9]+/));const hit=t.filter(w=>slug.has(w)).length/t.length;if(hit>=0.5)s+=Math.round(hit*50)}
  return s;
}
/**
 * Find the real page for a wrapped result. Returns {url, page?, via} or null.
 * `page` is the fetched result (reused by the caller so nothing is fetched twice).
 */
export async function resolveWrapped(c,{fetchImpl=fetch,timeout=9000}={}){
  // 1. Google's own redirect (works when the wrapper is publicly resolvable).
  if(c.goto){
    const r=await fetchPage(c.goto,{fetchImpl,timeout,maxBytes:500000});
    if(r.status===200&&r.body&&!isGoogleHost(hostOf(r.url))&&hostOf(r.url).endsWith(c.domain))return {url:normUrl(r.url),page:r,via:'redirect'};
    if(r.status===200&&r.body&&isGoogleHost(hostOf(r.url))){ // interstitial: the destination is in the page
      const m=r.body.match(/(?:url=|href=")(https?:\/\/[^"'&<>\s]+)/i);
      if(m&&hostOf(m[1]).endsWith(c.domain))return {url:normUrl(m[1]),via:'interstitial'};
    }
  }
  const crumb=c.crumb||{};
  // 2. The exact breadcrumb path, when it is complete.
  if(crumb.guess){
    const r=await fetchPage(crumb.guess,{fetchImpl,timeout,maxBytes:500000});
    if(r.status===200&&r.body&&hostOf(r.url).endsWith(c.domain))return {url:normUrl(r.url),page:r,via:'breadcrumb'};
  }
  // 3. The publisher's own URL list: sitemap first, homepage links second.
  const origin=crumb.origin||`https://${c.domain}`;
  const urls=new Set();
  for(const sm of ['/sitemap.xml','/sitemap_index.xml','/wp-sitemap.xml']){
    const r=await fetchPage(origin+sm,{fetchImpl,timeout,maxBytes:2_000_000,accept:'application/xml,text/xml'});
    if(r.status!==200||!r.body)continue;
    const found=locs(r.body);
    const children=found.filter(u=>/sitemap[^/]*\.xml/i.test(u));
    for(const u of found)if(!/\.xml(\?|$)/i.test(u))urls.add(u);
    // Sitemap index: open the post/page children most likely to hold articles (max 3).
    for(const child of children.sort((a,b)=>(/post|article|blog|page/i.test(b)?1:0)-(/post|article|blog|page/i.test(a)?1:0)).slice(0,3)){
      const cr=await fetchPage(child,{fetchImpl,timeout,maxBytes:3_000_000,accept:'application/xml,text/xml'});
      if(cr.status===200)for(const u of locs(cr.body))if(!/\.xml(\?|$)/i.test(u))urls.add(u);
    }
    if(urls.size)break;
  }
  if(!urls.size){
    const home=await fetchPage(origin+'/',{fetchImpl,timeout,maxBytes:400000});
    if(home.status===200)for(const m of home.body.matchAll(/href="([^"#]+)"/gi)){const u=normUrl(m[1],home.url);if(u&&hostOf(u).endsWith(c.domain))urls.add(u)}
  }
  let best=null,bestScore=0;
  for(const u of urls){if(!hostOf(u).endsWith(c.domain))continue;const s=matchScore(u,{segments:crumb.segments,title:c.serp_title||c.title});if(s>bestScore){best=u;bestScore=s}}
  return best&&bestScore>=40?{url:normUrl(best),via:'sitemap'}:null;
}
