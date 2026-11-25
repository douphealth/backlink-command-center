import test from 'node:test';
import assert from 'node:assert/strict';
import {isWrapped,parseBreadcrumb,unwrapItem,carouselItems,resolveWrapped,matchScore} from '../../scripts/autopilot/serp-unwrap.mjs';
import {DataForSEO} from '../../scripts/autopilot/dataforseo.mjs';
import {discoverProspects,footprintOf,linkGapTargets,pairAsset} from '../../scripts/autopilot/prospect.mjs';
import {templatePitch,alternativePitch,linkLabel} from '../../scripts/autopilot/pitch.mjs';
import {repairSerpOutage} from '../../scripts/autopilot/run.mjs';
import {diagnose,TUNING} from '../../scripts/autopilot/health.mjs';

const resp=(body,{status=200,type='text/html; charset=utf-8',headers={}}={})=>new Response(body,{status,headers:{'content-type':type,...headers}});
const json=o=>resp(JSON.stringify(o),{type:'application/json'});
const words=n=>Array.from({length:n},(_,i)=>['houseplant','care','watering','light','soil','repotting','humidity','plants'][i%8]).join(' ');
const GOTO='https://google.com/goto?url=CAESdQHEIkXX&gsessionid=abc';
// Shapes copied from real DataForSEO Google organic responses (Nov 2026).
const wrapped=(breadcrumb,title,rank=2)=>({type:'organic',rank_absolute:rank,domain:'google.com',title,url:GOTO+rank,breadcrumb});

test('Google redirect-wrapped results recover the publisher from the breadcrumb',()=>{
  const x=wrapped('https://www.ixcoach.com › concerns › variability-in-prac...','Coaching practices for Variability in Practice');
  assert.equal(isWrapped(x),true);
  assert.equal(isWrapped({url:'https://pub.com/a'}),false);
  const u=unwrapItem(x);
  assert.equal(u.domain,'ixcoach.com');assert.equal(u.url,null);assert.equal(u.goto,x.url);
  assert.deepEqual(u.crumb.segments,['concerns','variability-in-prac']);assert.equal(u.crumb.truncated,true);assert.equal(u.crumb.guess,null);
  const full=unwrapItem(wrapped('https://pamsrootedingreen.com › plant-care-guides','Plant Care Guides'));
  assert.equal(full.crumb.guess,'https://pamsrootedingreen.com/plant-care-guides','complete slug breadcrumb is a usable guess');
  const named=parseBreadcrumb('https://brainrash.com › Blog › AI Personalized Learning');
  assert.equal(named.slugLike,false,'schema breadcrumb names are not URL paths');
  assert.equal(unwrapItem(wrapped('','x')).domain,'','no breadcrumb: unrecoverable');
  assert.equal(unwrapItem({type:'organic',url:'https://www.p.com/x',domain:'www.p.com',title:'P',rank_absolute:1}).domain,'p.com','plain results unchanged');
});

test('DataForSEO.serp returns real publishers (and carousel pages), never google.com',async()=>{
  const items=[{type:'ai_overview'},wrapped('https://homegrownfutures.com','Beginner\'s Guide to Indoor Plant Care',2),wrapped('https://www.pinterest.com','Pins',3),
    {type:'images',rank_absolute:9,items:[{type:'images_element',url:'https://catsandcoffee.me/houseplant-care-guides/',alt:'The Best Houseplant Care Guides'},{type:'images_element',url:GOTO,alt:'x'}]}];
  const dfs=new DataForSEO({login:'l',password:'p',state:{},fetchImpl:async()=>json({status_code:20000,cost:0.006,tasks:[{status_code:20000,result:[{items}]}]})});
  const r=await dfs.serp('houseplant care resources');
  assert.deepEqual(r.map(x=>x.domain),['homegrownfutures.com','pinterest.com','catsandcoffee.me']);
  assert.ok(!r.some(x=>/google/.test(x.domain)));
  assert.equal(r[2].url,'https://catsandcoffee.me/houseplant-care-guides/');
  const allBad=new DataForSEO({login:'l',password:'p',state:{},fetchImpl:async()=>json({status_code:20000,cost:0.006,tasks:[{status_code:20000,result:[{items:[wrapped('','a',1),wrapped('','b',2),wrapped('','c',3)]}]}]})});
  assert.equal(await allBad.serp('q'),null,'only unrecoverable links: treated as a failed search, retried next run');
});

