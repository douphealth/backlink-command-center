/**
 * Cloudflare Pages first-class API. No D1/Access credentials are required to
 * deploy a safe, browser-only dashboard. API endpoints always return JSON,
 * avoiding Pages SPA HTML fallback misreported as an API response.
 * If the owner later configures D1 and operator/Access identity, reuse the
 * existing authenticated server-backed command center implementation.
 */
import {handleApi} from '../_lib/api.js';
import {SITES} from '../_lib/sites.js';
import {operatorReady} from '../_lib/operator-auth.js';
import {accessReady} from '../_lib/auth.js';

const HEADERS={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store, private',
  'x-content-type-options':'nosniff',
  'x-robots-tag':'noindex, nofollow, noarchive',
  'referrer-policy':'no-referrer',
};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADERS});
const stamp=()=>new Date().toISOString();

function localMode(env){return !env?.DB || !(operatorReady(env)||accessReady(env));}
async function checkPortfolioSite(domain,context){
  if(!/^[a-z0-9.-]{4,255}$/.test(domain))return json({detail:'Invalid site'},422);
  const site=SITES.find(s=>s.domain===domain);
  if(!site)return json({detail:'Unknown portfolio site'},404);
  // Public preconfigured URLs only: the browser cannot provide an arbitrary host.
  const targets=site.assets.slice(0,3);
  const cache=typeof caches!=='undefined'?caches.default:null;
  const cacheKey=new Request(`https://linkforge-public-check.invalid/${encodeURIComponent(domain)}`);
  if(cache){try{const hit=await cache.match(cacheKey);if(hit)return hit;}catch{ /* caching is best-effort */ }}
  const checked=await Promise.all(targets.map(async url=>{
    const u=new URL(url);
    if(u.protocol!=='https:'||u.username||u.password)return {url,status:0,detail:'Unsafe URL'};
    try{
      const res=await fetch(url,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(7000),headers:{'User-Agent':'LinkForge-Portfolio-Health/1.0'}});
      return {url,status:res.status,detail:res.status===200?'HTTP 200':res.status>=300&&res.status<400?'Redirect — target not verified':`HTTP ${res.status}`};
    }catch{return {url,status:0,detail:'Request blocked or timed out'};}
  }));
  const body=json({site:domain,checked_at:stamp(),checks:checked,origin:'Public HEAD checks, not SEO or backlink verification'});
  if(cache){try{const c=body.clone();c.headers.set('cache-control','public, max-age=300');context.waitUntil?.(cache.put(cacheKey,c));}catch{ /* ignore */ }}
  return body;
}
export async function onRequest(context){
  const {request,env}=context,url=new URL(request.url);
  const route=url.pathname.replace(/^\/api\/?/,'');
  // Liveness is not readiness. A missing optional database must not make the
  // deployed Pages frontend appear offline to uptime checks.
  if(request.method==='GET'&&route==='health'){
    const configured=!localMode(env);
    return json({
      status:'ok',
      service:'Backlink Command Center Pages API',
      dashboard:'available',
      mode:configured?'cloud_backend':'browser_workspace',
      backend_ready:configured,
      database_bound:!!env?.DB,
      authentication_configured:operatorReady(env)||accessReady(env),
      automation_ready:false,
      note:configured?'Cloud backend configured; use authenticated endpoints to inspect individual integrations.':'The browser workspace is available, but cloud automation and cross-device data are not configured.',
      checked_at:stamp(),
    });
  }
  if(request.method==='GET'&&route==='readiness'){
    const ready=!localMode(env);
    return json({ready,backend_ready:ready,reason:ready?'Backend configured':'Cloudflare D1 and owner authentication are required'},ready?200:503);
  }
  if(request.method==='GET'&&route==='setup'){
    if(!localMode(env))return handleApi(request,env);
    return json({mode:'browser_workspace',deployment:'cloudflare_pages',database_bound:false,auth_ready:false,
      browser_workspace_available:true,cloud_automation_available:false,no_admin_password:true,
      message:'Dashboard ready. Records are stored in this browser. Cloud-wide synchronization and scheduled automation need a separately provisioned backend.'});
  }
  if(request.method==='GET'&&route==='asset-check')return checkPortfolioSite(url.searchParams.get('domain')||'',context);
  if(!localMode(env))return handleApi(request,env);
  return json({detail:'Cloud backend not configured. The dashboard uses the on-device workspace without DataForSEO calls or email sending.',mode:'browser_workspace'},503);
}
