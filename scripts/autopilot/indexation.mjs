/**
 * Indexation health for owned sites, from the crawl Autopilot already runs.
 * Every URL here came from the site's own XML sitemap, so each issue is a page
 * you are asking Google to index that cannot (or should not) be indexed.
 * Links built to such pages are wasted, so they are also excluded from promotion.
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
  if((p.words||0)>0&&p.words<300&&!p.interactive)return 'thin';
  return null;
}

/** Per-site counts plus the most severe individual issues (public data: URLs of your own sites only). */
export function indexationReport(crawl,{limit=150}={}){
  const sites=[],issues=[];
  for(const s of crawl){
    const counts=Object.fromEntries(Object.keys(ISSUES).map(k=>[k,0]));let healthy=0;
    for(const p of s.pages){
      const k=pageIssue(p);
      if(!k){if(p.status===200)healthy++;continue}
      counts[k]++;
      issues.push({site:s.site,url:p.url,issue:k,label:ISSUES[k].label,fix:ISSUES[k].fix,severity:ISSUES[k].severity,status:p.status,
        ...(k==='redirect'?{final_url:p.final_url}:{}),...(k==='canonical_mismatch'?{canonical:p.canonical}:{}),...(k==='thin'?{words:p.words}:{})});
    }
    const problems=Object.values(counts).reduce((a,b)=>a+b,0);
    sites.push({site:s.site,checked:s.pages.length,healthy,problems,critical:counts.not_found+counts.server_error+counts.noindex+counts.canonical_mismatch,...counts});
  }
  issues.sort((a,b)=>a.severity-b.severity||a.site.localeCompare(b.site)||a.url.localeCompare(b.url));
  return {sites,issues:issues.slice(0,limit),total_issues:issues.length,
    note:'Covers the sitemap URLs crawled this cycle (up to 300 per site, newest first).'};
}