test('wrapped results resolve via redirect, then breadcrumb, then the publisher sitemap',async()=>{
  const html='<html><title>Variability</title><body>ok</body></html>',page=()=>resp(html);
  // 1. goto redirect
  const viaRedirect=await resolveWrapped({domain:'ixcoach.com',goto:GOTO},{fetchImpl:async u=>u.startsWith('https://google.com')?resp('',{status:302,headers:{location:'https://www.ixcoach.com/concerns/variability-in-practice/'}}):page()});
  assert.equal(viaRedirect.via,'redirect');assert.equal(viaRedirect.url,'https://www.ixcoach.com/concerns/variability-in-practice');assert.ok(viaRedirect.page.body);
  // 2. blocked goto, complete breadcrumb
  const viaCrumb=await resolveWrapped({domain:'pams.com',goto:GOTO,crumb:{origin:'https://pams.com',segments:['plant-care'],guess:'https://pams.com/plant-care'}},
    {fetchImpl:async u=>u.startsWith('https://google.com')?resp('',{status:429}):u==='https://pams.com/plant-care'?page():resp('',{status:404})});
  assert.equal(viaCrumb.via,'breadcrumb');
  // 3. truncated breadcrumb: slug prefix found in a sitemap index child
  const sm=async u=>{
    if(u.startsWith('https://google.com'))return resp('',{status:403});
    if(u==='https://www.ixcoach.com/sitemap.xml')return resp('<sitemapindex><sitemap><loc>https://www.ixcoach.com/post-sitemap.xml</loc></sitemap></sitemapindex>',{type:'application/xml'});
    if(u==='https://www.ixcoach.com/post-sitemap.xml')return resp('<urlset><url><loc>https://www.ixcoach.com/concerns/burnout/</loc></url><url><loc>https://www.ixcoach.com/concerns/variability-in-practice/</loc></url></urlset>',{type:'application/xml'});
    return resp('',{status:404})};
  const viaMap=await resolveWrapped({domain:'ixcoach.com',goto:GOTO,title:'Coaching practices for Variability in Practice',crumb:{origin:'https://www.ixcoach.com',segments:['concerns','variability-in-prac'],truncated:true,guess:null}},{fetchImpl:sm});
  assert.equal(viaMap.via,'sitemap');assert.equal(viaMap.url,'https://www.ixcoach.com/concerns/variability-in-practice');
  assert.equal(await resolveWrapped({domain:'nope.com',goto:GOTO,crumb:{origin:'https://nope.com',segments:[]}},{fetchImpl:async()=>resp('',{status:404})}),null);
  assert.ok(matchScore('https://a.com/plant-care-guide',{title:'Plant Care Guide'})>=40,'title words in the slug match');
});

const site={domain:'plantastichaven.com',topic:'houseplant care',assets:[],competitors:['plantcaretoday.com']};
const asset={site:'plantastichaven.com',url:'https://plantastichaven.com/plant-care-plan/',title:'Free Houseplant Care Plan Generator',h1:'Houseplant Care Plan Generator',type:'interactive_tool',interactive:true,
  description:'Pick your plants and room light and get a watering, feeding and repotting schedule.',terms:['houseplant','care','watering','repotting','schedule'],linkability:95,promotion:86};
const outs=Array.from({length:6},(_,i)=>`<a href="https://ref${i}.org/">r</a>`).join('');
const article=(title,extra='')=>`<html><head><title>${title}</title></head><body><main><h1>${title}</h1><h2>Watering schedule</h2><p>${words(400)} 2026</p>${outs}${extra}</main></body></html>`;

