import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../functions/api/[[path]].js';

const SECRET='test-very-long-unique-private-proxy-password-123456789';
const origin='https://private-api.example.net';
const env={BACKLINK_API_ORIGIN:origin, BACKLINK_PROXY_SECRET:SECRET};
const req=(path, opts={})=>new Request(`https://backlink-command-center.pages.dev${path}`,opts);
const go=(request,bindings=env)=>onRequest({request,env:bindings});
const readJson=async r=>r.json();

test('missing settings fail closed without calling upstream', async()=>{
  const r=await go(req('/api/session'),{});
  assert.equal(r.status,503);
  assert.match((await readJson(r)).detail,/Configure/);
  assert.equal(r.headers.get('Cache-Control'),'no-store, private');
});

test('refuse insecure HTTP origins or embedded user info', async()=>{
  for(const v of ['http://example.net','https://user:pass@example.net','https://example.net/other','javascript:alert(1)']){
    const r=await go(req('/api/session'),{...env,BACKLINK_API_ORIGIN:v});
    assert.equal(r.status,503);
  }
});

test('proxy forwards only approved headers, enforces internal token, returns cookie securely',async t=>{
  const previous=globalThis.fetch;
  t.after(()=>globalThis.fetch=previous);
  let passed;
  globalThis.fetch=async request=>{passed=request;return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json','set-cookie':'bcc_session=abc; HttpOnly; Secure; SameSite=Strict; Path=/','access-control-allow-origin':'*'}})};
  const request=req('/api/login?source=test',{method:'POST',body:JSON.stringify({password:'not-an-actual-password'}),headers:{'Content-Type':'application/json','X-Backlink-Proxy-Token':'spoof','X-CSRF-Token':'abc','X-Attack':'evil','Cookie':'cookie123'}});
  const r=await go(request);
  assert.equal(r.status,200);
  assert.equal(passed.url,origin+'/api/login?source=test');
  assert.equal(passed.headers.get('X-Backlink-Proxy-Token'),SECRET);
  assert.equal(passed.headers.get('X-CSRF-Token'),'abc');
  assert.equal(passed.headers.get('X-Attack'),null);
  assert.equal(passed.headers.get('Cookie'),'cookie123');
  assert.match(r.headers.get('Set-Cookie'),/HttpOnly/);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
});

test('never leak private host via redirects',async t=>{
  const old=globalThis.fetch;
  t.after(()=>globalThis.fetch=old);
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:origin+'/secret'}});
  const r=await go(req('/api/session'));
  assert.equal(r.status,502);
  assert.equal(r.headers.get('Location'),null);
});

test('backend errors remain meaningful but cannot leak upstream headers',async t=>{
  const old=globalThis.fetch;
  t.after(()=>globalThis.fetch=old);
  globalThis.fetch=async()=>new Response(JSON.stringify({detail:'unauthorized'}),{status:401,headers:{'content-type':'application/json','x-debug-token':'secret'}});
  const r=await go(req('/api/session'));
  assert.equal(r.status,401);
  assert.equal(r.headers.get('X-Debug-Token'),null);
  assert.deepEqual(await readJson(r),{detail:'unauthorized'});
});

test('network outage produces explicit 503 without credentials',async t=>{
  const old=globalThis.fetch;
  t.after(()=>globalThis.fetch=old);
  globalThis.fetch=async()=>{throw new Error('PRIVATE SECRET '+SECRET)};
  const r=await go(req('/api/session'));
  assert.equal(r.status,503);
  const body=await r.text();
  assert.doesNotMatch(body,/PRIVATE SECRET|test-very-long-unique/);
});

test('reject unrelated paths',async()=>{
  const r=await go(req('/other'));
  assert.equal(r.status,404);
});
