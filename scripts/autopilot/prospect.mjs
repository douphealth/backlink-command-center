/**
 * Prospect discovery and qualification.
 * 1. Generate intent + resource-page queries for each promoted asset.
 * 2. Pull SERPs (DataForSEO), drop platforms/competitors/known domains.
 * 3. Fetch each page, score topical fit and "links out to resources" behaviour,
 *    detect existing links to us, and find the best editorial contact.
 */
import {fetchPage,pool,tokens,keyPhrase,links,tagText,jsonLd,mainText,stripTags,extractEmails,rankEmail,hostOf,sameSite,rootDomain,normUrl,hashId,ageDays,metaContent,NOW,DAY} from './util.mjs';
import {findBrokenLink,assetTerms,outboundCandidates,contentHtml} from './broken.mjs';
import {extractEditorialCandidates,pageKind,isSuppressed,POLICY_VERSION} from './recipient-policy.mjs';
import {bestPitchAsset} from './assets.mjs';
import {resolveWrapped} from './serp-unwrap.mjs';
import {readArticle} from './article.mjs';

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
  if(/^neighbor:/.test(query))return 'neighbor';
  if(/^cited:/.test(query))return 'cited_by_us';
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
/** The search market a site's readers are in (DataForSEO location/language). Defaults to the US. */
export const marketOf=site=>({location:Number(site?.market?.location)||2840,language:site?.market?.language||'en'});
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

/**
 * Auto-generated pages about a domain (worth/traffic estimates, whois, "is it legit/down", "sites like")
 * mention every new site but have no editor who would add a link: never thank them for a "mention".
 */
const SITE_INFO_HOST=/(^|\.)(siteprice|sitelike|similarsites|hypestat|statshow|websiteoutlook|site-analyzer|webstatsdomain|siteindices|scamadviser|scam-detector|scamdoc|isitdownrightnow|downforeveryoneorjustme|downdetector|whois|domaintools|sitechecker|seoptimer|website-informer|webrate|robtex|urlscan|builtwith|wappalyzer|siteworthtraffic|worthofweb|websiteiq|ranking|sur\.ly|validin|similarweb|semrush|ahrefs|crunchbase)\.[a-z.]+$/i;
const SITE_INFO_TEXT=/\b(?:website (?:worth|value|valuation|traffic)|(?:site|domain) (?:worth|value|valuation|age|info(?:rmation)?|report|analysis)|traffic (?:estimate|analysis|stats)|whois|is (?:it |this )?(?:legit|a scam)|is [a-z0-9-]+\.[a-z.]{2,} (?:legit|safe|a scam|down|up)|scam (?:check|score)|trust score|(?:similar|related) (?:sites|websites)|sites like|seo (?:report|score|analysis|audit))\b/i;
export function siteInfoPage(url,title=''){
  let host='',path='';try{const u=new URL(url);host=u.hostname;path=decodeURIComponent(u.pathname).replace(/[-_/]+/g,' ')}catch{}
  return SITE_INFO_HOST.test(host)||SITE_INFO_TEXT.test(`${title} ${path}`);
}

export function knownDomain(state,site,domain){
  return !!(state.domains?.[`${site}|${domain}`]||state.suppression?.[domain]||state.contacted?.[domain]);
}

/* ---------- Lists, roundups and the matched section: what an editor would edit ---------- */
/** "Best X", "top 10", roundups and resource lists: pages whose job is naming outside resources. */
const LIST_TITLE=/\b(?:best|top\s*\d+|\d+\s+(?:best|top|great|useful|essential|free|popular|favou?rite|recommended|must-have)|round-?up|list of|resources|tools|apps|blogs|websites|sites|alternatives|picks)\b/i;
/** A section where additions naturally go ("other notable", "honourable mentions"). */
const OTHER_SECTION=/\b(?:other notable|honou?rable mentions?|also (?:worth|consider)|more (?:tools|resources|options|picks|reading)|other (?:options|tools|resources|picks))\b/i;
const OWN_PRODUCT_PATH=/\/(?:products?|features?|solutions?|services?|pricing|plans|shop|store|apps?|integrations?|templates?)(?:\/|$)/i;
// Link text that only appears where spam was injected into a hacked page.
const SPAM_ANCHOR=/\b(?:viagra|cialis|levitra|online casino|casino online|slots? online|online slots?|judi|togel|poker online|payday loans?|replica (?:watches|bags)|essay writing service|buy (?:followers|likes))\b/i;
const clip=(t,n)=>t.length<=n?t:t.slice(0,n).replace(/\s+\S*$/,'');
/**
 * Is this a list or roundup with entries from several outside companies (skill steps 1-2)? `ownOnly`: every entry is
 * the publisher's own product (a vendor ranking itself), which never adds a third party. `items`: outside sites named in the content.
 */
