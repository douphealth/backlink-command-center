import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePublicPage,editorialSignals,collectPublicEvidence} from '../../scripts/refresh-public-intelligence.mjs';

test('Accept only genuine 200 self-canonical pages for technical eligibility',()=>{
  const body='<html><head><title>Running Shoe Selection Framework</title><link rel="canonical" href="https://gearuptofit.com/shoe-finder/"></head><body>'+('Running technique and shoe-selection instructions. '.repeat(20))+'</body></html>';
  const row=evaluatePublicPage('https://gearuptofit.com/shoe-finder/',{status:200,contentType:'text/html',body});
  assert.equal(row.technical_status,'technically_eligible');
  assert.equal(row.canonical_matches,true);
});
test('Never promote noindex or noncanonical pages',()=>{
  const long='.'.repeat(800);
  assert.equal(evaluatePublicPage('https://gearuptofit.com/shoe-finder/',{status:200,contentType:'text/html',body:'<title>Example</title><meta name="robots" content="noindex">'+long}).technical_status,'blocked_noindex');
  assert.equal(evaluatePublicPage('https://gearuptofit.com/shoe-finder/',{status:200,contentType:'text/html',body:'<title>Example</title><link rel="canonical" href="https://gearuptofit.com/other/">'+long}).technical_status,'blocked_canonical');
});
test('Editorial heuristic is explicitly independent of clicks',()=>{
  assert.ok(editorialSignals('https://gearuptofit.com/shoe-finder/methodology/').editorial_fit_score>editorialSignals('https://gearuptofit.com/checkout/').editorial_fit_score);
});
test('Public snapshot has no invented GSC metrics or email actions',async()=>{
  const portfolio={sites:[{domain:'gearuptofit.com',topic:'running',assets:['https://gearuptofit.com/shoe-finder/']}]};
  const fakeFetch=async()=>new Response('<html><title>Guide</title>'+'.'.repeat(800)+'</html>',{status:200,headers:{'content-type':'text/html'}});
  const result=await collectPublicEvidence(portfolio,{fetchImpl:fakeFetch,now:new Date('2026-10-21T01:00:00Z')});
  assert.equal(result.urls.length,1);
  assert.equal(result.urls[0].technical_status,'needs_editorial_review');
  assert.equal(result.gsc_metrics_included,false);
  assert.equal(result.urls[0].clicks,undefined);
});
