/**
 * Promotion scoring: which owned URLs deserve links first.
 * linkability (is it worth citing?) x demand (will a link move real traffic?).
 * Demand comes from Search Console when connected, else DataForSEO page traffic.
 */
import {classifyAsset} from '../editorial-opportunity-engine.mjs';
import {clamp,ageDays,tokens,keyPhrase} from './util.mjs';

const RICH_SCHEMA=/HowTo|FAQPage|Dataset|WebApplication|SoftwareApplication|Recipe|Quiz|ItemList/;

export function eligiblePage(p){
  if(p.status!==200||p.noindex||!p.title)return false;
  if(p.technical_status==='technically_eligible')return true;
  return p.technical_status==='needs_editorial_review'&&(p.words>=300||p.interactive);
}
export function linkability(p){
  const kind=classifyAsset(p.final_url||p.url,p.title);
  const reasons=[];
  const depth=clamp(Math.log2((p.words||0)/200+1)*8,0,22);
  const structure=clamp((p.h2_count||0)*.8+(p.tables||0)*3+(p.lists||0)*.4,0,10);
  const media=clamp((p.images||0)*.4+(p.videos||0)*2,0,5);
  const interactive=p.interactive?12:0;
  const evidence=clamp((p.authority_citations||0)*2+(p.external_domains||0)*.25,0,10);
  const schema=clamp((p.schema||[]).filter(t=>RICH_SCHEMA.test(t)).length*2,0,6);
  const age=Math.min(ageDays(p.modified),ageDays(p.lastmod));
  const fresh=age<180?6:age<365?3:age>730&&Number.isFinite(age)?-5:0;
  const thin=(p.words||0)<400&&!p.interactive?-20:0;
  if(p.interactive)reasons.push('Has an interactive tool/quiz — earns links naturally');
  if(kind.type==='methodology'||kind.type==='research_candidate')reasons.push('Original method/data — citation-worthy');
  if((p.words||0)>=2000)reasons.push(`In-depth (${p.words.toLocaleString('en-US')} words)`);
  if((p.tables||0)>=1)reasons.push(`${p.tables} data table${p.tables>1?'s':''}`);
  if((p.authority_citations||0)>=3)reasons.push(`Cites ${p.authority_citations} authoritative sources`);
  if(fresh>0)reasons.push('Recently updated');
  if(thin)reasons.push('Thin content — expand before pitching');
  const score=clamp(Math.round(kind.base*.35+depth+structure+media+interactive+evidence+schema+fresh+thin),0,100);
  return {score,type:kind.type,sensitive:kind.sensitive,reasons};
}
export function demandScore(m){
  if(!m)return null;
  if(m.source==='gsc'){
    const pos=Number(m.position||100),impr=Number(m.impressions||0),clicks=Number(m.clicks||0);
    const striking=pos>=4&&pos<=20?22:pos>20&&pos<=40?9:pos<4?5:0;
    const expectedCtr=pos<=3?.18:pos<=10?.05:.012,gap=Math.max(0,impr*expectedCtr-clicks);
    return clamp(Math.round(Math.log10(impr+1)*20+striking+Math.sqrt(gap)*1.5),0,100);
  }
  const etv=Number(m.etv||0),kw=Number(m.keywords||0),striking=Number(m.striking||0);
  return clamp(Math.round(Math.log10(etv+1)*24+Math.log10(kw+1)*14+Math.min(18,striking*3)),0,100);
}

