/**
 * Explainable URL opportunity intelligence.
 * Uses only real first-party HTTP evidence. Not GSC, not publisher qualification,
 * not evidence of original research or actual editorial placements.
 */
const NAVIGATION=/(?:^|\/)(?:blog|blogs|news|archive|archives|category|tag|tags|author|authors|search|feed|page|topics|all-posts|collections|shop|store|cart|checkout|privacy|terms|disclosure|about|contact|sitemap|wp-admin)(?:\/|$)/i;
const FILES=/\.(?:xml|json|pdf|jpg|jpeg|png|webp|svg|zip|js|css|txt)$/i;
const MEDICAL=/\b(?:cancer|diagnos|depress|treatment|diabetes|symptom|disease|medication|supplement|weight.loss|nutrition|therapy|mental.health|health.claim)\b/i;
const SALES=/\b(?:buy|sale|discount|coupon|deal|pricing|shop|checkout|affiliate|best.product|top.10|review)\b/i;
const tokenized=s=>String(s||'').toLowerCase().replace(/[-_]/g,' ').replace(/\s+/g,' ').trim();
const has=(text,re)=>re.test(text);
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function decodeTitle(input){
  return String(input||'').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|hellip);/gi,(match,entity)=>{
    const e=entity.toLowerCase();const symbols={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',hellip:'…'};
    if(e[0]==='#'){const n=e[1]==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return n>=32&&n<=0x10ffff?String.fromCodePoint(n):match;}
    return symbols[e]||match;
  }).replace(/\s+/g,' ').trim().slice(0,175);
}
export function classifyAsset(url,title=''){
  let u;try{u=new URL(url)}catch{return {type:'invalid',base:0,reason:'Invalid URL',sensitive:false};}
  const path=decodeURIComponent(u.pathname).toLowerCase();
  const combined=tokenized(path+' '+decodeTitle(title));
  const sensitive=has(combined,MEDICAL);
  if(path==='/'||NAVIGATION.test(path)||FILES.test(path))
    return {type:'navigation',base:0,reason:'Navigation, archive, policy or non-HTML asset; not a direct editorial pitch',sensitive};
  if(has(combined,/\b(?:methodology|methods|how it works|scoring model|review criteria|sources and weights)\b/))
    return {type:'methodology',base:91,reason:'Specific transparent process that a relevant editor could reference',sensitive};
  if(has(combined,/\b(?:calculator|shoe finder|finder|interactive|selector|matcher|comparison tool|planner|assessment|blueprint generator|generator)\b/))
    return {type:'interactive_tool',base:88,reason:'Potentially useful interactive resource; functionality must be checked',sensitive};
  if(has(combined,/\b(?:original study|original research|dataset|statistics|benchmark|survey results)\b/))
    return {type:'research_candidate',base:84,reason:'Data-oriented topic; underlying original evidence must be verified',sensitive};
  if(has(combined,/\b(?:security|technical reference|checklist|framework|identification|identify|protocol)\b/))
    return {type:'reference',base:81,reason:'Reference-style material for a specific specialist audience',sensitive};
  if(has(combined,/\b(?:versus| vs |comparison|compare|difference between|alternatives)\b/))
    return {type:'comparison',base:78,reason:'Direct comparison that could support an evidence-backed citation',sensitive};
  if(has(combined,SALES))
    return {type:'commercial',base:42,reason:'Commercial intent; editorial links require particularly strong independent utility',sensitive};
  if(has(combined,/\b(?:guide|tutorial|how to|how-to|steps|instructions|care|learning|spaced repetition|training)\b/))
    return {type:'practical_guide',base:69,reason:'Practical guide; independent utility and distinctiveness need checking',sensitive};
  return {type:'general_article',base:55,reason:'General article without a confirmed unique citation asset',sensitive};
}
const techStatus=x=>String(x?.technical_status||'unreachable_from_probe');
const technicalNote={
  technically_eligible:'HTTP 200, HTML, title and self-canonical observed; indexation and editorial quality still unverified',
  blocked_canonical:'The inspected page declares a different canonical',
  blocked_noindex:'Noindex directive observed',
  redirect_requires_review:'The inspected URL redirects; final target must be re-evaluated',
  needs_editorial_review:'Missing canonical or title, or insufficient HTML evidence',
  unreachable_from_probe:'The HTTP probe could not verify the URL',
  unexpected_content_type:'The response was not an HTML page'
};
export function scoreOpportunity(item,{configured=false,checkedAt=null}={}){
  const classification=classifyAsset(item.url,item.title);
  const technical=techStatus(item);
  const eligible=technical==='technically_eligible'&&classification.type!=='navigation'&&classification.type!=='invalid';
  const sensitive=classification.sensitive;
  const staleness=checkedAt?Date.now()-Date.parse(checkedAt):NaN;
  const stale=Number.isFinite(staleness)&&staleness>72*3600*1000;
  const editorial=clamp(classification.base+(configured?4:0)-(sensitive?12:0)-(stale?10:0),0,95);
  const priority=eligible?editorial:0;
  const gate=!eligible?'blocked_or_review':sensitive?'expert_review_required':'editorial_review_required';
  const nextAction=!eligible?(classification.type==='navigation'?'Do not pitch this index/navigation page':'Resolve the technical issue; rerun the HTTP audit'):sensitive?'Confirm expertise and source quality before any pitch':'Verify originality, publisher fit, contact permission and CRM suppression';
  return {
    site:item.site,url:item.url,title:decodeTitle(item.title)||new URL(item.url).pathname,
    category:classification.type,editorial_priority:priority,editorial_fit:editorial,
    technical_status:technical,http_status:item.http_status??0,canonical:item.canonical??null,
    measured_at:checkedAt,source:configured?'configured_resource':'public_sitemap',
    quality_gate:gate,ready_to_send:false,health_sensitive:sensitive,
    reason:classification.reason,technical_evidence:technicalNote[technical]||'Unclassified technical evidence',
    next_action:nextAction,requires:['human-quality-equivalent content review','publisher relevance and official contact','CRM suppression/duplicate check']
  };
}
export function buildOpportunitySnapshot(evidence,portfolio,{maxPerSite=4,maxTotal=50}={}){
  const configured=new Map((portfolio.sites||[]).map(s=>[s.domain,new Set((s.assets||[]).map(x=>{try{return new URL(x).pathname.replace(/\/$/,'')}catch{return x}}))]));
  const assets=(evidence.urls||[]).map(item=>{
    const path=(()=>{try{return new URL(item.url).pathname.replace(/\/$/,'')}catch{return ''}})();
    return scoreOpportunity(item,{configured:configured.get(item.site)?.has(path),checkedAt:evidence.generated_at});
  });
  const eligible=assets.filter(x=>x.quality_gate!=='blocked_or_review').sort((a,b)=>b.editorial_priority-a.editorial_priority||a.url.localeCompare(b.url));
  const selected=[],bySite=new Map();
  for(const item of eligible){
    if((bySite.get(item.site)||0)>=maxPerSite)continue;
    selected.push(item);bySite.set(item.site,(bySite.get(item.site)||0)+1);
    if(selected.length>=maxTotal)break;
  }
  const issues=assets.filter(x=>x.quality_gate==='blocked_or_review').sort((a,b)=>a.site.localeCompare(b.site)||a.url.localeCompare(b.url));
  return {schema_version:2,generated_at:evidence.generated_at,source:'first_party_http_only',
    gsc_metrics_included:false,publisher_qualification_included:false,outreach_authorized:false,
    policy:'Automated URL research, never automatic publisher sending. Requires live indexation/content/publisher/CRM checks.',
    counts:{audited:assets.length,technically_eligible:assets.filter(x=>x.technical_status==='technically_eligible').length,editorial_candidates:eligible.length,shortlisted:selected.length,held_or_review:issues.length,sites_seen:new Set(assets.map(x=>x.site)).size},
    shortlist:selected,holds:issues,by_site:[...new Set(assets.map(x=>x.site))].sort().map(site=>({site,audited:assets.filter(x=>x.site===site).length,eligible:eligible.filter(x=>x.site===site).length,shortlisted:selected.filter(x=>x.site===site).length}))};
}