test('end to end: a wrapped Google result becomes a qualified, contactable prospect',async()=>{
  const f=async url=>{const u=new URL(url);
    if(u.hostname==='google.com')return resp('',{status:302,headers:{location:'https://homegrownfutures.com/indoor-plant-care/'}});
    if(u.hostname==='homegrownfutures.com'&&u.pathname==='/indoor-plant-care/')return resp(article('Beginner\'s Guide to Indoor Plant Care'));
    if(u.hostname==='homegrownfutures.com'&&u.pathname==='/contact')return resp('<a href="mailto:hello@homegrownfutures.com">mail</a>');
    return resp('<p>home</p>')};
  const items=[wrapped('https://homegrownfutures.com','Beginner\'s Guide to Indoor Plant Care',2)];
  const dfs=new DataForSEO({login:'l',password:'p',state:{},fetchImpl:async()=>json({status_code:20000,cost:0.006,tasks:[{status_code:20000,result:[{items}]}]})});
  dfs.domainTraffic=async()=>({'homegrownfutures.com':5200});
  const state={queries:{},mentions_at:{'plantastichaven.com':new Date().toISOString()},linkgap:{'plantastichaven.com|plantcaretoday.com':{at:new Date().toISOString(),offset:0,total:0}}};
  state.queries[`plantastichaven.com|"plantastichaven" OR "plantastichaven.com" -site:plantastichaven.com`]=new Date().toISOString();
  const stats=await discoverProspects({assets:[asset],sites:[site],state,dfs,fetchImpl:f,perAsset:1});
  assert.equal(stats.filtered?.platform_or_giant,undefined,'nothing discarded as google.com');
  assert.equal(stats.resolved,1);assert.equal(stats.resolved_via.redirect,1);
  const p=Object.values(state.prospects)[0];
  assert.equal(p.page_url,'https://homegrownfutures.com/indoor-plant-care');assert.equal(p.status,'ready');assert.equal(p.email,'hello@homegrownfutures.com');
  assert.equal(state.serp_hosts['plantastichaven.com']['homegrownfutures.com'],1,'ranking domains are remembered as competitors');
});

test('competitor link gap: content links to a rival become warm prospects; sidebars, spam and junk are skipped',async()=>{
  const backlinks=async(target,{offset})=>({total:450,items:[
    {url_from:'https://plantmom.blog/watering-guide/',domain_from:'plantmom.blog',title:'How Often to Water Houseplants',url_to:'https://www.plantcaretoday.com/watering-schedule.html',anchor:'watering schedule guide',
      text_pre:'For a full houseplant watering schedule see this',text_post:'.',location:'article',spam:2,external_links:12,broken_to:false},
    {url_from:'https://sidebar.net/a',domain_from:'sidebar.net',title:'Houseplant care',url_to:'https://plantcaretoday.com/',anchor:'Plant Care Today',location:'aside',spam:1,external_links:30},
    {url_from:'https://spammy.com/a',domain_from:'spammy.com',title:'houseplant care',url_to:'https://plantcaretoday.com/',anchor:'x',location:'article',spam:60,external_links:30},
    {url_from:'https://green-lion-1.hostingersite.com/a',domain_from:'green-lion-1.hostingersite.com',title:'houseplant care',url_to:'https://plantcaretoday.com/',anchor:'x',location:'article',spam:1,external_links:30},
    {url_from:'https://cars.com/engine',domain_from:'cars.com',title:'Engine oil change',url_to:'https://plantcaretoday.com/x',anchor:'oil',location:'article',spam:1,external_links:30}]});
  const f=async url=>{const u=new URL(url);
    if(u.hostname==='plantmom.blog'&&u.pathname.startsWith('/watering-guide'))return resp(article('How Often to Water Houseplants','<a href="https://www.plantcaretoday.com/watering-schedule.html">watering schedule guide</a>'));
    if(u.hostname==='plantmom.blog'&&u.pathname==='/contact')return resp('<a href="mailto:jess@plantmom.blog">mail</a>');
    return resp('<p>home</p>')};
  const state={queries:{},mentions_at:{'plantastichaven.com':new Date().toISOString()}};
  state.queries[`plantastichaven.com|"plantastichaven" OR "plantastichaven.com" -site:plantastichaven.com`]=new Date().toISOString();
  const dfs={canSpend:()=>true,affordable:()=>0,serp:async()=>[],backlinks,domainTraffic:async()=>({'plantmom.blog':3000})};
  const stats=await discoverProspects({assets:[asset],sites:[site],state,dfs,fetchImpl:f,perAsset:0});
  assert.equal(stats.linkgap_calls,1);assert.equal(stats.linkgap_candidates,1);
  assert.equal(stats.filtered.sitewide_or_sidebar_link,1);assert.equal(stats.filtered.spam_score,1);assert.equal(stats.filtered.platform_or_giant,1);assert.equal(stats.filtered.off_topic_link,1);
  const p=Object.values(state.prospects)[0];
  assert.equal(p.kind,'linkgap');assert.equal(p.status,'ready',p.reason);assert.equal(p.competitor_link.host,'plantcaretoday.com');assert.equal(p.footprint,'link_gap');
  assert.deepEqual(state.linkgap['plantastichaven.com|plantcaretoday.com'].offset,5,'large link profiles continue from where they stopped');
  assert.equal(footprintOf('linkgap:plantcaretoday.com:0',site),'link_gap');
  assert.equal(linkGapTargets([site],state).length,0,'mined target waits a week before the next page');
  // The pitch names the link the editor already chose and carries exactly one URL: ours.
  const pitch=templatePitch(p,asset,{senderName:'Alex',site});
  assert.deepEqual(pitch,alternativePitch(p,asset,{senderName:'Alex',site}));
  assert.match(pitch.body,/you link to "watering schedule guide" \(plantcaretoday\.com\)/);
  assert.equal(p.competitor_link.match,'specific');assert.match(pitch.body,/second option on the same topic/);
  const loose=alternativePitch({...p,competitor_link:{...p.competitor_link,match:'topic'}},asset,{senderName:'Alex',site});
  assert.doesNotMatch(loose.body,/same topic/,'a topic-only match never claims the pages cover the same subject');
  assert.deepEqual(pitch.body.match(/https?:\/\/\S+/g),[asset.url]);
  assert.doesNotMatch(pitch.body,/better|outdated|instead of/i,'never disparages the other site');
});

