/**
 * Dashboard control of the Autopilot workflow through the GitHub REST API.
 * Uses a fine-grained token (this repository only: Actions, Secrets, Variables)
 * kept in this browser's localStorage. Secret values are encrypted in the browser
 * with the repository's public key before upload; GitHub can't return them.
 */
import {sealedBox,toB64,fromB64} from './sealed-box.js';

export const REPO='douphealth/backlink-command-center';
const WORKFLOW='autopilot.yml';
const API='https://api.github.com';
const TOKEN_KEY='linkforge-github-token';
export const TOKEN_URL='https://github.com/settings/personal-access-tokens/new?'+new URLSearchParams({
  name:'LinkForge Autopilot control',description:'Run/Stop and connect credentials from the LinkForge dashboard',
  target_name:REPO.split('/')[0],expires_in:'365',actions:'write',secrets:'write',variables:'write'});

export const token={get:()=>{try{return localStorage.getItem(TOKEN_KEY)||''}catch{return ''}},
  set:v=>{try{v?localStorage.setItem(TOKEN_KEY,v):localStorage.removeItem(TOKEN_KEY)}catch{}}};

async function gh(path,{method='GET',body,auth=true}={}){
  const t=token.get();
  const res=await fetch(API+path,{method,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
    ...(auth&&t?{Authorization:'Bearer '+t}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
  if(res.status===204)return {};
  const data=await res.json().catch(()=>({}));
  if(!res.ok){const e=Error(res.headers.get('x-ratelimit-remaining')==='0'?'GitHub rate limit reached — add your control token to lift it.':res.status===401?'GitHub rejected the token (expired or mistyped).':res.status===403||res.status===404?'The token is missing a permission for this repository (needs Actions, Secrets and Variables: read & write).':data.message||`GitHub error ${res.status}`);e.status=res.status;throw e}
  return data;
}

/** Workflow state + latest run. Works without a token (public repo), with rate limits. */
export async function status(){
  // Read-only on a public repo: fall back to anonymous if the saved token is rejected.
  const read=path=>gh(path).catch(e=>e.status===401?gh(path,{auth:false}):Promise.reject(e));
  const [wf,runs]=await Promise.all([read(`/repos/${REPO}/actions/workflows/${WORKFLOW}`),read(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1`)]);
  const r=runs.workflow_runs?.[0]||null;
  return {enabled:wf.state==='active',state:wf.state,
    run:r&&{status:r.status,conclusion:r.conclusion,url:r.html_url,started:r.run_started_at||r.created_at,event:r.event,id:r.id},
    running:!!r&&['queued','in_progress','waiting','pending','requested'].includes(r.status)};
}
export async function run(){
  const s=await status().catch(()=>null);
  if(!s?.enabled)await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/enable`,{method:'PUT'});
  await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,{method:'POST',body:{ref:'main'}});
}
/** Stops the schedule and cancels anything queued or running. */
export async function stop(){
  await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/disable`,{method:'PUT'});
  for(const st of ['in_progress','queued']){
    const runs=await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=${st}&per_page=10`);
    for(const r of runs.workflow_runs||[])await gh(`/repos/${REPO}/actions/runs/${r.id}/cancel`,{method:'POST'}).catch(()=>{});
  }
}
export async function configured(){
  const [s,v]=await Promise.all([gh(`/repos/${REPO}/actions/secrets?per_page=100`),gh(`/repos/${REPO}/actions/variables?per_page=30`)]);
  return {secrets:new Set((s.secrets||[]).map(x=>x.name)),variables:Object.fromEntries((v.variables||[]).map(x=>[x.name,x.value]))};
}
let publicKey=null;
export async function setSecret(name,value){
  publicKey??=await gh(`/repos/${REPO}/actions/secrets/public-key`);
  const sealed=sealedBox(new TextEncoder().encode(value),fromB64(publicKey.key));
  await gh(`/repos/${REPO}/actions/secrets/${name}`,{method:'PUT',body:{encrypted_value:toB64(sealed),key_id:publicKey.key_id}});
}
export async function setVariable(name,value){
  try{await gh(`/repos/${REPO}/actions/variables/${name}`,{method:'PATCH',body:{name,value}})}
  catch(e){if(e.status!==404)throw e;await gh(`/repos/${REPO}/actions/variables`,{method:'POST',body:{name,value}})}
}
