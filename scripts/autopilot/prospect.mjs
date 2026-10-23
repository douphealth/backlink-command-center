/**
 * Prospect discovery and qualification.
 * 1. Generate intent + resource-page queries for each promoted asset.
 * 2. Pull SERPs (DataForSEO), drop platforms/competitors/known domains.
 * 3. Fetch each page, score topical fit and "links out to resources" behaviour,
 *    detect existing links to us, and find the best editorial contact.
 */
import {fetchPage,pool,tokens,keyPhrase,links,tagText,jsonLd,mainText,stripTags,extractEmails,rankEmail,hostOf,sameSite,rootDomain,normUrl,hashId,ageDays,NOW} from './util.mjs';

export const BLOCKED=/(^|\.)(reddit|quora|youtube|youtu|facebook|instagram|pinterest|tiktok|twitter|x|linkedin|threads|tumblr|amazon|ebay|walmart|etsy|target|bestbuy|aliexpress|temu|wikipedia|wikihow|wiktionary|medium|substack|github|stackexchange|stackoverflow|apple|google|bing|yahoo|msn|microsoft|play\.google|apps\.apple|yelp|tripadvisor|trustpilot|glassdoor|indeed|craigslist|scribd|slideshare|issuu|archive|imdb|britannica|dictionary|merriam-webster|cambridge|fandom|discord|telegram|whatsapp|twitch|vimeo|dailymotion|soundcloud|spotify|goodreads|zillow|webmd|healthline|mayoclinic|clevelandclinic|nytimes|washingtonpost|theguardian|bbc|cnn|forbes|businessinsider|wsj|usatoday|nbcnews|cbsnews|foxnews|reuters|apnews|bloomberg)\.[a-z.]+$/i;
// Government sites essentially never add outreach links; skip them before spending a fetch.
const GOVERNMENT=/(\.gov|\.mil|\.gov\.[a-z]{2}|\.gc\.ca|\.nhs\.uk|amsadobe\.com)$/i;
// Cold link requests to university staff are almost never answered.
const ACADEMIC=/(\.edu|\.edu\.[a-z]{2}|\.ac\.[a-z]{2})$/i;
// Bump when qualification rules change: older prospects are re-checked before any (follow-up) email.
export const QUALIFY_VERSION=2;
// Estimated monthly organic visits: giants don't answer, near-zero sites add no value.
export const TRAFFIC_BAND={min:50,max:1_000_000};
export const trafficVerdict=etv=>etv==null?null:etv>TRAFFIC_BAND.max?'Very large brand (unlikely to add outreach links)':etv<TRAFFIC_BAND.min?'Almost no search traffic':null;
const UGC=/(?:^|\/)(forum|forums|thread|threads|community|questions?|answers|topic|t|r|groups?|profile|user|members?)\//i;
const RESOURCE=/\b(resources?|links|useful|helpful|recommended|tools|toolkit|roundup|round-up|best|list|directory|guide|reading|library|where to)\b/i;

export function queriesFor(asset,site){
  const k=keyPhrase(asset.h1||asset.title,4)||site.topic,t=site.topic;
  const base=asset.type==='interactive_tool'?[`${t} tools`,`free ${t} tools`,`best ${t} resources`,`intitle:resources ${t}`,`${t} useful websites`]
    :asset.type==='methodology'||asset.type==='research_candidate'?[`${t} statistics`,`${t} research resources`,`intitle:resources ${t}`,`${t} sources`]
    :[`${t} resources`,`intitle:resources ${t}`,`${t} "useful links"`,`${t} blogs to follow`,`${t} recommended reading`];
  return [...new Set([k,...base].map(q=>q.trim()).filter(q=>q.length>3))];
}

/** Rotate unused queries; returns at most `perAsset` per asset. */
export function pickQueries(assets,sites,state,{perAsset=2,reuseDays=45}={}){
  state.queries??={};
  const bySite=new Map(sites.map(s=>[s.domain,s])),out=[];
  for(const a of assets){
    const fresh=queriesFor(a,bySite.get(a.site)).filter(q=>ageDays(state.queries[`${a.site}|${q}`])>reuseDays);
    for(const q of fresh.slice(0,perAsset))out.push({asset:a,query:q});
  }
  return out;
}

export function knownDomain(state,site,domain){
  return !!(state.domains?.[`${site}|${domain}`]||state.suppression?.[domain]||state.contacted?.[domain]);
}

export function qualifyPage(url,html,{asset,site,ourDomains}){
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
  let score=Math.round(relevance*55+Math.min(20,ext.size*1.2)+(resource?15:0)+(fitSection?.n?5:0)+(year>=new Date().getUTCFullYear()-1?5:0));
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
  if(kind!=='publisher')return {email:null,email_source:null,alternates:[],contact_form:null,site_kind:kind};
  const linked=links(pageHtml,pageUrl).filter(l=>sameSite(hostOf(l.url),domain)&&/contact|about|write-for-us|contribute/i.test(l.url+' '+l.anchor)&&!/advertis|sponsor|media-kit|partner/i.test(l.url)).map(l=>l.url);
  const paths=[...new Set([...linked.slice(0,3),origin+'/contact',origin+'/contact-us',origin+'/about',origin+'/write-for-us'].map(u=>normUrl(u)))].slice(0,5);
  for(const p of paths){
    const best=Math.max(-1,...[...candidates.values()].map(c=>c.rank));if(best>=75)break;
    const res=await fetchPage(p,{fetchImpl,timeout:9000,maxBytes:250000});
    if(res.status===200&&res.body)take(res.body,res.url,'contact');
  }
  const ranked=[...candidates.values()].sort((a,b)=>b.rank-a.rank);
  return {email:ranked[0]?.email||null,email_source:ranked[0]?.source||null,alternates:ranked.slice(1,3).map(x=>x.email),contact_form:form,site_kind:kind};
}