test('link-gap targets rotate across sites and include domains that keep ranking for the topic',()=>{
  const sites=[site,{domain:'micegoneguide.com',topic:'mouse proofing home',competitors:[]}];
  const state={serp_hosts:{'micegoneguide.com':{'pestblog.com':3,'reddit.com':9,'once.com':1}}};
  const t=linkGapTargets(sites,state,{max:2});
  assert.deepEqual(t.map(x=>x.target).sort(),['pestblog.com','plantcaretoday.com']);
  assert.equal(linkLabel({anchor:'doctorsofrunning.com+1runningshoesguru.com+1',host:'doctorsofrunning.com'}),'doctorsofrunning.com','junk anchors fall back to the site name');
  assert.equal(pairAsset({title:'Car engines',anchor:'oil',text_pre:'',text_post:'',url_to:'https://x.com/oil'},[asset],site),null);
  const guide={site:site.domain,url:'https://plantastichaven.com/string-of-pearls-plant-care/',title:'String of Pearls Plant Care',type:'practical_guide',terms:['string','pearls','plant','care']};
  const snake={title:'Gift ideas',anchor:'Bird\u2019s Nest Snake Plant',text_pre:'',text_post:'',url_to:'https://plantcaretoday.com/birds-nest-snake-plant.html'};
  assert.equal(pairAsset(snake,[guide],site),null,'a shared generic word ("plant") is not a match');
  assert.deepEqual(pairAsset({...snake,anchor:'string of pearls care'},[guide],site),{asset:guide,match:'specific'});
});

test('one-time repair reopens searches burned by the redirect-link outage',()=>{
  const state={queries:{'s|before':'2026-11-01T00:00:00.000Z','s|during':'2026-11-10T00:00:00.000Z','s|linkgap:x.com:0':'2026-11-20T00:00:00.000Z'},mentions_at:{s:'2026-11-12T00:00:00.000Z'},fp_novelty:{intent:{q:40,n:0}},tuning:{max_queries:8}};
  assert.deepEqual(repairSerpOutage(state),{queries_reopened:1});
  assert.deepEqual(Object.keys(state.queries),['s|before','s|linkgap:x.com:0']);
  assert.deepEqual(state.mentions_at,{});assert.deepEqual(state.fp_novelty,{});assert.equal(state.tuning.max_queries,TUNING.start);
  assert.equal(repairSerpOutage(state),null,'runs once');
});

