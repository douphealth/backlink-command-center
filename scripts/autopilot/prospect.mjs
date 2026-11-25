/**
 * Prospect discovery and qualification.
 * 1. Generate intent + resource-page queries for each promoted asset.
 * 2. Pull SERPs (DataForSEO), drop platforms/competitors/known domains.
 * 3. Fetch each page, score topical fit and "links out to resources" behaviour,
 *    detect existing links to us, and find the best editorial contact.
 */
import {fetchPage,pool,tokens,keyPhrase,links,tagText,jsonLd,mainText,stripTags,extractEmails,rankEmail,hostOf,sameSite,rootDomain,normUrl,hashId,ageDays,NOW} from './util.mjs';
import {findBrokenLink,assetTerms} from './broken.mjs';
import {resolveWrapped} from './serp-unwrap.mjs';

export const BLOCKED=/(^|\.)(reddit|quora|youtube|youtu|facebook|instagram|pinterest|tiktok|twitter|x|linkedin|threads|tumblr|amazon|ebay|walmart|etsy|target|bestbuy|aliexpress|temu|wikipedia|wikihow|wiktionary|medium|substack|github|stackexchange|stackoverflow|apple|google|bing|yahoo|msn|microsoft|play\.google|apps\.apple|yelp|tripadvisor|trustpilot|glassdoor|indeed|craigslist|scribd|slideshare|issuu|archive|imdb|britannica|dictionary|merriam-webster|cambridge|fandom|discord|telegram|whatsapp|twitch|vimeo|dailymotion|soundcloud|spotify|goodreads|zillow|webmd|healthline|mayoclinic|clevelandclinic|nytimes|washingtonpost|theguardian|bbc|cnn|forbes|businessinsider|wsj|usatoday|nbcnews|cbsnews|foxnews|reuters|apnews|bloomberg)\.[a-z.]+$/i;
// Government sites essentially never add outreach links; skip them before spending a fetch.
const GOVERNMENT=/(\.gov|\.mil|\.gov\.[a-z]{2}|\.gc\.ca|\.nhs\.uk|amsadobe\.com)$/i;
// Cold link requests to university staff are almost never answered.
const ACADEMIC=/(\.edu|\.edu\.[a-z]{2}|\.ac\.[a-z]{2})$/i;
// Bump when qualification rules change: older prospects are re-checked before any (follow-up) email.
export const QUALIFY_VERSION=2;
// Hosting previews, page builders and link farms that DataForSEO reports as referring domains.
const JUNK_HOST=/(hostingersite\.com|wpcomstaging\.com|wpengine\.com|alibaba\.com|aliexpress\.[a-z.]+|translate\.goog|ampproject\.org|webcache\.|archive\.ph|feedspot\.com|scoop\.it|flipboard\.com|muckrack\.com|similarweb\.com|semrush\.com|ahrefs\.com|moz\.com)$/i;
// Estimated monthly organic visits: giants don't answer, near-zero sites add no value.
export const TRAFFIC_BAND={min:50,max:1_000_000};
export const trafficVerdict=(etv,kind)=>etv==null?null:etv>(kind==='mention'?5_000_000:TRAFFIC_BAND.max)?'Very large brand (unlikely to add outreach links)':etv<(kind==='mention'?10:TRAFFIC_BAND.min)?'Almost no search traffic':null;
const UGC=/(?:^|\/)(forum|forums|thread|threads|community|questions?|answers|topic|t|r|groups?|profile|user|members?)\//i;
const RESOURCE=/\b(resources?|links|useful|helpful|recommended|tools|toolkit|roundup|round-up|best|list|directory|guide|reading|library|where to)\b/i;

/**
 * Search footprints, each named so its real yield can be measured and learned.
 * `{t}` = site topic, `{k}` = the asset's key phrase.
 */
