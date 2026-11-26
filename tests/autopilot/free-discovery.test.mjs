import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {discoverProspects,neighborSources,footprintOf} from '../../scripts/autopilot/prospect.mjs';
import {BraveSearch,braveQuery} from '../../scripts/autopilot/search.mjs';
import {planWake,isFresh} from '../../scripts/autopilot/waker.mjs';

const html=b=>new Response(b,{headers:{'content-type':'text/html; charset=utf-8'}});
const json=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:{'content-type':'application/json'}});
const words=n=>Array.from({length:n},(_,i)=>['houseplant','care','watering','light','soil','repotting','humidity','plants'][i%8]).join(' ');
const outs=Array.from({length:6},(_,i)=>`<a href="https://ref${i}.org/">r</a>`).join('');
const article=(title,extra='')=>`<html><head><title>${title}</title></head><body><main><h1>${title}</h1><h2>Watering schedule</h2><p>${words(400)} 2026</p>${outs}${extra}</main></body></html>`;
const site={domain:'plantastichaven.com',topic:'houseplant care',assets:[],competitors:[]};
const asset={site:site.domain,url:'https://plantastichaven.com/plant-care-plan/',title:'Houseplant Care Plan Generator',h1:'Houseplant Care Plan Generator',type:'interactive_tool',terms:['houseplant','care','watering']};
const quiet=state=>{state.queries={[`${site.domain}|"plantastichaven" OR "plantastichaven.com" -site:plantastichaven.com`]:new Date().toISOString()};state.mentions_at={[site.domain]:new Date().toISOString()};return state};
const noFunds={enabled:true,canSpend:()=>false,affordable:()=>0,serp:async()=>{throw Error('paid search must not run')},domainTraffic:async()=>{throw Error('paid sizing must not run')}};

test('with no search credit at all, prospects still come from the sites that qualified pages recommend',async()=>{
  const source={id:'src',site:site.domain,domain:'plantlists.org',page_url:'https://plantlists.org/best-plant-blogs',asset_url:asset.url,asset_title:asset.title,status:'sent',resource_page:true,external_domains:14,score:80,history:[]};
  const state=quiet({prospects:{src:source},domains:{[`${site.domain}|plantlists.org`]:'src'}});
  const f=async url=>{const u=new URL(url);
    if(u.hostname==='plantlists.org')return html(`<html><body><main><h1>Best plant blogs</h1><p>${words(300)}</p>
      <a href="https://leafyhome.blog/houseplant-watering-guide/">Leafy Home watering guide</a> <a href="https://www.youtube.com/watch?v=1">video</a>
      <a href="https://plantlists.org/about">about us</a> <a href="https://plantastichaven.com/x">our site</a> <a href="https://files.example.com/care-sheet.pdf">houseplant care sheet</a>
      <a href="https://cars.example.net/engine-oil">engine oil</a></main></body></html>`);
    if(u.hostname==='leafyhome.blog'&&u.pathname.startsWith('/houseplant-watering-guide'))return html(article('Houseplant Watering Guide'));
    if(u.hostname==='leafyhome.blog'&&u.pathname==='/contact')return html('<a href="mailto:hello@leafyhome.blog">mail</a>');
    if(u.hostname==='cars.example.net')return html(article('Engine oil change').replaceAll('houseplant','engine').replaceAll('watering','oil').replaceAll('care','motor'));
    return html('<p>home</p>')};
  const stats=await discoverProspects({assets:[asset],sites:[site],state,dfs:noFunds,fetchImpl:f,perAsset:0,linkGapCalls:0});
  assert.equal(stats.neighbor_pages,1);assert.ok(stats.neighbor_candidates>=2);assert.equal(stats.queries,0);
  const p=Object.values(state.prospects).find(x=>x.domain==='leafyhome.blog');
  assert.equal(p.kind,'neighbor');assert.equal(p.footprint,'neighbor');assert.equal(p.status,'ready');assert.equal(p.email,'hello@leafyhome.blog');
  assert.equal(Object.values(state.prospects).find(x=>x.domain==='cars.example.net').status,'rejected','off-topic recommendations are still rejected by qualification');
  assert.ok(!Object.values(state.prospects).some(x=>/youtube|files\.example|plantastichaven/.test(x.domain)),'platforms, files and our own sites are never candidates');
  assert.ok(source.mined_at,'a source page is mined once, then rests for 90 days');
  assert.equal(neighborSources(state,[site]).filter(x=>x.id==='src').length,0);
  assert.equal(footprintOf('neighbor:plantlists.org',site),'neighbor');
  // The new prospect becomes a source itself next cycle: discovery compounds without any paid lookup.
  assert.ok(neighborSources(state,[site]).some(x=>x.domain==='leafyhome.blog'));
});

test('neighbour sources favour resource pages and advance every site',()=>{
  const mk=(id,s,extra)=>({id,site:s,domain:id+'.com',page_url:`https://${id}.com/p`,status:'ready',external_domains:9,score:60,...extra});
  const state={prospects:{a:mk('a','s1.com'),b:mk('b','s1.com',{resource_page:true}),c:mk('c','s1.com'),d:mk('d','s2.com'),
    thin:mk('thin','s2.com',{external_domains:2}),rej:mk('rej','s2.com',{status:'rejected'}),old:mk('old','gone.com')}};
  const got=neighborSources(state,[{domain:'s1.com'},{domain:'s2.com'}],{max:10,perSite:2});
  assert.deepEqual(got.map(x=>x.id),['b','a','d'],'resource page first; two per site; pages that barely link out, rejected ones and removed sites are skipped');
});

