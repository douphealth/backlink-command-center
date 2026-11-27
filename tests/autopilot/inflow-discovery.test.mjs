import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverProspects,qualifyPage,listShape,fitExcerpt,rejectionKind,expireRejections,backfillRejections,probeResourcePage,citedCandidates,footprintOf} from '../../scripts/autopilot/prospect.mjs';

const html=b=>new Response(b,{headers:{'content-type':'text/html; charset=utf-8'}});
const xml=b=>new Response(b,{headers:{'content-type':'application/xml'}});
const nf=()=>new Response('nf',{status:404});
const words=n=>Array.from({length:n},(_,i)=>['houseplant','care','watering','light','soil','repotting','humidity','plants'][i%8]).join(' ');
const outs=Array.from({length:6},(_,i)=>`<a href="https://ref${i}.org/">r</a>`).join('');
const article=(title,extra='')=>`<html><head><title>${title}</title></head><body><main><h1>${title}</h1><h2>Watering schedule</h2><p>${words(400)} 2026</p>${outs}${extra}</main></body></html>`;
const site={domain:'plantastichaven.com',topic:'houseplant care',assets:[],competitors:[]};
const general={site:site.domain,url:'https://plantastichaven.com/plant-care-plan/',title:'Houseplant Care Plan Generator',h1:'Houseplant Care Plan Generator',type:'interactive_tool',terms:['houseplant','care','plan']};
const snake={site:site.domain,url:'https://plantastichaven.com/snake-plant-watering/',title:'Snake Plant Watering Calculator',h1:'Snake Plant Watering Calculator',type:'interactive_tool',terms:['snake','plant','watering','calculator']};
const ago=d=>new Date(Date.now()-d*86400e3).toISOString();
const quiet=state=>{state.queries={...(state.queries||{}),[`${site.domain}|"plantastichaven" OR "plantastichaven.com" -site:plantastichaven.com`]:new Date().toISOString()};state.mentions_at={[site.domain]:new Date().toISOString()};return state};
const noFunds={enabled:true,canSpend:()=>false,affordable:()=>0,serp:async()=>{throw Error('paid search must not run')},domainTraffic:async()=>{throw Error('paid sizing must not run')}};

test('rejections are classified by what could change: a page (30 d), a server (14 d) or the publisher (never)',()=>{
  const k=r=>{const x=rejectionKind(r);return `${x.kind}:${x.code}`};
  assert.equal(k('HTTP 503'),'transient:http_5xx');assert.equal(k('HTTP timeout'),'transient:timeout');assert.equal(k('HTTP network'),'transient:fetch_error');assert.equal(k('HTTP 429'),'transient:http_429');
  assert.equal(k('HTTP 404'),'page:http_4xx');assert.equal(k('Thin page; Rarely links out'),'page:thin');assert.equal(k('Low fit score'),'page:low_fit');assert.equal(k('Weak topical match'),'page:weak_match');
  assert.equal(k('List of the publisher\'s own products only'),'page:own_products_list');assert.equal(k('Page looks compromised (injected spam links)'),'page:compromised');
  assert.equal(k('Software vendor (competing product)'),'publisher:vendor');assert.equal(k('Local service business'),'publisher:local_business');
  assert.equal(k('Page is not in English (deu)'),'publisher:language');assert.equal(k('Automated site-info page, not an editorial mention'),'publisher:site_info');
  assert.equal(k('Very large brand (unlikely to add outreach links)'),'publisher:traffic');
});

