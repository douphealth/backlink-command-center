/**
 * The free pitch writer: Cloudflare Workers AI behind this dashboard, callable only by this repository's Autopilot
 * workflow (GitHub Actions identity token; see actions-oidc.js). Speaks the OpenAI chat-completions format, so the
 * engine uses it like any other provider. Workers Free includes 10,000 Neurons a day (about 100 pitches); beyond
 * that Cloudflare refuses the call on the free plan rather than charging.
 */
import {verifyActionsToken} from './actions-oidc.js';

export const AUDIENCE='linkforge-ai-writer';
export const WORKFLOW='autopilot.yml';
/** Text models, best writer first. Ids and prices checked on developers.cloudflare.com (2026-11-26). */
export const MODELS=['@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/openai/gpt-oss-120b','@cf/meta/llama-4-scout-17b-16e-instruct','@cf/meta/llama-3.1-8b-instruct'];
const MAX_INPUT_CHARS=24000,MAX_TOKENS=2000;
const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store, private','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow, noarchive'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADERS});
const error=(status,code,message)=>json({error:{code,message}},status);

/** Whatever shape a model answers in, the text of its answer. */
export function answerText(out){
  if(typeof out==='string')return out;
  const c=out?.choices?.[0]?.message?.content;
  if(typeof c==='string'&&c)return c;
  if(Array.isArray(c))return c.map(p=>typeof p==='string'?p:p?.text||'').join('');
  if(typeof out?.response==='string')return out.response;
  if(typeof out?.output_text==='string')return out.output_text;
  if(Array.isArray(out?.output))return out.output.flatMap(o=>Array.isArray(o?.content)?o.content:[]).map(p=>p?.text||'').join('');
  return typeof out?.result?.response==='string'?out.result.response:'';
}

async function authorised(request,env,deps){
  const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
  if(!token)return error(401,'no_token','Send the GitHub Actions identity token as a Bearer token');
  const repository=env?.LINKFORGE_REPO||'';
  if(!repository)return error(503,'not_configured','LINKFORGE_REPO is not set for this deployment');
  try{await verifyActionsToken(token,{audience:AUDIENCE,repository,workflow:WORKFLOW,...deps});return null}
  catch(e){return error(e.code==='keys_unavailable'?503:401,e.code||'rejected',e.message)}
}

export async function listModels(request,env,deps={}){
  const denied=await authorised(request,env,deps);if(denied)return denied;
  return json({object:'list',data:MODELS.map(id=>({id,object:'model'}))});
}

export async function chatCompletion(request,env,deps={}){
  if(request.method!=='POST')return error(405,'method','POST only');
  const denied=await authorised(request,env,deps);if(denied)return denied;
  if(!env?.AI)return error(503,'no_ai_binding','Workers AI is not bound to this deployment (wrangler.toml [ai])');
  let body;try{body=await request.json()}catch{return error(400,'bad_json','Body is not JSON')}
  const model=String(body?.model||''),messages=Array.isArray(body?.messages)?body.messages:[];
  if(!MODELS.includes(model))return error(404,'unknown_model',`Model not offered here: ${model.slice(0,80)}`);
  const clean=messages.filter(m=>m&&['system','user','assistant'].includes(m.role)&&typeof m.content==='string').map(m=>({role:m.role,content:m.content}));
  if(!clean.length||clean.length!==messages.length)return error(400,'bad_messages','messages must be {role, content} with text content');
  if(clean.reduce((n,m)=>n+m.content.length,0)>MAX_INPUT_CHARS)return error(413,'too_long','Request is longer than this endpoint accepts');
  const max_tokens=Math.max(64,Math.min(MAX_TOKENS,Number(body.max_tokens)||800));
  const temperature=Math.max(0,Math.min(1.5,Number.isFinite(Number(body.temperature))?Number(body.temperature):0.5));
  let out;
  try{out=await env.AI.run(model,{messages:clean,max_tokens,temperature})}
  catch(e){
    const msg=String(e?.message||e).slice(0,200);
    if(/neuron|allocation|quota|rate.?limit|too many|\b429\b|3036|4006/i.test(msg))return error(429,'quota','Workers AI daily free allocation is used up: '+msg);
    if(/no such model|not found|unknown model|5007|5018/i.test(msg))return error(404,'model_unavailable',msg);
    return error(502,'ai_error',msg);
  }
  const content=answerText(out);
  return json({id:'lf-'+Date.now(),object:'chat.completion',model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],...(out?.usage?{usage:out.usage}:{})});
}
