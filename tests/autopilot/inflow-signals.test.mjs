import test from 'node:test';
import assert from 'node:assert/strict';
import {rankPortfolio,internalLinkPlan,demandPrior,demandScore} from '../../scripts/autopilot/score.mjs';
import {DataForSEO} from '../../scripts/autopilot/dataforseo.mjs';
import {dfsDemand} from '../../scripts/autopilot/demand.mjs';
import {BraveSearch} from '../../scripts/autopilot/search.mjs';
import {checkLinks} from '../../scripts/autopilot/outreach.mjs';
import {extractFeatures} from '../../scripts/autopilot/crawl.mjs';

const json=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:{'content-type':'application/json'}});
const html=b=>new Response(b,{headers:{'content-type':'text/html'}});
const ago=d=>new Date(Date.now()-d*86400e3).toISOString();
const page=(slug,extra={})=>({site:'ex.com',url:`https://ex.com/${slug}`,final_url:`https://ex.com/${slug}/`,status:200,title:'Houseplant watering guide',h1:'Houseplant watering guide',
  words:2400,h2_count:8,tables:1,lists:4,images:6,videos:0,interactive:false,schema:[],external_domains:6,authority_citations:3,internal_links:[],terms:['houseplant','watering'],
  technical_status:'technically_eligible',...extra});

test('pages without demand data get a neutral prior: a measured page with real demand now ranks above an identical unmeasured one',()=>{
  assert.equal(demandPrior([]),30);assert.equal(demandPrior([10,20,30,40,50,60,70,80]),20);assert.equal(demandPrior([1,2,3,4,5]),15);assert.equal(demandPrior([90,90,90,90,90]),45);
  const crawl=[{site:'ex.com',pages:[page('measured-guide'),page('unmeasured-guide'),page('weak-guide')]}];
  // Moderate measured demand (43): the old blend ranked any unmeasured page above it unless demand reached 0.78 x linkability.
  const demand={'https://ex.com/measured-guide':{source:'dataforseo',etv:20,keywords:5,striking:0},'https://ex.com/weak-guide':{source:'dataforseo',etv:0,keywords:1,striking:0}};
  assert.ok(demandScore(demand['https://ex.com/measured-guide'])>30&&demandScore(demand['https://ex.com/weak-guide'])<30);
  const ranked=rankPortfolio(crawl,{demand});
  assert.deepEqual(ranked.map(a=>a.url.split('/')[3]),['measured-guide','unmeasured-guide','weak-guide']);
  assert.equal(ranked[1].demand,null,'the prior is used for ranking only; no demand is invented for the page');
});

test('internal-link plan: existing links are matched with or without the trailing slash; menu-wide targets are skipped',()=>{
  const target={site:'ex.com',url:'https://ex.com/watering-calculator/',title:'Watering Calculator for Houseplants',h1:'Watering Calculator for Houseplants',promotion:80};
  const src=(slug,links=[])=>page(slug,{words:900,terms:['watering','calculator','watering calculator','houseplants'],internal_links:links});
  const pages=[page('watering-calculator',{internal_links:[]}),src('s1',['https://ex.com/watering-calculator']),src('s2'),src('s3'),src('s4'),src('s5')];
  const plan=internalLinkPlan([{site:'ex.com',pages}],[target]);
  assert.deepEqual(plan.map(s=>s.from.split('/')[3]).sort(),['s2','s3','s4','s5'],'s1 already links to it; the page itself is never a source');
  const nearlyAll=pages.map((p,i)=>i===5?p:{...p,internal_links:['https://ex.com/watering-calculator']}); // 5 of 6 pages: the menu or footer
  assert.deepEqual(internalLinkPlan([{site:'ex.com',pages:nearlyAll}],[target]),[],'a target linked site-wide needs no suggestion');
});

test('a failed demand lookup keeps the cached pages; a real empty answer refreshes them',async()=>{
  const failing=new DataForSEO({login:'l',password:'p',state:{},fetchImpl:async()=>json({status_code:20000,cost:0,tasks:[{status_code:40501,status_message:'Invalid Field'}]})});
  assert.equal(await failing.relevantPages('a.com'),null);
  const empty=new DataForSEO({login:'l',password:'p',state:{},fetchImpl:async()=>json({status_code:20000,cost:0.01,tasks:[{status_code:40102,status_message:'No Search Results.'}]})});
  assert.deepEqual(await empty.relevantPages('a.com'),[]);
  const old={at:ago(9),items:[{url:'https://a.com/x',etv:120,keywords:9,striking:1,top3:0}]};
  const state={demand_cache:{'a.com':old}};
  const out=await dfsDemand([{domain:'a.com'}],{canSpend:()=>true,relevantPages:async()=>null},state);
  assert.equal(state.demand_cache['a.com'],old);assert.equal(out['https://a.com/x'].etv,120,'the stale pages still inform ranking');
  await dfsDemand([{domain:'a.com'}],{canSpend:()=>true,relevantPages:async()=>[]},state);
  assert.deepEqual(state.demand_cache['a.com'].items,[]);assert.ok(Date.now()-Date.parse(state.demand_cache['a.com'].at)<60e3);
});

