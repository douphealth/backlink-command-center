import {operatorReady,verifyOperator} from './operator-auth.js';
/* Cloudflare Access JWT validation. Fail CLOSED if Access isn't configured.
 * No in-app passwords. Only signed Access identities explicitly permitted
 * by ADMIN_EMAIL are authorized to read or mutate campaign records.
 */
let jwksCache={domain:'',expires:0,keys:[]};
const decoder = new TextDecoder();
function b64url(data){const padded=data.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(data.length/4)*4,'=');return Uint8Array.from(atob(padded),c=>c.charCodeAt(0));}
function utf8part(segment){return JSON.parse(decoder.decode(b64url(segment)));}
function hex(buffer){return [...new Uint8Array(buffer)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export const accessReady=env=>Boolean(env?.CF_ACCESS_TEAM_DOMAIN&&env?.CF_ACCESS_AUD&&env?.ADMIN_EMAIL);
function getDomain(env){
  const domain=String(env.CF_ACCESS_TEAM_DOMAIN).trim().toLowerCase();
  // Do not permit attacker-selected JWK retrieval hosts or network SSRF.
  if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(domain))throw new Error('Access team domain is invalid');
  return domain;
}
async function getJwk(domain,kid){
  if(jwksCache.domain!==domain||Date.now()>jwksCache.expires){
    const response=await fetch(`https://${domain}/cdn-cgi/access/certs`,{redirect:'error'});
    if(!response.ok)throw new Error('Unable to verify Access identity');
    const json=await response.json();
    if(!Array.isArray(json.keys))throw new Error('Unrecognized Access public keys');
    jwksCache={domain,expires:Date.now()+15*60*1000,keys:json.keys};
  }
  const jwk=jwksCache.keys.find(k=>k.kid===kid&&k.kty==='RSA');
  if(!jwk)throw new Error('Access signing key not found');
  return jwk;
}
export async function verifyAccess(request,env){
  if(operatorReady(env))return verifyOperator(request,env);
  if(!accessReady(env))return {ok:false,status:503,error:'Cloudflare Access is not yet configured'};
  const token=request.headers.get('Cf-Access-Jwt-Assertion');
  if(!token)return {ok:false,status:401,error:'Sign in through Cloudflare Access to continue'};
  const segments=token.split('.');
  if(segments.length!==3)return {ok:false,status:401,error:'Invalid Access identity'};
  try{
    const [head,body,sig]=segments;
    const header=utf8part(head),claim=utf8part(body);
    const domain=getDomain(env);
    if(header.alg!=='RS256'||typeof header.kid!=='string')throw Error('Unsupported Access signature');
    const now=Math.floor(Date.now()/1000);
    const aud=Array.isArray(claim.aud)?claim.aud:[claim.aud];
    const validIssuer=claim.iss===`https://${domain}`;
    if(!validIssuer||!aud.includes(env.CF_ACCESS_AUD)||!(claim.exp>now)||claim.nbf>now+30)throw Error('Invalid Access claims');
    const email=String(claim.email||'').trim().toLowerCase();
    const allow=String(env.ADMIN_EMAIL).split(',').map(x=>x.trim().toLowerCase());
    if(!email||!allow.includes(email))return {ok:false,status:403,error:'Your account is not authorized for this workspace'};
    const jwk=await getJwk(domain,header.kid);
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,b64url(sig),new TextEncoder().encode(`${head}.${body}`));
    if(!valid)throw Error('Invalid signature');
    const csrf=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`linkforge-csrf:${token}`)));
    return {ok:true,email,csrf};
  }catch{
    return {ok:false,status:401,error:'Access verification failed. Sign in again through Cloudflare.'};
  }
}
export function checkCsrf(request,identity){
  if(!['POST','PUT','PATCH','DELETE'].includes(request.method))return true;
  const supplied=request.headers.get('X-CSRF-Token');
  return !!supplied && supplied.length===identity.csrf.length && supplied===identity.csrf;
}
