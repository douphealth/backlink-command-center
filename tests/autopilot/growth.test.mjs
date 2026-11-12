import test from 'node:test';
import assert from 'node:assert/strict';
import {outboundCandidates,checkDead,findBrokenLink,assetTerms} from '../../scripts/autopilot/broken.mjs';
import {templatePitch,brokenLinkPitch,assetFacts} from '../../scripts/autopilot/pitch.mjs';
import {runOutreach,dailyCap,restartRampIfIdle,lastSendAt} from '../../scripts/autopilot/outreach.mjs';
import {indexationReport,pageIssue} from '../../scripts/autopilot/indexation.mjs';
import {validTarget} from '../../scripts/autopilot/dataforseo.mjs';
import {freshQueryCount,queriesFor,enrichBrokenLinks} from '../../scripts/autopilot/prospect.mjs';
import {chooseAssets,loadConfig,setupChecklist,funnel} from '../../scripts/autopilot/run.mjs';
import {linkLikelihood} from '../../scripts/autopilot/learn.mjs';

const resp=(body,{status=200,type='text/html; charset=utf-8'}={})=>new Response(body,{status,headers:{'content-type':type}});
const nx=async()=>{const e=Error('nx');e.code='ENOTFOUND';throw e};
const resolves=async()=>['1.2.3.4'];
const page=`<html><body><nav><a href="https://navsite.com/running-shoes">running shoes</a></nav><article>${'Intro text about running and shoes. '.repeat(40)}
 <a href="https://deadshoes.com/shoe-fit-guide">shoe fit guide</a> <a href="https://alive.com/running-shoes">running shoe reviews</a>
 <a href="https://facebook.com/running-shoes">share</a> <a href="https://blog.example/other">our other post</a>
 <a href="https://cooking.com/recipes">pasta recipes</a></article><footer><a href="https://footer.com/shoes">shoes</a></footer></body></html>`;

