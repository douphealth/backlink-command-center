import test from 'node:test';
import assert from 'node:assert/strict';
import {DataForSEO,trackExternalSpend,MIN_BALANCE} from '../../scripts/autopilot/dataforseo.mjs';
import {unparkAfterFundsOutage} from '../../scripts/autopilot/run.mjs';
import {diagnose} from '../../scripts/autopilot/health.mjs';
import {mxClass,verifyPassRate,RecipientVerifier} from '../../scripts/autopilot/recipient-policy.mjs';
import {preverify,coolingDown,creditValue,applyProof} from '../../scripts/autopilot/outreach.mjs';

const json=o=>new Response(JSON.stringify(o),{headers:{'content-type':'application/json'}});

test('an empty DataForSEO balance stops lookups for the cycle but parks nothing',async()=>{
  let calls=0;const logs=[];
  const state={};
  const dfs=new DataForSEO({login:'l',password:'p',state,log:m=>logs.push(m),fetchImpl:async()=>{calls++;return new Response(JSON.stringify({status_code:40200,status_message:'Payment Required.',cost:0,tasks:[{status_code:40200,status_message:'Payment Required.'}]}),{status:402,headers:{'content-type':'application/json'}})}});
  assert.equal(await dfs.serp('q'),null);
  assert.equal(dfs.outOfFunds,true);assert.deepEqual(state.dfs_blocked,{},'nothing parked for 7 days');
  assert.equal(await dfs.backlinks('rival.com'),null);assert.equal(calls,1,'no further paid call this cycle');
  assert.equal(logs.filter(l=>/balance is used up/.test(l)).length,1);
  // After a top-up the next cycle works at once.
  const next=new DataForSEO({login:'l',password:'p',state,fetchImpl:async u=>String(u).includes('user_data')?json({status_code:20000,tasks:[{result:[{money:{balance:12.5}}]}]}):json({status_code:20000,cost:0.006,tasks:[{status_code:20000,result:[{items:[{type:'organic',url:'https://p.com/x',domain:'p.com',title:'P',rank_absolute:1}]}]}]})});
  assert.equal((await next.verify()).balance_usd,12.5);assert.equal(next.canSpend('serp'),true);assert.equal((await next.serp('q')).length,1);
});

test('a known-empty balance makes no paid call; a missing subscription is still parked',async()=>{
  let paid=0;
  const dfs=new DataForSEO({login:'l',password:'p',state:{},fetchImpl:async u=>{if(String(u).includes('user_data'))return json({status_code:20000,tasks:[{result:[{money:{balance:-0.0008}}]}]});paid++;return json({})}});
  const v=await dfs.verify();assert.equal(v.out_of_funds,true);assert.ok(v.balance_usd<MIN_BALANCE);
  assert.equal(dfs.canSpend('serp'),false);assert.equal(await dfs.serp('q'),null);assert.equal(paid,0);
  const state={};
  const sub=new DataForSEO({login:'l',password:'p',state,fetchImpl:async()=>json({status_code:20000,cost:0,tasks:[{status_code:40204,status_message:'Access denied. Visit Plans and Subscriptions to activate your subscription.'}]})});
  await sub.backlinks('rival.com');assert.ok(state.dfs_blocked.backlinks,'a real access restriction is parked');assert.ok(!sub.outOfFunds);
});

test('lookups parked by the empty balance are reopened once',()=>{
  const state={dfs_blocked:{serp:'2026-11-26T02:42:28Z',backlinks:'2026-11-26T02:42:28Z',traffic:'2026-11-26T02:42:28Z'}};
  assert.deepEqual(unparkAfterFundsOutage(state),{reopened:['serp','backlinks','traffic']});assert.deepEqual(state.dfs_blocked,{});
  state.dfs_blocked={backlinks:'2026-12-01T00:00:00Z'};assert.equal(unparkAfterFundsOutage(state),null);assert.ok(state.dfs_blocked.backlinks,'runs once');
});

test('spending outside Autopilot is measured from the balance and the ledger',()=>{
  const now=new Date().toISOString();
  const state={ledger:[{at:now,kind:'serp',cost:0.10}]};
  assert.equal(trackExternalSpend(state,10).since_last_cycle_usd,0,'first reading only sets the baseline');
  state.ledger.push({at:now,kind:'serp',cost:0.20});
  assert.equal(trackExternalSpend(state,9.8).since_last_cycle_usd,0,'balance fell exactly by what Autopilot spent');
  state.ledger.push({at:now,kind:'backlinks',cost:0.10});
  const r=trackExternalSpend(state,8.2);
  assert.equal(r.since_last_cycle_usd,1.5);assert.equal(r.last_7d_usd,1.5);
  assert.equal(trackExternalSpend(state,20).since_last_cycle_usd,0,'a top-up is not spending');
  assert.equal(trackExternalSpend(state,NaN),null);
  const out=diagnose({capabilities:{verifier:{ready:true},connections:{dataforseo:{status:'connected',balance_usd:-0.0008}}},spend:{external:{last_7d_usd:5.4}}});
  assert.ok(out.find(x=>x.code==='dataforseo_funds'&&x.level==='action'));assert.ok(out.find(x=>x.code==='dataforseo_external'));
  assert.ok(diagnose({capabilities:{verifier:{ready:true},connections:{dataforseo:{status:'connected',balance_usd:1.2}}}}).find(x=>x.code==='dataforseo_low'));
});

