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
/** Replies/links per page we promote, as a smoothed rate (prior: 1 reply in 3 pitches is "average"). */
export function assetStats(state){
  const m=new Map();
  for(const p of Object.values(state.prospects||{})){
    if(!(p.history||[]).some(h=>h.type==='initial')&&!CONTACTED.has(p.status))continue;
    const r=m.get(p.asset_url)||{sent:0,replied:0,positive:0,won:0};
    r.sent++;if(p.replied_at)r.replied++;if(p.status==='positive')r.positive++;if(p.status==='won')r.won++;
    m.set(p.asset_url,r);
  }
  for(const r of m.values())r.rate=(r.replied+2*r.positive+4*r.won+1)/(r.sent+3);
  return m;
}

/** 0–100: how likely this prospect is to add a link, from evidence we already hold. */
export function linkLikelihood(p,{assets=new Map()}={}){
  const year=new Date().getUTCFullYear();
  const rank=p.email_rank??(p.email?rankEmail(p.email,p.domain,{source:'contact',author:p.author}):-1);
  const etv=p.etv;
  let s=Math.min(100,p.score||0)*.3;                                   // topical fit and page quality
  if(p.kind==='mention')s+=25;                                         // already knows and mentions us
  if(p.resource_page)s+=10;                                            // a page whose job is linking out
  s+=etv==null?6:etv>=1000&&etv<=300000?15:etv>=300&&etv<1_000_000?8:3; // independent, real audience
  s+=rank>=95?15:rank>=72?12:rank>=50?7:0;                             // author > editorial > generic inbox
  if((p.last_year_mentioned||0)>=year-1)s+=8;                         // recently maintained
  const a=assets.get(p.asset_url);if(a&&a.sent>=3)s+=Math.max(-10,Math.min(10,(a.rate-1/3)*30)); // our page's track record
  return Math.round(Math.max(0,Math.min(100,s)));
}

/** Public, non-personal summary of what's working (no addresses, no prospect names). */
export function learningSummary(state,sites){
  const y=footprintYield(state,sites);
  const footprints=Object.entries(y).filter(([,v])=>v.queries>0).map(([fp,v])=>({footprint:fp,queries:v.queries,ready:v.ready,rate:Number(v.rate.toFixed(3))}))
    .sort((a,b)=>b.rate-a.rate);
  const assets=[...assetStats(state)].map(([url,v])=>({url,...v,rate:Number(v.rate.toFixed(3))})).sort((a,b)=>b.rate-a.rate);
  return {footprints,assets};
}