test('outbound candidates come from the article body, skip social/same-site, most relevant first',()=>{
  const c=outboundCandidates(page,'https://blog.example/resources',{terms:['running','shoes','shoe','fit']});
  const urls=c.map(x=>x.url);
  assert.ok(!urls.some(u=>/navsite|footer|facebook|blog\.example/.test(u)),urls.join());
  assert.ok(urls.includes('https://deadshoes.com/shoe-fit-guide')&&urls.includes('https://cooking.com/recipes'));
  assert.equal(c.at(-1).url,'https://cooking.com/recipes');assert.equal(c.at(-1).relevance,0);
});
test('only 404/410 or a vanished domain count as dead; blocks, errors and live hosts never do',async()=>{
  const at=status=>async()=>resp('x',{status});
  assert.deepEqual((await checkDead('https://a.com/x',{fetchImpl:at(404),resolveHost:resolves})).dead,true);
  assert.equal((await checkDead('https://a.com/x',{fetchImpl:at(410),resolveHost:resolves})).reason,'gone');
  for(const s of [200,403,429,500,503])assert.equal((await checkDead('https://a.com/x',{fetchImpl:at(s),resolveHost:nx})).dead,false,String(s));
  const down=async()=>{throw new TypeError('fetch failed')};
  assert.deepEqual(await checkDead('https://gone.com/x',{fetchImpl:down,resolveHost:nx}),{dead:true,status:0,reason:'domain_gone'});
  assert.equal((await checkDead('https://flaky.com/x',{fetchImpl:down,resolveHost:resolves})).dead,false);
  const servfail=async()=>{const e=Error('x');e.code='ESERVFAIL';throw e};
  assert.equal((await checkDead('https://flaky.com/x',{fetchImpl:down,resolveHost:servfail})).dead,false);
});
test('finds the relevant dead link and ignores unrelated dead ones',async()=>{
  const f=async u=>resp('x',{status:/deadshoes|cooking/.test(u)?404:200});
  const b=await findBrokenLink(page,'https://blog.example/resources',{terms:['running','shoes','shoe','fit'],fetchImpl:f,resolveHost:resolves});
  assert.equal(b.url,'https://deadshoes.com/shoe-fit-guide');assert.equal(b.host,'deadshoes.com');assert.equal(b.reason,'not_found');
  const none=await findBrokenLink(page,'https://blog.example/resources',{terms:['running'],fetchImpl:async u=>resp('x',{status:/cooking/.test(u)?404:200}),resolveHost:resolves});
  assert.equal(none,null);
});
const site={domain:'gearuptofit.com',topic:'running shoes'};
const asset={url:'https://gearuptofit.com/shoe-finder',title:'Running Shoe Finder | GearUpToFit',description:'Answer six questions and get matched to running shoes by gait and terrain.',interactive:true,words:1900,type:'interactive_tool',reasons:['2 data tables','Under-linked internally (0 inbound)','Flagship asset']};
test('asset facts are crawl-derived and never include internal ranking notes',()=>{
  assert.deepEqual(assetFacts(asset),['it is a free interactive tool (no sign-up needed)','it includes 2 data tables']);
  assert.deepEqual(assetTerms(asset,site).slice(0,3),['running','shoes','shoe']);
});
test('broken-link pitch names the dead link without its URL and carries exactly one URL (ours)',()=>{
  const p={id:'x',title:'Resources for New Runners',author:'Jane Doe',broken_link:{url:'https://deadshoes.com/shoe-fit-guide',anchor:'shoe fit guide',host:'deadshoes.com',reason:'domain_gone'}};
  const out=templatePitch(p,asset,{senderName:'Alex',site});
  assert.deepEqual(out,brokenLinkPitch(p,asset,{senderName:'Alex',site}));
  assert.match(out.subject,/^Broken link on "Resources for New Runners"$/);
  assert.match(out.body,/^Hi Jane,/);assert.match(out.body,/"shoe fit guide" \(deadshoes\.com\) points to a domain that no longer exists/);
  assert.deepEqual(out.body.match(/https?:\/\/\S+/g),[asset.url]);
  assert.doesNotMatch(out.body,/Under-linked|Flagship/);assert.match(out.body,/reply "no"/);
});
test('standard pitch stays specific and honest',()=>{
  const out=templatePitch({id:'y',title:'Best Running Resources',fit_section:'Choosing shoes'},asset,{senderName:'Alex',site});
  assert.match(out.body,/^Hi there,/);assert.match(out.body,/"Choosing shoes" section in "Best Running Resources"/);
  assert.deepEqual(out.body.match(/https?:\/\/\S+/g),[asset.url]);assert.doesNotMatch(out.body,/word guide/); // tools are not described as articles
});
function outreachFixture(){
  const sent=[],now=new Date().toISOString();
  const pr={id:'a',domain:'pub.example',site:'gearuptofit.com',page_url:'https://pub.example/resources',asset_url:asset.url,email:'editor@pub.example',qv:2,status:'ready',history:[],
    broken_link:{url:'https://deadshoes.com/x',anchor:'shoe fit guide',host:'deadshoes.com',reason:'not_found'}};
  const proof=p=>({ok:true,email:p.email,evidence:{source:'https://pub.example/contact',email:p.email,rank:95,observed_at:now},verification:{status:'valid'}});
  const state={prospects:{a:pr},reply_health:{status:'ok',checked_at:now},suppression:{},contacted:{}};
  const written=[];
  return {sent,state,pr,written,args:{state,assets:[asset],sites:[site],writer:{write:async p=>{written.push(structuredClone(p));return {subject:'s',body:'b'}}},
    mailer:{send:async m=>sent.push(m),draft:async()=>{}},config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'me@gearuptofit.com',senderName:'Alex',gapMs:()=>0,sendWindow:false}}};
}
test('a dead-link claim is re-checked right before writing; a fixed link drops the claim',async()=>{
  const live=outreachFixture();live.args.config.recheckBroken=async()=>({dead:false});
  await runOutreach(live.args);assert.equal(live.written[0].broken_link,undefined);assert.ok(live.pr.broken_link_cleared_at);
  const dead=outreachFixture();dead.args.config.recheckBroken=async()=>({dead:true});
  const r=await runOutreach(dead.args);assert.equal(dead.written[0].broken_link.host,'deadshoes.com');assert.equal(r.broken_link_pitches,1);
  const err=outreachFixture();err.args.config.recheckBroken=async()=>{throw Error('net')};
  await runOutreach(err.args);assert.equal(err.written[0].broken_link,undefined);
});
test('warm-up ramp restarts at 5/day after a week without sending',()=>{
  const old=new Date(Date.now()-20*864e5).toISOString();
  const state={first_send_at:old,prospects:{a:{history:[{type:'initial',at:new Date(Date.now()-10*864e5).toISOString(),mode:'send'}]}}};
  assert.equal(dailyCap(state,12),12);
  restartRampIfIdle(state);assert.equal(dailyCap(state,12),5);
  const active={first_send_at:old,prospects:{a:{history:[{type:'initial',at:new Date(Date.now()-864e5).toISOString(),mode:'send'}]}}};
  restartRampIfIdle(active);assert.equal(active.ramp_started_at,undefined);assert.equal(dailyCap(active,12),12);
  assert.equal(lastSendAt({prospects:{a:{history:[{type:'initial',at:'2026-01-01',mode:'draft'}]}}}),null);
});
test('indexation report classifies sitemap URLs that cannot be indexed',()=>{
  const base={status:200,technical_status:'technically_eligible',canonical:'https://s.com/a',words:900};
  const pages=[{...base,url:'https://s.com/a'},{...base,url:'https://s.com/gone',status:404},{...base,url:'https://s.com/n',noindex:true,technical_status:'blocked_noindex'},
    {...base,url:'https://s.com/c',technical_status:'blocked_canonical',canonical:'https://s.com/a'},{...base,url:'https://s.com/r',final_url:'https://s.com/a',technical_status:'redirect_requires_review'},
    {...base,url:'https://s.com/t',words:120},{...base,url:'https://s.com/tool',words:120,interactive:true},{...base,url:'https://s.com/nc',canonical:null},{...base,url:'https://s.com/e',status:503}];
  assert.deepEqual(pages.map(pageIssue),[null,'not_found','noindex','canonical_mismatch','redirect','thin',null,'missing_canonical','server_error']);
  const r=indexationReport([{site:'s.com',pages}]);
  assert.equal(r.total_issues,7);assert.equal(r.sites[0].critical,4);assert.equal(r.sites[0].healthy,2);
  assert.equal(r.issues[0].issue,'not_found');assert.equal(r.issues.find(x=>x.issue==='redirect').final_url,'https://s.com/a');
});
test('DataForSEO bulk targets are sanitised so one bad domain cannot fail the batch',()=>{
  assert.deepEqual(['Foo.COM','www.a.co.uk','https://x.io/p','b.com:443','bücher.de','-x.com','a.b'].map(validTarget),['foo.com','a.co.uk','x.io','b.com','','','']);
});
test('asset rotation skips pages whose searches are all on cooldown',()=>{
  const s={domain:'gearuptofit.com',topic:'running shoes'};
  const a1={site:s.domain,url:'https://gearuptofit.com/a',title:'Shoe Finder',type:'interactive_tool',linkability:80,promotion:90};
  const a2={site:s.domain,url:'https://gearuptofit.com/b',title:'Trail Shoe Guide',type:'practical_guide',linkability:70,promotion:60};
  const state={queries:{}};for(const q of queriesFor(a1,s))state.queries[`${s.domain}|${q.q}`]=new Date().toISOString();
  assert.equal(freshQueryCount(a1,s,state),0);assert.ok(freshQueryCount(a2,s,state)>5);
  assert.deepEqual(chooseAssets([a1,a2],state,{perSite:1,sites:[s]}).map(a=>a.url),[a2.url]);
  assert.deepEqual(chooseAssets([a1,a2],state,{perSite:1}).map(a=>a.url),[a1.url]); // legacy behaviour without sites
});
test('verifier opt-in and budget can come from the dashboard settings secret',()=>{
  const cfg=loadConfig({HUNTER_API_KEY:'k',LINKFORGE_SETTINGS:JSON.stringify({EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:'500'})},[]);
  assert.deepEqual(cfg.verifier,{providers:['hunter'],enabled:true,dailyLimit:100});
  assert.equal(setupChecklist(cfg).find(x=>x.key.startsWith('VERIFALIA')).done,true);
  const both=loadConfig({VERIFALIA_USERNAME:'u',VERIFALIA_PASSWORD:'p',HUNTER_API_KEY:'k',EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:'12'},[]);
  assert.deepEqual(both.verifier.providers,['verifalia','hunter']);
  const off=loadConfig({HUNTER_API_KEY:'test-api-key',EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:'5'},[]);
  assert.equal(setupChecklist(off).find(x=>x.key.startsWith('VERIFALIA')).done,false);
});
test('dead-link prospects rank higher and are counted in the funnel',()=>{
  const p={score:60,etv:2000,email:'editor@x.com',email_rank:80,domain:'x.com'};
  assert.equal(linkLikelihood({...p,broken_link:{}})-linkLikelihood(p),15);
  assert.equal(funnel({prospects:{a:{status:'ready',broken_link:{}},b:{status:'ready'}},domains:{}}).broken_link_ready,1);
});
test('queued prospects are back-filled with dead-link evidence once per 30 days',async()=>{
  const state={prospects:{a:{id:'a',status:'ready',site:site.domain,page_url:'https://blog.example/resources',asset_url:asset.url,score:70,history:[]},
    b:{id:'b',status:'sent',site:site.domain,page_url:'https://blog.example/x',asset_url:asset.url,history:[{type:'initial'}]}}};
  const f=async u=>u.startsWith('https://blog.example/')?resp(page):resp('x',{status:/deadshoes/.test(u)?404:200});
  const r=await enrichBrokenLinks({state,assets:[asset],sites:[site],fetchImpl:f,resolveHost:resolves});
  assert.deepEqual(r,{checked:1,found:1});assert.equal(state.prospects.a.broken_link.host,'deadshoes.com');assert.equal(state.prospects.b.broken_link,undefined);
  assert.deepEqual(await enrichBrokenLinks({state,assets:[asset],sites:[site],fetchImpl:f,resolveHost:resolves}),{checked:0,found:0});
});

