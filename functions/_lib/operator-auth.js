/**
 * Standalone, built-in operator auth: no Cloudflare Access configuration.
 * Strong random sign-in code and signing key are provisioned at deploy time as
 * Cloudflare Worker secrets. Unauthenticated records remain inaccessible.
 */
const COOKIE='linkforge_session';
const MAX_AGE=7*24*3600;
const encoder=new TextEncoder();
const decoder=new TextDecoder();
const PREFIX='v1';

export function operatorReady(env) {
  return typeof env?.LINKFORGE_ADMIN_KEY==='string' && env.LINKFORGE_ADMIN_KEY.length>=32 &&
    typeof env?.LINKFORGE_SESSION_SECRET==='string' && env.LINKFORGE_SESSION_SECRET.length>=40;
}
function b64(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
function toBytes(text){const normalized=text.replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'=')),x=>x.charCodeAt(0));}
function constantEqual(a,b){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a[i]^b[i];return n===0;}
async function digest(text){return new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)));}
async function key(secret){return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);}
async function sign(secret,payload){return new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(payload)));}
const getCookie=request=>{
  const cookie=request.headers.get('cookie')||'';
  for(const item of cookie.split(';')){const idx=item.indexOf('=');if(idx>=0&&item.slice(0,idx).trim()===COOKIE)return item.slice(idx+1).trim();}
  return '';
};

export async function verifyOperator(request,env){
  if(!operatorReady(env))return {ok:false,status:503,error:'Operator credentials were not provisioned by Cloudflare deployment'};
  const token=getCookie(request);if(!token)return {ok:false,status:401,error:'Sign in with your deployment access code'};
  const parts=token.split('.');if(parts.length!==4||parts[0]!==PREFIX)return {ok:false,status:401,error:'Session expired; sign in again'};
  const issued=Number(parts[1]);const now=Math.floor(Date.now()/1000);
  if(!Number.isSafeInteger(issued)||issued>now+30||now-issued>MAX_AGE||!/^[A-Za-z0-9_-]{15,70}$/.test(parts[2]))return {ok:false,status:401,error:'Session expired; sign in again'};
  const payload=parts.slice(0,3).join('.');
  try{
    const expected=await sign(env.LINKFORGE_SESSION_SECRET,payload);const supplied=toBytes(parts[3]);
    if(b64(supplied)!==parts[3]||!constantEqual(expected,supplied))return {ok:false,status:401,error:'Invalid operator session'};
    const csrf=b64(await digest('linkforge-csrf:'+token));
    return {ok:true,email:'Owner',provider:'LinkForge secure session',csrf};
  }catch{return {ok:false,status:401,error:'Invalid operator session'};}
}

export async function authenticateCode(request,env,db){
  if(!operatorReady(env))return new Response(JSON.stringify({detail:'Deploy the unified Cloudflare Worker to activate secure login'}),{status:503,headers:{'Content-Type':'application/json'}});
  const ip=request.headers.get('CF-Connecting-IP')||'unidentified';
  // Do not store raw IP addresses or the access code in SQLite.
  const ipHash=b64(await digest('login-ip:'+env.LINKFORGE_SESSION_SECRET+':'+ip));
  const now=Date.now();
  const record=await db.prepare('SELECT failed,until_ms FROM login_attempts WHERE ip_hash=?').bind(ipHash).first();
  if(record && Number(record.failed)>=6 && Number(record.until_ms)>now)return new Response(JSON.stringify({detail:'Too many attempts. Try again in 15 minutes.'}),{status:429,headers:{'Content-Type':'application/json','Retry-After':'900'}});
  let supplied='';try{const body=await request.json();supplied=typeof body?.code==='string'?body.code.trim().slice(0,180):'';}catch{}
  const expected=await digest(env.LINKFORGE_ADMIN_KEY);const actual=await digest(supplied);
  if(!supplied||!constantEqual(actual,expected)){
    await db.prepare(`INSERT INTO login_attempts(ip_hash,failed,until_ms) VALUES(?,1,?)
      ON CONFLICT(ip_hash) DO UPDATE SET failed=CASE WHEN login_attempts.until_ms<? THEN 1 ELSE login_attempts.failed+1 END,until_ms=?`).bind(ipHash,now+900000,now,now+900000).run();
    return new Response(JSON.stringify({detail:'Incorrect access code'}),{status:401,headers:{'Content-Type':'application/json'}});
  }
  await db.prepare('DELETE FROM login_attempts WHERE ip_hash=?').bind(ipHash).run();
  const tokenBody=`${PREFIX}.${Math.floor(now/1000)}.${b64(crypto.getRandomValues(new Uint8Array(32)))}`;
  const token=tokenBody+'.'+b64(await sign(env.LINKFORGE_SESSION_SECRET,tokenBody));
  const csrf=b64(await digest('linkforge-csrf:'+token));
  const headers=new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'Set-Cookie':`${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}`});
  return new Response(JSON.stringify({ok:true,csrf,provider:'LinkForge secure session'}),{status:200,headers});
}
export function clearOperatorCookie(){return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;}