test('a provider format change that discards nearly every result raises an action',()=>{
  const out=diagnose({stages:{prospects:{ok:true,result:{queries:8,serp_results:339,candidates:0,filtered:{platform_or_giant:339}}}},capabilities:{verifier:{ready:true},claude:false},funnel:{contacted:70,replied:1}});
  assert.ok(out.some(x=>x.code==='serp_format'&&x.level==='action'));
  assert.ok(out.some(x=>x.code==='templates_only'));
});

test('guides and software reviews are never described to editors as "a free interactive tool"',async()=>{
  const {assetFacts}=await import('../../scripts/autopilot/pitch.mjs');
  assert.deepEqual(assetFacts({interactive:true,type:'comparison',words:2400}),['it is an in-depth 2400-word guide']);
  assert.deepEqual(assetFacts({interactive:true,type:'interactive_tool'}),['it is a free interactive tool (no sign-up needed)']);
  const {extractFeatures}=await import('../../scripts/autopilot/crawl.mjs');
  const review=`<html><head><script type="application/ld+json">{"@type":"Review","itemReviewed":{"@type":"SoftwareApplication","name":"X"}}</script><script type="application/ld+json">{"@type":"SoftwareApplication","name":"X"}</script></head><body><h1>X review</h1><p>${'word '.repeat(300)}</p></body></html>`;
  assert.equal(extractFeatures('https://a.com/review/x',review,'a.com').interactive,false);
});

test('pre-verification only spends credits on inboxes whose send window opens within 20 h',async()=>{
  const {preverify}=await import('../../scripts/autopilot/outreach.mjs');
  const asked=[];const mailer={authorizeRecipient:async p=>{asked.push(p.id);return {ok:false,reason:'x',detail:'mailbox_unknown'}}};
  const state={prospects:{us:{id:'us',status:'ready',email:'e@us-blog.com',domain:'us-blog.com',qv:2,history:[]},uk:{id:'uk',status:'ready',email:'e@uk-blog.co.uk',domain:'uk-blog.co.uk',qv:2,history:[]}}};
  await preverify({state,mailer,max:5,now:()=>new Date('2026-11-27T22:00:00Z')}); // Friday night: next windows are Monday
  assert.deepEqual(asked,[],'a proof bought now would expire before Monday');
  await preverify({state,mailer,max:5,now:()=>new Date('2026-11-25T03:00:00Z')}); // Wednesday night: windows open in 4 h (EU) and 10 h (US)
  assert.deepEqual(asked.sort(),['uk','us']);
});

