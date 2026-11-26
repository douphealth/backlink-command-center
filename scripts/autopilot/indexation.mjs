/**
 * Indexation health for owned sites, from the crawl Autopilot already runs.
 * Every URL here came from the site's own XML sitemap (or is a configured asset), so each blocking issue
 * is a page you are asking Google to index that cannot be indexed as it is.
 * Links built to such pages are wasted, so they are also excluded from promotion.
 *
 * Three groups, kept apart because they need different action:
 *  - blocking: 404/410, server error, noindex, canonical pointing elsewhere (the page cannot be indexed)
 *  - review:   redirect, no response, bot-blocked, no canonical (usually indexable, worth a look)
 *  - thin:     indexable, but under 300 words and not a tool (a quality note, not an indexing error)
 */
import {normUrl} from './util.mjs';

export const ISSUES={
  not_found:{severity:1,label:'404/410 in sitemap',fix:'Restore the page or 301-redirect it to the closest live page, then remove the old URL from the sitemap.'},
  server_error:{severity:2,label:'Server error (5xx)',fix:'Check hosting/caching/firewall logs for this URL; Google drops URLs that keep failing.'},
  noindex:{severity:3,label:'noindex but listed in sitemap',fix:'If the page should rank, remove the noindex (SEO plugin / X-Robots-Tag). If not, drop it from the sitemap.'},
  canonical_mismatch:{severity:4,label:'Canonical points to another URL',fix:'Make the canonical self-referencing, or list the canonical URL in the sitemap instead of this one.'},
  redirect:{severity:5,label:'Sitemap URL redirects',fix:'Replace the sitemap entry and internal links with the final URL (sitemaps should list only 200, canonical URLs).'},
  unreachable:{severity:6,label:'Did not respond to the crawler (timeout/DNS/TLS)',fix:'Often transient. If it repeats over several cycles, check DNS, the TLS certificate and firewall rules.'},
  bot_blocked:{severity:6,label:'Blocks automated requests (401/403/429/challenge)',fix:'Confirm Googlebot is allowed in the firewall/CDN bot rules and use URL Inspection in Search Console.'},
  missing_canonical:{severity:7,label:'No canonical tag',fix:'Add a self-referencing canonical (most SEO plugins do this when enabled).'},
  thin:{severity:8,label:'Thin page (under 300 words, no tool)',fix:'Expand it to fully answer the query, merge it into a stronger page with a 301, or noindex it.'},
};
export const BLOCKING=['not_found','server_error','noindex','canonical_mismatch'];
export const REVIEW=['redirect','unreachable','bot_blocked','missing_canonical'];
/** Examples listed per site and problem; the per-site counts always cover everything. */
const EXAMPLES_PER_GROUP=12;

/** Policy, legal and utility pages are short by nature: a 150-word refund policy is not a content problem. */
const UTILITY=/polic(?:y|ies)|disclaimer|disclosure|standards|terms|unsubscribe|thank-?you|thanks|change-?log|ownership|corrections|methodology|^about$|^about-(?:us|me|the-|.*founder)/i;
export function utilityPage(url){
  try{const seg=new URL(url).pathname.split('/').filter(Boolean).pop()||'';return UTILITY.test(seg)}catch{return false}
}

export function pageIssue(p){
  if(p.status===404||p.status===410)return 'not_found';
  if(p.status>=500||p.technical_status==='origin_or_edge_error')return 'server_error';
  if(!p.status)return 'unreachable';
  if(p.technical_status==='probe_access_restricted'||p.technical_status==='probe_challenged')return 'bot_blocked';
  if(p.status!==200)return null;
  if(p.technical_status==='redirect_requires_review'||(p.final_url&&normUrl(p.final_url)!==normUrl(p.url)))return 'redirect';
  if(p.noindex||p.technical_status==='blocked_noindex')return 'noindex';
  if(p.technical_status==='blocked_canonical')return 'canonical_mismatch';
  if(!p.canonical)return 'missing_canonical';
  // `truncated`: only the first part of a very large page was read, so its word count is not the page's.
  if((p.words||0)>0&&p.words<300&&!p.interactive&&!p.truncated&&!utilityPage(p.url))return 'thin';
  return null;
}

const mostCommon=list=>{const c=new Map();for(const x of list)c.set(x,(c.get(x)||0)+1);return [...c].sort((a,b)=>b[1]-a[1])[0]?.[0]};
/** One sentence when a whole site is failing, so 150 identical rows are not mistaken for 150 separate problems. */
function siteAlert(s,counts){
  const parts=[];
  const failing=s.pages.filter(p=>pageIssue(p)==='server_error');
  if(failing.length>=10||s.outage){
    const status=mostCommon(failing.map(p=>p.status))||s.outage?.status,hint=mostCommon(failing.map(p=>p.server_hint).filter(Boolean))||s.outage?.hint;
    parts.push(`${counts.server_error} of ${s.pages.length} URLs answered HTTP ${status||'5xx'}${hint?` (the site says: ${hint})`:''}. The site itself is failing under light crawling, not individual pages`
      +(s.outage?.stopped?`; the crawl stopped early after ${s.outage.failed} failures to avoid adding load`:''));
  }
  const map=(s.sitemap_errors||[])[0];
  if(map)parts.push(`the sitemap answered HTTP ${map.status}${s.reused_known?`, so ${s.reused_known} URLs known from earlier cycles were checked instead`:''}`);
  return parts.length?parts.join('. ')+'.':null;
}

/** Per-site counts plus example issues, most severe first (public data: URLs of your own sites only). */
export function indexationReport(crawl,{limit=150}={}){
  const sites=[],issues=[];let total=0;const sum=keys=>counts=>keys.reduce((n,k)=>n+counts[k],0);
  for(const s of crawl){
    const counts=Object.fromEntries(Object.keys(ISSUES).map(k=>[k,0]));let healthy=0;
    for(const p of s.pages){
      const k=pageIssue(p);
      if(!k){if(p.status===200)healthy++;continue}
      counts[k]++;total++;
      if(counts[k]>EXAMPLES_PER_GROUP)continue;
      const detail=k==='server_error'?[`HTTP ${p.status}`,p.retry_after?`retry-after ${p.retry_after}`:'',p.server_hint||''].filter(Boolean).join(' · '):'';
      issues.push({site:s.site,url:p.url,issue:k,label:ISSUES[k].label,fix:ISSUES[k].fix,severity:ISSUES[k].severity,status:p.status,
        ...(detail?{detail}:{}),...(k==='redirect'?{final_url:p.final_url}:{}),...(k==='canonical_mismatch'?{canonical:p.canonical}:{}),...(k==='thin'?{words:p.words}:{})});
    }
    const problems=Object.values(counts).reduce((a,b)=>a+b,0),alert=siteAlert(s,counts);
    sites.push({site:s.site,checked:s.pages.length,healthy,problems,critical:sum(BLOCKING)(counts),review:sum(REVIEW)(counts),...counts,...(alert?{alert}:{})});
  }
  issues.sort((a,b)=>a.severity-b.severity||a.site.localeCompare(b.site)||a.url.localeCompare(b.url));
  const t=k=>sites.reduce((n,x)=>n+x[k],0);
  return {sites,issues:issues.slice(0,limit),total_issues:total,blocking:t('critical'),review:t('review'),thin:t('thin'),
    note:`Covers the sitemap URLs crawled this cycle (up to 300 per site, newest first); up to ${EXAMPLES_PER_GROUP} examples are listed per site and problem.`};
}
