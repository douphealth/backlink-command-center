/**
 * What Autopilot learns from its own results, and how it turns that into decisions:
 *  - link likelihood: which queued prospect to pitch first while daily sends are scarce
 *  - asset outcomes: which of our pages actually earn replies and links
 *  - footprint yield: which search patterns actually produce pitchable prospects
 * Everything is computed from stored records, so it improves as results accumulate.
 */
import {rankEmail} from './util.mjs';
import {footprintYield} from './prospect.mjs';

const CONTACTED=new Set(['sent','followed_up','replied','positive','won','lost','declined','bounced']);
/**
 * How strongly a page's own record is pulled toward the portfolio-wide (pooled) result, in pitches: a page's own
 * outcomes weigh as much as the pooled rate once it has been pitched PRIOR_STRENGTH times. At a pooled reply rate of
 * about 3%, the old fixed prior (1 reply in 3 pitches) was ~11x too optimistic, so 3-4 unanswered pitches cost a page
 * 5-6 points of pure noise; with this prior 10 unanswered pitches move it by about 2.5 points.
 */
export const PRIOR_STRENGTH=30;
/** Page-level adjustments apply only from this many pitches on; below it every page counts as average (lift 1). */
export const MIN_PAGE_SENDS=10;
/**
 * Replies/links per page we promote. `rate` is the outcome score per pitch (reply 1, positive +2, link +4), shrunk toward
 * the pooled score per pitch with PRIOR_STRENGTH pseudo-pitches; `lift` is rate / pooled (1 = average), and stays 1 below
 * MIN_PAGE_SENDS pitches or while nothing has been earned anywhere. The map also carries `pooled`.
 */
export function assetStats(state){
  const m=new Map();
  for(const p of Object.values(state.prospects||{})){
    if(!(p.history||[]).some(h=>h.type==='initial')&&!CONTACTED.has(p.status))continue;
    const r=m.get(p.asset_url)||{sent:0,replied:0,positive:0,won:0};
    r.sent++;if(p.replied_at)r.replied++;if(p.status==='positive')r.positive++;if(p.status==='won')r.won++;
    m.set(p.asset_url,r);
  }
  const score=r=>r.replied+2*r.positive+4*r.won;let sent=0,earned=0;
  for(const r of m.values()){sent+=r.sent;earned+=score(r)}
  const pooled=sent?earned/sent:0;
  for(const r of m.values()){r.rate=(score(r)+PRIOR_STRENGTH*pooled)/(r.sent+PRIOR_STRENGTH);r.lift=r.sent>=MIN_PAGE_SENDS&&pooled>0?r.rate/pooled:1}
  m.pooled=pooled;
  return m;
}

/** 0–100: how likely this prospect is to add a link, from evidence we already hold. */
export function linkLikelihood(p,{assets=new Map()}={}){
  const year=new Date().getUTCFullYear();
  const rank=p.email_rank??(p.email?rankEmail(p.email,p.domain,{source:'contact',author:p.author}):-1);
  const etv=p.etv;
  let s=Math.min(100,p.score||0)*.3;                                   // topical fit and page quality
  if(p.kind==='mention')s+=25;                                         // already knows and mentions us
  if(p.kind==='linkgap')s+=12;                                         // already links to a competing resource from its content
  if(p.resource_page)s+=10;                                            // a page whose job is linking out
  if(p.broken_link)s+=15;                                              // a dead link on their page we can replace
  s+=etv==null?6:etv>=1000&&etv<=300000?15:etv>=300&&etv<1_000_000?8:3; // independent, real audience
  s+=rank>=95?15:rank>=72?12:rank>=50?7:0;                             // author > editorial > generic inbox
  if((p.last_year_mentioned||0)>=year-1)s+=8;                         // recently maintained
  // What the link is worth: DataForSEO domain authority (0-1000) for link-gap pages, and a page that already
  // ranks in Google's top 10 for our topic is both clearly on-topic and a placement readers actually see.
  const dr=p.authority?.domain_rank;if(dr!=null)s+=dr>=400?8:dr>=200?5:dr>=100?2:0;
  if(p.serp_rank!=null&&p.serp_rank<=10)s+=5;
  const a=assets.get(p.asset_url);if(a&&a.sent>=MIN_PAGE_SENDS)s+=Math.max(-10,Math.min(10,((a.lift??1)-1)*10)); // our page's track record, shrunk toward the pooled rate
  return Math.round(Math.max(0,Math.min(100,s)));
}

/** Public, non-personal summary of what's working (no addresses, no prospect names). */
export function learningSummary(state,sites){
  const y=footprintYield(state,sites);
  const footprints=Object.entries(y).filter(([,v])=>v.queries>0).map(([fp,v])=>({footprint:fp,queries:v.queries,ready:v.ready,rate:Number(v.rate.toFixed(3))}))
    .sort((a,b)=>b.rate-a.rate);
  const stats=assetStats(state);
  const assets=[...stats].map(([url,v])=>({url,...v,rate:Number(v.rate.toFixed(3)),lift:Number(v.lift.toFixed(2))})).sort((a,b)=>b.rate-a.rate);
  return {footprints,assets,asset_prior:{pooled_rate:Number(stats.pooled.toFixed(4)),strength:PRIOR_STRENGTH,min_sends:MIN_PAGE_SENDS}};
}