test('page-level and transient rejections expire; publisher-level, contacted and suppressed publishers stay blocked',()=>{
  const keys=['page.org','flaky.org','vendor.io','talked.org','optout.org','fresh.org','requalified.org'].map(d=>`s.com|${d}`);
  const state={domains:Object.fromEntries(keys.map((k,i)=>[k,'p'+i])),prospects:{p6:{id:'p6',status:'ready'}},contacted:{'talked.org':ago(100)},suppression:{'optout.org':{reason:'Opt-out'}},
    domain_rejections:{'s.com|page.org':{at:ago(31),kind:'page',code:'low_fit'},'s.com|flaky.org':{at:ago(15),kind:'transient',code:'http_5xx'},'s.com|vendor.io':{at:ago(400),kind:'publisher',code:'vendor'},
      's.com|talked.org':{at:ago(40),kind:'page',code:'thin'},'s.com|optout.org':{at:ago(40),kind:'page',code:'thin'},'s.com|fresh.org':{at:ago(10),kind:'page',code:'thin'},'s.com|requalified.org':{at:ago(40),kind:'page',code:'thin'}}};
  assert.equal(expireRejections(state),2);
  assert.deepEqual(Object.keys(state.domains).sort(),['s.com|fresh.org','s.com|optout.org','s.com|requalified.org','s.com|talked.org','s.com|vendor.io']);
  assert.deepEqual(Object.keys(state.domain_rejections).sort(),['s.com|fresh.org','s.com|vendor.io']);
  assert.equal(expireRejections({}),0);
});

test('rejections made before expiry existed are backfilled once from the records still kept',()=>{
  const state={domains:{'s.com|a.org':'a','s.com|b.org':'b','s.com|c.org':'x'},prospects:{a:{id:'a',site:'s.com',domain:'a.org',status:'rejected',reason:'HTTP 502',found_at:ago(20)},
    b:{id:'b',site:'s.com',domain:'b.org',status:'ready'},c:{id:'c',site:'s.com',domain:'c.org',status:'rejected',reason:'Thin page'}}};
  assert.equal(backfillRejections(state),1);assert.deepEqual(state.domain_rejections['s.com|a.org'],{at:state.prospects.a.found_at,kind:'transient',code:'http_5xx'});
  assert.equal(backfillRejections(state),0,'one-off');
  assert.equal(expireRejections(state),1);assert.equal(state.domains['s.com|a.org'],undefined);
});

test('an expired page-level rejection lets a recommended site be evaluated again; a publisher-level one does not',async()=>{
  const source={id:'src',site:site.domain,domain:'plantlists.org',page_url:'https://plantlists.org/best-plant-blogs',asset_url:general.url,asset_title:general.title,status:'sent',resource_page:true,external_domains:14,score:80,history:[]};
  const state=quiet({prospects:{src:source},domains:{[`${site.domain}|plantlists.org`]:'src',[`${site.domain}|leafyhome.blog`]:'old',[`${site.domain}|vendorplants.com`]:'old2'},
    domain_rejections:{[`${site.domain}|leafyhome.blog`]:{at:ago(31),kind:'page',code:'low_fit'},[`${site.domain}|vendorplants.com`]:{at:ago(31),kind:'publisher',code:'vendor'}}});
  const f=async url=>{const u=new URL(url);
    if(u.hostname==='plantlists.org')return html(`<main><h1>Best plant blogs</h1><p>${words(300)}</p><a href="https://leafyhome.blog/houseplant-watering-guide/">houseplant watering guide</a> <a href="https://vendorplants.com/houseplant-care">houseplant care tips</a></main>`);
    if(u.hostname==='leafyhome.blog'&&u.pathname.startsWith('/houseplant-watering-guide'))return html(article('Houseplant Watering Guide'));
    if(u.hostname==='leafyhome.blog'&&u.pathname==='/contact')return html('<a href="mailto:hello@leafyhome.blog">mail</a>');
    return html('<p>home</p>')};
  const stats=await discoverProspects({assets:[general],sites:[site],state,dfs:noFunds,fetchImpl:f,perAsset:0,linkGapCalls:0});
  assert.equal(stats.rejections_expired,1);
  assert.equal(Object.values(state.prospects).find(p=>p.domain==='leafyhome.blog')?.status,'ready');
  assert.equal(stats.filtered.already_evaluated,1,'the vendor stays blocked');assert.ok(state.domain_rejections[`${site.domain}|vendorplants.com`]);
});

