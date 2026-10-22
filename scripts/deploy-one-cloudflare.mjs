#!/usr/bin/env node
/**
 * One-command, owner-initiated deployment of the entire LinkForge stack.
 * Cloudflare auto-provisions D1 from wrangler.jsonc and schedules the Cron.
 * Operator credentials are generated locally, never logged by CI or in Git.
 * Only the admin+session secrets are uploaded -- NEVER DataForSEO credentials.
 */
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findDatabase,workerConfig,workerUrl,googleServiceAccount} from './cloudflare-deploy-guards.mjs';

const root=process.env.NODE_ENV==='test' && process.env.LINKFORGE_TEST_ROOT_DIR ? resolve(process.env.LINKFORGE_TEST_ROOT_DIR) : resolve(dirname(fileURLToPath(import.meta.url)),'..');
const home=join(root,'.linkforge');
const credentialsFile=join(home,'operator-credentials.json');
const config=join(root,'worker.wrangler.jsonc');
const deployConfig=join(root,'.linkforge-worker.deploy.jsonc');
const autoInstall=process.env.LINKFORGE_TEST_SKIP_INSTALL!=='1';

function banner(text){process.stdout.write(`\n${text}\n`);}
function run(binary,args,opts={}){
  return new Promise((done,reject)=>{
    const out=[];
    const p=spawn(binary,args,{cwd:root,env:process.env,stdio:['inherit','pipe','pipe'],shell:false,...opts});
    p.stdout.on('data',x=>{const t=String(x);out.push(t);if(!opts.quiet)process.stdout.write(t);});
    p.stderr.on('data',x=>{const t=String(x);out.push(t);if(!opts.quiet)process.stderr.write(t);});
    p.on('error',reject);
    p.on('close',(code)=>code===0?done(out.join('')):reject(Object.assign(new Error(`${binary} ${args.slice(0,2).join(' ')} exited with code ${code}`),{code})));
  });
}
async function wrangler(...args){
  if(process.env.LINKFORGE_TEST_WRANGLER_BIN){return run(process.execPath,[process.env.LINKFORGE_TEST_WRANGLER_BIN,...args]);}
  const runner=process.platform==='win32'?'npx.cmd':'npx';
  return run(runner,['--no-install','wrangler',...args]);
}
function secureWrite(path,data){writeFileSync(path,data,{mode:0o600,flag:'w'});if(process.platform!=='win32')chmodSync(path,0o600);}
function credentials(){
  mkdirSync(home,{recursive:true,mode:0o700});
  if(existsSync(credentialsFile)){
    const c=JSON.parse(readFileSync(credentialsFile,'utf8'));
    if(typeof c.access_code!=='string'||c.access_code.length<32||typeof c.session_secret!=='string'||c.session_secret.length<40)throw Error('Local credentials are corrupted; do not rotate implicitly. Inspect .linkforge/operator-credentials.json');
    return {data:c,created:false};
  }
  if(process.env.CI==='true')throw Error('Refusing to generate an operator access code in CI build logs. Run this command from your own computer first.');
  const c={access_code:randomBytes(30).toString('base64url'),session_secret:randomBytes(40).toString('base64url'),created_at:new Date().toISOString()};
  secureWrite(credentialsFile,JSON.stringify(c,null,2)+'\n');
  return {data:c,created:true};
}
function deploymentUrl(output){
  const matches=output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/ig)||[];
  return matches[matches.length-1]||null;
}
async function main(){
  banner('LINKFORGE · ONE CLOUDFLARE DEPLOYMENT');
  banner('Dashboard + private API + D1 database + scheduled jobs, in a single Worker.');
  if(!existsSync(config))throw Error('worker.wrangler.jsonc is missing');
  if(!process.env.LINKFORGE_TEST_WRANGLER_BIN && autoInstall && !existsSync(join(root,'node_modules','wrangler','bin','wrangler.js'))){
    banner('Installing the official Cloudflare Wrangler CLI...');
    await run(process.platform==='win32'?'npm.cmd':'npm',['install','--no-audit','--no-fund']);
  }
  banner('Checking Cloudflare authorization...');
  try{await wrangler('whoami');}
  catch{
    if(process.env.CI==='true')throw Error('Cloudflare authentication missing in CI. Use an interactive computer.');
    banner('One-time Cloudflare sign-in: complete the browser prompt.');
    await wrangler('login');
  }
  const list=await wrangler('d1','list','--json');
  let database=findDatabase(list);
  if(!database){
    banner('Creating the missing LinkForge D1 database once...');
    await wrangler('d1','create','linkforge-db');
    database=findDatabase(await wrangler('d1','list','--json'));
    if(!database)throw Error('D1 was not visible after creation; refusing an unbound deployment');
  }
  mkdirSync(home,{recursive:true,mode:0o700});
  secureWrite(deployConfig,workerConfig(readFileSync(config,'utf8'),database.id));
  const {data,created}=credentials();
  if(created)banner('A unique private access code was generated and saved locally (not in GitHub).');
  const secretFile=join(home,`secrets-upload-${randomBytes(6).toString('hex')}.json`);
  const secrets={LINKFORGE_ADMIN_KEY:data.access_code,LINKFORGE_SESSION_SECRET:data.session_secret};
  if(process.env.GSC_SERVICE_ACCOUNT_JSON)secrets.GSC_SERVICE_ACCOUNT_JSON=googleServiceAccount(process.env.GSC_SERVICE_ACCOUNT_JSON);
  secureWrite(secretFile,JSON.stringify(secrets));
  let deployOutput='';
  try{
    banner('Deploying ONE Cloudflare Worker with an already-resolved D1 binding.');
    deployOutput=await wrangler('deploy','--config',deployConfig,'--secrets-file',secretFile);
  }finally{try{unlinkSync(secretFile);}catch{}}
  const url=workerUrl(deployOutput);
  banner('CLOUDFLARE DEPLOYMENT COMMAND SUCCEEDED.');
  banner(`Open: ${url||'the workers.dev URL printed by Wrangler above'}`);
  banner('Private sign-in code remains only in the local operator-credentials.json (never printed in deployment logs).');
  banner(`A recovery copy is saved at: ${credentialsFile}`);
  banner('Never paste this code in chat or commit the local .linkforge directory.');
  banner('DataForSEO paid calls: OFF. Outgoing emails: OFF. No RackNerd, Pages bindings, Access identifiers, or separate scheduler.');
  if(url&&!process.env.LINKFORGE_TEST_WRANGLER_BIN){
    try{const r=await fetch(`${url}/api/setup`,{signal:AbortSignal.timeout(12000)});const s=await r.json();
      if(!(r.ok&&s.database_bound&&s.admin_login_ready))throw Error('Live Worker health check failed: missing D1 or operator auth');
      banner('Remote API: database and authentication verified.');
    }catch(e){throw Error('Live Worker readiness not verified: '+e.message);}
  }
}
main().catch(e=>{console.error('\nDeployment stopped:',e.message);process.exitCode=1;});