test('waker: next send window when pitches wait, a 5 h keep-alive otherwise, cycles 2 h apart, never after a dry run',async()=>{
  const {planWake,shouldStillWake}=await import('../../scripts/autopilot/waker.mjs');
  const now=Date.parse('2026-11-25T08:57:00Z');
  const base={generated_at:'2026-11-25T08:56:37Z',capabilities:{outreach_mode:'send'},outreach:{ready:60,sent_today:0,cap_today:12,next_send_at:'2026-11-25T13:00:00.000Z',reply_health:'ok'}};
  const p=planWake(base,now);
  assert.equal(p.wake,true);assert.equal(p.at,'2026-11-25T13:00:00.000Z');assert.equal(p.wait_s,4*3600+3*60);assert.match(p.reason,/send window/);
  const open=planWake({...base,outreach:{...base.outreach,next_send_at:'2026-11-25T08:56:37Z'}},now);
  assert.equal(open.at,'2026-11-25T10:56:37.000Z','window already open: next cycle 2 h after the last one, not immediately');
  const keep='2026-11-25T13:56:37.000Z';
  for(const s of [{...base,outreach:{...base.outreach,next_send_at:'2026-11-26T13:00:00Z'}},{...base,capabilities:{outreach_mode:'off'}},{...base,outreach:{...base.outreach,ready:0}},{...base,outreach:{...base.outreach,reply_health:'checking'}}]){
    const k=planWake(s,now);assert.equal(k.at,keep,'no window soon: keep-alive 5 h after the last cycle');assert.match(k.reason,/keep-alive/);
  }
  assert.equal(planWake({...base,dry_run:true},now).wake,false);
  assert.equal(planWake(base,Date.parse('2026-11-25T19:21:00Z')).wait_s,0,'an overdue cycle starts at once');
  assert.equal(shouldStillWake(base,Date.parse('2026-11-25T13:00:00Z')),true);
  assert.equal(shouldStillWake({...base,generated_at:'2026-11-25T12:30:00Z'},Date.parse('2026-11-25T13:00:00Z')),false,'a cycle ran meanwhile');
  assert.equal(shouldStillWake({...base,capabilities:{outreach_mode:'off'}},Date.parse('2026-11-25T13:00:00Z')),true,'research cycles keep running with outreach off');
});
test('indie-blog contact pages count as the publisher\'s own contact pages; other pages do not',async()=>{
  const {CONTACT_PAGE}=await import('../../scripts/autopilot/recipient-policy.mjs');
  for(const p of ['/contact','/contact-us/','/contact-me/','/about','/about-me','/work-with-me/','/get-in-touch','/write-for-us'])assert.ok(CONTACT_PAGE.test(p),p);
  for(const p of ['/contact-lens-guide/','/about-aloe-vera','/blog/team-building-games','/privacy'])assert.ok(!CONTACT_PAGE.test(p.replace(/\/team-building.*/,'/teamwork')),p);
});

test('contact finder follows the homepage menu and indie contact pages',async()=>{
  const {findContact}=await import('../../scripts/autopilot/prospect.mjs');
  const pages={'https://plantmom.blog/':'<nav><a href="/contact-me/">Say hi</a></nav>','https://plantmom.blog/contact-me':'<p>Email me at <a href="mailto:jess@plantmom.blog">jess@plantmom.blog</a> for collaborations.</p>'};
  const fetched=[];
  const f=async u=>{fetched.push(u);const b=pages[u.replace(/\/$/,'')]??pages[u];return b?new Response(b,{headers:{'content-type':'text/html'}}):new Response('',{status:404})};
  const c=await findContact('https://plantmom.blog/watering','<main>no contact links here</main>',{fetchImpl:f});
  assert.equal(c.email,'jess@plantmom.blog');
  assert.equal(fetched[1].replace(/\/$/,''),'https://plantmom.blog/contact-me','the homepage menu link is tried before guessed paths');
});

test('each site searches and sizes publishers in its own market (UK sites are not judged on US traffic)',async()=>{
  const {marketOf}=await import('../../scripts/autopilot/prospect.mjs');
  const uk={domain:'bordercover.shop',topic:'car insurance abroad',market:{location:2826,language:'en'},assets:[],competitors:[]};
  const us={domain:'cabinvolt.shop',topic:'power bank flight rules',assets:[],competitors:[]};
  assert.deepEqual(marketOf(uk),{location:2826,language:'en'});assert.deepEqual(marketOf(us),{location:2840,language:'en'});
  const serpCalls=[],trafficCalls=[];
  const dfs={canSpend:()=>true,affordable:()=>4,serp:async(q,o)=>{serpCalls.push(o.location);return [{url:`https://blog-${o.location}.co.uk/x`,domain:`blog-${o.location}.co.uk`,title:'t',rank:1}]},
    domainTraffic:async(d,o)=>{trafficCalls.push([o.location,d.length]);return Object.fromEntries(d.map(x=>[x,500]))}};
  const state={};
  await discoverProspects({assets:[],sites:[uk,us],state,dfs,fetchImpl:async()=>new Response('',{status:404})});
  assert.deepEqual([...new Set(serpCalls)].sort(),[2826,2840],'brand searches run in each site\'s market');
  assert.deepEqual(trafficCalls.map(x=>x[0]).sort(),[2826,2840],'audience sized per market');
});

