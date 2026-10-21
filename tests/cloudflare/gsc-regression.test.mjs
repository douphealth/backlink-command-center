import test from 'node:test';
import assert from 'node:assert/strict';
import {rankUrls} from '../../functions/_lib/gsc.js';
import {collectPublicEvidence} from '../../scripts/refresh-public-intelligence.mjs';

test('direct Search Console URL ranker rejects other hosts and sensitive pages',()=>{
  const rows=[
    {keys:['https://gearuptofit.com/shoe-finder/'],impressions:400,clicks:3,position:8},
    {keys:['https://gearuptofit.com/privacy'],impressions:9000,clicks:1,position:2},
    {keys:['https://gearuptofit.com/contact/'],impressions:9000,clicks:1,position:2},
    {keys:['https://other.example/guide/'],impressions:9000,clicks:1,position:2},
  ];
  const results=rankUrls('gearuptofit.com',rows);
  assert.equal(results.length,1);
  assert.equal(results[0].url,'https://gearuptofit.com/shoe-finder/');
});

test('public asset list rejects credential-in-URL and non-HTTPS URLs',async()=>{
  const urls=['https://gearuptofit.com/shoe-finder/','https://owner:secret@gearuptofit.com/guide/','http://gearuptofit.com/guide/'];
  let calls=0;
  const data=await collectPublicEvidence({sites:[{domain:'gearuptofit.com',assets:urls}]},{
    now:new Date('2026-10-21T00:00:00Z'),
    fetchImpl:async()=>{calls++;return new Response('<html><title>Page</title></html>',{status:200,headers:{'content-type':'text/html'}})}
  });
  assert.equal(calls,1);
  assert.equal(data.urls.length,1);
  assert.equal(data.gsc_metrics_included,false);
});