export const FOOTPRINTS={
  intent:'{k}', resources:'{t} resources', intitle_resources:'intitle:resources {t}', useful_links:'{t} "useful links"',
  tools:'{t} tools', free_tools:'free {t} tools', best_resources:'best {t} resources', useful_websites:'{t} useful websites',
  statistics:'{t} statistics', research_resources:'{t} research resources', sources:'{t} sources',
  blogs_to_follow:'{t} blogs to follow', recommended_reading:'{t} recommended reading',
  inurl_resources:'{t} inurl:resources', inurl_links:'{t} inurl:links', best_guides:'best {k} guides', k_resources:'{k} resources',
  // Curated link pages and roundups exist to link out: highest acceptance for new resources.
  link_roundup:'{t} "link roundup"', weekly_roundup:'{t} "weekly roundup"', best_of_web:'{t} "best of the web"',
  further_reading:'{k} "further reading"', helpful_resources:'{k} "helpful resources"', recommended_tools:'{t} "recommended tools"',
  // Long-tail: built from the promoted page's own distinctive phrases ({b}), so searches reach past the
  // same top-20 sites that every short topic query returns (discovery saturated on those in Nov 2026).
  phrase_resources:'"{b}" resources', phrase_links:'"{b}" "useful links"', phrase_blog:'"{b}" blog',
};
const PHRASE_FPS=['phrase_resources','phrase_links','phrase_blog'];
/** Distinctive two-word phrases from the page's own top terms (not the site topic itself). */
export function assetPhrases(asset,site,max=3){
  const topic=new Set(tokens(site?.topic||''));
  return (asset.terms||[]).filter(t=>/^[a-z0-9]+ [a-z0-9]+$/.test(t)&&!t.split(' ').every(w=>topic.has(w))).slice(0,max);
}
const BY_TYPE={
  interactive_tool:['intent','tools','free_tools','best_resources','intitle_resources','useful_websites','inurl_resources','k_resources','recommended_tools','helpful_resources','link_roundup'],
  methodology:['intent','statistics','research_resources','intitle_resources','sources','inurl_resources','further_reading','helpful_resources'],
  research_candidate:['intent','statistics','research_resources','intitle_resources','sources','inurl_resources','further_reading','helpful_resources'],
  default:['intent','resources','intitle_resources','useful_links','k_resources','inurl_resources','inurl_links','best_guides','blogs_to_follow','recommended_reading','further_reading','helpful_resources','link_roundup','weekly_roundup','best_of_web'],
};
export function queriesFor(asset,site){
  const k=keyPhrase(asset.h1||asset.title,4)||site.topic,t=site.topic;
  const seen=new Set(),out=[];
  for(const fp of BY_TYPE[asset.type]||BY_TYPE.default){
    const q=FOOTPRINTS[fp].replace('{t}',t).replace('{k}',k).trim();
    if(q.length>3&&!seen.has(q)){seen.add(q);out.push({q,fp})}
  }
  for(const b of assetPhrases(asset,site))for(const fp of PHRASE_FPS){
    const q=FOOTPRINTS[fp].replace('{b}',b);if(!seen.has(q)){seen.add(q);out.push({q,fp})}
  }
  return out;
}
/** Best guess of the footprint behind an older query string (before footprints were recorded). */
export function footprintOf(query,site){
  for(const [fp,tpl] of Object.entries(FOOTPRINTS)){if(fp==='intent')continue;
    const re=new RegExp('^'+tpl.replace(/[.*+?^$()|[\]\\]/g,'\\$&').replace('\\{t\\}',`(${site?.topic?.replace(/[.*+?^$()|[\]\\]/g,'\\$&')||'.+'})`).replace(/\{t\}|\{k\}|\{b\}/g,'.+')+'$','i');
    if(re.test(query))return fp}
  if(/^linkgap:/.test(query))return 'link_gap';
  return /^"[^"]+"( OR "[^"]+")? -site:/.test(query)?'mention':'intent';
}
/**
 * Learned yield per footprint: how many ready-to-pitch prospects each search produced.
 * Bayesian mean (ready+1)/(queries+3) so new footprints are tried and dead ones fade.
 */
export function footprintYield(state,sites){
  const bySite=new Map(sites.map(s=>[s.domain,s])),y={};
  const row=fp=>y[fp]??={queries:0,ready:0};
  for(const key of Object.keys(state.queries||{})){const [site,...q]=key.split('|');row(footprintOf(q.join('|'),bySite.get(site))).queries++}
  for(const p of Object.values(state.prospects||{}))if(p.email&&['ready','sent','followed_up','replied','positive','won'].includes(p.status))row(p.footprint||footprintOf(p.query||'',bySite.get(p.site))).ready++;
  for(const v of Object.values(y))v.rate=(v.ready+1)/(v.queries+3);
  return y;
}

/** How many of this asset's searches are not on cooldown (0 = nothing new to search for it). */
export function freshQueryCount(asset,site,state,{reuseDays=45}={}){
  if(!site)return 0;
  return queriesFor(asset,site).filter(x=>ageDays(state.queries?.[`${asset.site}|${x.q}`])>reuseDays).length;
}

/** Choose the most productive unused queries per asset (untried footprints get a fair chance). */
export function pickQueries(assets,sites,state,{perAsset=2,reuseDays=45}={}){
  state.queries??={};
  const bySite=new Map(sites.map(s=>[s.domain,s])),out=[],yieldBy=footprintYield(state,sites);
  // Rank by pitchable yield x novelty (share of results that are sites never evaluated before).
  const nov=fp=>{const x=state.fp_novelty?.[fp];return x?(x.n+1)/(x.q+2):0.5};
  const score=fp=>(yieldBy[fp]?.rate??1/3)*nov(fp);
  for(const a of assets){
    const fresh=queriesFor(a,bySite.get(a.site)).filter(x=>ageDays(state.queries[`${a.site}|${x.q}`])>reuseDays)
      .sort((x,y)=>score(y.fp)-score(x.fp));
    for(const x of fresh.slice(0,perAsset))out.push({asset:a,query:x.q,footprint:x.fp});
  }
  return out;
}

