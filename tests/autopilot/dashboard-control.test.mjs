import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
globalThis.nacl=require('tweetnacl');
const mem=new Map();
globalThis.localStorage={getItem:k=>mem.get(k)??null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)};
const {blake2b,sealedBox,toB64}=await import('../../public/sealed-box.js');
const control=await import('../../public/github-control.js');

test('BLAKE2b matches Node and libsodium at every block boundary',async()=>{
  const sodium=require('libsodium-wrappers');await sodium.ready;
  for(const len of [0,1,64,127,128,129,256,300]){
    const x=new Uint8Array(len).map((_,i)=>(i*31)&255);
    assert.deepEqual(Buffer.from(blake2b(x,64)),createHash('blake2b512').update(x).digest());
    assert.deepEqual(Buffer.from(blake2b(x,24)),Buffer.from(sodium.crypto_generichash(24,x)));
  }
});

test('sealed box opens with libsodium crypto_box_seal_open (GitHub secrets format)',async()=>{
  const sodium=require('libsodium-wrappers');await sodium.ready;
  const kp=sodium.crypto_box_keypair();
  const sealed=sealedBox(new TextEncoder().encode('app password ✓'),kp.publicKey);
  assert.equal(sodium.to_string(sodium.crypto_box_seal_open(sealed,kp.publicKey,kp.privateKey)),'app password ✓');
});

function mockGitHub(){
  const calls=[],sodiumKp=globalThis.nacl.box.keyPair();
  const state={wf:'active',runs:[{id:7,status:'in_progress',html_url:'u',run_started_at:'2026-10-23T05:00:00Z'}],secrets:{},vars:{}};
  globalThis.fetch=async(url,init={})=>{
    const path=new URL(url).pathname,method=init.method||'GET';calls.push(`${method} ${path}`);
    const json=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json'}});
    if(init.headers?.Authorization!=='Bearer tok'&&method!=='GET')return json({message:'Bad credentials'},401);
    if(path==='/user')return init.headers?.Authorization==='Bearer tok'?json({login:'douphealth'}):json({message:'Bad credentials'},401);
    if(state.publicOnly&&/\/actions\/(secrets|variables)|\/enable$/.test(path))return json({message:'Resource not accessible by personal access token'},403);
    if(path.endsWith('/workflows/autopilot.yml'))return json({state:state.wf});
    if(path.endsWith('/workflows/autopilot.yml/runs'))return json({workflow_runs:new URL(url).searchParams.get('status')==='queued'?[]:state.runs});
    if(path.endsWith('/disable')){state.wf='disabled_manually';return new Response(null,{status:204})}
    if(path.endsWith('/enable')){state.wf='active';return new Response(null,{status:204})}
    if(path.endsWith('/dispatches'))return new Response(null,{status:204});
    if(path.endsWith('/cancel'))return json({},202);
    if(path.endsWith('/secrets/public-key'))return json({key_id:'k1',key:toB64(sodiumKp.publicKey)});
    if(path.includes('/secrets/')&&method==='PUT'){state.secrets[path.split('/').pop()]=JSON.parse(init.body);return new Response(null,{status:201})}
    if(path.endsWith('/secrets'))return json({secrets:Object.keys(state.secrets).map(name=>({name}))});
    if(path.includes('/variables/')&&method==='PATCH')return state.vars[path.split('/').pop()]?new Response(null,{status:204}):json({message:'Not Found'},404);
    if(path.endsWith('/variables')&&method==='POST'){const b=JSON.parse(init.body);state.vars[b.name]=b.value;return new Response(null,{status:201})}
    if(path.endsWith('/variables'))return json({variables:Object.entries(state.vars).map(([name,value])=>({name,value}))});
    return json({message:'unexpected '+path},500);
  };
  return {calls,state,kp:sodiumKp};
}