test('paid searches pause while the watchdog says so; link gap and the free fallback continue',async()=>{
  const s2={...site,competitors:['plantcaretoday.com']};let backlinkCalls=0,paidSerp=0;
  const dfs={enabled:true,canSpend:()=>true,affordable:()=>4,serp:async()=>{paidSerp++;return []},domainTraffic:async()=>({}),backlinks:async()=>{backlinkCalls++;return {total:0,items:[]}}};
  const state={paid_serp_paused_until:new Date(Date.now()+3*86400e3).toISOString()};
  const stats=await discoverProspects({assets:[general],sites:[s2],state,dfs,fetchImpl:async()=>nf(),perAsset:2,linkGapCalls:1,neighborPages:0});
  assert.equal(paidSerp,0,'no paid SERP call, brand-mention searches included');assert.equal(stats.queries,0);assert.equal(stats.paid_serp_paused,true);assert.equal(backlinkCalls,1);
  const alt={calls:0,canSearch:()=>true,remaining:()=>10,serp:async()=>{alt.calls++;return []}};
  const st2=await discoverProspects({assets:[general],sites:[s2],state:{paid_serp_paused_until:state.paid_serp_paused_until},dfs,altSearch:alt,fetchImpl:async()=>nf(),perAsset:1,linkGapCalls:0,neighborPages:0});
  assert.equal(paidSerp,0);assert.ok(alt.calls>0);assert.equal(st2.fallback_queries,alt.calls);
  await discoverProspects({assets:[general],sites:[s2],state:{paid_serp_paused_until:ago(1)},dfs,fetchImpl:async()=>nf(),perAsset:1,linkGapCalls:0,neighborPages:0});
  assert.ok(paidSerp>0,'searches resume once the pause has passed');
});

test('sites with no sends are seeded from the pages our own articles cite; the pitched page is chosen after reading theirs',async()=>{
  const mice={domain:'micegoneguide.com',topic:'mouse proofing home',assets:[],competitors:[]};
  const mouse={site:mice.domain,url:'https://micegoneguide.com/plan/',title:'Mouse Proofing Plan',type:'interactive_tool',terms:['mouse']};
  const crawl=[{site:site.domain,pages:[{url:'https://plantastichaven.com/plant-care-plan',final_url:'https://plantastichaven.com/plant-care-plan/',status:200,external_links:[
      {url:'https://snakeplantblog.net/watering-snake-plants/',anchor:'snake plant watering tips'},{url:'https://www.youtube.com/watch?v=1',anchor:'video'},{url:'https://micegoneguide.com/x',anchor:'sister site'},
      {url:'https://thinpage.net/plants',anchor:'plants'},{url:'https://downsite.net/care',anchor:'care'},{url:'https://heldblog.net/houseplant-care-guide',anchor:'houseplant care'}]}]},
    {site:mice.domain,pages:[{url:'https://micegoneguide.com/a',status:200,external_links:[{url:'https://mousesite.org/a',anchor:'mice'}]}]}];
  const state=quiet({prospects:{sent:{id:'sent',site:mice.domain,domain:'x.org',status:'sent',history:[{type:'initial',mode:'send',at:ago(3)}]}}});
  state.mentions_at[mice.domain]=new Date().toISOString();state.queries[`${mice.domain}|"micegoneguide" OR "micegoneguide.com" -site:micegoneguide.com`]=new Date().toISOString();
  const f=async url=>{const u=new URL(url);
    if(u.hostname==='snakeplantblog.net'&&u.pathname.startsWith('/watering-snake-plants'))return html(article('How to Water Snake Plants'));
    if(u.hostname==='snakeplantblog.net'&&u.pathname==='/contact')return html('<a href="mailto:hello@snakeplantblog.net">mail</a>');
    if(u.hostname==='thinpage.net')return html('<p>Plants.</p>');
    if(u.hostname==='downsite.net')return new Response('down',{status:503});
    if(u.hostname==='heldblog.net'&&u.pathname.startsWith('/houseplant-care-guide'))return html(article('Houseplant Care Guide'));
    if(u.hostname==='heldblog.net'&&u.pathname==='/about')return html('<p>Me: sam@heldblog.net</p>');
    return nf()};
  const stats=await discoverProspects({assets:[],pairPool:[general,snake,mouse],sites:[site,mice],state,dfs:noFunds,fetchImpl:f,perAsset:0,linkGapCalls:0,neighborPages:0,crawl});
  assert.equal(stats.cited_candidates,4,'platforms and our own sites are dropped; the site that already sends is not seeded');
  assert.ok(!Object.values(state.prospects).some(p=>p.domain==='mousesite.org'));
  const p=Object.values(state.prospects).find(x=>x.domain==='snakeplantblog.net');
  assert.equal(p.status,'ready');assert.equal(p.kind,'cited');assert.equal(p.footprint,'cited_by_us');assert.equal(footprintOf(p.query,site),'cited_by_us');
  assert.deepEqual(p.cited_by_us,{our_url:'https://plantastichaven.com/plant-care-plan/'});
  assert.equal(p.asset_url,snake.url,'paired with our page about what their page covers');
  assert.equal(stats.with_email,1);assert.equal(stats.held_address,1);
  const held=Object.values(state.prospects).find(x=>x.domain==='heldblog.net');
  assert.equal(held.status,'contact_unverifiable','an address the send rules hold never makes a prospect ready');assert.equal(held.contact_quality.detail,'only_non_editorial_inbox_published');
  assert.deepEqual(state.domain_rejections[`${site.domain}|thinpage.net`],{at:state.domain_rejections[`${site.domain}|thinpage.net`].at,kind:'page',code:'thin'});
  assert.equal(state.domain_rejections[`${site.domain}|downsite.net`].kind,'transient');
  // Nothing is seeded twice: every cited publisher is now evaluated.
  assert.equal(citedCandidates(state,[site],crawl,{pitchList:()=>[general]}).length,0,'a site with a ready prospect is no longer seeded');
});

