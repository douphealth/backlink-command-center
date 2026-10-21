import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto,randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,statSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import handler from '../../src/index.js';
import {handleApi} from '../../functions/_lib/api.js';
import {ensureDb,first,run} from '../../functions/_lib/db.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
class Db {
  constructor(){this.sqlite=new DatabaseSync(':memory:');}
  prepare(sql){const make=(args=[])=>({bind(...vals){return make(vals)},all:async()=>({results:this.sqlite.prepare(sql).all(...args)}),first:async()=>this.sqlite.prepare(sql).get(...args)||null,run:async()=>{const r=this.sqlite.prepare(sql).run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}}}});return make()}
  async batch(items){for(const entry of items)await entry.run();return []}
}
const secretKey='LFC-'+randomBytes(35).toString('base64url');
const secretSession='LFS-'+randomBytes(45).toString('base64url');
const makeEnv=()=>({DB:new Db(),LINKFORGE_ADMIN_KEY:secretKey,LINKFORGE_SESSION_SECRET:secretSession,DATAFORSEO_PAID_ENABLED:'NO',ASSETS:{fetch:async()=>new Response('<html>Dashboard</html>',{headers:{'content-type':'text/html'}})}});
const req=(path,options={})=>new Request('https://linkforge.example'+path,options);
const body=(code)=>JSON.stringify({code});
const login=(env,code)=>handleApi(req('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:body(code)}),env);

test('one Worker combines static assets, D1 and the scheduled job handler',async()=>{
  const e=makeEnv();const status=await handler.fetch(req('/api/setup'),e);
  assert.equal(status.status,200);
  const s=await status.json();assert.equal(s.database_bound,true);assert.equal(s.auth_ready,true);assert.equal(s.login_method,'deployment_code');
  assert.equal(s.cloudflare_access_configured,false);
  const front=await handler.fetch(req('/'),e);
  assert.equal(front.status,200);assert.equal(front.headers.get('X-Robots-Tag'),'noindex, nofollow, noarchive');
  assert.equal(front.headers.get('Cache-Control'),'no-store');
  assert.equal((await front.text()).includes('Dashboard'),true);
  const blocked=await handler.fetch(req('/api/overview'),e);assert.equal(blocked.status,401);
  let work;
  const ctx={waitUntil(p){work=p}};
  await handler.scheduled({},e,ctx);await work;
  const heartbeat=await first(e.DB,'SELECT last_seen_at FROM worker_status WHERE id=1');assert.ok(heartbeat?.last_seen_at);
});

test('operator code creates secure HttpOnly session; API enforces private records and CSRF',async()=>{
  const e=makeEnv();let r=await login(e,secretKey+'bad');assert.equal(r.status,401);
  r=await login(e,secretKey);assert.equal(r.status,200);
  const setCookie=r.headers.get('set-cookie')||'';
  assert.match(setCookie,/Secure/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);
  assert.doesNotMatch(setCookie,new RegExp(secretKey));
  const cookie=setCookie.split(';')[0];
  const sessionReq=req('/api/session',{headers:{cookie}});
  const session=await handleApi(sessionReq,e);assert.equal(session.status,200);
  const data=await session.json();assert.equal(data.provider,'LinkForge secure session');assert.equal(data.authenticated,true);
  r=await handleApi(req('/api/overview',{headers:{cookie}}),e);assert.equal(r.status,200);
  r=await handleApi(req('/api/operations/commands',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'audit_assets'})}),e);assert.equal(r.status,403);
  r=await handleApi(req('/api/operations/commands',{method:'POST',headers:{cookie,'x-csrf-token':data.csrf,'content-type':'application/json'},body:JSON.stringify({action:'audit_assets'})}),e);assert.equal(r.status,200);
  const logoutNoCsrf=await handleApi(req('/api/logout',{method:'POST',headers:{cookie}}),e);
  assert.equal(logoutNoCsrf.status,403);
  const logout=await handleApi(req('/api/logout',{method:'POST',headers:{cookie,'x-csrf-token':data.csrf}}),e);
  assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie')||'',/Max-Age=0/);
  const segments=cookie.split('.');segments[2]=(segments[2][0]==='A'?'B':'A')+segments[2].slice(1);const forged=segments.join('.');
  r=await handleApi(req('/api/overview',{headers:{cookie:forged}}),e);assert.equal(r.status,401);
});