test('a saved Verifalia login turns free verification on at 12/day unless the owner set a limit',async()=>{
  const {verifierDefaults}=await import('../../scripts/autopilot/run.mjs');
  const v={VERIFALIA_USERNAME:'u',VERIFALIA_PASSWORD:'p',EMAIL_VERIFICATION_ENABLED:'NO',EMAIL_VERIFY_DAILY_LIMIT:'0'};
  assert.equal(loadConfig(v,[]).verifier.enabled,true);assert.equal(loadConfig(v,[]).verifier.dailyLimit,24);
  const off={...v,LINKFORGE_SETTINGS:JSON.stringify({EMAIL_VERIFICATION_ENABLED:'NO',EMAIL_VERIFY_DAILY_LIMIT:'0'})};
  assert.equal(loadConfig(off,[]).verifier.enabled,false);
  assert.equal(loadConfig({...v,VERIFALIA_ALLOW_PAID:'YES'},[]).verifier.enabled,false); // paid use needs an explicit opt-in
  assert.equal(loadConfig({HUNTER_API_KEY:'k',EMAIL_VERIFICATION_ENABLED:'NO'},[]).verifier.enabled,false); // paid providers never default on
  assert.equal(verifierDefaults({...v,EMAIL_VERIFY_DAILY_LIMIT:'5'}).EMAIL_VERIFY_DAILY_LIMIT,'5');
});
test('search results are never discarded: unqualified candidates are queued and processed first next run',async()=>{
  const {discoverProspects}=await import('../../scripts/autopilot/prospect.mjs');
  const s={domain:'gearuptofit.com',topic:'running shoes'};
  const serps=[];const dfs={canSpend:()=>true,affordable:()=>10,serp:async q=>{serps.push(q);return [{url:`https://pub${serps.length}.example/resources`,domain:`pub${serps.length}.example`,title:'Running resources',rank:1}]},domainTraffic:async ds=>Object.fromEntries(ds.map(d=>[d,5000]))};
  const state={queries:{},prospects:{},domains:{}};
  const assets=[{site:s.domain,url:'https://gearuptofit.com/a',title:'Shoe Finder',type:'interactive_tool',linkability:80,promotion:90}];
  const r1=await discoverProspects({assets,sites:[s],state,dfs,perAsset:6,maxQueries:6,deadline:Date.now()-1,fetchImpl:async()=>{throw Error('no fetch expected')}});
  assert.equal(r1.queries,0); // deadline already passed: no paid search is even started
  const r2=await discoverProspects({assets,sites:[s],state,dfs,perAsset:6,maxQueries:3,maxNewPerRun:1,fetchImpl:async()=>new Response('<p>x</p>',{status:404,headers:{'content-type':'text/html'}})});
  assert.equal(r2.queries,3);assert.equal(serps.length,3);assert.equal(r2.deferred,1);assert.equal(state.candidate_queue.length,1); // 3 found, 2 processed (maxNewPerRun*2), 1 queued
  const queued=state.candidate_queue[0].domain;
  const r3=await discoverProspects({assets:[],sites:[s],state,dfs,maxQueries:0,fetchImpl:async()=>new Response('<p>x</p>',{status:404,headers:{'content-type':'text/html'}})});
  assert.equal(r3.from_queue,1);assert.equal(r3.queries,0);assert.equal(state.candidate_queue.length,0);
  assert.ok(Object.values(state.prospects).some(p=>p.domain===queued));
});
test('long-tail queries come from the page\'s own phrases and novelty steers footprint order',async()=>{
  const {queriesFor,assetPhrases,pickQueries}=await import('../../scripts/autopilot/prospect.mjs');
  const s={domain:'gearuptofit.com',topic:'running shoes'};
  const a={site:s.domain,url:'https://gearuptofit.com/a',title:'Trail Shoe Guide',type:'practical_guide',terms:['trail','running shoes','trail running','rock plate','shoe']};
  assert.deepEqual(assetPhrases(a,s),['trail running','rock plate']);
  const qs=queriesFor(a,s).map(x=>x.q);assert.ok(qs.includes('"trail running" resources')&&qs.includes('"rock plate" "useful links"'));
  const state={queries:{},prospects:{},fp_novelty:{intent:{q:30,n:0},phrase_resources:{q:4,n:4}}};
  assert.equal(pickQueries([a],[s],state,{perAsset:1})[0].footprint,'phrase_resources');
});
test('spend estimate is learned from real charges',async()=>{
  const {DataForSEO}=await import('../../scripts/autopilot/dataforseo.mjs');
  const st={ledger:[1,2,3].map(()=>({at:new Date().toISOString(),kind:'serp',cost:0.02}))};
  const d=new DataForSEO({login:'l',password:'p',state:st,dailyUsd:0.5,monthlyUsd:10});
  assert.equal(d.estimate('serp'),0.02);assert.equal(d.affordable('serp'),22); // (0.5-0.06)/0.02
});
test('follow-up adds a new, verifiable reason and an easy one-word reply',async()=>{
  const {followupPitch}=await import('../../scripts/autopilot/pitch.mjs');
  const f=followupPitch({title:'Best Running Resources',author:'Jane Doe',last_subject:'Resource for your page'},asset,{senderName:'Alex'});
  assert.equal(f.subject,'Re: Resource for your page');assert.match(f.body,/^Hi Jane,/);
  assert.match(f.body,/One detail I didn't mention: it is a free interactive tool/);assert.match(f.body,/reply "no"/);
  assert.deepEqual(f.body.match(/https?:\/\/\S+/g),[asset.url]);assert.doesNotMatch(f.body,/top of your inbox/);
  const b=followupPitch({title:'X',broken_link:{anchor:'shoe fit guide',host:'deadshoes.com',reason:'not_found'}},asset,{senderName:'Alex'});
  assert.match(b.body,/"shoe fit guide" \(deadshoes\.com\) on that page still returns a "page not found" error/);
});
test('every dropped search result is counted by reason',async()=>{
  const {discoverProspects}=await import('../../scripts/autopilot/prospect.mjs');
  const s={domain:'gearuptofit.com',topic:'running shoes'};
  const res=[{url:'https://www.reddit.com/r/running/x',domain:'www.reddit.com'},{url:'https://gearuptofit.com/a',domain:'gearuptofit.com'},{url:'https://known.example/x',domain:'known.example'},{url:'https://fresh.example/forum/x',domain:'fresh.example'},{url:'https://new.example/resources',domain:'new.example'}];
  const dfs={canSpend:()=>true,affordable:()=>5,serp:async()=>res,domainTraffic:async ds=>Object.fromEntries(ds.map(d=>[d,5000]))};
  const state={queries:{},prospects:{},domains:{'gearuptofit.com|known.example':'x'}};
  const r=await discoverProspects({assets:[{site:s.domain,url:'https://gearuptofit.com/a',title:'Shoe Finder',type:'interactive_tool',linkability:80}],sites:[s],state,dfs,perAsset:1,maxQueries:1,fetchImpl:async()=>new Response('',{status:404,headers:{'content-type':'text/html'}})});
  assert.deepEqual(r.filtered,{platform_or_giant:1,own_site:1,already_evaluated:1,forum_or_ugc:1});assert.equal(r.new_domains,1);
});