/**
 * Run discovery for the chosen assets. Mutates `state.prospects` / `state.domains`.
 * Returns counters for the run report.
 */
export async function discoverProspects({assets,sites,state,dfs,fetchImpl=fetch,perAsset=2,maxNewPerRun=60,deadline=Infinity,log=()=>{}}){
  state.prospects??={};state.domains??={};state.queries??={};
  const ourDomains=sites.map(s=>s.domain),competitors=new Set(sites.flatMap(s=>s.competitors||[]));
  const bySite=new Map(sites.map(s=>[s.domain,s]));
  const jobs=pickQueries(assets,sites,state,{perAsset});
  const stats={queries:0,serp_results:0,candidates:0,qualified:0,already_linked:0,rejected:0,with_email:0,contact_form:0};
  const fresh=[];
  for(const job of jobs){
    if(Date.now()>deadline||fresh.length>=maxNewPerRun*2||!dfs.canSpend('serp'))break;
    const site=bySite.get(job.asset.site);
    const results=await dfs.serp(job.query);
    state.queries[`${site.domain}|${job.query}`]=NOW();stats.queries++;stats.serp_results+=results.length;
    for(const r of results){
      const domain=rootDomain(r.domain||hostOf(r.url));
      if(!domain||BLOCKED.test(domain)||GOVERNMENT.test(domain)||ACADEMIC.test(domain)||ourDomains.some(d=>sameSite(domain,d))||competitors.has(domain)||UGC.test(new URL(r.url).pathname))continue;
      if(knownDomain(state,site.domain,domain)||fresh.some(f=>f.domain===domain&&f.site===site.domain))continue;
      fresh.push({site:site.domain,domain,url:normUrl(r.url),serp_title:r.title,query:job.query,rank:r.rank,asset:job.asset});
    }
  }
  // One cheap request sizes every candidate domain; drop giants and dead sites before fetching anything.
  const traffic=dfs.canSpend('traffic')?await dfs.domainTraffic([...new Set(fresh.map(f=>f.domain))]):null;
  if(traffic)for(let i=fresh.length-1;i>=0;i--){
    const why=trafficVerdict(traffic[fresh[i].domain]);
    if(why){const f=fresh[i],id=hashId(`${f.site}|${f.url}`);state.prospects[id]={id,site:f.site,domain:f.domain,page_url:f.url,asset_url:f.asset.url,asset_title:f.asset.title,query:f.query,found_at:NOW(),history:[],status:'rejected',reason:why,etv:traffic[f.domain],qv:QUALIFY_VERSION};
      state.domains[`${f.site}|${f.domain}`]=id;stats.rejected++;fresh.splice(i,1)}
    else fresh[i].etv=traffic[fresh[i].domain]??null;
  }
  stats.candidates=fresh.length;
  const checked=await pool(fresh.slice(0,maxNewPerRun*2),6,async c=>{
    if(Date.now()>deadline)return null;
    const res=await fetchPage(c.url,{fetchImpl,timeout:12000,maxBytes:500000});
    const id=hashId(`${c.site}|${c.url}`);
    const base={id,site:c.site,domain:c.domain,page_url:c.url,asset_url:c.asset.url,asset_title:c.asset.title,query:c.query,serp_rank:c.rank,etv:c.etv??null,found_at:NOW(),history:[]};
    if(res.status!==200||!res.body)return {...base,status:'rejected',reason:`HTTP ${res.status||res.error}`};
    const q=qualifyPage(res.url,res.body,{asset:c.asset,site:bySite.get(c.site),ourDomains});
    const rec={...base,page_url:normUrl(res.url)||c.url,title:q.title||c.serp_title,score:q.score,relevance:q.relevance,external_domains:q.external_domains,
      resource_page:q.resource_page,fit_section:q.fit_section,author:q.author,excerpt:q.excerpt,last_year_mentioned:q.last_year_mentioned};
    if(q.linksToUs)return {...rec,status:'already_linked',reason:'Already links to us',existing_link:{url:q.linksToUs.url,anchor:q.linksToUs.anchor,rel:q.linksToUs.rel}};
    if(!q.qualified)return {...rec,status:'rejected',reason:q.reasons.join('; ')||'Low fit score'};
    const contact=await findContact(rec.page_url,res.body,{fetchImpl,author:q.author});
    if(contact.site_kind!=='publisher')return {...rec,qv:QUALIFY_VERSION,status:'rejected',reason:contact.site_kind==='software_vendor'?'Software vendor (competing product)':'Local service business'};
    return {...rec,...contact,qv:QUALIFY_VERSION,status:contact.email?'ready':contact.contact_form?'contact_form':'no_contact'};
  });
  for(const p of checked){
    if(!p||p.error)continue;
    if(p.status==='rejected'||p.status==='already_linked')delete p.excerpt;
    state.prospects[p.id]=p;state.domains[`${p.site}|${p.domain}`]=p.id;
    if(p.status==='already_linked')stats.already_linked++;
    else if(p.status==='rejected')stats.rejected++;
    else{stats.qualified++;if(p.email)stats.with_email++;else if(p.contact_form)stats.contact_form++}
  }
  log(`prospects: ${stats.queries} queries, ${stats.candidates} candidates, ${stats.qualified} qualified, ${stats.with_email} with email, ${stats.already_linked} already linking`);
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