test('authentication fails closed without deployment secrets or DB',async()=>{
  let r=await handleApi(req('/api/setup'),{DB:new Db()});let s=await r.json();assert.equal(s.auth_ready,false);
  r=await handleApi(req('/api/session'),{DB:new Db()});assert.equal(r.status,503);
  r=await handleApi(req('/api/login',{method:'POST',body:body('x')}),{LINKFORGE_ADMIN_KEY:secretKey,LINKFORGE_SESSION_SECRET:secretSession});assert.equal(r.status,503);
});

test('brute-force guard is durable in D1, after six failures next attempt is blocked',async()=>{
  const e=makeEnv();for(let i=0;i<6;i++)assert.equal((await login(e,'fake-'+i)).status,401);
  assert.equal((await login(e,secretKey)).status,429);
  const record=await first(e.DB,'SELECT failed FROM login_attempts');assert.equal(record.failed,6);
});

test('Cloudflare config auto-provisions one D1 and deploys static site, API and cron in one Worker',()=>{
  const json=JSON.parse(readFileSync(join(root,'wrangler.jsonc'),'utf8'));
  assert.equal(json.main,'src/index.js');assert.equal(json.d1_databases.length,1);
  assert.equal(json.d1_databases[0].binding,'DB');assert.equal(json.d1_databases[0].database_name,'linkforge-db');
  assert.equal('database_id' in json.d1_databases[0],false);
  assert.deepEqual(json.triggers.crons,['0 * * * *']);
  assert.equal(json.assets.directory,'./public');
  assert.deepEqual(json.assets.run_worker_first,['/api/*']);
  assert.equal(json.vars.DATAFORSEO_PAID_ENABLED,'NO');
});

test('single deployment script generates safe secrets once, reuses them, never checks secrets into git',()=>{
  const dir=mkdtempSync(join(tmpdir(),'linkforge-deploy-test-'));
  try{
    writeFileSync(join(dir,'wrangler.jsonc'),'{}');
    const wrangler=join(dir,'fake-wrangler.mjs');
    const events=join(dir,'calls.log');
    writeFileSync(wrangler,`import{writeFileSync,readFileSync}from'node:fs';\nconst cmd=process.argv[2];\nif(cmd==='deploy'){const ix=process.argv.indexOf('--secrets-file');if(ix<0)process.exit(4);const s=JSON.parse(readFileSync(process.argv[ix+1],'utf8'));if(s.LINKFORGE_ADMIN_KEY.length<32||s.LINKFORGE_SESSION_SECRET.length<40)process.exit(5);}\nwriteFileSync(process.env.MOCK_CALLS_FILE,cmd+'\\n',{flag:'a'});if(cmd==='deploy')console.log('https://linkforge-command-center.owner.workers.dev');\n`);
    const cmd=join(root,'scripts/deploy-one-cloudflare.mjs');
    const env={...process.env,NODE_ENV:'test',LINKFORGE_TEST_ROOT_DIR:dir,LINKFORGE_TEST_WRANGLER_BIN:wrangler,MOCK_CALLS_FILE:events,CI:'false'};
    const firstRun=spawnSync(process.execPath,[cmd],{env,encoding:'utf8',timeout:20000});
    assert.equal(firstRun.status,0,firstRun.stderr);
    const creds=join(dir,'.linkforge','operator-credentials.json');assert.ok(existsSync(creds));
    const c1=JSON.parse(readFileSync(creds,'utf8'));assert.ok(c1.access_code.length>=32);
    const recorded=readFileSync(events,'utf8');assert.match(recorded,/whoami/);assert.match(recorded,/deploy/);
    assert.equal(existsSync(join(dir,'.linkforge','secrets-upload.json')),false);
    assert.ok(!firstRun.stderr.includes(c1.access_code));
    if(process.platform!=='win32')assert.equal(statSync(creds).mode & 0o077,0);
    const second=spawnSync(process.execPath,[cmd],{env,encoding:'utf8',timeout:20000});assert.equal(second.status,0,second.stderr);
    const c2=JSON.parse(readFileSync(creds,'utf8'));assert.equal(c1.access_code,c2.access_code);
    assert.doesNotMatch(readFileSync(join(root,'.gitignore'),'utf8'),/^#include operator credentials$/m);
    assert.match(readFileSync(join(root,'.gitignore'),'utf8'),/\.linkforge\//);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