/* ---------- Unlinked brand mentions: pages that already talk about us but don't link ---------- */
export const brandOf=site=>site.brand||site.domain.split('.')[0];
/** One mention search per site every 14 days. */
export function mentionJobs(sites,state,{everyDays=14}={}){
  state.mentions_at??={};state.queries??={};
  // Keyed by the exact query, so an improved query runs right away instead of waiting out the old one.
  return sites.filter(s=>brandOf(s).length>=5)
    .map(s=>({site:s,query:`"${brandOf(s)}" OR "${s.domain}" -site:${s.domain}`}))
    .filter(j=>ageDays(state.queries[`${j.site.domain}|${j.query}`])>everyDays);
}
export function mentionsUs(html,site){
  const text=mainText(html).toLowerCase(),b=brandOf(site).toLowerCase();
  return text.includes(site.domain)||text.includes(b)||text.includes(b.replace(/([a-z])(?=(up|to|for|fit|grow|gone|guide|hub|lab|app)\b)/g,'$1 '));
}

export function knownDomain(state,site,domain){
  return !!(state.domains?.[`${site}|${domain}`]||state.suppression?.[domain]||state.contacted?.[domain]);
}

export function qualifyPage(url,html,{asset,site,ourDomains,provenLinker=false}){
  const title=tagText(html,'title')[0]||'',h1=tagText(html,'h1')[0]||'',h2=tagText(html,'h2').slice(0,30);
  const text=mainText(html);
  const outs=links(html,url),host=hostOf(url);
  const ext=new Set();let linksToUs=null;
  for(const l of outs){const h=hostOf(l.url);if(!h||sameSite(h,host))continue;ext.add(rootDomain(h));
    if(!linksToUs&&ourDomains.some(d=>sameSite(h,d)))linksToUs=l}
  const pageTerms=new Set(tokens(`${title} ${h1} ${h2.join(' ')} ${text.slice(0,20000)}`));
  const want=[...new Set(tokens(`${site.topic} ${keyPhrase(asset.h1||asset.title,4)}`))];
  const matched=want.filter(w=>pageTerms.has(w));
  const relevance=want.length?matched.length/want.length:0;
  const resource=RESOURCE.test(`${title} ${h1} ${new URL(url).pathname.replace(/[-_/]/g,' ')}`);
  const ld=jsonLd(html);
  const ecommerce=ld.some(x=>/^(Product|Offer|AggregateOffer)$/.test(String(x['@type'])))||/add to cart|add-to-cart|woocommerce-cart/i.test(html.slice(0,200000));
  const words=text.split(/\s+/).length;
  const fitSection=h2.map(h=>({h,n:tokens(h).filter(w=>want.includes(w)).length})).sort((a,b)=>b.n-a.n)[0];
  const authorRaw=ld.map(x=>x.author).find(Boolean);
  const author=String((Array.isArray(authorRaw)?authorRaw[0]:authorRaw)?.name||authorRaw||'').trim();
  const year=Math.max(0,...[...text.matchAll(/\b(20[12]\d)\b/g)].map(m=>Number(m[1])).filter(y=>y<=new Date().getUTCFullYear()));
  // A page that already links to a competing resource from its content has shown it adds links like ours.
  let score=Math.round(relevance*55+Math.min(20,ext.size*1.2)+(resource?15:0)+(provenLinker?12:0)+(fitSection?.n?5:0)+(year>=new Date().getUTCFullYear()-1?5:0));
  const reasons=[];
  if(ecommerce){score=0;reasons.push('Store/product page')}
  if(words<250){score=Math.min(score,30);reasons.push('Thin page')}
  if(ext.size<3){score=Math.min(score,35);reasons.push('Rarely links out')}
  if(relevance<.34)reasons.push('Weak topical match');
  return {title:title.slice(0,180),h1:h1.slice(0,180),relevance:Number(relevance.toFixed(2)),matched,external_domains:ext.size,resource_page:resource,
    score,qualified:score>=45&&relevance>=.34&&ext.size>=3&&!ecommerce,linksToUs,fit_section:fitSection?.n?fitSection.h:null,
    author:/^[A-Za-z][A-Za-z .'-]{1,40}$/.test(author)&&!/admin|staff|team|editor/i.test(author)?author:null,
    excerpt:text.slice(0,1800),reasons,last_year_mentioned:year||null};
}

/** Find the best contact on the publisher's site within a few fetches. */
/**
 * What kind of site is this? Software vendors and local service businesses rarely
 * link to a third-party resource (and are often competitors), so they're skipped.
 */
export function siteKind(html){
  const text=stripTags(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi,' ')).slice(0,40000);
  const types=jsonLd(html).flatMap(x=>[].concat(x['@type']||[])).map(String);
  if(types.some(t=>/LocalBusiness|ProfessionalService|HomeAndConstructionBusiness|PestControl|Plumber|Electrician|Contractor|HVACBusiness|Dentist|LegalService|AutoRepair|MedicalBusiness/.test(t))||
    /\bfree (inspection|estimate|quote)\b|\bcall (us )?(now|today)\b|\bservice areas?\b|\bschedule (an? )?(appointment|service|inspection)\b|\blicensed (and|&) insured\b/i.test(text))return 'local_business';
  const pricing=links(html,'https://site.invalid/').some(l=>/\/pricing\b|\/plans\b/i.test(l.url)||/^pricing$/i.test(l.anchor));
  if(pricing&&/\b(start (your |a )?free trial|sign up (for )?free|get started (for )?free|book a demo|request a demo|try (it )?(for )?free|start for free)\b/i.test(text))return 'software_vendor';
  return 'publisher';
}

