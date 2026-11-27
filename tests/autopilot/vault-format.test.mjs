import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {seal,sealJson,open,vaultFormat,VAULT_VERSION} from '../../scripts/autopilot/vault.mjs';
import {prune,vaultSealer,REJECTED_KEEP_DAYS} from '../../scripts/autopilot/run.mjs';

const KEY='vault-test-key-'.repeat(2);
const iso=days=>new Date(Date.now()-days*86400e3).toISOString();

/** A state shaped like production: mostly rejected and queued prospects with URLs, reasons, excerpts and history. */
function syntheticState(n=1500){
  const words='mouse proofing garage seal gaps traps pest control guide home safety winter checklist'.split(' ');
  const text=i=>Array.from({length:40},(_,k)=>words[(i*7+k*3)%words.length]).join(' ');
  const prospects={},domains={};
  for(let i=0;i<n;i++){
    const d=`publisher-${i%600}-${(i*7919)%1000}.example`,site=['mice.example','plants.example','tools.example'][i%3],id=`p${i.toString(36)}`;
    prospects[id]={id,site,domain:d,page_url:`https://${d}/blog/${words[i%words.length]}-${i}/`,asset_url:`https://${site}/guide/${words[(i+3)%words.length]}/`,
      asset_title:`The complete ${words[i%words.length]} guide`,query:`${words[i%words.length]} resources`,found_at:iso(i%40),
      status:['rejected','rejected','ready','contact_unverifiable','sent'][i%5],reason:i%5<2?`Low fit score; ${text(i).slice(0,80)}`:undefined,
      title:`${text(i).slice(0,60)} | ${d}`,excerpt:text(i+1),score:(i*37)%100,etv:(i*131)%5000,qv:7,email:i%5>=2?`editor@${d}`:undefined,
      history:i%5===4?[{type:'initial',at:iso(3),message_id:`<lf-${i}-abc@sender.example>`,subject:`A resource for your ${words[i%words.length]} page`,to:`editor@${d}`,mode:'send',writer:'template'}]:[]};
    domains[`${site}|${d}`]=id;
  }
  return {v:1,created_at:iso(60),prospects,domains,suppression:{},contacted:{},queries:{},ledger:[]};
}

test('vault v2 gzips before sealing, round-trips, and never exposes the plaintext',async()=>{
  const value={a:1,emails:['x@y.com'],nested:{t:'ünïcødé ✓'}};
  const box=await seal(value,KEY);
  assert.equal(VAULT_VERSION,2);assert.equal(box.v,2);assert.equal(box.z,'gzip');assert.equal(box.alg,'AES-256-GCM');assert.ok(box.ct&&box.iv&&box.salt);
  assert.ok(!JSON.stringify(box).includes('x@y.com'));
  assert.deepEqual(await open(box,KEY),value);
  await assert.rejects(open(box,'z'.repeat(24)),/wrong LINKFORGE_DATA_KEY/);
  await assert.rejects(seal({},'short'),/at least 16/);
  assert.equal(vaultFormat(box),'v2-gzip');assert.equal(vaultFormat(null),null);
});

test('vault v1 files (sealed before the gzip change) still open',async()=>{
  const legacy=await sealJson(JSON.stringify({prospects:{a:{email:'ed@pub.com'}}}),KEY,{version:1});
  assert.equal(legacy.v,1);assert.equal(legacy.z,undefined);assert.equal(vaultFormat(legacy),'v1');
  assert.deepEqual(await open(legacy,KEY),{prospects:{a:{email:'ed@pub.com'}}});
  await assert.rejects(open(legacy,'z'.repeat(24)),/wrong LINKFORGE_DATA_KEY/);
});

test('unknown vault formats are refused instead of guessed',async()=>{
  const box=await seal({a:1},KEY);
  await assert.rejects(open({...box,v:3},KEY),/Unrecognized vault format/);
  await assert.rejects(open({...box,z:undefined},KEY),/Unrecognized vault format/,'v2 without its compression marker');
  await assert.rejects(open({...box,z:'brotli'},KEY),/Unrecognized vault format/);
  await assert.rejects(open(null,KEY),/Unrecognized vault format/);
  // A tampered ciphertext fails authentication, never yields partial data.
  const ct=Buffer.from(box.ct,'base64');ct[5]^=1;
  await assert.rejects(open({...box,ct:ct.toString('base64')},KEY),/wrong LINKFORGE_DATA_KEY or corrupted/);
});

test('a realistic state seals at least 3x smaller as v2 than v1',async()=>{
  const state=syntheticState();
  const v1=JSON.stringify(await seal(state,KEY,{version:1})).length,v2=JSON.stringify(await seal(state,KEY)).length;
  assert.ok(v1>1e6,`synthetic state is production-like in size (${v1} B)`);
  assert.ok(v2*3<v1,`v2 ${v2} B vs v1 ${v1} B`);
  assert.deepEqual(await open(await seal(state,KEY),KEY),JSON.parse(JSON.stringify(state)));
});