/** Rank every page in the portfolio. Returns sorted assets with reasons and internal-link stats. */
export function rankPortfolio(crawl,{demand={},maxPerSite=25}={}){
  const out=[];
  for(const site of crawl){
    const pages=site.pages.filter(p=>p.status===200);
    const inlinks=new Map();
    for(const p of pages)for(const l of p.internal_links||[])inlinks.set(l,(inlinks.get(l)||0)+1);
    for(const p of pages){
      if(!eligiblePage(p))continue;
      const link=linkability(p);
      if(link.type==='navigation'||link.type==='invalid')continue;
      const m=demand[p.url]||demand[p.final_url];
      const dem=demandScore(m);
      const internal=Math.max(inlinks.get(p.url)||0,inlinks.get(p.final_url)||0);
      let promotion=dem==null?Math.round(link.score*.9):Math.round(link.score*.55+dem*.45);
      const reasons=[...link.reasons];
      if(m?.source==='gsc'&&m.position>=4&&m.position<=20)reasons.unshift(`Striking distance: avg position ${Number(m.position).toFixed(1)} on ${Math.round(m.impressions).toLocaleString('en-US')} impressions`);
      else if(m?.etv)reasons.unshift(`~${Math.round(m.etv).toLocaleString('en-US')} est. monthly visits from ${m.keywords} keywords`);
      if(internal<=2){promotion+=4;reasons.push(`Under-linked internally (${internal} inbound)`)}
      if(p.configured){promotion+=6;reasons.push('Flagship asset')}
      if(link.sensitive)reasons.push('Health/YMYL topic — pitch only to expert publishers');
      out.push({site:site.site,url:p.final_url||p.url,title:p.title,h1:p.h1,description:p.description,type:link.type,
        promotion:clamp(promotion,0,100),linkability:link.score,demand:dem,metrics:m||null,internal_inlinks:internal,
        words:p.words,interactive:!!p.interactive,modified:p.modified||p.lastmod||null,reasons:reasons.slice(0,5),terms:p.terms||[]});
    }
  }
  // Programmatic siblings (e.g. /compare/x-vs-y) compete with each other: keep the best two per template.
  const clusters=new Map();
  for(const a of out){const key=a.site+new URL(a.url).pathname.replace(/\/[^/]+\/?$/,'');(clusters.get(key)||clusters.set(key,[]).get(key)).push(a)}
  for(const list of clusters.values()){if(list.length<6)continue;
    list.sort((a,b)=>b.promotion-a.promotion).slice(2).forEach(a=>{a.promotion=Math.max(0,a.promotion-12);a.reasons.push(`One of ${list.length} templated sibling pages — promote the hub first`)})}
  out.sort((a,b)=>b.promotion-a.promotion||b.linkability-a.linkability);
  const per=new Map();
  return out.filter(a=>{const n=per.get(a.site)||0;per.set(a.site,n+1);return n<maxPerSite});
}

/**
 * Internal links are the fastest free ranking lever: find same-site pages that
 * discuss an asset's topic but do not link to it yet, with a natural anchor.
 */
export function internalLinkPlan(crawl,assets,{perAsset=5,topPerSite=12}={}){
  const bySite=new Map(crawl.map(s=>[s.site,s.pages.filter(p=>p.status===200&&p.words>=250)]));
  const promo=new Map(assets.map(a=>[a.url,a.promotion]));
  const counts=new Map(),plan=[];
  for(const a of assets){
    const n=counts.get(a.site)||0;if(n>=topPerSite)continue;counts.set(a.site,n+1);
    const phrase=keyPhrase(a.h1||a.title,5),core=[...new Set(tokens(phrase))];if(core.length<2)continue;
    const bigrams=core.slice(0,-1).map((w,i)=>w+' '+core[i+1]);
    const suggestions=[];
    for(const q of bySite.get(a.site)||[]){
      const qUrl=q.final_url||q.url;if(qUrl===a.url||q.url===a.url)continue;
      if((q.internal_links||[]).includes(a.url))continue;
      const terms=new Set(q.terms||[]);
      const uni=core.filter(w=>terms.has(w)).length,bi=bigrams.filter(b=>terms.has(b));
      if(uni<2||(uni<3&&!bi.length))continue;
      suggestions.push({from:qUrl,from_title:q.title,to:a.url,to_title:a.title,anchor:bi[0]||core.slice(0,3).join(' '),
        relevance:uni+bi.length*2,from_strength:promo.get(qUrl)??0});
    }
    suggestions.sort((x,y)=>y.relevance-x.relevance||y.from_strength-x.from_strength);
    plan.push(...suggestions.slice(0,perAsset).map(s=>({site:a.site,...s})));
  }
  return plan;
}
