import test from 'node:test';
import assert from 'node:assert/strict';
import {assetStats,linkLikelihood,learningSummary,PRIOR_STRENGTH,MIN_PAGE_SENDS} from '../../scripts/autopilot/learn.mjs';
import {chooseAssets} from '../../scripts/autopilot/run.mjs';

const pitched=(asset,n,{replied=0,positive=0}={})=>Array.from({length:n},(_,i)=>({asset_url:asset,status:i<positive?'positive':i<replied?'replied':'sent',
  replied_at:i<replied?'2026-11-20T00:00:00Z':undefined,history:[{type:'initial',at:'2026-11-10T00:00:00Z',mode:'send'}]}));
const stateOf=(...groups)=>({prospects:Object.fromEntries(groups.flat().map((p,i)=>[`p${i}`,p]))});

test('page rates are shrunk toward the pooled rate with a stated strength',()=>{
  assert.equal(PRIOR_STRENGTH,30);assert.equal(MIN_PAGE_SENDS,10);
  const s=assetStats(stateOf(pitched('a',10),pitched('b',30,{replied:3}),pitched('c',3)));
  assert.ok(Math.abs(s.pooled-3/43)<1e-12);
  const a=s.get('a');assert.ok(Math.abs(a.rate-(30*s.pooled)/(10+30))<1e-12);
  assert.ok(Math.abs(a.lift-0.75)<1e-12,'10 unanswered pitches: 30/(10+30) of the pooled rate');
  assert.ok(s.get('b').lift>1);
  assert.equal(s.get('c').lift,1,'under 10 pitches a page counts as average');
  assert.equal(assetStats(stateOf(pitched('a',20))).get('a').lift,1,'no replies anywhere yet: nothing to compare');
});
test('page-level adjustments apply only from 10 pitches on, and stay within ±10 points',()=>{
  const p={score:70,domain:'blog.example',etv:20000,email_rank:80,asset_url:'a'};
  const none=linkLikelihood(p);
  const few=assetStats(stateOf(pitched('a',4),pitched('b',30,{replied:3})));
  assert.equal(linkLikelihood(p,{assets:few}),none,'4 unanswered pitches are noise, not evidence (the old prior took 5-6 points)');
  const ten=assetStats(stateOf(pitched('a',10),pitched('b',30,{replied:3})));
  assert.equal(linkLikelihood(p,{assets:ten}),Math.round(none-2.5));
  const great=assetStats(stateOf(pitched('a',12,{replied:6,positive:3}),pitched('b',60)));
  assert.equal(linkLikelihood(p,{assets:great}),none+10);
  const awful=assetStats(stateOf(pitched('a',400),pitched('b',30,{replied:30,positive:30})));
  assert.ok(linkLikelihood(p,{assets:awful})>=none-10);
});
test('the learning summary states the prior and publishes the lift (counts only)',()=>{
  const sum=learningSummary(stateOf(pitched('https://mice.com/a',12,{replied:2}),pitched('https://mice.com/b',10)),[{domain:'mice.com',topic:'mice'}]);
  assert.deepEqual(sum.asset_prior,{pooled_rate:0.0909,strength:30,min_sends:10});
  assert.equal(sum.assets[0].url,'https://mice.com/a');assert.ok(sum.assets[0].lift>1);assert.ok(sum.assets[1].lift<1);
});
test('asset rotation follows the shrunk lift: a page with a better record is promoted before an equally queued weaker one',()=>{
  const ranked=[{site:'mice.com',url:'https://mice.com/weak',linkability:80,promotion:90},{site:'mice.com',url:'https://mice.com/strong',linkability:80,promotion:70}];
  const state=stateOf(pitched('https://mice.com/weak',10),pitched('https://mice.com/strong',10,{replied:3}));
  assert.deepEqual(chooseAssets(ranked,state,{perSite:1}).map(a=>a.url),['https://mice.com/strong']);
  assert.deepEqual(chooseAssets(ranked,{},{perSite:1}).map(a=>a.url),['https://mice.com/weak'],'without evidence, promotion decides');
});