export async function findContact(pageUrl,pageHtml,{fetchImpl=fetch,author=''}={}){
  const origin=new URL(pageUrl).origin,domain=hostOf(pageUrl);
  const candidates=new Map();let form=null,kind='publisher';
  const take=(html,url,source)=>{for(const e of extractEmails(html)){const r=rankEmail(e,domain,{source,author});if(r>=0&&!(candidates.get(e)?.rank>=r))candidates.set(e,{email:e,rank:r,source:url})}
    if(!form&&source!=='other'&&/<form\b[\s\S]{0,4000}<textarea\b/i.test(html))form=url};
  take(pageHtml,pageUrl,'page');
  // The homepage is always fetched: it tells us what kind of site this is.
  const home=await fetchPage(origin+'/',{fetchImpl,timeout:9000,maxBytes:300000});
  if(home.status===200&&home.body){kind=siteKind(home.body);take(home.body,home.url,'other')}
  if(kind==='local_business')return {email:null,email_source:null,alternates:[],contact_form:null,site_kind:kind};
  // Contact pages the site itself links to (article first, then the homepage menu/footer) beat guessed paths;
  // indie blogs mostly use /contact-me, /about-me or /work-with-me rather than /contact-us.
  const contactLinks=(html,base)=>html?links(html,base).filter(l=>sameSite(hostOf(l.url),domain)&&/contact|about|write-for-us|contribute|work-with-me|get-in-touch/i.test(l.url+' '+l.anchor)&&!/advertis|sponsor|media-kit|partner|privacy|terms|cookie|affiliate-disclosure/i.test(l.url)).map(l=>l.url):[];
  const linked=[...contactLinks(pageHtml,pageUrl).slice(0,3),...(home.status===200?contactLinks(home.body,home.url).slice(0,3):[])];
  const paths=[...new Set([...linked,origin+'/contact',origin+'/contact-us',origin+'/contact-me',origin+'/about',origin+'/about-me',origin+'/work-with-me',origin+'/write-for-us'].map(u=>normUrl(u)).filter(Boolean))].slice(0,7);
  for(const p of paths){
    const best=Math.max(-1,...[...candidates.values()].map(c=>c.rank));if(best>=75)break;
    const res=await fetchPage(p,{fetchImpl,timeout:9000,maxBytes:250000});
    if(res.status===200&&res.body)take(res.body,res.url,'contact');
  }
  const ranked=[...candidates.values()].sort((a,b)=>b.rank-a.rank);
  return {email:ranked[0]?.email||null,email_rank:ranked[0]?.rank??null,email_source:ranked[0]?.source||null,alternates:ranked.slice(1,3).map(x=>x.email),contact_form:form,site_kind:kind};
}

/* ---------- Competitor link gap: pages that already link to a competing resource from their content ---------- */
const CONTENT_LOCATIONS=new Set(['article','main','section','details','']);
/**
 * Competitor targets due for mining: configured competitors first, then domains that keep ranking in
 * this site's own topic searches. Large link profiles are paged (offset) across runs.
 */
export function linkGapTargets(sites,state,{max=1,serpHostMin=2}={}){
  state.linkgap??={};
  const out=[];
  for(const s of sites){
    const auto=Object.entries(state.serp_hosts?.[s.domain]||{})
      .filter(([h,n])=>n>=serpHostMin&&!BLOCKED.test(h)&&!GOVERNMENT.test(h)&&!ACADEMIC.test(h)&&!JUNK_HOST.test(h)&&!sites.some(x=>sameSite(h,x.domain)))
      .sort((a,b)=>b[1]-a[1]).slice(0,6).map(([h])=>h);
    for(const t of [...new Set([...(s.competitors||[]),...auto])]){
      const g=state.linkgap[`${s.domain}|${t}`];
      const more=g&&g.offset<g.total&&ageDays(g.at)<=90;
      if(!g||(more&&ageDays(g.at)>7)||ageDays(g.at)>90)out.push({site:s,target:t,offset:more?g.offset:0,configured:(s.competitors||[]).includes(t)?1:0,last:g?.at||''});
    }
  }
  out.sort((a,b)=>String(a.last).localeCompare(String(b.last))||b.configured-a.configured);
  const per=new Set(),pick=[];
  for(const j of out){if(per.has(j.site.domain))continue;per.add(j.site.domain);pick.push(j);if(pick.length>=max)break}
  return pick;
}
// Words too broad to prove two pages share a subject (beyond the site's own topic words).
const GENERIC=new Set('plant plants care guide guides tips home house indoor easy simple online tool tools calculator free help learn learning practice beginner beginners basics step steps list ideas info information resource resources article blog'.split(' '));
/**
 * Which promoted page answers what the competitor link was about, and how strongly.
 * 'specific': the link context and the page share a specific subject word plus one more word (e.g. "snake plant" + "watering").
 * 'topic': only the site topic matches; offered only for hub pages and tools, and pitched as an extra resource, never "same topic".
 */