test('Brave fallback: same result shape, real URLs, monthly cap, unsupported operator removed',async()=>{
  assert.equal(braveQuery('houseplant care inurl:resources'),'houseplant care resources');
  assert.equal(braveQuery('intitle:resources houseplant care'),'intitle:resources houseplant care');
  const seen=[];const state={};
  const brave=new BraveSearch({apiKey:'k',state,monthlyRequests:2,gapMs:0,fetchImpl:async(u,o)=>{seen.push([u,o.headers['X-Subscription-Token']]);
    return json({web:{results:[{title:'Leafy Home',url:'https://www.leafyhome.blog/guide',description:'d'},{title:'no url'}]}})}});
  const r=await brave.serp('houseplant care inurl:resources',{location:2826,language:'en'});
  assert.deepEqual(r,[{url:'https://www.leafyhome.blog/guide',domain:'leafyhome.blog',title:'Leafy Home',description:'d',rank:1}]);
  assert.match(seen[0][0],/q=houseplant%20care%20resources&count=20&country=gb&search_lang=en/);assert.equal(seen[0][1],'k');
  assert.equal(brave.remaining(),1);await brave.serp('q2');
  assert.equal(brave.canSearch(),false);assert.equal(await brave.serp('q3'),null,'the monthly cap is never exceeded');assert.equal(seen.length,2);
  const bad=new BraveSearch({apiKey:'wrong',state:{},gapMs:0,fetchImpl:async()=>json({},401)});
  assert.equal(await bad.serp('q'),null);assert.equal(bad.canSearch(),false,'a rejected key stops further requests');
  assert.equal(new BraveSearch({apiKey:'',state:{}}).canSearch(),false);
});

test('searches switch to the fallback only when DataForSEO cannot pay for them',async()=>{
  const page=async url=>{const u=new URL(url);return u.pathname==='/contact'?html('<a href="mailto:ed@indieplants.net">m</a>'):u.hostname==='indieplants.net'?html(article('Houseplant Care Guide')):html('<p>home</p>')};
  const alt=()=>{const calls=[];return {calls,canSearch:()=>true,remaining:()=>50,serp:async q=>{calls.push(q);return [{url:'https://indieplants.net/houseplant-care',domain:'indieplants.net',title:'Houseplant Care Guide',rank:1}]}}};
  const a1=alt(),s1=quiet({});
  const stats=await discoverProspects({assets:[asset],sites:[site],state:s1,dfs:noFunds,altSearch:a1,fetchImpl:page,perAsset:1,linkGapCalls:0,neighborPages:0});
  assert.equal(a1.calls.length,1);assert.equal(stats.fallback_queries,1);assert.equal(stats.queries,1);
  assert.equal(Object.values(s1.prospects)[0].status,'ready',JSON.stringify(Object.values(s1.prospects)[0]).slice(0,400));
  const a2=alt(),dfsCalls=[];
  const funded={enabled:true,canSpend:()=>true,affordable:()=>4,serp:async q=>{dfsCalls.push(q);return []},domainTraffic:async()=>({})};
  const st2=await discoverProspects({assets:[asset],sites:[site],state:quiet({}),dfs:funded,altSearch:a2,fetchImpl:page,perAsset:1,linkGapCalls:0,neighborPages:0});
  assert.equal(dfsCalls.length,1);assert.equal(a2.calls.length,0,'DataForSEO stays the primary source while it has funds');assert.equal(st2.fallback_queries,undefined);
});

test('waker chain: a cycle it started is never followed in under 2 h, even if that cycle published nothing',()=>{
  const now=Date.parse('2026-11-26T08:40:00Z');
  const stale={generated_at:'2026-11-26T04:44:54Z',capabilities:{outreach_mode:'send'},outreach:{ready:66,next_send_at:'2026-11-26T04:44:54Z',reply_health:'ok'}};
  assert.equal(planWake(stale,now).wait_s,0,'overdue: start now');
  const chained=planWake(stale,now,{after:'2026-11-26T08:39:00Z'});
  assert.equal(chained.at,'2026-11-26T10:39:00.000Z');assert.equal(chained.wait_s,2*3600-60);
  assert.equal(planWake(stale,now,{after:'not a date'}).wait_s,0,'a bad value is ignored');
  assert.equal(isFresh(stale,'2026-11-26T04:00:00Z'),true);assert.equal(isFresh(stale,'2026-11-26T05:00:00Z'),false);assert.equal(isFresh(null,'2026-11-26T05:00:00Z'),false);
});

test('the waker workflow starts its own successor and never interpolates input into a script',()=>{
  const y=readFileSync(new URL('../../.github/workflows/autopilot-waker.yml',import.meta.url),'utf8');
  assert.match(y,/workflow_dispatch:/);assert.match(y,/gh workflow run autopilot-waker\.yml --ref main -f after="\$STARTED"/);
  assert.match(y,/AFTER: \$\{\{ inputs\.after \}\}/,'the input reaches the script through an environment variable');
  const scripts=y.split(/\n\s+run: /).slice(1).join('\n');
  assert.ok(!/\$\{\{\s*inputs\./.test(scripts.replace(/env:[\s\S]*?run:/g,'')),'no ${{ inputs.* }} inside a run script');
  assert.match(y,/the chain ends here/);assert.match(y,/cancel-in-progress: true/);
});
