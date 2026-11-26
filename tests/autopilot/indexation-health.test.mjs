import test from 'node:test';
import assert from 'node:assert/strict';
import {indexationReport,pageIssue,utilityPage} from '../../scripts/autopilot/indexation.mjs';
import {crawlPortfolio,discoverSite} from '../../scripts/autopilot/crawl.mjs';
import {diagnose} from '../../scripts/autopilot/health.mjs';

const resp=(body,{status=200,type='text/html; charset=utf-8',headers={}}={})=>new Response(body,{status,headers:{'content-type':type,...headers}});
const page=(path,words=600)=>`<html><head><title>T ${path}</title><link rel="canonical" href="https://ex.com${path}"></head><body><main><h1>H</h1><p>${'word '.repeat(words)}</p></main></body></html>`;
const ok={status:200,technical_status:'technically_eligible',canonical:'https://s.com/a',words:900};

test('thin is a quality note: short policy and utility pages and pages read only in part are not flagged',()=>{
  for(const path of ['/refund-policy','/editorial-standards','/medical-financial-relationship-disclaimer','/runmatch-thank-you','/runmatch-unsubscribe','/change-log','/el/ownership','/review-methodology','/about-the-editor','/corrections-policy/'])
    assert.equal(utilityPage('https://s.com'+path),true,path);
  for(const path of ['/guides/how-to-wash-a-rug','/skills/browser-automation','/plant-care-tips','/about-running-shoes-for-flat-feet'])
    assert.equal(utilityPage('https://s.com'+path),false,path);
  assert.equal(utilityPage('https://s.com/about-alexios-papaioannou-founder-of-micegoneguide'),true);
  assert.equal(pageIssue({...ok,url:'https://s.com/refund-policy',words:139}),null);
  assert.equal(pageIssue({...ok,url:'https://s.com/guides/x',words:139}),'thin');
  assert.equal(pageIssue({...ok,url:'https://s.com/',words:21,truncated:true}),null,'a page read only in part has no trustworthy word count');
});

test('the report separates "cannot be indexed" from "needs a look" and "thin", and explains a failing site once',()=>{
  const down=Array.from({length:40},(_,i)=>({url:`https://down.com/t/${i}`,status:503,technical_status:'origin_or_edge_error',server_hint:'database-unavailable',retry_after:'3600'}));
  const r=indexationReport([
    {site:'down.com',pages:[...down,{...ok,url:'https://down.com/ok'}],sitemap_errors:[{url:'https://down.com/sitemap.xml',status:503}],reused_known:41},
    {site:'fine.com',pages:[{...ok,url:'https://fine.com/a'},{...ok,url:'https://fine.com/thin',words:120},{...ok,url:'https://fine.com/r',final_url:'https://fine.com/a',technical_status:'redirect_requires_review'},{...ok,url:'https://fine.com/n',noindex:true}]},
  ]);
  assert.equal(r.total_issues,43);assert.equal(r.blocking,41);assert.equal(r.review,1);assert.equal(r.thin,1);
  const d=r.sites[0],f=r.sites[1];
  assert.equal(d.critical,40);assert.equal(d.server_error,40);assert.equal(d.healthy,1);
  assert.match(d.alert,/40 of 41 URLs answered HTTP 503 \(the site says: database-unavailable\)/);assert.match(d.alert,/sitemap answered HTTP 503, so 41 URLs known from earlier cycles were checked instead/);
  assert.equal(f.alert,undefined);assert.deepEqual([f.critical,f.review,f.thin],[1,1,1]);
  assert.equal(r.issues.filter(x=>x.site==='down.com').length,12,'examples are capped per site and problem; the counts are not');
  assert.equal(r.issues.find(x=>x.site==='down.com').detail,'HTTP 503 · retry-after 3600 · database-unavailable');
  assert.ok(r.issues.some(x=>x.issue==='thin'),'a failing site no longer crowds everything else out of the list');
  const attention=diagnose({indexation:r});
  assert.equal(attention.filter(a=>a.code==='site_failing').length,1);assert.match(attention.find(a=>a.code==='site_failing').message,/^down\.com: 40 of 41/);
});