export function pairAsset(link,assets,site){
  const ctx=new Set(tokens(`${link.title} ${link.anchor} ${link.text_pre} ${link.text_post} ${(()=>{try{return new URL(link.url_to).pathname.replace(/[-_/.]/g,' ')}catch{return ''}})()}`));
  const topic=new Set(tokens(site.topic));
  let best=null,bestN=0;
  for(const a of assets){if(a.site!==site.domain)continue;
    const want=new Set([...tokens(keyPhrase(a.h1||a.title,6)),...(a.terms||[]).filter(t=>!t.includes(' ')).slice(0,15)]);
    const hit=[...want].filter(w=>ctx.has(w)),specific=hit.filter(w=>!topic.has(w)&&!GENERIC.has(w));
    const n=specific.length?hit.length+specific.length:0;
    if(specific.length&&hit.length>=2&&n>bestN){best=a;bestN=n}}
  if(best)return {asset:best,match:'specific'};
  const hub=assets.find(a=>a.site===site.domain&&(a.type==='interactive_tool'||a.type==='reference'));
  return hub&&[...topic].some(w=>ctx.has(w))?{asset:hub,match:'topic'}:null;
}

/**
 * Run discovery for the chosen assets. Mutates `state.prospects` / `state.domains`.
 * Returns counters for the run report.
 */
