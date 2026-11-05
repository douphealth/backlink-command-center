import test from 'node:test';
import assert from 'node:assert/strict';
import {autotune,diagnose,TUNING} from '../../scripts/autopilot/health.mjs';

test('search budget backs off after an overrun and grows after a clean full run',()=>{
  const state={};
  assert.equal(autotune(state,{ok:true,result:{queries:24,deferred:0,failed_queries:1}}),28);
  assert.equal(autotune(state,{ok:true,result:{queries:20,deferred:12}}),24);
  assert.equal(autotune(state,{ok:false,error:'stopped at its time budget (600 s); continues next cycle'}),20);
  assert.equal(autotune(state,{ok:true,result:{queries:5,deferred:0}}),20); // used less than allowed: unchanged
  for(let i=0;i<20;i++)autotune(state,{ok:true,result:{queries:99,deferred:0}});assert.equal(state.tuning.max_queries,TUNING.maxQueries);
  for(let i=0;i<20;i++)autotune(state,{ok:true,result:{queries:9,deferred:3}});assert.equal(state.tuning.max_queries,TUNING.minQueries);
  assert.equal(autotune(state,{ok:true,result:{}},{envQueries:30}),30); // owner setting wins
});
test('self-diagnosis puts owner actions first with exact fixes and no private data',()=>{
  const list=diagnose({stages:{prospects:{ok:true,result:{queries:62,qualified:0,deferred:0,failed_queries:30}},link_checks:{ok:false,error:'boom'}},
    capabilities:{verifier:{ready:false,key:true},connections:{gmail:{status:'rejected'}}},outreach:{mode:'off',verified_ready:0},funnel:{ready:151},spend:{today_usd:0.5,daily_cap_usd:0.5}});
  assert.deepEqual(list.map(x=>x.code),['gmail_rejected','verifier_off','no_qualified','dataforseo_errors','stage_link_checks','spend_cap']);
  assert.match(list[1].fix,/Mailbox checks per day/);
  assert.doesNotMatch(JSON.stringify(list),/@/);
  const ready=diagnose({capabilities:{verifier:{ready:true}},outreach:{mode:'off',verified_ready:4},funnel:{ready:151},held:true});
  assert.equal(ready[0].code,'hold_with_verified');assert.match(ready[0].message,/4 verified inboxes/);
});
test('hold reasons are reported with counts (owner already decided the contact rule)',()=>{
  const d=diagnose({capabilities:{verifier:{ready:true}},outreach:{mode:'off',holds:{only_non_editorial_inbox_published:4,no_email_published:1}},funnel:{ready:150}});
  assert.equal(d[0].code,'holds');assert.equal(d[0].level,'info');assert.match(d[0].message,/5 queued inboxes are held; most often \(4\)/);
  const auto=diagnose({capabilities:{verifier:{ready:true}},outreach:{mode:'off',holds:{catch_all_domain:3}},funnel:{ready:150}});
  assert.equal(auto.find(x=>x.code==='holds').level,'info');
});
test('a rejected Verifalia login is a top owner action',()=>{
  for(const input of [{capabilities:{verifier:{ready:true,balance:{error:'login_rejected'}}},outreach:{}},{capabilities:{verifier:{ready:true}},outreach:{holds:{mailbox_verifalia_login_rejected:1}}}]){
    const d=diagnose({...input,funnel:{ready:100}});assert.equal(d[0].code,'verifier_rejected');assert.equal(d[0].level,'action');
  }
});
test('permission problems get their own fix, distinct from a wrong password',()=>{
  const p=diagnose({capabilities:{verifier:{ready:true,balance:{error:'permission_denied',endpoint:'credits_balance'}}},outreach:{},funnel:{ready:100}});
  assert.equal(p[0].code,'verifier_permission');assert.match(p[0].message,/view the credits balance/);
  const l=diagnose({capabilities:{verifier:{ready:true,balance:{error:'login_rejected'}}},outreach:{},funnel:{ready:100}});
  assert.equal(l[0].code,'verifier_rejected');assert.match(l[0].fix,/two-factor/);
});
