/**
 * Private OAuth2 Gmail transport for the Cloudflare Worker.
 * No ChatGPT connector token is exportable to this process.
 * Supports gmail.send; sender validation uses gmail.metadata/read-only profile scopes.
 */
const OAUTH_URL='https://oauth2.googleapis.com/token';
const GMAIL='https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY=10000;
const cleanHeader=s=>typeof s==='string'&&!/[\r\n\0]/.test(s)&&s.length>0;
const enc=new TextEncoder();
function base64Url(bytes){
 let b='';for(const byte of bytes)b+=String.fromCharCode(byte);
 return btoa(b).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function gmailConfigured(env){
 return Boolean(env?.GMAIL_OAUTH_CLIENT_ID&&env.GMAIL_OAUTH_CLIENT_SECRET&&env.GMAIL_OAUTH_REFRESH_TOKEN&&env.GMAIL_SENDER_ADDRESS);
}
export function emailSafe(email){
 return typeof email==='string'&&email.length<255&&/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(email)&&!/[\r\n]/.test(email);
}
export function sendingAuthorized(env,controls){
 return gmailConfigured(env)&&env.GMAIL_OUTBOUND_ENABLED==='YES'&&
 env.LINKFORGE_SINGLE_SENDER==='worker'&&env.OUTREACH_CRM_SYNC_VERIFIED==='YES'&&
 env.OUTREACH_LEGACY_SENDER_DISABLED==='YES'&&controls?.outreach_paused===false;
}
export async function oauthAccessToken(env,{fetchImpl=fetch}={}){
 if(!gmailConfigured(env))throw Error('Worker Gmail OAuth secrets are not configured');
 const response=await fetchImpl(OAUTH_URL,{
   method:'POST',redirect:'error',
   headers:{'content-type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({client_id:env.GMAIL_OAUTH_CLIENT_ID,client_secret:env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token:env.GMAIL_OAUTH_REFRESH_TOKEN,grant_type:'refresh_token'})
 });
 if(!response.ok)throw Error('Gmail OAuth refresh rejected: HTTP '+response.status);
 const data=await response.json();
 if(!data.access_token||!Number(data.expires_in))throw Error('Gmail OAuth did not return a usable access token');
 return data.access_token;
}
async function gmailJson(url,token,{fetchImpl=fetch,method='GET',body}={}){
 const response=await fetchImpl(url,{
   method,redirect:'error',
   headers:{Authorization:'Bearer '+token,'Accept':'application/json',...(body?{'content-type':'application/json'}:{})},
   ...(body?{body:JSON.stringify(body)}:{})
 });
 if(!response.ok)throw Error('Gmail API '+method+' failed: HTTP '+response.status);
 return response.json();
}
export async function probeGmail(env,{fetchImpl=fetch}={}){
 if(!gmailConfigured(env))return {ok:false,status:'credentials_missing'};
 try{
   const token=await oauthAccessToken(env,{fetchImpl});
   const profile=await gmailJson(GMAIL+'/profile',token,{fetchImpl});
   const actual=String(profile.emailAddress||'').toLowerCase();
   if(!emailSafe(actual)||actual!==env.GMAIL_SENDER_ADDRESS.toLowerCase())
     return {ok:false,status:'sender_mismatch'};
   // gmail.send alone cannot read the profile or search Sent. Validate the
   // independent read permission needed for duplicate-outreach protection.
   const sent=await gmailJson(GMAIL+'/messages?'+new URLSearchParams({q:'in:sent newer_than:7d',maxResults:'1'}),token,{fetchImpl});
   if(!Array.isArray(sent.messages)&&!Number.isFinite(Number(sent.resultSizeEstimate)))
     return {ok:false,status:'sent_history_inaccessible',sender:actual};
   return {ok:true,status:'profile_and_sent_search_verified',sender:actual,history_search_verified:true};
 }catch{return {ok:false,status:'oauth_or_scope_rejected'};}
}
export async function hasSentToRecipient(env,email,{fetchImpl=fetch,token}={}){
 if(!emailSafe(email))throw Error('Invalid recipient');
 const access=token||await oauthAccessToken(env,{fetchImpl});
 // Search the entire mailbox, not just 365 days; an older contact is still a duplicate.
 const q='in:sent to:"'+email+'"';
 const data=await gmailJson(GMAIL+'/messages?'+new URLSearchParams({q,maxResults:'1'}),access,{fetchImpl});
 return Array.isArray(data.messages)&&data.messages.length>0;
}
export async function sendGmailMessage(env,{to,subject,body,messageId},{fetchImpl=fetch,token}={}){
 if(!gmailConfigured(env))throw Error('Worker Gmail OAuth secrets are not configured');
 if(!emailSafe(to)||!emailSafe(env.GMAIL_SENDER_ADDRESS)||!cleanHeader(subject)||subject.length>150||
   typeof body!=='string'||!body.trim()||body.length>MAX_BODY)throw Error('Unsafe email payload');
 const id=messageId||'';
 if(id&&!/^<linkforge-[0-9a-z-]+@[a-z0-9.-]+>$/i.test(id))throw Error('Invalid message ID');
 const content=[
   'From: '+env.GMAIL_SENDER_ADDRESS,'To: '+to,'Subject: =?UTF-8?B?'+btoa(unescape(encodeURIComponent(subject)))+'?=',
   ...(id?['Message-ID: '+id]:[]),
   'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64',
   '',btoa(unescape(encodeURIComponent(body)))
 ].join('\r\n');
 const access=token||await oauthAccessToken(env,{fetchImpl});
 const reply=await gmailJson(GMAIL+'/messages/send',access,{fetchImpl,method:'POST',body:{raw:base64Url(enc.encode(content))}});
 if(typeof reply.id!=='string'||!reply.id||typeof reply.threadId!=='string')
   throw Error('Gmail returned no confirmed message and thread IDs');
 return {gmail_id:reply.id,thread_id:reply.threadId};
}
