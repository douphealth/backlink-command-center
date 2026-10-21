/**
 * LinkForge: ONE Cloudflare Worker for the dashboard, API, D1 and Cron Trigger.
 * Static assets never access DataForSEO. API and scheduled work share one D1.
 */
import {handleApi} from '../functions/_lib/api.js';
import {runTick} from './scheduler.js';

const PRIVATE_HEADERS = {
  'X-Robots-Tag':'noindex, nofollow, noarchive',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY',
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
};

export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/'))return handleApi(request,env);
    if(!env?.ASSETS)return new Response('Static assets binding unavailable', {status:503});
    if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
    const response=await env.ASSETS.fetch(request);
    const headers=new Headers(response.headers);
    for(const [key,value] of Object.entries(PRIVATE_HEADERS))headers.set(key,value);
    if(url.pathname==='/'||url.pathname.endsWith('.html'))headers.set('Cache-Control','no-store');
    return new Response(response.body,{status:response.status,headers});
  },
  async scheduled(_controller,env,ctx) {
    ctx.waitUntil(runTick(env,{maxJobs:2}).catch(err=>{
      console.error('LinkForge Cron execution failed',String(err?.message||'unknown').slice(0,200));
    }));
  },
};
