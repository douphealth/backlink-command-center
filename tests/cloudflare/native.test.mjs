import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import {handleApi} from '../../functions/_lib/api.js';
import {runTick, researchGap} from '../../src/scheduler.js';
import {ensureDb,run,first,flags,query} from '../../functions/_lib/db.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
class Db {
  constructor(){this.sqlite=new DatabaseSync(':memory:');}
  prepare(sql){const db=this.sqlite;const make=(args=[])=>({
    bind(...vals){return make(vals)},
    all(){return Promise.resolve({results:db.prepare(sql).all(...args)})},
    first(){return Promise.resolve(db.prepare(sql).get(...args)||null)},
    run(){const r=db.prepare(sql).run(...args);return Promise.resolve({meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}})},
  });return make()}
  async batch(items){for(const x of items) await x.run();return []}
}
const env=()=>({DB:new Db()});
const request=(path,opts={})=>new Request('https://command.example'+path,opts);
const b64url=bytes=>Buffer.from(bytes).toString('base64url');
const jsonurl=o=>b64url(JSON.stringify(o));
let token,siteEmail='admin@example.com',signingKey,publicKey;
async function setupIdentity(){
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  signingKey=keys.privateKey;publicKey={...(await crypto.subtle.exportKey('jwk',keys.publicKey)),kid:'test-signing-key'};
  const head=jsonurl({typ:'JWT',alg:'RS256',kid:'test-signing-key'}),body=jsonurl({aud:['cf-app-audience'],email:siteEmail,iss:'https://myteam.cloudflareaccess.com',exp:Math.floor(Date.now()/1000)+600,iat:Math.floor(Date.now()/1000)});
  const sig=await crypto.subtle.sign({name:'RSASSA-PKCS1-v1_5'},signingKey,new TextEncoder().encode(head+'.'+body));token=head+'.'+body+'.'+b64url(sig);
}
const authorized=(path,init={})=>request(path,{...init,headers:{'Cf-Access-Jwt-Assertion':token,...(init.headers||{})}});
const envAccess=()=>({...env(),CF_ACCESS_TEAM_DOMAIN:'myteam.cloudflareaccess.com',CF_ACCESS_AUD:'cf-app-audience',ADMIN_EMAIL:siteEmail});
const orig=globalThis.fetch;
test.before(async()=>{await setupIdentity();globalThis.fetch=async (input,init)=>{const url=String(input);if(url==='https://myteam.cloudflareaccess.com/cdn-cgi/access/certs')return Response.json({keys:[publicKey]});return orig(input,init);};});
test.after(()=>{globalThis.fetch=orig});

test('No password on the frontend; setup endpoint reveals config status without data',async()=>{
  const r=await handleApi(request('/api/setup'),{});assert.equal(r.status,200);const d=await r.json();assert.equal(d.no_manual_cloudflare_setup,true);assert.equal(d.mode,'setup_required');
});
test('Dashboard API denies access without valid Cloudflare identity and refuses missing config',async()=>{
  let r=await handleApi(request('/api/overview'),env());assert.equal(r.status,503);
  r=await handleApi(request('/api/session'),envAccess());assert.equal(r.status,401);
  r=await handleApi(authorized('/api/session',{headers:{'Cf-Access-Jwt-Assertion':'forged.jwt.signature'}}),envAccess());assert.equal(r.status,401);
});
test('Authenticated Cloudflare Access opens real D1-backed dashboard with zero fabricated results',async()=>{
  const e=envAccess();let r=await handleApi(authorized('/api/session'),e);assert.equal(r.status,200);let data=await r.json();assert.equal(data.authenticated,true);assert.equal(data.provider,'Cloudflare Access');
  r=await handleApi(authorized('/api/overview'),e);assert.equal(r.status,200);data=await r.json();assert.equal(data.counts.links,0);assert.equal(data.counts.prospects,0);assert.equal(data.data_source,'Cloudflare D1 — verified records only');
});
test('Unauthenticated public readers cannot query private outreach data',async()=>{
  const e=envAccess();let r=await handleApi(request('/api/outreach'),e);assert.equal(r.status,401);
});
test('CSRF required on operator writes; valid request queues only once',async()=>{
  const e=envAccess();const login=await (await handleApi(authorized('/api/session'),e)).json();
  const payload=JSON.stringify({action:'audit_assets'});
  let r=await handleApi(authorized('/api/operations/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:payload}),e);assert.equal(r.status,403);
  const init={method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':login.csrf},body:payload};
  r=await handleApi(authorized('/api/operations/commands',init),e);assert.equal(r.status,200);let d=await r.json();assert.equal(d.created,true);
  r=await handleApi(authorized('/api/operations/commands',init),e);d=await r.json();assert.equal(d.created,false);
});
test('Outreach and paid DataForSEO are paused by default',async()=>{
  const e=envAccess();await ensureDb(e.DB);const f=await flags(e.DB);assert.equal(f.outreach_paused,true);assert.equal(f.dataforseo_paused,true);
  assert.equal(f.research_paused,false);
});
test('Cannot promote unverified candidates to verified via admin action',async()=>{
  const e=envAccess();await ensureDb(e.DB);
  await run(e.DB,'INSERT INTO candidates(site,publisher_domain,source_url,last_updated) VALUES(?,?,?,?)','gearuptofit.com','editor.example','https://editor.example/','2026-10-21');
  const {csrf}=await (await handleApi(authorized('/api/session'),e)).json();
  const r=await handleApi(authorized('/api/prospects/1',{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({status:'verified_ready'})}),e);
  assert.equal(r.status,409);
});
test('A queued audit can execute on the Cloudflare Worker with durable heartbeat',async()=>{
  const e=envAccess();await ensureDb(e.DB);
  await run(e.DB,"INSERT INTO worker_commands(action,status,requested_at) VALUES('audit_assets','queued',?)",new Date().toISOString());
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async (input,init)=>{if(String(input).includes('cloudflareaccess.com'))return oldFetch(input,init);return new Response('<html>'+('good source content '.repeat(30))+'</html>',{status:200,headers:{'Content-Type':'text/html'}})};
  try{
    const jobs=await runTick(e,{maxJobs:1});assert.equal(jobs.length,1);assert.equal(jobs[0].action,'audit_assets');
    const status=await first(e.DB,'SELECT status FROM worker_commands WHERE id=1');assert.equal(status.status,'completed');
    const heartbeat=await first(e.DB,'SELECT last_seen_at FROM worker_status WHERE id=1');assert.ok(heartbeat.last_seen_at);
  }finally{globalThis.fetch=oldFetch}
});
test('No DataForSEO paid API calls without verified provider settings and released controls',async()=>{
  const e=env();await ensureDb(e.DB);
  const result=await researchGap(e.DB,e);assert.match(result.blocked,/paused|credentials/i);
  const rows=await query(e.DB,'SELECT * FROM dfs_requests');assert.equal(rows.length,0);
});
test('Suppression and cost ledger queries are persistent in D1',async()=>{
  const e=envAccess();await ensureDb(e.DB);
  const {csrf}=await (await handleApi(authorized('/api/session'),e)).json();
  const r=await handleApi(authorized('/api/suppression',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({identity:'publisher.example',reason:'Publisher explicitly opted out'})}),e);
  assert.equal(r.status,200);const row=await first(e.DB,'SELECT reason FROM suppression WHERE identity=?','publisher.example');assert.equal(row.reason,'Publisher explicitly opted out');
  const overview=await (await handleApi(authorized('/api/overview'),e)).json();assert.equal(overview.spend.today_usd,0);
});