export async function discoverProspects({assets,sites,state,dfs,fetchImpl=fetch,resolveHost,perAsset=2,maxNewPerRun=60,maxQueries=24,serpDepth=50,linkGapCalls=1,pairPool=null,deadline=Infinity,log=()=>{}}){
  state.prospects??={};state.domains??={};state.queries??={};
  const ourDomains=sites.map(s=>s.domain),competitors=new Set(sites.flatMap(s=>s.competitors||[]));
  const bySite=new Map(sites.map(s=>[s.domain,s]));
  // Brand-mention searches go first: editors who already mention us convert best.
  const mentions=mentionJobs(sites,state).map(m=>({query:m.query,footprint:'mention',kind:'mention',
    asset:{site:m.site.domain,url:`https://${m.site.domain}/`,title:brandOf(m.site),type:'brand'}}));
  const jobs=[...mentions,...pickQueries(assets,sites,state,{perAsset})];
  const stats={queries:0,mention_queries:0,serp_results:0,candidates:0,qualified:0,mentions:0,already_linked:0,rejected:0,with_email:0,contact_form:0,broken_links:0};
  // Paid search results are never thrown away: candidates a previous run could not qualify in time come first.
  const fresh=(state.candidate_queue||[]).filter(c=>ageDays(c.queued_at)<14&&bySite.has(c.site)&&!knownDomain(state,c.site,c.domain));
  stats.from_queue=fresh.length;state.candidate_queue=[];
  state.serp_hosts??={};state.unresolved??={};
  for(const [d,t] of Object.entries(state.unresolved))if(ageDays(t)>30)delete state.unresolved[d];
  /** Shared admission rules for every discovery source; returns false (and counts why) when a result is dropped. */
  const admit=(site,domain,path,drop)=>{
    if(!domain){drop('no_domain');return false}
    if(BLOCKED.test(domain)||JUNK_HOST.test(domain)){drop('platform_or_giant');return false}
    if(GOVERNMENT.test(domain)||ACADEMIC.test(domain)){drop('gov_or_edu');return false}
    if(ourDomains.some(d=>sameSite(domain,d))){drop('own_site');return false}
    if(competitors.has(domain)){drop('competitor');return false}
    if(UGC.test(path)){drop('forum_or_ugc');return false}
    if(state.domains?.[`${site.domain}|${domain}`]){drop('already_evaluated');return false}
    if(state.suppression?.[domain]||state.contacted?.[domain]){drop('contacted_or_suppressed');return false}
    if(state.unresolved[domain]){drop('page_unresolvable_recently');return false}
    if(fresh.some(f=>f.domain===domain&&f.site===site.domain)){drop('duplicate_this_run');return false}
    return true;
  };
  const dropBy=k=>{stats.filtered??={};stats.filtered[k]=(stats.filtered[k]||0)+1};
  // ---- Competitor link gap first: one Backlinks call yields up to 200 proven in-niche linkers (≈$0.03). ----
  stats.linkgap_calls=0;stats.linkgap_candidates=0;
  if(typeof dfs.backlinks==='function'&&linkGapCalls>0&&fresh.length<150){
    for(const job of linkGapTargets(sites,state,{max:linkGapCalls})){
      if(Date.now()>=deadline||!dfs.canSpend('backlinks'))break;
      const r=await dfs.backlinks(job.target,{offset:job.offset});
      if(!r){stats.linkgap_failed=(stats.linkgap_failed||0)+1;continue}
      stats.linkgap_calls++;
      state.linkgap[`${job.site.domain}|${job.target}`]={at:NOW(),offset:job.offset+r.items.length,total:r.total};
      state.queries[`${job.site.domain}|linkgap:${job.target}:${job.offset}`]=NOW();
      const before=fresh.length;
      for(const l of r.items){
        const domain=rootDomain(l.domain_from||hostOf(l.url_from));let path='';
        try{path=new URL(l.url_from).pathname}catch{dropBy('bad_url');continue}
        if(!CONTENT_LOCATIONS.has(l.location)){dropBy('sitewide_or_sidebar_link');continue}
        if(l.spam!=null&&l.spam>30){dropBy('spam_score');continue}
        if(l.external_links!=null&&l.external_links<3){dropBy('rarely_links_out');continue}
        if(!admit(job.site,domain,path,dropBy))continue;
        const pair=pairAsset(l,pairPool||assets,job.site);if(!pair){dropBy('off_topic_link');continue}
        const asset=pair.asset;
        fresh.push({site:job.site.domain,domain,url:normUrl(l.url_from),serp_title:l.title,query:`linkgap:${job.target}`,footprint:'link_gap',kind:'linkgap',rank:null,
          asset:{site:asset.site,url:asset.url,title:asset.title,h1:asset.h1,type:asset.type,terms:(asset.terms||[]).slice(0,30)},
          competitor_link:{url:l.url_to,host:hostOf(l.url_to),anchor:String(l.anchor||'').slice(0,120),context:`${l.text_pre} … ${l.text_post}`.replace(/\s+/g,' ').trim().slice(0,300),dead:!!l.broken_to,match:pair.match}});
      }
      stats.linkgap_candidates+=fresh.length-before;
      log(`link gap: ${job.target} (for ${job.site.domain}) ${r.items.length} referring pages from offset ${job.offset}/${r.total}, ${fresh.length-before} new candidates`);
    }
  }
  // Searches get at most 40% of the time left, so their results can still be qualified in this run.
  const serpUntil=Number.isFinite(deadline)?Date.now()+Math.max(0,deadline-Date.now())*0.4:Infinity;
  const take=(job,results)=>{
    const site=bySite.get(job.asset.site);
    state.queries[`${site.domain}|${job.query}`]=NOW();stats.queries++;stats.serp_results+=results.length;
    if(job.kind==='mention'){state.mentions_at[site.domain]=NOW();stats.mention_queries++}
    const asset={site:job.asset.site,url:job.asset.url,title:job.asset.title,h1:job.asset.h1,type:job.asset.type,terms:(job.asset.terms||[]).slice(0,30)};
    const before=fresh.length;state.fp_novelty??={};
    const drop=dropBy;
    const hosts=state.serp_hosts[site.domain]??={};
    for(const r of results){
      const domain=rootDomain(r.domain||hostOf(r.url));
      // Every dropped result is counted by reason, so a stalled pipeline shows exactly where (published, no URLs).
      // Wrapped Google results have no URL yet: their path comes from the breadcrumb and the page is resolved before qualifying.
      let path='';
      if(r.url){try{path=new URL(r.url).pathname}catch{drop('bad_url');continue}}else path='/'+(r.crumb?.segments||[]).join('/')+'/';
      // Domains that keep ranking for this site's own topic are its real competitors: their backlinks get mined.
      if(job.kind!=='mention'&&domain&&!BLOCKED.test(domain)&&!ourDomains.some(d=>sameSite(domain,d))&&Object.keys(hosts).length<400)hosts[domain]=(hosts[domain]||0)+1;
      if(!admit(site,domain,path,drop))continue;
      fresh.push({site:site.domain,domain,url:r.url?normUrl(r.url):null,goto:r.goto||null,crumb:r.crumb||null,serp_title:r.title,query:job.query,footprint:job.footprint,kind:job.kind||'resource',rank:r.rank,asset});
    }
    // Novelty learning: how many never-seen sites each search pattern still finds (old data halves over time).
    const nv=state.fp_novelty[job.footprint]??={q:0,n:0};if(nv.q>=40){nv.q/=2;nv.n/=2}nv.q++;nv.n+=Math.min(1,(fresh.length-before)/3);
    stats.new_domains=(stats.new_domains||0)+(fresh.length-before);
  };
  // Live SERPs take ~10 s each: run them 4 at a time (never more than the spend cap allows).
  for(let i=0;i<jobs.length;){
    // A full candidate list stops topic searches, never the (fortnightly, highest-converting) brand-mention searches.
    if(Date.now()>=serpUntil||Date.now()>=deadline||stats.queries>=maxQueries||(fresh.length>=maxNewPerRun*2&&jobs[i].kind!=='mention'))break;
    const n=Math.min(4,maxQueries-stats.queries,jobs.length-i,dfs.affordable?dfs.affordable('serp'):(dfs.canSpend('serp')?1:0));
    if(n<=0)break;
    const batch=jobs.slice(i,i+n);i+=n;
    const results=await Promise.all(batch.map(j=>dfs.serp(j.query,{depth:serpDepth})));
    batch.forEach((job,k)=>{if(results[k]===null)stats.failed_queries=(stats.failed_queries||0)+1;else take(job,results[k])}); // provider error: retried next run
  }
  // One cheap request sizes every new candidate domain; drop giants and dead sites before fetching anything.
  const unsized=[...new Set(fresh.filter(f=>!('etv' in f)).map(f=>f.domain))];
  const traffic=unsized.length&&dfs.canSpend('traffic')?await dfs.domainTraffic(unsized):null;
  if(traffic)for(let i=fresh.length-1;i>=0;i--){
    if('etv' in fresh[i])continue;
    const why=trafficVerdict(traffic[fresh[i].domain],fresh[i].kind);
    if(why){const f=fresh[i],id=hashId(`${f.site}|${f.url}`);state.prospects[id]={id,site:f.site,domain:f.domain,page_url:f.url,asset_url:f.asset.url,asset_title:f.asset.title,query:f.query,found_at:NOW(),history:[],status:'rejected',reason:why,etv:traffic[f.domain],qv:QUALIFY_VERSION};
      state.domains[`${f.site}|${f.domain}`]=id;stats.rejected++;fresh.splice(i,1)}
    else fresh[i].etv=traffic[fresh[i].domain]??null;
  }
  stats.candidates=fresh.length;
  const checked=await pool(fresh.slice(0,maxNewPerRun*2),6,async c=>{
    if(Date.now()>deadline)return {deferred:c};
    let url=c.url,res=null;
    if(!url){
      const found=await resolveWrapped({...c,title:c.serp_title},{fetchImpl}).catch(()=>null);
      if(!found){state.unresolved[c.domain]=NOW();return {unresolved:c}}
      url=found.url;res=found.page||null;stats.resolved=(stats.resolved||0)+1;(stats.resolved_via??={})[found.via]=(stats.resolved_via[found.via]||0)+1;
    }
    res??=await fetchPage(url,{fetchImpl,timeout:12000,maxBytes:500000});
    const id=hashId(`${c.site}|${url}`);
    const base={id,site:c.site,domain:c.domain,page_url:url,asset_url:c.asset.url,asset_title:c.asset.title,query:c.query,footprint:c.footprint,kind:c.kind,serp_rank:c.rank,etv:c.etv??null,found_at:NOW(),history:[],
      ...(c.competitor_link?{competitor_link:c.competitor_link}:{})};
    if(res.status!==200||!res.body)return {...base,status:'rejected',reason:`HTTP ${res.status||res.error}`};
    const site=bySite.get(c.site),mention=c.kind==='mention';
    const q=qualifyPage(res.url,res.body,{asset:c.asset,site,ourDomains,provenLinker:c.kind==='linkgap'});
    const rec={...base,page_url:normUrl(res.url)||url,title:q.title||c.serp_title,score:q.score,relevance:q.relevance,external_domains:q.external_domains,
      resource_page:q.resource_page,fit_section:q.fit_section,author:q.author,excerpt:q.excerpt,last_year_mentioned:q.last_year_mentioned};
    if(q.linksToUs)return {...rec,status:'already_linked',reason:'Already links to us',existing_link:{url:q.linksToUs.url,anchor:q.linksToUs.anchor,rel:q.linksToUs.rel}};
    // A mention is relevant by definition; it only has to really name us (search engines are fuzzy).
    if(mention){if(!mentionsUs(res.body,site))return {...rec,status:'rejected',reason:'Brand not actually mentioned'};rec.score=Math.max(rec.score,70)}
    else if(!q.qualified)return {...rec,status:'rejected',reason:q.reasons.join('; ')||'Low fit score'};
    if(Date.now()>deadline)return {deferred:c};
    const contact=await findContact(rec.page_url,res.body,{fetchImpl,author:q.author});
    // Vendors that mention us may still link; for cold pitches they're competitors.
    if(contact.site_kind==='local_business'||(contact.site_kind==='software_vendor'&&!mention))return {...rec,qv:QUALIFY_VERSION,status:'rejected',reason:contact.site_kind==='software_vendor'?'Software vendor (competing product)':'Local service business'};
    const status=contact.email?'ready':contact.contact_form?'contact_form':'no_contact';
    // A dead link on their page that our asset replaces is the strongest reason for an editor to reply.
    let broken=null;
    if(status!=='no_contact'&&!mention&&Date.now()<deadline)broken=await findBrokenLink(res.body,rec.page_url,{terms:assetTerms(c.asset,site),ourDomains,fetchImpl,resolveHost,deadline}).catch(()=>null);
    return {...rec,...contact,qv:QUALIFY_VERSION,status,broken_link:broken,broken_checked_at:NOW()};
  });
  // Anything not qualified this run (time or volume) is queued for the next one.
  const deferred=[...checked.filter(x=>x?.deferred).map(x=>x.deferred),...fresh.slice(maxNewPerRun*2)];
  state.candidate_queue=deferred.slice(0,300).map(c=>({...c,queued_at:c.queued_at||NOW()}));stats.deferred=state.candidate_queue.length;
  for(const p of checked){
    if(p?.unresolved){stats.unresolved=(stats.unresolved||0)+1;continue}
    if(!p||p.error||p.deferred)continue;
    if(p.status==='rejected'||p.status==='already_linked')delete p.excerpt;
    state.prospects[p.id]=p;state.domains[`${p.site}|${p.domain}`]=p.id;
    if(p.status==='already_linked')stats.already_linked++;
    else if(p.status==='rejected')stats.rejected++;
    else{stats.qualified++;if(p.kind==='mention')stats.mentions++;if(p.email)stats.with_email++;else if(p.contact_form)stats.contact_form++;if(p.broken_link)stats.broken_links++}
  }
  log(`prospects: ${stats.from_queue} from the saved queue, ${stats.deferred} saved for next run; ${stats.linkgap_calls} competitor link-gap pulls (${stats.linkgap_candidates} candidates); ${stats.queries} queries (${stats.mention_queries} brand-mention), ${stats.resolved||0} Google-wrapped results resolved, ${stats.unresolved||0} unresolvable; ${stats.candidates} candidates, ${stats.qualified} qualified (${stats.mentions} unlinked mentions), ${stats.with_email} with email, ${stats.broken_links} with a dead link we can replace, ${stats.already_linked} already linking`);
  return stats;
}