test('Brave requests are paced per day so the monthly budget lasts the month',async()=>{
  let t=Date.parse('2026-11-01T10:00:00Z'),calls=0;const state={};
  const b=new BraveSearch({apiKey:'k',state,monthlyRequests:300,gapMs:0,now:()=>t,fetchImpl:async()=>{calls++;return json({web:{results:[]}})}});
  assert.equal(b.dailyAllowance(),10);assert.equal(b.remaining(),10);
  for(let i=0;i<10;i++)await b.serp('q'+i);
  assert.equal(calls,10);assert.equal(b.remaining(),0);assert.equal(b.canSearch(),false);assert.equal(await b.serp('more'),null);assert.equal(calls,10);
  t=Date.parse('2026-11-02T10:00:00Z');assert.equal(b.remaining(),10,'a new day: (300 - 10) / 29 days left');
  const late=new BraveSearch({apiKey:'k',state:{brave_usage:{'2026-11':280}},monthlyRequests:300,now:()=>Date.parse('2026-11-21T08:00:00Z')});
  assert.equal(late.remaining(),2,'20 left over 10 days');
  const last=new BraveSearch({apiKey:'k',state:{brave_usage:{'2026-11':299}},monthlyRequests:300,now:()=>Date.parse('2026-11-30T08:00:00Z')});
  assert.equal(last.remaining(),1,'the monthly cap still holds');
  assert.equal(new BraveSearch({apiKey:'',state:{},now:()=>t}).remaining(),0);
});

test('a link check that gets no 200 is recorded as unverifiable, never read as won or lost',async()=>{
  const state={prospects:{
    a:{id:'a',page_url:'https://down.org/p',status:'sent',history:[{type:'initial',at:ago(6)}]},
    b:{id:'b',page_url:'https://up.org/p',status:'sent',history:[{type:'initial',at:ago(6)}]},
    w:{id:'w',page_url:'https://wonpage.org/p',status:'won',won:{checked_at:ago(20),found_at:ago(30),target:'https://mice.com/'},history:[{type:'initial',at:ago(40)}]}}};
  const f=async u=>{const h=new URL(u).hostname;if(h==='down.org')return new Response('busy',{status:503});if(h==='wonpage.org')throw Error('socket hang up');
    return html('<p>See <a href="https://mice.com/plan">this plan</a></p>')};
  const r=await checkLinks({state,ourDomains:['mice.com'],fetchImpl:f});
  assert.equal(r.checked,3);assert.equal(r.unverifiable,2);assert.equal(r.won,1);assert.equal(r.lost,0);
  const {a,b,w}=state.prospects;
  assert.equal(a.status,'sent');assert.equal(a.link_check.status,503);assert.ok(a.link_check.at);
  assert.equal(w.status,'won');assert.equal(w.link_check.status,0);assert.equal(w.link_check.error,'network');
  assert.equal(b.status,'won');assert.equal(b.link_check.status,200);
});

test('the crawl keeps up to 20 links each page cites from its own content (no menu, footer, social or own links)',()=>{
  const body=`<html><body><nav><a href="https://navpartner.com/">Partner</a></nav><main><h1>Guide</h1><p>${'text '.repeat(300)}</p>
    ${Array.from({length:25},(_,i)=>`<a href="https://source${i}.org/page">Source ${i}</a>`).join(' ')} <a href="https://twitter.com/x">tw</a> <a href="https://ex.com/other">own</a> <a href="https://www.ex.com/more">own www</a></main>
    <footer><a href="https://footerlink.com/">f</a></footer></body></html>`;
  const f=extractFeatures('https://ex.com/guide',body,'ex.com');
  assert.equal(f.external_links.length,20);assert.deepEqual(f.external_links[0],{url:'https://source0.org/page',anchor:'Source 0'});
  assert.ok(!f.external_links.some(l=>/navpartner|footerlink|twitter|ex\.com/.test(l.url)));
});
