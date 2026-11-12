import test from 'node:test';
import assert from 'node:assert/strict';
import {indexClass,monitorIndex,indexReport,searchPerformance} from '../../scripts/autopilot/searchconsole.mjs';
import {submitToBing,bingCandidates} from '../../scripts/autopilot/bing.mjs';

const sites=[{domain:'a.com',assets:['https://a.com/tool']},{domain:'b.com',assets:[]}];
const page=(url,extra={})=>({url,final_url:url,status:200,canonical:url,lastmod:'2026-11-10',...extra});
const crawl=[{site:'a.com',pages:[page('https://a.com/tool'),page('https://a.com/new',{lastmod:'2026-11-12'}),page('https://a.com/old',{lastmod:'2025-01-01'}),page('https://a.com/blocked',{noindex:true})]}];
// Real coverage strings returned by the URL Inspection API in production (2026-11-12).
const LIVE={'https://a.com/tool':{verdict:'NEUTRAL',coverageState:'Crawled - currently not indexed'},'https://a.com/new':{verdict:'NEUTRAL',coverageState:'URL is unknown to Google'},'https://a.com/old':{verdict:'PASS',coverageState:'Submitted and indexed',lastCrawlTime:'2026-11-11T00:00:00Z'}};
const fakeGsc=(calls=[])=>({property:d=>d==='a.com'?'sc-domain:a.com':null,inspect:async(prop,url)=>{calls.push(url);return {inspectionResult:{indexStatusResult:LIVE[url]||{verdict:'NEUTRAL',coverageState:'Discovered - currently not indexed'}}}},
  query:async(prop,body)=>body.dimensions?{rows:[{keys:['x'],position:7,impressions:40},{keys:['y'],position:30,impressions:90}]}:{rows:[{clicks:12,impressions:900,ctr:0.0133,position:18.2}]}});