test('Run re-enables and dispatches; Stop disables and cancels the live run',async()=>{
  const gh=mockGitHub();control.token.set('tok');
  let s=await control.status();
  assert.equal(s.running,true);assert.equal(s.enabled,true);
  await control.stop();
  assert.equal(gh.state.wf,'disabled_manually');
  assert.ok(gh.calls.includes('POST /repos/douphealth/backlink-command-center/actions/runs/7/cancel'));
  gh.state.runs=[];
  await control.run();
  assert.equal(gh.state.wf,'active');
  assert.ok(gh.calls.at(-1).endsWith('/actions/workflows/autopilot.yml/dispatches'));
});

test('secrets are sealed in the browser before upload',async()=>{
  const gh=mockGitHub();control.token.set('tok');
  await control.setSecret('GMAIL_APP_PASSWORD','abcdabcdabcdabcd');
  const put=gh.state.secrets.GMAIL_APP_PASSWORD;
  assert.equal(put.key_id,'k1');assert.ok(!put.encrypted_value.includes('abcd'));
  const sealed=Uint8Array.from(atob(put.encrypted_value),c=>c.charCodeAt(0));
  const nonce=blake2b(Uint8Array.from([...sealed.slice(0,32),...gh.kp.publicKey]),24);
  const opened=globalThis.nacl.box.open(sealed.slice(32),nonce,sealed.slice(0,32),gh.kp.secretKey);
  assert.equal(new TextDecoder().decode(opened),'abcdabcdabcdabcd');
  assert.ok((await control.diagnose()).secretNames.has('GMAIL_APP_PASSWORD'));
});

test('a bad token produces a clear message; the token link asks only for Actions + Secrets',async()=>{
  mockGitHub();control.token.set('wrong');
  await assert.rejects(control.run(),/rejected the token/);
  const u=new URL(control.TOKEN_URL);
  assert.equal(u.searchParams.get('actions'),'write');assert.equal(u.searchParams.get('secrets'),'write');
  assert.ok(!u.searchParams.has('variables')&&!u.searchParams.has('actions_variables'));
});

test('diagnose names the missing permission; Actions + Secrets alone is enough',async()=>{
  const gh=mockGitHub();control.token.set('tok');
  gh.state.publicOnly=true;
  let d=await control.diagnose({probeActions:true});
  assert.equal(d.valid,true);assert.equal(d.login,'douphealth');
  assert.equal(d.secrets,false);assert.equal(d.actions,false);
  assert.equal(control.diagnosisOk(d),false);
  // The owner's real token: Actions + Secrets read/write, no Variables permission.
  gh.state.publicOnly=false;gh.state.secrets.LINKFORGE_DATA_KEY={};
  d=await control.diagnose({probeActions:true});
  assert.equal(control.diagnosisOk(d),true);assert.ok(d.secretNames.has('LINKFORGE_DATA_KEY'));
  control.token.set('wrong');
  d=await control.diagnose();
  assert.equal(d.valid,false);assert.match(d.error,/rejected the token/);
});

test('token falls back to tab memory when the browser blocks storage',()=>{
  const saved=globalThis.localStorage;
  globalThis.localStorage={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')},removeItem(){throw Error('blocked')}};
  try{control.token.set('tok-mem');assert.equal(control.token.get(),'tok-mem');assert.equal(control.token.persistent,false)}
  finally{globalThis.localStorage=saved;control.token.set('')}
});

test('a dropped connection gives a clear message instead of "Failed to fetch"',async()=>{
  globalThis.fetch=async()=>{throw new TypeError('Failed to fetch')};
  control.token.set('tok');
  await assert.rejects(control.setSecret('X','y'),/Couldn't reach GitHub/);
  const d=await control.diagnose();assert.equal(d.valid,false);assert.match(d.error,/Couldn't reach GitHub/);
  control.token.set('');
});

test('routine token checks never re-enable the workflow (only an explicit re-check probes)',async()=>{
  const gh=mockGitHub();control.token.set('tok');
  await control.diagnose({probeActions:true});
  const before=gh.calls.filter(c=>c.endsWith('/enable')).length;
  const d=await control.diagnose();
  assert.equal(gh.calls.filter(c=>c.endsWith('/enable')).length,before,'no PUT /enable on routine checks');
  assert.equal(d.actions,true,'remembered result reused');
});