test('a sitemap that answers 503 once is retried; when it stays down the URLs known from earlier cycles are checked',async()=>{
  let mapCalls=0;
  const flaky=async url=>{
    if(url==='https://ex.com/robots.txt')return resp('Sitemap: https://ex.com/sitemap.xml',{type:'text/plain'});
    if(url==='https://ex.com/sitemap.xml')return ++mapCalls===1?resp('Sitemap temporarily unavailable',{status:503,type:'text/plain'}):resp('<urlset><url><loc>https://ex.com/a</loc></url></urlset>',{type:'application/xml'});
    return resp('nope',{status:404});
  };
  const found=await discoverSite({domain:'ex.com',assets:[]},{fetchImpl:flaky,retryMs:0});
  assert.deepEqual(found.urls.map(u=>u.url),['https://ex.com/a']);assert.deepEqual(found.sitemap_errors,[]);

  const logs=[];
  const down=async url=>{
    if(url==='https://ex.com/robots.txt')return resp('Sitemap: https://ex.com/sitemap.xml',{type:'text/plain'});
    if(/sitemap/.test(url))return resp('Sitemap temporarily unavailable',{status:503,type:'text/plain'});
    return resp(page(new URL(url).pathname));
  };
  const cache={'https://ex.com/a':{site:'ex.com',url:'https://ex.com/a',status:200,fetched_at:'2026-01-01T00:00:00Z'},'https://ex.com/b':{site:'ex.com',url:'https://ex.com/b',status:200,fetched_at:'2026-01-01T00:00:00Z'},'https://other.com/x':{site:'other.com',url:'https://other.com/x',status:200}};
  const [site]=await crawlPortfolio([{domain:'ex.com',assets:['https://ex.com/tool']}],{cache,fetchImpl:down,retryMs:0,log:m=>logs.push(m)});
  assert.deepEqual(site.pages.map(p=>p.url).sort(),['https://ex.com/a','https://ex.com/b','https://ex.com/tool']);
  assert.equal(site.reused_known,2);assert.equal(site.sitemap_errors[0].status,503);assert.match(logs[0],/sitemap answered HTTP 503; 2 URLs known from earlier cycles/);
});

test('a site that fails most requests is left alone for the cycle, and the failure carries what the server said',async()=>{
  let pageCalls=0;
  const urls=Array.from({length:60},(_,i)=>`https://ex.com/t/${i}`);
  const f=async url=>{
    if(url==='https://ex.com/robots.txt')return resp('Sitemap: https://ex.com/sitemap.xml',{type:'text/plain'});
    if(url==='https://ex.com/sitemap.xml')return resp(`<urlset>${urls.map(u=>`<url><loc>${u}</loc></url>`).join('')}</urlset>`,{type:'application/xml'});
    if(/sitemap|wp-/.test(url))return resp('nope',{status:404});
    pageCalls++;return resp('<html><title>Tender not found</title></html>',{status:503,headers:{'retry-after':'3600','x-outage-guard':'database-unavailable'}});
  };
  const logs=[];
  const [site]=await crawlPortfolio([{domain:'ex.com',assets:[]}],{fetchImpl:f,retryMs:0,log:m=>logs.push(m)});
  assert.ok(pageCalls>=12&&pageCalls<=16,`stopped after about a dozen failures, made ${pageCalls} requests`);
  assert.equal(site.outage.stopped,true);assert.equal(site.outage.status,503);assert.equal(site.outage.hint,'database-unavailable');
  assert.equal(site.pages[0].server_hint,'database-unavailable');assert.equal(site.pages[0].retry_after,'3600');
  assert.match(logs.at(-1),/answered HTTP 503 \(database-unavailable\), crawl stopped early \(\d+ not requested\)/);
  const r=indexationReport([site]);
  assert.match(r.sites[0].alert,/the crawl stopped early after \d+ failures to avoid adding load/);

  // A few failures among many good answers are not an outage.
  let n=0;
  const mostlyFine=async url=>{
    if(url==='https://ex.com/robots.txt')return resp('Sitemap: https://ex.com/sitemap.xml',{type:'text/plain'});
    if(url==='https://ex.com/sitemap.xml')return resp(`<urlset>${urls.map(u=>`<url><loc>${u}</loc></url>`).join('')}</urlset>`,{type:'application/xml'});
    if(/sitemap|wp-/.test(url))return resp('nope',{status:404});
    return ++n%20===0?resp('busy',{status:503}):resp(page(new URL(url).pathname));
  };
  const [fine]=await crawlPortfolio([{domain:'ex.com',assets:[]}],{fetchImpl:mostlyFine,retryMs:0});
  assert.equal(fine.outage,undefined);assert.equal(fine.pages.length,60);
});