test('a recommended homepage leads to the site\'s own resource page (at most two extra fetches)',async()=>{
  const source={id:'src',site:site.domain,domain:'plantlists.org',page_url:'https://plantlists.org/best-plant-blogs',asset_url:general.url,asset_title:general.title,status:'sent',resource_page:true,external_domains:14,score:80,history:[]};
  const state=quiet({prospects:{src:source},domains:{[`${site.domain}|plantlists.org`]:'src'}});
  const f=async url=>{const u=new URL(url);
    if(u.hostname==='plantlists.org')return html(`<main><h1>Best plant blogs</h1><p>${words(300)}</p><a href="https://indieblog.net/">Indie houseplant care blog</a></main>`);
    if(u.hostname==='indieblog.net'&&u.pathname==='/')return html('<nav><a href="/resources/">Resources</a> <a href="/contact/">Contact</a></nav><main><h1>Indie Blog</h1><p>Welcome.</p></main>');
    if(u.hostname==='indieblog.net'&&u.pathname.replace(/\/$/,'')==='/resources')return html(article('Houseplant Care Resources'));
    if(u.hostname==='indieblog.net'&&u.pathname==='/contact')return html('<h1>Contact</h1><a href="mailto:editor@indieblog.net">Email the editor</a>');
    return nf()};
  const stats=await discoverProspects({assets:[general],sites:[site],state,dfs:noFunds,fetchImpl:f,perAsset:0,linkGapCalls:0});
  const p=Object.values(state.prospects).find(x=>x.domain==='indieblog.net');
  assert.equal(p.page_url,'https://indieblog.net/resources');assert.equal(p.status,'ready');assert.equal(p.email,'editor@indieblog.net');assert.equal(stats.resource_pages_found,1);
});