/**
 * Re-check prospects found under older rules before anyone is emailed (again).
 * Queued ones are re-qualified (new contact or rejected); already-emailed ones
 * that fail the current rules get no follow-up.
 */
export async function requalify({state,dfs,fetchImpl=fetch,deadline=Infinity,log=()=>{}}){
  const due=Object.values(state.prospects||{}).filter(p=>(p.qv||1)<QUALIFY_VERSION&&['ready','contact_form','no_contact','sent'].includes(p.status));
  const stats={checked:0,rejected:0,no_followup:0,recontacted:0};
  if(!due.length)return stats;
  const traffic=dfs.canSpend('traffic')?await dfs.domainTraffic([...new Set(due.map(p=>p.domain))]):null;
  const fail=(p,reason)=>{if(p.status==='sent'){p.no_followup=true;p.no_followup_reason=reason;stats.no_followup++}else{p.status='rejected';p.reason=reason;stats.rejected++}};
  await pool(due,4,async p=>{
    if(Date.now()>deadline)return;
    stats.checked++;p.qv=QUALIFY_VERSION;
    if(traffic){p.etv=traffic[p.domain]??null;const why=trafficVerdict(p.etv);if(why)return fail(p,why)}
    if(ACADEMIC.test(p.domain))return fail(p,'University site');
    const res=await fetchPage(p.page_url,{fetchImpl,timeout:12000,maxBytes:500000});
    if(res.status!==200||!res.body)return p.status==='sent'?null:fail(p,`HTTP ${res.status||res.error}`);
    const c=await findContact(p.page_url,res.body,{fetchImpl,author:p.author});
    if(c.site_kind!=='publisher')return fail(p,c.site_kind==='software_vendor'?'Software vendor (competing product)':'Local service business');
    if(p.status==='sent'){if(!c.email||(c.email!==p.email&&!c.alternates.includes(p.email)))fail(p,'Emailed address no longer passes inbox rules');return}
    Object.assign(p,{email:c.email,email_source:c.email_source,alternates:c.alternates,contact_form:c.contact_form,site_kind:c.site_kind});
    p.status=c.email?'ready':c.contact_form?'contact_form':'no_contact';if(c.email)stats.recontacted++;
  });
  log(`requalify: ${stats.checked} re-checked, ${stats.rejected} dropped, ${stats.no_followup} follow-ups cancelled, ${stats.recontacted} still ready`);
  return stats;
}

