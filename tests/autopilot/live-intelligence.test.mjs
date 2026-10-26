import test from 'node:test';
import assert from 'node:assert/strict';
import {readAutopilot,ageHours,livePanel,liveBanner} from '../../public/live-intelligence.js';
const data={schema:'linkforge-autopilot/1',generated_at:'2026-10-26T06:00:00Z',
  funnel:{prospects_evaluated:1500,qualified:333,contacted:7,won:0,replied:0,existing_links:4},
  outreach:{ready:120,mode:'send',sent_today:2,cap_today:9},
  spend:{today_usd:.21,month_usd:1.71,monthly_cap_usd:10},
  wins:[{kind:'existing',publisher:'example.org',page_url:'https://example.org/a',target:'https://oursite.com/a'}],
  stages:{crawl:{ok:true}},sites:[],learning:{footprints:[]},log:[]};
const h={
  escapeHTML:x=>String(x??'').replace(/&/g,'&amp;').replace(/</g,'&lt;'),
  n:x=>String(x??0),niceTime:x=>String(x),external:(url,label)=>label+':'+url,
  panel:(title,sub,content)=>title+' '+sub+' '+content,
  table:(_head,rows)=>rows.join('\n'),empty:(title)=>title};
test('read only live intelligence accepts only verified snapshot schema',async()=>{
  const response=v=>({ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>v});
  assert.deepEqual(await readAutopilot(async()=>response(data)),data);
  assert.equal(await readAutopilot(async()=>response({funnel:{}})),null);
  assert.equal(await readAutopilot(async()=>{throw Error('offline')}),null);
});
test('the snapshot staleness policy fails closed',()=>{
  assert.equal(ageHours(null),Infinity);
  assert.equal(ageHours({generated_at:'bogus'}),Infinity);
  assert.equal(ageHours(data,Date.parse('2026-10-26T09:00:00Z')),3);
});
test('live sections never disguise separate browser controls as active controls',()=>{
  const operation=livePanel(data,'operations',h);
  assert.match(operation,/NOT pause, resume or cancel GitHub Autopilot/);
  const suppression=livePanel(data,'suppression',h);
  assert.match(suppression,/does not prevent unattended outreach/);
  const banner=liveBanner(data,'overview',h);
  assert.match(banner,/BROWSER RECORDS SEPARATE/);
});
test('existing backlink is not credited as earned',()=>{
  const panel=livePanel(data,'placements',h);
  assert.match(panel,/Pre-existing link/);
  assert.match(panel,/Earned links/);
  assert.match(panel,/0/);
});
test('outreach and spend sections display published evidence not local fake zeros',()=>{
  const outreach=livePanel(data,'outreach',h),spend=livePanel(data,'spend',h);
  assert.match(outreach,/120/);
  assert.match(outreach,/SMTP-accepted/);
  assert.match(spend,/1.710/);
});
