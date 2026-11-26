/**
 * Verifies a GitHub Actions identity token (OIDC). The Autopilot workflow asks GitHub for a short-lived signed
 * token that states which repository and workflow is running; this proves the caller to our own endpoint
 * without any stored secret. Checked: GitHub's signature, issuer, audience, expiry, repository and workflow.
 */
const ISSUER='https://token.actions.githubusercontent.com';
const bytes=s=>Uint8Array.from(atob(String(s).replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));
const text=b=>new TextDecoder().decode(b);
let cache={at:0,keys:[]};
async function signingKeys(fetchImpl,fresh=false){
  if(!fresh&&cache.keys.length&&Date.now()-cache.at<3600e3)return cache.keys;
  const res=await fetchImpl(ISSUER+'/.well-known/jwks',{headers:{accept:'application/json'}});
  if(!res.ok)throw Object.assign(Error('GitHub signing keys unavailable'),{code:'keys_unavailable'});
  const j=await res.json();cache={at:Date.now(),keys:Array.isArray(j?.keys)?j.keys:[]};return cache.keys;
}
const deny=(code,message)=>Object.assign(Error(message),{code});

/** Returns the token's claims, or throws an Error with `.code` saying which check failed. */
export async function verifyActionsToken(token,{audience,repository,workflow,now=Date.now(),fetchImpl=fetch}={}){
  const parts=String(token||'').split('.');
  if(parts.length!==3)throw deny('malformed','Not a signed token');
  let header,claims;
  try{header=JSON.parse(text(bytes(parts[0])));claims=JSON.parse(text(bytes(parts[1])))}catch{throw deny('malformed','Token cannot be read')}
  if(header.alg!=='RS256'||!header.kid)throw deny('algorithm','Unexpected signing algorithm');
  let jwk=(await signingKeys(fetchImpl)).find(k=>k.kid===header.kid);
  if(!jwk)jwk=(await signingKeys(fetchImpl,true)).find(k=>k.kid===header.kid); // GitHub rotates its keys
  if(!jwk||jwk.kty!=='RSA')throw deny('unknown_key','Signing key not published by GitHub');
  const key=await crypto.subtle.importKey('jwk',{kty:'RSA',n:jwk.n,e:jwk.e,alg:'RS256',ext:true},{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,bytes(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
  if(!ok)throw deny('signature','Signature does not match');
  const sec=now/1000;
  if(claims.iss!==ISSUER)throw deny('issuer','Not issued by GitHub Actions');
  if(![].concat(claims.aud||[]).includes(audience))throw deny('audience','Token was issued for another service');
  if(!(Number(claims.exp)>sec))throw deny('expired','Token has expired');
  if(Number(claims.nbf)>sec+60||Number(claims.iat)>sec+60)throw deny('not_yet_valid','Token is not valid yet');
  if(String(claims.repository||'').toLowerCase()!==String(repository||'').toLowerCase())throw deny('repository','Token is for another repository');
  if(workflow&&!String(claims.job_workflow_ref||'').toLowerCase().startsWith(`${String(repository).toLowerCase()}/.github/workflows/${workflow.toLowerCase()}@`))throw deny('workflow','Token is for another workflow');
  return claims;
}
export const _resetKeyCache=()=>{cache={at:0,keys:[]}};
