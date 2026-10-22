#!/usr/bin/env node
/**
 * LinkForge production deployment from GitHub Actions.
 *
 * Only uses encrypted GitHub Action secrets, never repository files or
 * serialized console credentials. Provisions/reuses exactly one D1, deploys
 * the Worker, then authenticates against the real endpoint. Fails closed.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,rm,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findDatabase,workerConfig,workerUrl,googleServiceAccount} from './cloudflare-deploy-guards.mjs';

const exec=promisify(execFile),root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const REQUIRED=['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','LINKFORGE_ADMIN_KEY','LINKFORGE_SESSION_SECRET'];
const GMAIL=['GMAIL_OAUTH_CLIENT_ID','GMAIL_OAUTH_CLIENT_SECRET','GMAIL_OAUTH_REFRESH_TOKEN','GMAIL_SENDER_ADDRESS'];
export function preflight(env){
  const missing=REQUIRED.filter(k=>!env[k]);
  if(missing.length)return {ready:false,stage:'credentials_missing',missing,has_gsc:false,has_gmail:false};
  if(env.LINKFORGE_ADMIN_KEY.length<32||env.LINKFORGE_SESSION_SECRET.length<40)
    return {ready:false,stage:'operator_credentials_too_short',missing:[],has_gsc:false,has_gmail:false};
  const configuredGmail=GMAIL.filter(k=>Boolean(env[k]));
  if(configuredGmail.length>0&&configuredGmail.length<GMAIL.length)
    return {ready:false,stage:'incomplete_gmail_credentials',missing:GMAIL.filter(k=>!env[k]),has_gsc:!!env.GSC_SERVICE_ACCOUNT_JSON,has_gmail:false};
  try{
    if(env.GSC_SERVICE_ACCOUNT_JSON)googleServiceAccount(env.GSC_SERVICE_ACCOUNT_JSON);
  }catch{
    return {ready:false,stage:'invalid_gsc_service_account',missing:[],has_gsc:false,has_gmail:configuredGmail.length===GMAIL.length};
  }
  return {ready:true,stage:'ready',missing:[],has_gsc:!!env.GSC_SERVICE_ACCOUNT_JSON,has_gmail:configuredGmail.length===GMAIL.length};
}
function emitSummary(text){
  process.stdout.write(text+'\n');
}
async function wrangler(args){
  const binary=process.platform==='win32'?'npx.cmd':'npx';
  try{
    const {stdout,stderr}=await exec(binary,['--no-install','wrangler',...args],{
      cwd:root,env:process.env,timeout:180000,maxBuffer:3*1024*1024,windowsHide:true
    });
    return stdout+'\n'+(stderr||'');
  }catch(e){
    // Do not echo stdout or stderr: Wrangler may include deployment output.
    throw Error('Wrangler command failed ('+args.slice(0,2).join(' ')+'): exit '+(e.code||'unknown'));
  }
}
async function fetchJson(url,{method='GET',headers={},body=null,timeout=20000}={}){
  const resp=await fetch(url,{method,headers,body,redirect:'error',signal:AbortSignal.timeout(timeout)});
  const text=await resp.text();
  let data;try{data=JSON.parse(text);}catch{data={};}
  return {status:resp.status,headers:resp.headers,body:data};
}
export async function verifyLiveWorker(url,env){
  if(!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(url))
    throw Error('Expected a Cloudflare workers.dev deployment URL');
  let lastError='unknown';
  // First requests can be transient while deployments propagate globally.
  for(let attempt=0;attempt<3;attempt++){
    try{
      const setup=await fetchJson(url+'/api/setup');
      if(setup.status!==200||setup.body.database_bound!==true||setup.body.admin_login_ready!==true)
        throw Error('Cloudflare D1 or operator authentication is not bound');
      const login=await fetchJson(url+'/api/login',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:env.LINKFORGE_ADMIN_KEY})});
      const cookie=login.headers.get('set-cookie')?.split(';')[0];
      if(login.status!==200||!cookie)throw Error('Worker administrator login failed');
      const session=await fetchJson(url+'/api/session',{headers:{cookie}});
      if(session.status!==200||session.body.authenticated!==true)
        throw Error('Authenticated Worker session check failed');
      const probe=await fetchJson(url+'/api/integrations/probe',{headers:{cookie}});
      if(probe.status!==200)throw Error('Authenticated integrations probe failed');
      const result={
        worker:'authenticated_and_D1_accessible',
        gsc:probe.body.gsc?.status||'unknown',
        gsc_properties:probe.body.gsc?.readable_properties??null,
        gmail:probe.body.gmail?.status||'unknown',
        gmail_sent_search_verified:probe.body.gmail?.history_search_verified===true,
        cron:probe.body.worker?.status||'not_yet_observed',
      };
      if(env.GSC_SERVICE_ACCOUNT_JSON&&result.gsc!=='authenticated'){
        throw Error('GSC secret was supplied but the live Search Console property probe failed: '+result.gsc);
      }
      if(GMAIL.every(k=>env[k])&&result.gmail!=='profile_and_sent_search_verified'){
        throw Error('Gmail OAuth was supplied but profile and Sent-history checks failed: '+result.gmail);
      }
      if(env.GMAIL_SELF_TEST_ON_DEPLOY==='YES'&&result.gmail_sent_search_verified){
        const check=await fetchJson(url+'/api/integrations/gmail-self-test',{
          method:'POST',headers:{cookie,'x-csrf-token':session.body.csrf,'content-type':'application/json'},body:'{}'});
        if(check.status!==200||check.body.status!=='gmail_api_accepted')
          throw Error('Self-addressed Gmail test was not accepted');
        result.gmail_self_test='gmail_api_accepted_to_self';
      }
      return result;
    }catch(e){lastError=String(e.message||e).slice(0,150);
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,2500));
    }
  }
  throw Error('Live verification did not pass: '+lastError);
}
export async function deploy(env){
  const plan=preflight(env);
  if(!plan.ready)throw Error('BLOCKED: '+plan.stage+' ['+plan.missing.join(', ')+']');
  const work=await mkdtemp(join(tmpdir(),'linkforge-production-'));
  try{
    const list=await wrangler(['d1','list','--json']);
    let db=findDatabase(list.trim());
    if(!db){
      emitSummary('D1 not found; provisioning linkforge-db...');
      await wrangler(['d1','create','linkforge-db']);
      db=findDatabase((await wrangler(['d1','list','--json'])).trim());
      if(!db)throw Error('Database not found after D1 creation; refusing to deploy');
    }
    const template=await readFile(join(root,'worker.wrangler.jsonc'),'utf8');
    const configFile=join(root,'.linkforge-worker.deploy.jsonc');
    await writeFile(configFile,workerConfig(template,db.id),{mode:0o600});
    const secrets={
      LINKFORGE_ADMIN_KEY:env.LINKFORGE_ADMIN_KEY,
      LINKFORGE_SESSION_SECRET:env.LINKFORGE_SESSION_SECRET,
    };
    if(plan.has_gsc)secrets.GSC_SERVICE_ACCOUNT_JSON=env.GSC_SERVICE_ACCOUNT_JSON;
    if(plan.has_gmail)for(const key of GMAIL)secrets[key]=env[key];
    // Outgoing editorial email is NEVER switched on automatically: the
    // existing ChatGPT process is the sole sender.
    const secretFile=join(work,'worker-secrets.json');
    await writeFile(secretFile,JSON.stringify(secrets),{mode:0o600});
    const output=await wrangler(['deploy','--config',configFile,'--secrets-file',secretFile]);
    const url=workerUrl(output);
    if(!url)throw Error('Worker deployment URL not found in Wrangler response');
    const verified=await verifyLiveWorker(url,env);
    return {url,db_reused_or_created:true,has_gsc:plan.has_gsc,has_gmail:plan.has_gmail,verified};
  }finally{
    await rm(work,{recursive:true,force:true});
    // Do not leave the account-specific D1 ID deployment config in artifacts.
    await rm(join(root,'.linkforge-worker.deploy.jsonc'),{force:true});
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const env=process.env,plan=preflight(env);
    if(process.argv.includes('--preflight')){
      emitSummary('LinkForge production preflight: '+JSON.stringify(plan));
      if(!plan.ready)process.exitCode=2;
    }else{
      const result=await deploy(env);
      emitSummary('Verified Worker: '+JSON.stringify(result));
    }
  }catch(e){process.stderr.write(String(e.message||e)+'\n');process.exitCode=1;}
}