test('mail hosts are classed from MX records and their verification rate is learned',()=>{
  assert.equal(mxClass([{exchange:'aspmx.l.google.com'},{exchange:'alt1.aspmx.l.google.com'}]),'google');
  assert.equal(mxClass([{exchange:'pub-com.mail.protection.outlook.com'}]),'microsoft');
  assert.equal(mxClass([{exchange:'route1.mx.cloudflare.net'}]),'forwarder');
  assert.equal(mxClass([{exchange:'mail.selfhosted.example'}]),'other');assert.equal(mxClass([]),'none');
  const state={verify_stats:{google:{n:10,valid:7},other:{n:20,valid:1}}};
  assert.ok(verifyPassRate(state,'google')>0.6);assert.ok(verifyPassRate(state,'other')<0.1);
  assert.ok(Math.abs(verifyPassRate({},'google')-1/3)<1e-9,'untried hosts start at 1/3 so they are explored');
  const overall=verifyPassRate(state,'zoho');assert.ok(overall>0.2&&overall<0.35,'unseen host uses the overall rate');
  // Same link likelihood: the credit goes to the host that verifies.
  assert.ok(creditValue(state,{mx_class:'google'},60)>creditValue(state,{mx_class:'other'},80));
});

const env={EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:'24',HUNTER_API_KEY:'real-key'};
const hunter=status=>json({data:{email:'ed@pub.com',status,regexp:true,mx_records:true,smtp_server:true,smtp_check:status==='valid',accept_all:false,block:false,disposable:false,gibberish:false}});
test('an inbox that stays "unknown" waits longer each time and reports when it can be retried',async()=>{
  let now=Date.parse('2026-11-26T00:00:00Z'),calls=0;const state={};
  const v=new RecipientVerifier({state,fetchPage:async()=>({status:404}),env,now:()=>now,fetchImpl:async()=>{calls++;return hunter('unknown')}});
  const first=await v.mailbox('ed@pub.com',{mxClass:'other'});assert.equal(first.status,'unknown');assert.equal(calls,1);
  assert.deepEqual(state.verify_stats,{other:{n:1,valid:0}});
  now+=2*864e5;const cached=await v.mailbox('ed@pub.com',{mxClass:'other'});
  assert.equal(cached.reason,'recently_inconclusive');assert.equal(cached.retry_after,'2026-11-29T00:00:00.000Z');assert.equal(calls,1,'no credit for a cached answer');
  now+=2*864e5;await v.mailbox('ed@pub.com',{mxClass:'other'});assert.equal(calls,2,'re-checked after 3 days');
  now+=4*864e5;const again=await v.mailbox('ed@pub.com',{mxClass:'other'});
  assert.equal(calls,2,'second unknown waits 6 days, not 3');assert.equal(again.reason,'recently_inconclusive');
});

test('the queue skips inboxes with a cached inconclusive answer instead of spending a slot on them',async()=>{
  const at=new Date('2026-11-25T12:00:00Z'),future=new Date(at.getTime()+2*864e5).toISOString();
  const mk=(id,extra)=>({id,status:'ready',email:`e@${id}.com`,domain:`${id}.com`,qv:2,score:90,history:[],...extra});
  const state={verify_stats:{google:{n:10,valid:8},other:{n:10,valid:0}},prospects:{
    cool:mk('cool',{score:99,contact_quality:{status:'held',detail:'mailbox_recently_inconclusive',checked_at:at.toISOString(),retry_after:future}}),
    other:mk('other',{score:95}),google:mk('google',{score:60})}};
  assert.equal(coolingDown(state.prospects.cool,at.getTime()),true);assert.equal(coolingDown(state.prospects.other,at.getTime()),false);
  const asked=[];
  const mailer={mxClassOf:async p=>p.id==='google'?'google':'other',authorizeRecipient:async p=>{asked.push(p.id);return {ok:false,reason:'no_verified_mailbox',detail:'mailbox_unknown'}}};
  const r=await preverify({state,mailer,max:1,now:()=>at});
  assert.deepEqual(asked,['google'],'the one credit goes to the host that verifies, and never to the cooling inbox');assert.equal(r.checked,1);
  assert.equal(state.prospects.google.mx_class,'google');assert.equal(state.prospects.cool.mx_class,undefined,'no DNS lookup for a skipped inbox');
  // A hold records the retry time it was given.
  const p=mk('x');applyProof(state,p,{ok:false,reason:'no_verified_mailbox',detail:'mailbox_recently_inconclusive',retry_after:new Date(Date.now()+864e5).toISOString()});
  assert.ok(coolingDown(p));
});
