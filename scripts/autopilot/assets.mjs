/**
 * Which owned pages are worth pitching to an independent editor.
 *
 * By 2026-11-26 Autopilot had sent 97 pitches for 0 links. A main reason: to keep its searches fresh it rotated
 * deeper and deeper into each site's ranking and ended up pitching thin city pages, affiliate reviews,
 * product-vs-product pages and one of 299 templated pages. Editors do not link to those. Only pages that pass
 * this policy are promoted, and queued prospects are re-paired with one before any email is written.
 */
import {normUrl,tokens,keyPhrase} from './util.mjs';

const REVIEW_PATH=/\/(?:reviews?|compare|comparisons?|best|deals?|coupons?|discounts?|pricing|shop|product|products|buy)(?:\/|$)/i;
// Product pages by title. Concept comparisons ("interleaving vs blocked practice") are fine and are not matched here.
const REVIEW_TITLE=/\b(?:(?<!weekly |monthly |quarterly |annual |yearly |daily |peer |performance |code |literature |life |self[- ])reviews?(?! checklist| template| process| questions| meeting)|coupon|discount|deals?|pricing|cheapest|best [a-z0-9 ]{2,40} for)\b/i;
const pathOf=u=>{try{return new URL(u).pathname}catch{return ''}};

export const isFlagship=(asset,site)=>(site?.assets||[]).some(u=>normUrl(u)===normUrl(asset?.url));

/** {ok, why}: why is plain language for the dashboard. */
export function pitchable(asset,site){
  if(!asset?.url)return {ok:false,why:'no page'};
  if(isFlagship(asset,site))return {ok:true,why:'flagship page'};
  const reasons=asset.reasons||[],path=pathOf(asset.url),words=asset.words||0;
  // A blog category with a dozen posts is not programmatic; 40+ near-identical siblings is.
  const siblings=Math.max(0,...reasons.map(r=>Number((String(r).match(/One of (\d+) templated sibling/i)||[])[1]||0)));
  if(siblings>=40)return {ok:false,why:'one of many templated pages'};
  if(asset.type==='commercial'||REVIEW_PATH.test(path))return {ok:false,why:'review, comparison or sales page'};
  if(REVIEW_TITLE.test(String(asset.title||'')))return {ok:false,why:'review, comparison or sales page'};
  if(asset.type==='interactive_tool'&&asset.interactive)return {ok:true,why:'free tool'};
  if(['methodology','research_candidate'].includes(asset.type)&&words>=600)return {ok:true,why:'original method or data'};
  if(asset.type==='reference'&&words>=1200&&(asset.linkability||0)>=75)return {ok:true,why:'reference page'};
  if(['practical_guide','comparison','general_article'].includes(asset.type)&&words>=1500&&(asset.linkability||0)>=75)return {ok:true,why:'in-depth guide'};
  return {ok:false,why:words<1500?'too thin to earn a link':'not distinctive enough to earn a link'};
}

/** The pitchable pages of one site, best first (flagships lead). */
export function pitchableAssets(ranked,site){
  return ranked.filter(a=>a.site===site.domain&&pitchable(a,site).ok)
    .sort((a,b)=>(isFlagship(b,site)?1:0)-(isFlagship(a,site)?1:0)||(b.promotion||0)-(a.promotion||0));
}

const GENERIC=new Set('guide guides tips home best free online tool tools calculator help learn page pages site website blog article resources resource list ideas info'.split(' '));
/**
 * The pitchable page that best answers what the editor's page is about. Returns {asset, match}:
 * 'specific' = shares a specific subject word with the page; 'topic' = the site's lead page for an on-topic page.
 */
export function bestPitchAsset(prospect,assets,site){
  if(!assets.length)return null;
  const c=prospect.competitor_link||{};
  const ctx=new Set(tokens(`${prospect.title||''} ${prospect.fit_section||''} ${c.anchor||''} ${c.context||''} ${String(prospect.excerpt||'').slice(0,800)} ${pathOf(prospect.page_url).replace(/[-_/.]/g,' ')}`));
  const topic=new Set(tokens(site?.topic||''));
  let best=null,bestN=0;
  for(const a of assets){
    const want=new Set([...tokens(keyPhrase(a.h1||a.title,6)),...(a.terms||[]).filter(t=>!t.includes(' ')).slice(0,15)]);
    const hit=[...want].filter(w=>ctx.has(w)),specific=hit.filter(w=>!topic.has(w)&&!GENERIC.has(w));
    const n=specific.length?hit.length+specific.length*2:0;
    if(n>bestN){best=a;bestN=n}
  }
  return best?{asset:best,match:'specific'}:{asset:assets[0],match:'topic'};
}