test('Google coverage states map to actionable classes',()=>{
  assert.deepEqual(['Submitted and indexed','URL is unknown to Google','Discovered - currently not indexed','Crawled - currently not indexed',"Excluded by 'noindex' tag",'Duplicate, Google chose different canonical than user','Page with redirect','Not found (404)'].map((c,i)=>indexClass({verdict:i?'NEUTRAL':'PASS',coverageState:c})),
    ['indexed','unknown','discovered_not_indexed','crawled_not_indexed','noindex','canonical_elsewhere','redirect','not_found']);
});
test('index monitor inspects priority pages first, skips noindex and sites without access, respects the daily share',async()=>{
  const state={},calls=[];
  const r=await monitorIndex({state,client:fakeGsc(calls),sites,priority:new Map([['a.com',['https://a.com/tool']]]),crawl,perSiteDaily:3});
  assert.equal(calls[0],'https://a.com/tool');assert.equal(calls.length,3);assert.ok(!calls.includes('https://a.com/blocked'));
  assert.deepEqual(r.no_property,['b.com']);assert.equal(state.index_status['https://a.com/tool'].class,'crawled_not_indexed');
  assert.equal((await monitorIndex({state,client:fakeGsc(calls),sites,crawl,perSiteDaily:3})).inspected,0,'daily share used up');
});
test('index report lists the most valuable ignored pages with the exact fix',()=>{
  const state={index_status:{'https://a.com/tool':{site:'a.com',class:'crawled_not_indexed',coverage:'Crawled - currently not indexed',checked_at:'x'},'https://a.com/old':{site:'a.com',class:'indexed',checked_at:'x'}}};
  const r=indexReport(state,sites,[{url:'https://a.com/tool',promotion:80,title:'Tool'}]);
  assert.deepEqual(r.sites[0],{site:'a.com',checked:2,indexed:1,not_indexed:1,crawled_not_indexed:1});
  assert.equal(r.pages[0].title,'Tool');assert.match(r.pages[0].fix,/chose not to index/);
});
test('search performance gives 7-day totals and striking-distance counts per site',async()=>{
  const [x]=await searchPerformance({client:fakeGsc(),sites});
  assert.deepEqual({site:x.site,clicks:x.clicks,impressions:x.impressions,position:x.position,striking:x.striking_distance},{site:'a.com',clicks:12,impressions:900,position:18.2,striking:1});
});
test('bing candidates: non-indexed first, then never-submitted, changed pages resubmitted, noindex never',()=>{
  const index={'https://a.com/old':{class:'unknown'}};
  const c=bingCandidates({site:'a.com',crawl,submitted:{'https://a.com/tool':{at:new Date().toISOString(),lastmod:'2026-11-10'}},indexStatus:index});
  assert.deepEqual(c.map(x=>x.url),['https://a.com/old','https://a.com/new']); // tool unchanged since submission; blocked is noindex
});
function bingFake({quota=10,submitStatus=200,lowerOnly=false}={}){
  const calls=[];
  const fetchImpl=async(u,o={})=>{const url=new URL(u);calls.push({path:url.pathname.split('/').pop(),site:url.searchParams.get('siteUrl'),body:o.body&&JSON.parse(o.body),hasKey:url.searchParams.get('apikey')==='k-123'});
    const m=url.pathname.split('/').pop();
    if(m==='GetUrlSubmissionQuota')return new Response(JSON.stringify(url.searchParams.get('siteUrl')==='https://a.com/'?{d:{DailyQuota:quota,MonthlyQuota:quota*30}}:{ErrorCode:14,Message:'NotAuthorized k-123'}),{status:url.searchParams.get('siteUrl')==='https://a.com/'?200:400});
    if(lowerOnly&&m==='SubmitUrlBatch')return new Response('',{status:404});
    return new Response(JSON.stringify(submitStatus===200?{d:null}:{ErrorCode:2,Message:'InvalidApiKey k-123'}),{status:submitStatus});};
  return {calls,fetchImpl};
}
test('bing submission: quota-bounded, once a day, key never leaks into errors',async()=>{
  const state={index_status:{}},f=bingFake({quota:2});
  const r=await submitToBing({state,env:{BING_WEBMASTER_API_KEY:'k-123'},sites,crawl,fetchImpl:f.fetchImpl});
  assert.equal(r.submitted,2);const sub=f.calls.find(c=>c.path==='SubmitUrlBatch');assert.equal(sub.body.siteUrl,'https://a.com/');assert.equal(sub.body.urlList.length,2);
  assert.ok(f.calls.every(c=>c.hasKey));assert.ok(r.errors['b.com']);assert.doesNotMatch(JSON.stringify(state.bing.errors),/k-123/);
  const again=await submitToBing({state,env:{BING_WEBMASTER_API_KEY:'k-123'},sites,crawl,fetchImpl:f.fetchImpl});assert.equal(again.submitted,0);
});
test('bing submission falls back to the alternate method spelling and keeps failed batches for retry',async()=>{
  const ok=bingFake({lowerOnly:true}),state={};await submitToBing({state,env:{BING_WEBMASTER_API_KEY:'k-123'},sites:[sites[0]],crawl,fetchImpl:ok.fetchImpl});
  assert.ok(ok.calls.some(c=>c.path==='SubmitUrlbatch'));assert.equal(Object.keys(state.bing.submitted).length,3);
  const bad=bingFake({submitStatus:400}),st2={};const r=await submitToBing({state:st2,env:{BING_WEBMASTER_API_KEY:'k-123'},sites:[sites[0]],crawl,fetchImpl:bad.fetchImpl});
  assert.equal(r.submitted,0);assert.equal(Object.keys(st2.bing.submitted).length,0);assert.equal(st2.bing.days['a.com'],undefined,'a failed day is retried next cycle');
  assert.doesNotMatch(r.errors['a.com'],/k-123/);
  assert.deepEqual(await submitToBing({state:{},env:{},sites,crawl}),{skipped:'BING_WEBMASTER_API_KEY not set'});
});

test('Google and Bing get the exact published URL (trailing slash kept); lookups use the normalised key',async()=>{
  const c=[{site:'a.com',pages:[{url:'https://a.com/guide',final_url:'https://a.com/guide/',canonical:'https://a.com/guide/',status:200,lastmod:'2026-11-10'}]}];
  const calls=[],state={};await monitorIndex({state,client:fakeGsc(calls),sites:[sites[0]],priority:new Map([['a.com',['https://a.com/guide/']]]),crawl:c,perSiteDaily:5});
  assert.deepEqual(calls,['https://a.com/guide/']);assert.equal(state.index_status['https://a.com/guide'].url,'https://a.com/guide/');
  assert.deepEqual(bingCandidates({site:'a.com',crawl:c}).map(x=>x.url),['https://a.com/guide/']);
});