export function listShape(html,url,title=''){
  const content=contentHtml(html),host=hostOf(url),label=host.split('.')[0];
  const site=String(metaContent(html,'og:site_name')||'').toLowerCase().trim();
  const items=new Set(outboundCandidates(html,url,{max:200}).map(o=>hostOf(o.url))).size;
  const heads=[...content.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]\s*>/gi)].map(m=>stripTags(m[1])).filter(Boolean);
  const numbered=heads.filter(h=>/^\s*(?:#\s*)?\d{1,3}\s*[.):\-–—]\s*\S/.test(h)).length;
  const branded=heads.filter(h=>{const t=h.toLowerCase();return (label.length>=4&&t.includes(label))||(site.length>=4&&t.includes(site))}).length;
  const ownLinks=new Set(links(content,url).filter(l=>{const h=hostOf(l.url);if(!h||!(sameSite(h,host)||sameSite(host,h)))return false;try{return OWN_PRODUCT_PATH.test(new URL(l.url).pathname)}catch{return false}}).map(l=>normUrl(l.url))).size;
  const list=LIST_TITLE.test(title)&&(numbered>=3||items>=5);
  return {list,items,numbered,ownOnly:list&&items<=1&&(branded>=3||ownLinks>=3),other_section:heads.some(h=>OTHER_SECTION.test(h))};
}
/**
 * Up to 600 characters of the page's own words where it matches what we pitch: the text after the matched section
 * heading, else the sentences where the wanted words cluster. Gives the pitch writer the exact place an edit could go.
 */
export function fitExcerpt(html,heading,want=[]){
  if(heading){
    for(const m of String(html||'').matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)){
      if(stripTags(m[1])!==heading)continue;
      const rest=html.slice(m.index+m[0].length,m.index+m[0].length+20000),end=rest.search(/<h[12]\b/i);
      const t=stripTags((end>=0?rest.slice(0,end):rest).replace(/<(script|style|noscript|form|aside|nav)\b[\s\S]*?<\/\1\s*>/gi,' '));
      if(t.length>=40)return clip(t,600);break;
    }
  }
  const w=new Set(want),parts=mainText(html).split(/(?<=[.!?])\s+/).slice(0,400);
  let best=-1,bestN=0;parts.forEach((x,i)=>{const n=tokens(x).filter(t=>w.has(t)).length;if(n>bestN){best=i;bestN=n}});
  return best<0?null:clip(parts.slice(best).join(' '),600);
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
  const shape=listShape(html,url,`${title} ${h1}`),list=shape.list&&!shape.ownOnly&&shape.items>=4;
  const compromised=outs.filter(l=>SPAM_ANCHOR.test(l.anchor)).length>=2;
  // A page that already links to a competing resource from its content has shown it adds links like ours;
  // a list naming several outside sites exists to name more of them.
  let score=Math.round(relevance*55+Math.min(20,ext.size*1.2)+(resource?15:0)+(provenLinker?12:0)+(fitSection?.n?5:0)+(year>=new Date().getUTCFullYear()-1?5:0)+(list?5:0));
  const reasons=[];
  if(ecommerce){score=0;reasons.push('Store/product page')}
  if(compromised){score=0;reasons.push('Page looks compromised (injected spam links)')}
  if(shape.ownOnly){score=Math.min(score,30);reasons.push('List of the publisher\'s own products only')}
  if(words<250){score=Math.min(score,30);reasons.push('Thin page')}
  if(ext.size<3){score=Math.min(score,35);reasons.push('Rarely links out')}
  if(relevance<.34)reasons.push('Weak topical match');
  return {title:title.slice(0,180),h1:h1.slice(0,180),relevance:Number(relevance.toFixed(2)),matched,external_domains:ext.size,resource_page:resource,
    score,qualified:score>=45&&relevance>=.34&&ext.size>=3&&!ecommerce&&!compromised&&!shape.ownOnly,linksToUs,fit_section:fitSection?.n?fitSection.h:null,
    fit_excerpt:fitExcerpt(html,fitSection?.n?fitSection.h:null,want),
    list_page:list?{items:shape.items,title:(h1||title).slice(0,180),...(shape.other_section?{other_section:true}:{})}:null,
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

/** Pages where a site publishes how to reach it. Impressum/imprint/kontakt: German-language sites must list an address there. */
const CONTACT_LINK=/contact|about|write-for-us|contribute|work-with-me|get-in-touch|impressum|imprint|kontakt|masthead|editorial-team|our-team|meet-the-team|guest-post|submit-(?:a-)?(?:tip|story|post)/i;
/**
 * A form a reader can use to write to the site. Blog comment, reply, review, search, login and newsletter forms do not count,
 * nor do sales-intake forms (budget, start date, company size): they are not a route for an editorial suggestion.
 */
export function contactForm(html){
  for(const m of String(html||'').matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)){
    const tag=m[1],body=m[2].slice(0,8000);
    if(!/<textarea\b/i.test(body))continue;
    if(/comment|respond|reply|review|search|subscribe|newsletter|login|sign-?in|sign-?up|register/i.test(tag))continue;
    if(/<textarea\b[^>]*(?:name|id)\s*=\s*["']?(?:comment|reply)/i.test(body)||/name\s*=\s*["']comment_(?:post_ID|parent)["']/i.test(body))continue;
    if(/<(?:input|select)\b[^>]*name\s*=\s*["']?[\w\[\]-]*(?:budget|start[_-]?date|timeline|company[_-]?size|project[_-]?type)/i.test(body))continue;
    return true;
  }
  return false;
}
/**
 * The address is chosen by the send gate's own rules (recipient-policy.mjs), so a prospect is 'ready' only with an address that
 * can pass it. Addresses that discovery reads but the gate would hold are reported as `held_email` and never make a prospect ready.
 */
export async function findContact(pageUrl,pageHtml,{fetchImpl=fetch,author=''}={}){
  const origin=new URL(pageUrl).origin,domain=hostOf(pageUrl);
  const candidates=new Map(),held=new Map();let form=null,kind='publisher';
  const take=(html,url,source)=>{
    for(const c of extractEditorialCandidates(html,url,{domain,author:author||'',source:pageKind(url)}))if(!(candidates.get(c.email)?.rank>=c.rank))candidates.set(c.email,{email:c.email,rank:c.rank,role:c.role,source:url});
    for(const e of extractEmails(html)){const r=rankEmail(e,domain,{source,author});if(r>=0&&!(held.get(e)?.rank>=r))held.set(e,{email:e,rank:r,source:url})}
    if(!form&&source!=='other'&&contactForm(html))form=url};
  take(pageHtml,pageUrl,'page');
  // The homepage is always fetched: it tells us what kind of site this is.
  const home=await fetchPage(origin+'/',{fetchImpl,timeout:9000,maxBytes:300000});
  if(home.status===200&&home.body){kind=siteKind(home.body);take(home.body,home.url,'other')}
  if(kind==='local_business')return {email:null,email_source:null,alternates:[],contact_form:null,site_kind:kind};
  // Contact pages the site itself links to (article first, then the homepage menu/footer) beat guessed paths;
  // indie blogs mostly use /contact-me, /about-me or /work-with-me rather than /contact-us.
  const contactLinks=(html,base)=>html?links(html,base).filter(l=>sameSite(hostOf(l.url),domain)&&CONTACT_LINK.test(l.url+' '+l.anchor)&&!/advertis|sponsor|media-kit|partner|privacy|terms|cookie|affiliate-disclosure/i.test(l.url)).map(l=>l.url):[];
  // The article's author page first: a blogger's own address is the best one for a pitch about their article.
  const authorPage=links(pageHtml,pageUrl).find(l=>sameSite(hostOf(l.url),domain)&&/\/(?:author|authors|team|staff|writers?|contributors?)\/[^/?#]+\/?$/i.test(l.url))?.url;
  const linked=[...(authorPage?[authorPage]:[]),...contactLinks(pageHtml,pageUrl).slice(0,3),...(home.status===200?contactLinks(home.body,home.url).slice(0,4):[])];
  const paths=[...new Set([...linked,origin+'/contact',origin+'/contact-us',origin+'/contact-me',origin+'/about',origin+'/about-us',origin+'/about-me',origin+'/work-with-me',origin+'/write-for-us',origin+'/impressum'].map(u=>normUrl(u)).filter(Boolean))].slice(0,9);
  for(const p of paths){
    const best=Math.max(-1,...[...candidates.values()].map(c=>c.rank));if(best>=85)break; // an editorial inbox or the named author
    const res=await fetchPage(p,{fetchImpl,timeout:9000,maxBytes:250000});
    if(res.status===200&&res.body)take(res.body,res.url,'contact');
  }
  const ranked=[...candidates.values()].sort((a,b)=>b.rank-a.rank);
  // Owner rule: a general inbox is a last resort, never offered while an editorial or named-author address exists.
  const usable=ranked.some(c=>c.role!=='contact_page_inbox')?ranked.filter(c=>c.role!=='contact_page_inbox'):ranked;
  const hold=usable.length?null:[...held.values()].sort((a,b)=>b.rank-a.rank)[0];
  return {email:usable[0]?.email||null,email_rank:usable[0]?.rank??null,email_source:usable[0]?.source||null,alternates:usable.slice(1,3).map(x=>x.email),contact_form:form,site_kind:kind,
    ...(hold?{held_email:hold.email,held_source:hold.source}:{})};
}
/** Status of a qualified prospect from its contact lookup: an address the gate would hold is recorded, never queued. */
export function contactStatus(c){return c.email?'ready':c.held_email?'contact_unverifiable':c.contact_form?'contact_form':'no_contact'}
/** Fields a contact lookup writes on a prospect. A held address is kept (sealed vault only) so a later parser version can re-screen it. */
export function contactFields(c,at=NOW()){
  const {held_email,held_source,...rest}=c;
  return c.email||!held_email?rest:{...rest,email:held_email,email_source:held_source,reason:'No verifiable editorial inbox (only_non_editorial_inbox_published)',
    contact_quality:{status:'held',reason:'no_published_editorial_contact',detail:'only_non_editorial_inbox_published',checked_at:at,via:'discovery'},screen_v:POLICY_VERSION};
}

/* ---------- Second look at qualified pages that had no usable address ---------- */
/** Bumped when contact discovery learns to read more (v2: schema.org email, author page, impressum/team pages). */
export const CONTACT_VERSION=2;
/**
 * More than half of all qualified pages end as "contact form only" or "no contact" and were never looked at
 * again. They get one more look whenever contact discovery improves, and otherwise every 60 days (sites add
 * contact pages). This only ever promotes a prospect to ready: nothing is rejected or demoted here, and the
 * address still has to pass the same inbox rules and mailbox verification before anything is sent.
 */
export async function recontact({state,fetchImpl=fetch,deadline=Infinity,max=60,log=()=>{}}){
  const stats={checked:0,found:0,unreachable:0,waiting:0};
  const all=Object.values(state.prospects||{}).filter(p=>(p.status==='contact_form'||p.status==='no_contact')&&p.page_url&&((p.contact_v||1)<CONTACT_VERSION||ageDays(p.contact_checked_at||p.found_at)>60))
    .sort((a,b)=>(b.score||0)-(a.score||0));
  const due=all.slice(0,max);stats.waiting=all.length-due.length;
  await pool(due,4,async p=>{
    if(Date.now()>deadline){stats.waiting++;return}
    const res=await fetchPage(p.page_url,{fetchImpl,timeout:12000,maxBytes:500000});
    p.contact_v=CONTACT_VERSION;p.contact_checked_at=NOW();stats.checked++;
    if(res.status!==200||!res.body){stats.unreachable++;return}
    const c=await findContact(p.page_url,res.body,{fetchImpl,author:p.author});
    if(c.site_kind!=='publisher')return;
    if(!c.email){if(c.contact_form&&p.status==='no_contact'){p.contact_form=c.contact_form;p.status='contact_form'}return} // a held address never promotes
    Object.assign(p,{email:c.email,email_rank:c.email_rank,email_source:c.email_source,alternates:c.alternates,contact_form:c.contact_form||p.contact_form||null,site_kind:c.site_kind,status:'ready',recontacted_at:NOW()});
    stats.found++;
  });
  if(due.length)log(`second look: ${stats.checked} qualified pages without an address re-checked, ${stats.found} now have one (${stats.unreachable} unreachable, ${stats.waiting} waiting for a later cycle)`);
  return stats;
}

/* ---------- Link neighbourhood: sites that pages we already qualified link to (free, no search API) ---------- */
const NEIGHBOR_SOURCE=new Set(['ready','drafted','sent','followed_up','replied','positive','won','already_linked','contact_form','no_contact','contact_unverifiable']);
const NOT_A_PAGE=/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|pptx?)$/i;
/**
 * On-topic pages that link out a lot (resource lists, roundups, guides) were chosen by a human editor in the
 * niche. The sites they recommend are the next prospects, found with plain page fetches: no paid lookup.
 * Each source page is mined once every `everyDays`; at most `perSite` per site per cycle so every site advances.
 */
export function neighborSources(state,sites,{max=12,perSite=2,everyDays=90}={}){
  const ok=new Set(sites.map(s=>s.domain)),taken=new Map(),out=[];
  const all=Object.values(state.prospects||{}).filter(p=>NEIGHBOR_SOURCE.has(p.status)&&ok.has(p.site)&&p.page_url&&(p.external_domains||0)>=5&&ageDays(p.mined_at)>everyDays)
    .sort((a,b)=>(b.resource_page?1:0)-(a.resource_page?1:0)||(b.external_domains||0)-(a.external_domains||0)||(b.score||0)-(a.score||0));
  for(const p of all){const n=taken.get(p.site)||0;if(n>=perSite)continue;taken.set(p.site,n+1);out.push(p);if(out.length>=max)break}
  return out;
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

/* ---------- Rejections that expire: a page can improve and a server can recover; what a publisher is rarely changes ---------- */
/** Days until a rejected publisher may be evaluated again, by kind. Publisher-level rejections never expire. */
export const REJECTION_TTL_DAYS={page:30,transient:14};
/** {kind:'page'|'transient'|'publisher', code} for a rejection reason (codes only, no prospect data). */
export function rejectionKind(reason){
  const r=String(reason||'');
  const http=r.match(/^HTTP (\S+)/);
  if(http){const v=http[1];
    if(/^5\d\d$/.test(v))return {kind:'transient',code:'http_5xx'};
    if(v==='429')return {kind:'transient',code:'http_429'};
    if(/^(?:0|timeout|network|too_many_redirects|redirect_without_location|undefined)$/.test(v))return {kind:'transient',code:v==='timeout'?'timeout':'fetch_error'};
    return {kind:'page',code:/^\d{3}$/.test(v)?`http_${v[0]}xx`:'unsafe_url'}}
  for(const [re,code] of [[/Software vendor/i,'vendor'],[/Local service business/i,'local_business'],[/not in English/i,'language'],[/site-info page/i,'site_info'],
    [/University site/i,'academic'],[/Very large brand|Almost no search traffic/i,'traffic']])if(re.test(r))return {kind:'publisher',code};
  for(const [re,code] of [[/compromised/i,'compromised'],[/own products/i,'own_products_list'],[/Store\/product page/i,'store_page'],[/Brand not actually mentioned/i,'not_mentioned'],
    [/Thin page/i,'thin'],[/Rarely links out/i,'rare_links'],[/Weak topical match/i,'weak_match'],[/Low fit score/i,'low_fit']])if(re.test(r))return {kind:'page',code};
  return {kind:'page',code:'other'};
}
export function noteRejection(state,p,at=NOW()){(state.domain_rejections??={})[`${p.site}|${p.domain}`]={at,...rejectionKind(p.reason)}}
/**
 * Page-level (30 d) and transient (14 d) rejections expire: the publisher may be evaluated again when a discovery source
 * finds it. Publisher-level rejections never expire, and contacted or suppressed publishers always stay blocked.
 * Works from state.domain_rejections (rejected prospect records themselves are pruned after a week).
 */
export function expireRejections(state,now=Date.now()){
  let n=0;
  for(const [key,r] of Object.entries(state.domain_rejections||{})){
    const ttl=REJECTION_TTL_DAYS[r?.kind];if(!ttl)continue;
    const at=Date.parse(r.at);if(Number.isFinite(at)&&(now-at)/DAY<=ttl)continue;
    const domain=key.slice(key.indexOf('|')+1),id=state.domains?.[key],p=id?state.prospects?.[id]:null;
    delete state.domain_rejections[key];
    if(state.contacted?.[domain]||isSuppressed(state,'',domain)||(p&&p.status!=='rejected'))continue;
    if(state.domains)delete state.domains[key];n++;
  }
  return n;
}
/** One-off: rejections recorded before expiry existed (from the rejected records still kept) get an entry, so they can expire too. */
export function backfillRejections(state){
  state.migrations??={};if(state.migrations.rejection_expiry_v1)return 0;
  let n=0;
  for(const p of Object.values(state.prospects||{})){const key=`${p.site}|${p.domain}`;
    if(p.status==='rejected'&&p.site&&p.domain&&state.domains?.[key]===p.id&&!state.domain_rejections?.[key]){noteRejection(state,p,p.found_at||NOW());n++}}
  state.migrations.rejection_expiry_v1=NOW();return n;
}

/* ---------- Free sources: a recommended site's own resource page, and pages our own articles cite ---------- */
const RESOURCE_PATH=/\/(?:(?:[a-z0-9]+-){0,3}(?:resources?|links)|useful-(?:resources|sites)|recommended(?:-[a-z]+)?|tools|toolkit|reading-list|further-reading|blogroll|favou?rite-(?:blogs|sites|tools)|best-of)(?:\.html?)?\/?$/i;
const RESOURCE_ANCHOR=/^(?:resources?|useful (?:links|resources|sites)|links|recommended(?: reading| tools| resources| sites)?|tools|toolkit|reading list|further reading|blogroll)$/i;
/**
 * A site recommended by a page we qualified is often linked by its homepage or one article, neither of which is where an editor
 * adds resources. Its own resource/links page is: the one its pages link to, else the best match in its sitemap.
 * At most `maxFetches` (2) extra page fetches; returns the fetched page or null.
 */
export async function probeResourcePage(url,html,{fetchImpl=fetch,domain,terms=[],maxFetches=2}={}){
  let fetches=0;const want=new Set(terms),here=normUrl(url);
  const get=async(u,accept)=>{if(fetches>=maxFetches)return null;fetches++;const r=await fetchPage(u,{fetchImpl,timeout:10000,maxBytes:accept?1_000_000:500000,...(accept?{accept}:{})});
    return r.status===200&&r.body&&sameSite(hostOf(r.url),domain)?r:null};
  const path=u=>{try{return new URL(u).pathname}catch{return ''}};
  const linked=links(html,url).filter(l=>sameSite(hostOf(l.url),domain)&&normUrl(l.url)!==here&&(RESOURCE_PATH.test(path(l.url))||RESOURCE_ANCHOR.test(l.anchor.trim())));
  if(linked.length)return get(linked[0].url);
  let origin='';try{origin=new URL(url).origin}catch{return null}
  const map=await get(origin+'/sitemap.xml','application/xml,text/xml');
  if(!map||!/<urlset\b/i.test(map.body))return null;
  const best=[...map.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].slice(0,5000).map(m=>m[1].replace(/&amp;/g,'&'))
    .filter(u=>sameSite(hostOf(u),domain)&&RESOURCE_PATH.test(path(u))&&normUrl(u)!==here)
    .map(u=>({u,n:tokens(path(u).replace(/[-_/.]/g,' ')).filter(w=>want.has(w)).length})).sort((a,b)=>b.n-a.n)[0];
  return best?get(best.u):null;
}
/** Sites with no email sent yet and nothing ready to send: our own pages' outbound editorial links are their first prospects. */
export function citedCandidates(state,sites,crawl,{pitchList=()=>[]}={}){
  const out=[];
  for(const site of sites){
    const mine=Object.values(state.prospects||{}).filter(p=>p.site===site.domain);
    if(mine.some(p=>p.status==='ready'||(p.history||[]).some(h=>h.type==='initial'&&h.mode!=='draft')))continue;
    const list=pitchList(site.domain);if(!list.length)continue; // nothing worth pitching for this site yet
    const seen=new Set();
    for(const pg of (crawl||[]).find(c=>c.site===site.domain)?.pages||[]){
      if(pg.status!==200)continue;const our=pg.final_url||pg.url;
      for(const l of pg.external_links||[]){const d=hostOf(l.url);if(!d||seen.has(d))continue;seen.add(d);
        out.push({site,domain:d,url:l.url,anchor:l.anchor||'',our_url:our,asset:list.find(a=>normUrl(a.url)===normUrl(our))||list[0]})}
    }
  }
  return out;
}

/**
 * Run discovery for the chosen assets. Mutates `state.prospects` / `state.domains`.
 * Returns counters for the run report.
 */
export async function discoverProspects({assets,sites,state,dfs,fetchImpl=fetch,resolveHost,perAsset=2,maxNewPerRun=60,maxQueries=24,serpDepth=50,linkGapCalls=1,pairPool=null,neighborPages=12,altSearch=null,crawl=null,citedPerSite=6,deadline=Infinity,log=()=>{}}){
  state.prospects??={};state.domains??={};state.queries??={};
  // Page-level and transient rejections expire, so a recovered server or an improved page can be evaluated again.
  const backfilled=backfillRejections(state),expired=expireRejections(state);
  const ourDomains=sites.map(s=>s.domain),competitors=new Set(sites.flatMap(s=>s.competitors||[]));
  const bySite=new Map(sites.map(s=>[s.domain,s]));
  // Brand-mention searches go first: editors who already mention us convert best.
  const mentions=mentionJobs(sites,state).map(m=>({query:m.query,footprint:'mention',kind:'mention',
    asset:{site:m.site.domain,url:`https://${m.site.domain}/`,title:brandOf(m.site),type:'brand'}}));
  const jobs=[...mentions,...pickQueries(assets,sites,state,{perAsset})];
  // with_email: new prospects whose address passes the send gate's rules (ready to verify), not merely any address found.
  const stats={queries:0,mention_queries:0,serp_results:0,candidates:0,qualified:0,mentions:0,already_linked:0,rejected:0,with_email:0,held_address:0,contact_form:0,broken_links:0,
    rejections_expired:expired,...(backfilled?{rejections_backfilled:backfilled}:{})};
  // The watchdog pauses paid searches that keep finding nothing; link gap and the free sources continue.
  const paidSerpPaused=Date.parse(state.paid_serp_paused_until||'')>Date.now();if(paidSerpPaused)stats.paid_serp_paused=true;
  const pitchList=d=>(pairPool||assets).filter(a=>a.site===d);
  const slim=a=>({site:a.site,url:a.url,title:a.title,h1:a.h1,type:a.type,terms:(a.terms||[]).slice(0,30)});
  // Free sources (neighbours, our citations) carry a placeholder pairing until the page is read.
  const pickAfterFetch=(c,res,site)=>{const list=pitchList(c.site);if(!list.length)return c.asset;
    const pick=bestPitchAsset({title:tagText(res.body,'title')[0]||'',excerpt:`${tagText(res.body,'h1')[0]||''} ${tagText(res.body,'h2').slice(0,12).join(' ')} ${mainText(res.body).slice(0,1200)}`,page_url:res.url},list,site);
    // Without a specific match, the placeholder stays when it is pitchable (our citing page, or the recommending page's pairing).
    return pick&&(pick.match==='specific'||!list.some(a=>a.url===c.asset.url))?slim(pick.asset):c.asset};
  // Words of every page this site could pitch: a recommended link is worth a fetch only if it shares one of them.
  const termCache=new Map(),siteTerms=(site,asset)=>{const k=site.domain+'|'+(asset?.url||'');if(!termCache.has(k))termCache.set(k,[...new Set([...assetTerms(asset,site),...pitchList(site.domain).flatMap(a=>assetTerms(a,site))])]);return termCache.get(k)};
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
          authority:{domain_rank:l.domain_rank??null,page_rank:l.page_rank??null},
          competitor_link:{url:l.url_to,host:hostOf(l.url_to),anchor:String(l.anchor||'').slice(0,120),context:`${l.text_pre} … ${l.text_post}`.replace(/\s+/g,' ').trim().slice(0,300),dead:!!l.broken_to,match:pair.match}});
      }
      stats.linkgap_candidates+=fresh.length-before;
      log(`link gap: ${job.target} (for ${job.site.domain}) ${r.items.length} referring pages from offset ${job.offset}/${r.total}, ${fresh.length-before} new candidates`);
    }
  }
  // ---- Our own citations (free, no fetch): for sites with no email sent and nothing ready, the editorial pages our own
  // articles link to become candidates. They pass admission, qualification and verification like any other. ----
  stats.cited_candidates=0;
  if(crawl&&citedPerSite>0&&fresh.length<maxNewPerRun*2){
    const taken=new Map();
    for(const c of citedCandidates(state,sites,crawl,{pitchList})){
      const n=taken.get(c.site.domain)||0;if(n>=citedPerSite||fresh.length>=maxNewPerRun*2)continue;
      let path='';try{path=new URL(c.url).pathname}catch{continue}
      if(NOT_A_PAGE.test(path)){dropBy('not_a_page');continue}
      if(!admit(c.site,c.domain,path,dropBy))continue;
      fresh.push({site:c.site.domain,domain:c.domain,url:normUrl(c.url),serp_title:c.anchor,query:`cited:${c.domain}`,footprint:'cited_by_us',kind:'cited',rank:null,asset:slim(c.asset),cited_by_us:{our_url:c.our_url}});
      taken.set(c.site.domain,n+1);stats.cited_candidates++;
    }
    for(const d of taken.keys())state.queries[`${d}|cited:${NOW().slice(0,10)}`]=NOW();
    if(stats.cited_candidates)log(`our own citations (free): ${stats.cited_candidates} pages our articles link to, for ${taken.size} sites with no email sent yet`);
  }
  // ---- Link neighbourhood (free): the sites that already-qualified pages recommend. Runs after the paid
  // sources so it only fills the room they leave, and keeps prospecting alive when no search credit is left. ----
  stats.neighbor_pages=0;stats.neighbor_candidates=0;
  if(neighborPages>0&&fresh.length<maxNewPerRun*2&&Date.now()<deadline){
    const assetBy=new Map([...(pairPool||[]),...assets].map(a=>[a.url,a]));
    const sources=neighborSources(state,sites,{max:neighborPages});
    const pages=await pool(sources,6,async p=>Date.now()>deadline?null:{p,res:await fetchPage(p.page_url,{fetchImpl,timeout:10000,maxBytes:500000})});
    for(const x of pages){
      if(!x||x.error)continue;const {p,res}=x;p.mined_at=NOW();
      if(res.status!==200||!res.body)continue;
      stats.neighbor_pages++;
      const site=bySite.get(p.site),a=assetBy.get(p.asset_url)||{site:p.site,url:p.asset_url,title:p.asset_title||''};
      const asset={site:p.site,url:a.url,title:a.title,h1:a.h1,type:a.type,terms:(a.terms||[]).slice(0,30)};
      const before=fresh.length;let taken=0;
      // Most on-topic links first (anchor and URL words that match what this site's pitchable pages cover); at most 8 per
      // source page, and a link sharing no word with them is not worth a fetch. The asset is chosen once the page is read.
      for(const l of outboundCandidates(res.body,res.url,{terms:siteTerms(site,asset),ourDomains,max:40})){
        if(taken>=8||fresh.length>=maxNewPerRun*2)break;
        if(!l.relevance){dropBy('zero_relevance');continue}
        const domain=hostOf(l.url);let path='';try{path=new URL(l.url).pathname}catch{continue}
        if(NOT_A_PAGE.test(path)){dropBy('not_a_page');continue}
        if(!admit(site,domain,path,dropBy))continue;
        fresh.push({site:site.domain,domain,url:normUrl(l.url),serp_title:l.anchor,query:`neighbor:${p.domain}`,footprint:'neighbor',kind:'neighbor',rank:null,asset});taken++;
      }
      state.queries[`${site.domain}|neighbor:${p.domain}`]=NOW();
      stats.neighbor_candidates+=fresh.length-before;
    }
    if(stats.neighbor_pages)log(`link neighbourhood (free): ${stats.neighbor_pages} qualified pages mined, ${stats.neighbor_candidates} recommended sites to evaluate`);
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
    // DataForSEO serves searches while it can pay for them; otherwise the optional fallback provider does.
    const viaAlt=(paidSerpPaused||!dfs.canSpend('serp'))&&!!altSearch?.canSearch?.();
    const n=Math.min(4,maxQueries-stats.queries,jobs.length-i,viaAlt?altSearch.remaining():paidSerpPaused?0:dfs.affordable?dfs.affordable('serp'):(dfs.canSpend('serp')?1:0));
    if(n<=0)break;
    const batch=jobs.slice(i,i+n);i+=n;
    const results=await Promise.all(batch.map(j=>(viaAlt?altSearch:dfs).serp(j.query,{depth:serpDepth,...marketOf(bySite.get(j.asset.site))})));
    if(viaAlt)stats.fallback_queries=(stats.fallback_queries||0)+batch.length;
    batch.forEach((job,k)=>{if(results[k]===null)stats.failed_queries=(stats.failed_queries||0)+1;else take(job,results[k])}); // provider error: retried next run
  }
  // One cheap request sizes every new candidate domain; drop giants and dead sites before fetching anything.
  // Audience is sized in the site's own market: a UK publisher has little US traffic and must not be dropped for it.
  const byMarket=new Map();
  for(const f of fresh)if(!('etv' in f)){const m=marketOf(bySite.get(f.site)),k=`${m.location}|${m.language}`;(byMarket.get(k)??byMarket.set(k,{m,domains:new Set()}).get(k)).domains.add(f.domain)}
  let traffic=null;
  for(const {m,domains} of byMarket.values()){
    if(!dfs.canSpend('traffic'))break;
    const t=await dfs.domainTraffic([...domains],m);if(t)traffic={...(traffic||{}),...t};
  }
  if(traffic)for(let i=fresh.length-1;i>=0;i--){
    if('etv' in fresh[i])continue;
    const why=trafficVerdict(traffic[fresh[i].domain],fresh[i].kind);
    if(why){const f=fresh[i],id=hashId(`${f.site}|${f.url}`);state.prospects[id]={id,site:f.site,domain:f.domain,page_url:f.url,asset_url:f.asset.url,asset_title:f.asset.title,query:f.query,found_at:NOW(),history:[],status:'rejected',reason:why,etv:traffic[f.domain],qv:QUALIFY_VERSION};
      state.domains[`${f.site}|${f.domain}`]=id;noteRejection(state,state.prospects[id]);stats.rejected++;fresh.splice(i,1)}
    else fresh[i].etv=traffic[fresh[i].domain]??null;
  }
  stats.candidates=fresh.length;
  const checked=await pool(fresh.slice(0,maxNewPerRun*2),6,async c=>{
    if(Date.now()>deadline)return {deferred:c};
    let url=c.url,res=null;
    if(!url){
      const diag={},found=await resolveWrapped({...c,title:c.serp_title},{fetchImpl,diag}).catch(()=>null);
      if(!found){state.unresolved[c.domain]=NOW();const why=c.goto?`redirect_${diag.goto||'error'}`:'no_redirect';(stats.unresolved_why??={})[why]=(stats.unresolved_why[why]||0)+1;return {unresolved:c}}
      url=found.url;res=found.page||null;stats.resolved=(stats.resolved||0)+1;(stats.resolved_via??={})[found.via]=(stats.resolved_via[found.via]||0)+1;
    }
    res??=await fetchPage(url,{fetchImpl,timeout:12000,maxBytes:500000});
    const site=bySite.get(c.site),mention=c.kind==='mention',free=c.kind==='neighbor'||c.kind==='cited';
    let asset=c.asset,q=null;
    if(res.status===200&&res.body){
      // Free sources carry a placeholder pairing: the page we pitch is chosen for what this page is actually about.
      if(free)asset=pickAfterFetch(c,res,site);
      q=qualifyPage(res.url,res.body,{asset,site,ourDomains,provenLinker:c.kind==='linkgap'});
      // A recommended site's linked page is often its homepage: its own resource page may be the one an editor adds to.
      if(free&&!q.qualified&&!q.linksToUs&&Date.now()<deadline){
        const alt=await probeResourcePage(res.url,res.body,{fetchImpl,domain:c.domain,terms:siteTerms(site,asset)}).catch(()=>null);
        if(alt){const a2=pickAfterFetch(c,alt,site),q2=qualifyPage(alt.url,alt.body,{asset:a2,site,ourDomains});
          if(q2.qualified||q2.linksToUs){res=alt;url=normUrl(alt.url)||alt.url;asset=a2;q=q2;stats.resource_pages_found=(stats.resource_pages_found||0)+1}}
      }
    }
    const id=hashId(`${c.site}|${url}`);
    const base={id,site:c.site,domain:c.domain,page_url:url,asset_url:asset.url,asset_title:asset.title,query:c.query,footprint:c.footprint,kind:c.kind,serp_rank:c.rank,etv:c.etv??null,found_at:NOW(),history:[],
      ...(c.competitor_link?{competitor_link:c.competitor_link}:{}),...(c.authority?{authority:c.authority}:{}),...(c.cited_by_us?{cited_by_us:c.cited_by_us}:{})};
    if(res.status!==200||!res.body)return {...base,status:'rejected',reason:`HTTP ${res.status||res.error}`};
    const rec={...base,page_url:normUrl(res.url)||url,title:q.title||c.serp_title,score:q.score,relevance:q.relevance,external_domains:q.external_domains,
      resource_page:q.resource_page,fit_section:q.fit_section,fit_excerpt:q.fit_excerpt,...(q.list_page?{list_page:q.list_page}:{}),author:q.author,excerpt:q.excerpt,last_year_mentioned:q.last_year_mentioned};
    if(q.linksToUs)return {...rec,status:'already_linked',reason:'Already links to us',existing_link:{url:q.linksToUs.url,anchor:q.linksToUs.anchor,rel:q.linksToUs.rel}};
    // A mention is relevant by definition; it only has to really name us (search engines are fuzzy).
    if(mention){if(!mentionsUs(res.body,site))return {...rec,status:'rejected',reason:'Brand not actually mentioned'};
      if(siteInfoPage(rec.page_url,rec.title))return {...rec,status:'rejected',reason:'Automated site-info page, not an editorial mention'};
      rec.score=Math.max(rec.score,70)}
    else if(!q.qualified)return {...rec,status:'rejected',reason:q.reasons.join('; ')||'Low fit score'};
    if(Date.now()>deadline)return {deferred:c};
    // Read the page the way a reader does (Mozilla Readability): what the article itself says and who wrote it.
    // A page in another language is dropped here, before any contact lookup or verification credit.
    const art=readArticle(res.body,rec.page_url);
    if(art){
      const expected=marketOf(site).language==='en'?'eng':null;
      if(expected&&art.lang!=='und'&&art.lang!==expected&&art.text.length>=600)return {...rec,qv:QUALIFY_VERSION,status:'rejected',reason:`Page is not in English (${art.lang})`};
      if(art.text.length>=400)rec.excerpt=art.text.slice(0,1800);
      if(!rec.author&&art.byline){rec.author=art.byline;stats.bylines=(stats.bylines||0)+1}
    }
    const contact=await findContact(rec.page_url,res.body,{fetchImpl,author:rec.author});
    // Vendors that mention us may still link; for cold pitches they're competitors.
    if(contact.site_kind==='local_business'||(contact.site_kind==='software_vendor'&&!mention))return {...rec,qv:QUALIFY_VERSION,status:'rejected',reason:contact.site_kind==='software_vendor'?'Software vendor (competing product)':'Local service business'};
    const status=contactStatus(contact);
    // A dead link on their page that our asset replaces is the strongest reason for an editor to reply.
    let broken=null;
    if((status==='ready'||status==='contact_form')&&!mention&&Date.now()<deadline)broken=await findBrokenLink(res.body,rec.page_url,{terms:assetTerms(asset,site),ourDomains,fetchImpl,resolveHost,deadline}).catch(()=>null);
    return {...rec,...contactFields(contact),qv:QUALIFY_VERSION,status,broken_link:broken,broken_checked_at:NOW()};
  });
  // Anything not qualified this run (time or volume) is queued for the next one.
  const deferred=[...checked.filter(x=>x?.deferred).map(x=>x.deferred),...fresh.slice(maxNewPerRun*2)];
  state.candidate_queue=deferred.slice(0,300).map(c=>({...c,queued_at:c.queued_at||NOW()}));stats.deferred=state.candidate_queue.length;
  for(const p of checked){
    if(p?.unresolved){stats.unresolved=(stats.unresolved||0)+1;continue}
    if(!p||p.error||p.deferred)continue;
    if(p.status==='rejected'||p.status==='already_linked'){delete p.excerpt;delete p.fit_excerpt}
    state.prospects[p.id]=p;state.domains[`${p.site}|${p.domain}`]=p.id;
    if(p.status==='already_linked')stats.already_linked++;
    else if(p.status==='rejected'){stats.rejected++;noteRejection(state,p)}
    else{stats.qualified++;if(p.kind==='mention')stats.mentions++;if(p.status==='ready')stats.with_email++;else if(p.status==='contact_unverifiable')stats.held_address++;else if(p.contact_form)stats.contact_form++;
      if(p.broken_link)stats.broken_links++;if(p.list_page)stats.list_pages=(stats.list_pages||0)+1;if(p.cited_by_us)stats.cited_qualified=(stats.cited_qualified||0)+1}
  }
  log(`prospects: ${stats.from_queue} from the saved queue, ${stats.deferred} saved for next run; ${stats.linkgap_calls} competitor link-gap pulls (${stats.linkgap_candidates} candidates); ${stats.cited_candidates} from our own citations; ${stats.neighbor_candidates} from the link neighbourhood; ${stats.queries} queries (${stats.mention_queries} brand-mention)${paidSerpPaused?' [paid searches paused]':''}, ${stats.resolved||0} Google-wrapped results resolved, ${stats.unresolved||0} unresolvable; ${stats.candidates} candidates, ${stats.qualified} qualified (${stats.mentions} unlinked mentions), ${stats.with_email} with a usable email, ${stats.held_address} with only an address the send rules hold, ${stats.broken_links} with a dead link we can replace, ${stats.already_linked} already linking; ${stats.rejections_expired} old rejections expired`);
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
  const fail=(p,reason)=>{if(p.status==='sent'){p.no_followup=true;p.no_followup_reason=reason;stats.no_followup++}else{p.status='rejected';p.reason=reason;stats.rejected++;if(p.site&&p.domain)noteRejection(state,p)}};
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
    const f=contactFields(c);Object.assign(p,{email:f.email,email_source:f.email_source,alternates:f.alternates,contact_form:f.contact_form,site_kind:f.site_kind,...(f.contact_quality?{reason:f.reason,contact_quality:f.contact_quality,screen_v:f.screen_v}:{})});
    p.status=contactStatus(c);if(c.email)stats.recontacted++;
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