/**
 * Look for replaceable dead links on queued prospects found before broken-link
 * detection existed (or not re-checked for 30 days). Free: plain page fetches only.
 */
export async function enrichBrokenLinks({state,assets,sites,fetchImpl=fetch,resolveHost,max=25,deadline=Infinity,log=()=>{}}){
  const assetBy=new Map(assets.map(a=>[a.url,a])),siteBy=new Map(sites.map(s=>[s.domain,s])),ourDomains=sites.map(s=>s.domain);
  const due=Object.values(state.prospects||{}).filter(p=>['ready','contact_form'].includes(p.status)&&p.kind!=='mention'&&!(p.history||[]).some(h=>h.type==='initial')&&ageDays(p.broken_checked_at)>30)
    .sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,max);
  const stats={checked:0,found:0};
  await pool(due,4,async p=>{
    if(Date.now()>deadline)return;
    const site=siteBy.get(p.site),asset=assetBy.get(p.asset_url)||{url:p.asset_url,title:p.asset_title||''};
    const res=await fetchPage(p.page_url,{fetchImpl,timeout:12000,maxBytes:500000});
    stats.checked++;p.broken_checked_at=NOW();
    if(res.status!==200||!res.body)return;
    p.broken_link=await findBrokenLink(res.body,p.page_url,{terms:assetTerms(asset,site),ourDomains,fetchImpl,resolveHost,deadline}).catch(()=>null);
    if(p.broken_link)stats.found++;
  });
  log(`broken links: ${stats.checked} queued pages scanned, ${stats.found} with a dead link our page can replace`);
  return stats;
}