test('titles with the site name appended still match their real URL; decoys on the same site do not',async()=>{
  const {matchScore,coreTitle}=await import('../../scripts/autopilot/serp-unwrap.mjs');
  assert.equal(coreTitle('Beginner\'s Guide to Indoor Plant Care - Homegrown Futures'),'Beginner\'s Guide to Indoor Plant Care');
  assert.equal(coreTitle('How Interleaved Practice Schedules Outperform Blocked ...'),'How Interleaved Practice Schedules Outperform Blocked');
  const t='Beginner\'s Guide to Indoor Plant Care - Homegrown Futures';
  assert.ok(matchScore('https://homegrownfutures.com/beginners-guide-indoor-plant-care',{title:t})>=40,'real page accepted (scored 25 before)');
  assert.ok(matchScore('https://pamsrootedingreen.com/plant-care-guides',{title:'Plant Care Guides - Pam\'s Rooted in Green'})>=40);
  for(const decoy of ['https://homegrownfutures.com/about','https://homegrownfutures.com/indoor-herb-garden'])assert.ok(matchScore(decoy,{title:t})<40,decoy);
});

test('WordPress search recovers a wrapped result when the sitemap cannot',async()=>{
  const {resolveWrapped}=await import('../../scripts/autopilot/serp-unwrap.mjs');
  const asked=[];
  const f=async u=>{asked.push(u);
    if(u.includes('/wp-json/wp/v2/search'))return new Response(JSON.stringify([{url:'https://brainrash.com/about/',title:'About'},{url:'https://brainrash.com/blog/interleaving-why-mixing-practice-beats-blocking/',title:'Interleaving'}]),{headers:{'content-type':'application/json; charset=UTF-8'}});
    return new Response('',{status:u.startsWith('https://google.com')?403:404})};
  const r=await resolveWrapped({domain:'brainrash.com',goto:'https://google.com/goto?url=X',title:'Interleaving: Why Mixing Practice Beats Blocking | Blog',crumb:{origin:'https://brainrash.com',segments:['Blog','AI Personalized Learning'],truncated:false,slugLike:false,guess:null}},{fetchImpl:f});
  assert.deepEqual(r,{url:'https://brainrash.com/blog/interleaving-why-mixing-practice-beats-blocking',via:'wordpress_search'});
  assert.match(decodeURIComponent(asked.find(u=>u.includes('wp-json'))),/search=Interleaving: Why Mixing Practice Beats Blocking&/,'searched without the site-name suffix');
});

test('send order favours links worth more: domain authority and pages already ranking top 10',async()=>{
  const {linkLikelihood}=await import('../../scripts/autopilot/learn.mjs');
  const base={score:70,email:'editor@pub.com',domain:'pub.com',email_rank:95,etv:5000,kind:'linkgap'};
  const strong=linkLikelihood({...base,authority:{domain_rank:450}}),weak=linkLikelihood({...base,authority:{domain_rank:40}});
  assert.ok(strong>weak,`${strong} > ${weak}`);
  assert.ok(linkLikelihood({...base,serp_rank:3})>linkLikelihood({...base,serp_rank:40}));
  const dfs=new DataForSEO({login:'l',password:'p',state:{},fetchImpl:async()=>new Response(JSON.stringify({status_code:20000,cost:0.03,tasks:[{status_code:20000,result:[{total_count:1,items:[{url_from:'https://a.com/x',domain_from:'a.com',page_from_title:'t',url_to:'https://c.com/',anchor:'a',semantic_location:'article',domain_from_rank:312,page_from_rank:150,url_to_status_code:200}]}]}]}),{headers:{'content-type':'application/json'}})});
  const r=await dfs.backlinks('c.com');assert.equal(r.items[0].domain_rank,312);assert.equal(r.items[0].page_rank,150);
});

test('domains the old resolver gave up on are retried once',async()=>{
  const {retryUnresolved}=await import('../../scripts/autopilot/run.mjs');
  const state={unresolved:{'a.com':'2026-11-25T00:00:00Z','b.com':'2026-11-24T00:00:00Z'}};
  assert.deepEqual(retryUnresolved(state),{domains_retried:2});assert.deepEqual(state.unresolved,{});
  state.unresolved={'c.com':'2026-11-26T00:00:00Z'};assert.equal(retryUnresolved(state),null);assert.ok(state.unresolved['c.com'],'runs once');
});