test('the resource-page probe never makes more than two fetches',async()=>{
  const counting=routes=>{const seen=[];return {seen,f:async u=>{seen.push(u);const k=new URL(u).pathname;const r=routes[k]||routes[k.replace(/\/$/,'')];return r?r():nf()}}};
  const home='<main><h1>Blog</h1></main>';
  const a=counting({'/useful-links':()=>html(article('Useful links'))});
  const linked=await probeResourcePage('https://b.net/','<a href="/useful-links">Useful links</a>',{fetchImpl:a.f,domain:'b.net'});
  assert.equal(linked.url,'https://b.net/useful-links');assert.equal(a.seen.length,1);
  const b=counting({'/sitemap.xml':()=>xml('<urlset><url><loc>https://b.net/links/</loc></url><url><loc>https://b.net/houseplant-resources/</loc></url><url><loc>https://other.net/resources/</loc></url></urlset>'),
    '/houseplant-resources':()=>html(article('Houseplant resources')),'/links':()=>html('x')});
  const fromMap=await probeResourcePage('https://b.net/',home,{fetchImpl:b.f,domain:'b.net',terms:['houseplant']});
  assert.equal(new URL(fromMap.url).pathname,'/houseplant-resources/');assert.equal(b.seen.length,2);
  const c=counting({'/sitemap.xml':()=>xml('<sitemapindex><sitemap><loc>https://b.net/page-sitemap.xml</loc></sitemap></sitemapindex>')});
  assert.equal(await probeResourcePage('https://b.net/',home,{fetchImpl:c.f,domain:'b.net'}),null);assert.equal(c.seen.length,1);
  const d=counting({});
  assert.equal(await probeResourcePage('https://b.net/','<a href="/resources/">Resources</a>',{fetchImpl:d.f,domain:'b.net'}),null);assert.equal(d.seen.length,1);
});

test('roundups and "best X" lists are recognised; lists of the publisher\'s own products and hacked pages are rejected',()=>{
  const opts={asset:general,site,ourDomains:[site.domain]};
  const list=`<html><head><title>10 Best Houseplant Care Apps (2026)</title></head><body><main><h1>10 Best Houseplant Care Apps</h1>${[1,2,3,4,5,6].map(i=>`<h2>${i}. App ${i}</h2><p>${words(60)} <a href="https://app${i}.io/">App ${i}</a></p>`).join('')}<h2>Other notable apps</h2><p>${words(40)}</p></main></body></html>`;
  const q=qualifyPage('https://plantlists.org/best-apps',list,opts);
  assert.deepEqual(q.list_page,{items:6,title:'10 Best Houseplant Care Apps',other_section:true});assert.equal(q.qualified,true);
  assert.equal(qualifyPage('https://x.org/guide',article('Houseplant Watering Guide'),opts).list_page,null,'an ordinary guide is not a list');
  const own=`<html><head><title>Best Plant Care Tools</title><meta property="og:site_name" content="PlantPal"></head><body><main><h1>The 5 best plant care tools</h1>${[1,2,3,4].map(i=>`<h2>${i}. PlantPal Tool ${i}</h2><p>${words(80)} <a href="/products/tool-${i}">Get it</a></p>`).join('')}</main>
    <footer><a href="https://facebook.com/plantpal">fb</a><a href="https://twitter.com/plantpal">tw</a><a href="https://pinterest.com/plantpal">pin</a></footer></body></html>`;
  const o=qualifyPage('https://plantpal.com/best-tools',own,opts);
  assert.equal(o.qualified,false);assert.ok(o.reasons.some(r=>/own products/.test(r)));assert.equal(o.list_page,null);
  assert.equal(listShape(own,'https://plantpal.com/best-tools','Best Plant Care Tools').ownOnly,true);
  const hacked=article('Houseplant Watering Guide','<div><a href="https://spam1.biz/">best online casino</a> <a href="https://spam2.biz/">payday loans today</a></div>');
  const h=qualifyPage('https://hacked.org/guide',hacked,opts);assert.equal(h.qualified,false);assert.ok(h.reasons.some(r=>/compromised/.test(r)));
});

test('the matched section\'s own words are kept for the pitch (600 characters at most)',()=>{
  const q=qualifyPage('https://x.org/guide',article('Houseplant Watering Guide'),{asset:snake,site,ourDomains:[site.domain]});
  assert.equal(q.fit_section,'Watering schedule');assert.ok(q.fit_excerpt.startsWith('houseplant care watering light'));assert.ok(q.fit_excerpt.length<=600);
  assert.equal(fitExcerpt('<h2>Pricing</h2><p>x</p>','Missing heading',['zzz']),null);
  const prose=`<main><p>${'Unrelated words here. '.repeat(20)}</p><p>Repotting a houseplant needs fresh soil. Then water it well.</p></main>`;
  assert.match(fitExcerpt(prose,null,['repotting','soil']),/^Repotting a houseplant needs fresh soil\./);
});
