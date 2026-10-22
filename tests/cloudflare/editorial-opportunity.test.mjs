import test from 'node:test';import assert from 'node:assert/strict';
import {classifyAsset,scoreOpportunity,buildOpportunitySnapshot,decodeTitle} from '../../scripts/editorial-opportunity-engine.mjs';
test('Navigation and topic broad match do not become premium resources',()=>{
 assert.equal(classifyAsset('https://gearuptogrow.com/blog/','Latest Guides on Focus, Habits and Learning').type,'navigation');
 const result=scoreOpportunity({site:'gearuptogrow.com',url:'https://gearuptogrow.com/blog/',title:'Latest Guides',technical_status:'technically_eligible',http_status:200});
 assert.equal(result.quality_gate,'blocked_or_review');assert.equal(result.editorial_priority,0);
});
test('Explicit methodology earns priority but is still never automatically sent',()=>{
 const x=scoreOpportunity({site:'gearuptofit.com',url:'https://gearuptofit.com/shoe-finder/methodology/',title:'How RunMatch Scores Shoes: Methodology',technical_status:'technically_eligible',http_status:200});
 assert.equal(x.category,'methodology');assert.ok(x.editorial_priority>=85);assert.equal(x.ready_to_send,false);
});
test('Noindex and redirected pages never enter outbound shortlist',()=>{
 const portfolio={sites:[{domain:'a.example',assets:[]}]},data={generated_at:new Date().toISOString(),urls:[
 {site:'a.example',url:'https://a.example/guide/',title:'Guide',technical_status:'blocked_noindex'},
 {site:'a.example',url:'https://a.example/framework/',title:'Framework',technical_status:'technically_eligible'}
 ]};
 const r=buildOpportunitySnapshot(data,portfolio);assert.equal(r.shortlist.length,1);assert.equal(r.holds.length,1);assert.equal(r.outreach_authorized,false);
});
test('site caps distribute opportunities and no fabricated GSC metrics',()=>{
 const sites=[{domain:'a.example',assets:[]},{domain:'b.example',assets:[]}];
 const urls=sites.flatMap(s=>Array.from({length:9},(_,i)=>({site:s.domain,url:'https://'+s.domain+'/guide-'+i+'/',title:'Article',technical_status:'technically_eligible'})));
 const r=buildOpportunitySnapshot({urls,generated_at:new Date().toISOString()},{sites},{maxPerSite:2});
 assert.equal(r.shortlist.length,4);assert.equal(r.gsc_metrics_included,false);assert.ok(r.shortlist.every(x=>x.ready_to_send===false));
});
test('decode title entities safely',()=>{assert.equal(decodeTitle('Plants &amp; Care &#39;Basics&#39;'),'Plants & Care \'Basics\'');});