// The dashboard decrypts in the browser with WebCrypto; Node 22 has the same globals (crypto.subtle, atob,
// DecompressionStream, Blob, Response), so its reader is run here against vaults the engine sealed.
function dashboardReader(){
  const src=readFileSync(new URL('../../public/autopilot-view.js',import.meta.url),'utf8');
  const b64=src.match(/^const b64=.*$/m)[0],start=src.indexOf('async function openVault(');
  let depth=0,end=src.indexOf('{',start);for(;end<src.length;end++){if(src[end]==='{')depth++;else if(src[end]==='}'&&--depth===0)break}
  return new Function(`${b64}\n${src.slice(start,end+1)}\nreturn openVault;`)();
}
test('the dashboard reader opens both v1 and v2 vaults sealed by the engine',async()=>{
  const openVault=dashboardReader(),value={prospects:{a:{email:'ed@pub.com',status:'ready'}},note:'ünïcødé'};
  assert.deepEqual(await openVault(await seal(value,KEY),KEY),value);
  assert.deepEqual(await openVault(await sealJson(JSON.stringify(value),KEY,{version:1}),KEY),value);
  await assert.rejects(openVault(await seal(value,KEY),'z'.repeat(24)));
  await assert.rejects(openVault({...(await seal(value,KEY)),v:3},KEY),/Unrecognized vault format/);
  const big=syntheticState(400);assert.deepEqual(await openVault(await seal(big,KEY),KEY),JSON.parse(JSON.stringify(big)));
});

test('prune deletes rejected records after 7 days, keeps their dedup keys and anything that ever emailed',()=>{
  assert.equal(REJECTED_KEEP_DAYS,7);
  const state={prospects:{
    old:{id:'old',site:'s.com',domain:'old.com',status:'rejected',found_at:iso(8),history:[]},
    orphan:{id:'orphan',site:'s.com',domain:'orphan.com',status:'rejected',found_at:iso(30)},
    young:{id:'young',site:'s.com',domain:'young.com',status:'rejected',found_at:iso(3),history:[]},
    mailed:{id:'mailed',site:'s.com',domain:'mailed.com',status:'rejected',found_at:iso(50),history:[{type:'initial',at:iso(49),to:'ed@mailed.com',mode:'send'}]},
    bounced:{id:'bounced',site:'s.com',domain:'b.com',status:'rejected',found_at:iso(50),history:[{type:'bounce',at:iso(40)}]},
    queued:{id:'queued',site:'s.com',domain:'q.com',status:'ready',found_at:iso(100),history:[]},
    baddate:{id:'baddate',site:'s.com',domain:'x.com',status:'rejected',found_at:'not a date',history:[]},
  },domains:{'s.com|old.com':'old','s.com|young.com':'young'},domain_rejections:{'s.com|old.com':{at:iso(8),kind:'page',code:'low_fit'}},
  ledger:[{at:iso(401)},{at:iso(1)}],seen_replies:{a:iso(61),b:iso(2)},restored_sent:{'ed@gone.com':iso(401),'ed@kept.com':iso(30)}};
  const r=prune(state);
  assert.equal(r.rejected,2);
  assert.deepEqual(Object.keys(state.prospects).sort(),['baddate','bounced','mailed','queued','young']);
  assert.equal(state.domains['s.com|old.com'],'old','dedup kept');assert.equal(state.domains['s.com|orphan.com'],'orphan','dedup key added before the record goes');
  assert.ok(state.domain_rejections['s.com|old.com'],'rejection memory untouched');
  assert.equal(state.ledger.length,1);assert.deepEqual(Object.keys(state.seen_replies),['b']);
  assert.deepEqual(Object.keys(state.restored_sent),['ed@kept.com']);
  prune({prospects:{}});
});

test('vault sealer publishes the size it writes and re-seals only when the state changed',async()=>{
  const state={prospects:{a:{status:'ready'}}},s=vaultSealer(state,KEY);
  const first=await s.seal(),same=await s.seal();
  assert.equal(same,first,'unchanged state: the sealed file is reused');
  assert.equal(first.bytes,Buffer.byteLength(first.text));assert.ok(first.text.endsWith('\n'));
  assert.equal(JSON.parse(first.text).v,2);
  state.paid_serp_paused_until=iso(-1);
  const later=await s.seal();
  assert.notEqual(later,first);assert.equal((await open(JSON.parse(later.text),KEY)).paid_serp_paused_until,state.paid_serp_paused_until,'a late change is not lost');
});
