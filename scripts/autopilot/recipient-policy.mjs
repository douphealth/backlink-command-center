/** Fail-closed recipient eligibility. DNS is not proof of an existing mailbox. */
import {createHash} from 'node:crypto';
import {Resolver} from 'node:dns/promises';
export const POLICY_VERSION=1;
const DAY=86400000;
const host=s=>String(s||'').toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
export function samePublisher(url,domain){
  try{const u=new URL(url);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password&&!u.port&&host(u.hostname)===host(domain)}catch{return false}
}
export function normalizeEmail(value){
  if(typeof value!=='string'||value.length>254||value!==value.trim())return '';
  const e=value.toLowerCase(),parts=e.split('@');if(parts.length!==2)return '';
  const [local,domain]=parts;
  if(!local||local.length>64||!domain.includes('.')||local.startsWith('.')||local.endsWith('.')||local.includes('..'))return '';
  if(!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local))return '';
  if(!domain.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))||!/\.[a-z]{2,63}$/.test(domain))return '';
  return e;
}
const BAD_LOCAL=/^(?:noreply|no-reply|donotreply|abuse|postmaster|mailer-daemon|sales|press|pr|support|help|service|billing|jobs|careers|hr|privacy|legal|gdpr|dpo|ads|advertis\w*|sponsor\w*|partner\w*|feedback|newsletter|test|example|yourname|email|user|name)(?:[._+-]|$)/i;
const PLACEHOLDER=/(?:^|\.)(?:example\.(?:com|org|net)|invalid|test|localhost|yourdomain\.com|domain\.com)$/;
const EDITOR=/^(?:editor|editors|editorial|submissions?|contribute|content|blog)(?:[._+-]|$)/;
const PURPOSE=/\b(?:editorial|editor|article submissions?|contribut(?:e|ions|ors)|resource suggestions?|suggest (?:an? )?(?:article|resource))\b/i;
const DENIED=/\b(?:no (?:unsolicited |link )?(?:pitches|submissions)|do not (?:pitch|contact)|not accept(?:ing)? (?:guest posts|pitches|submissions))\b/i;
const FREEMAIL=/^(?:gmail|outlook|hotmail|yahoo|protonmail|proton|icloud)\.(?:com|me)$/;
const decode=s=>String(s||'').replace(/&#x([0-9a-f]+);/gi,(_,v)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(v,16))))
 .replace(/&#([0-9]+);/g,(_,v)=>String.fromCodePoint(Math.min(0x10ffff,Number(v))))
 .replace(/&commat;/gi,'@').replace(/&period;/gi,'.').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&nbsp;/gi,' ');
const plain=s=>decode(s.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export function cleanPublisherHtml(html){
  return String(html||'').slice(0,500000).replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<(script|style|noscript|template|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<(section|div|li)\b[^>]*(?:id|class)=["'][^"']*(?:comment|reviews|testimonial)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<([a-z][a-z0-9]*)\b[^>]*(?:\shidden\b|aria-hidden=["']true["']|display\s*:\s*none)[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
}
/** Literal, first-party editorial contacts only; never generate an address pattern. */
export function extractEditorialCandidates(html,url,{domain,author='',source='page',now=Date.now()}={}){
  if(!samePublisher(url,domain))return [];
  const h=cleanPublisherHtml(html),found=new Map();
  const add=(email,context,method)=>{
    const e=normalizeEmail(email);if(!e)return;
    const [local,d]=e.split('@');if(BAD_LOCAL.test(local)||PLACEHOLDER.test(d)||/\.(png|jpg|gif|svg|webp)$/.test(d))return;
    if(host(d)!==host(domain)&&!FREEMAIL.test(d))return;if(DENIED.test(context))return;
    const names=author.toLowerCase().split(/[^a-z]+/).filter(x=>x.length>=3),named=names.length>=2&&names.every(x=>local.includes(x));
    const purpose=PURPOSE.test(context),official=source==='contact'||source==='author';let rank=0,role='';
    if(named&&(purpose||source==='author'||/\b(?:author|writer)\b/i.test(context))){rank=100;role='named_author'}
    else if(EDITOR.test(local)&&purpose){rank=official?95:85;role='editorial'}
    else if(official&&purpose){rank=70;role='published_editorial_route'}
    if(!rank)return;
    const c={email:e,rank,role,source:url,source_type:source,method,observed_at:new Date(now).toISOString(),context:context.slice(0,300)};
    if(!found.has(e)||found.get(e).rank<rank)found.set(e,c);
  };
  for(const m of h.matchAll(/<a\b[^>]*href\s*=\s*["']mailto:([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi)){
    let e;try{e=decodeURIComponent(decode(m[1]).split('?')[0])}catch{continue}
    add(e,plain(h.slice(Math.max(0,m.index-180),m.index+m[0].length+180)),'mailto');
  }
  const text=plain(h).replace(/\s*\[at\]\s*/gi,'@').replace(/\s*\[dot\]\s*/gi,'.');
  for(const m of text.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi))add(m[0],text.slice(Math.max(0,m.index-180),m.index+m[0].length+180),'visible_text');
  for(const m of h.matchAll(/data-cfemail=["']([a-f0-9]+)["']/gi)){
    const hex=m[1];if(hex.length<6||hex.length%2)continue;
    const key=parseInt(hex.slice(0,2),16);let e='';for(let i=2;i<hex.length;i+=2)e+=String.fromCharCode(parseInt(hex.slice(i,i+2),16)^key);
    add(e,plain(h.slice(Math.max(0,m.index-180),m.index+hex.length+180)),'cloudflare_published');
  }
  return [...found.values()].sort((a,b)=>b.rank-a.rank||a.email.localeCompare(b.email));
}
export function isSuppressed(state,email,domain){
  const e=String(email||'').toLowerCase(),d=host(domain);
  return Object.keys(state.suppression||{}).some(key=>{const k=key.toLowerCase();return k===e||(!k.includes('@')&&(d===host(k)||d.endsWith('.'+host(k))))});
}
export function usableVerification(v,email,now=Date.now()){
  const checked=Date.parse(v?.checked_at||''),expires=Date.parse(v?.expires_at||'');
  return !!v&&v.policy_version===POLICY_VERSION&&v.email===normalizeEmail(email)&&v.status==='valid'&&v.smtp_check===true&&v.accept_all===false&&v.block===false&&v.disposable===false&&checked<=now&&now-checked<=DAY&&expires>now&&expires<=checked+DAY;
}
export function hunterVerdict(data,email,now=Date.now()){
  const d=data?.data,valid=d?.email?.toLowerCase()===email&&d.status==='valid'&&d.regexp===true&&d.mx_records===true&&d.smtp_server===true&&d.smtp_check===true&&d.accept_all===false&&d.block===false&&d.disposable===false&&d.gibberish===false;
  return {policy_version:POLICY_VERSION,email,status:valid?'valid':d?.status==='invalid'?'invalid':'unknown',provider:'hunter',checked_at:new Date(now).toISOString(),expires_at:new Date(now+DAY).toISOString(),smtp_check:valid,accept_all:d?.accept_all!==false,block:d?.block!==false,disposable:d?.disposable!==false};
}
export async function checkMx(domain,resolveMx){
  try{const records=await resolveMx(domain);
    if(!Array.isArray(records)||!records.length)return {ok:false,reason:'no_explicit_mx'};
    if(records.some(r=>r.exchange==='.'||r.exchange===''))return {ok:false,reason:'null_mx'};
    if(!records.some(r=>typeof r.exchange==='string'&&r.exchange.includes('.')))return {ok:false,reason:'unusable_mx'};
    return {ok:true,reason:'mx_present_not_mailbox_proof'};
  }catch{return {ok:false,reason:'dns_unverified'}}
}
export class RecipientVerifier{
  constructor({state,fetchPage,fetchImpl=fetch,env=process.env,resolveMx,now=()=>Date.now()}={}){
    if(!state||typeof fetchPage!=='function')throw Error('Recipient verifier requires state and bounded page fetch');
    Object.assign(this,{state,fetchPage,fetch:fetchImpl,env,now});this.resolveMx=resolveMx||((d)=>new Resolver({timeout:4000,tries:1}).resolveMx(d));
    state.email_verifications??={};state.email_verifier_usage??={};this.pages=new Map();
  }
  get enabled(){return this.env.EMAIL_VERIFICATION_ENABLED==='YES'&&!!this.env.HUNTER_API_KEY&&this.env.HUNTER_API_KEY!=='test-api-key'&&Number(this.env.EMAIL_VERIFY_DAILY_LIMIT)>0}
  async mailbox(email){
    if(!this.enabled)return {status:'unknown',reason:'verifier_not_configured'};
    const key=createHash('sha256').update(email).digest('hex'),cached=this.state.email_verifications[key];if(usableVerification(cached,email,this.now()))return cached;
    const day=new Date(this.now()).toISOString().slice(0,10),limit=Math.min(100,Math.floor(Number(this.env.EMAIL_VERIFY_DAILY_LIMIT)||0)),usage=this.state.email_verifier_usage;
    if((usage[day]||0)>=limit)return {status:'unknown',reason:'verification_budget_exhausted'};
    usage[day]=(usage[day]||0)+1;
    try{const response=await this.fetch('https://api.hunter.io/v2/email-verifier?email='+encodeURIComponent(email),{headers:{'X-API-KEY':this.env.HUNTER_API_KEY,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});
      if(response.status!==200)return {status:'unknown',reason:'verification_unavailable'};
      const v=hunterVerdict(await response.json(),email,this.now());this.state.email_verifications[key]=v;
      if(v.status==='invalid'){this.state.suppression??={};this.state.suppression[email]={reason:'Mailbox verifier returned invalid',at:new Date(this.now()).toISOString()}}
      return v;
    }catch{return {status:'unknown',reason:'verification_unavailable'}}
  }
  async page(url,domain){
    if(!samePublisher(url,domain))return null;if(this.pages.has(url))return this.pages.get(url);
    const pending=Promise.resolve().then(()=>this.fetchPage(url,{timeout:8000,maxBytes:300000,redirects:2})).then(r=>r.status===200&&r.body&&samePublisher(r.url,domain)?r:null).catch(()=>null);
    this.pages.set(url,pending);return pending;
  }
  async verify(p,{followup=false,deadline=Infinity}={}){
    const fail=reason=>({ok:false,reason});if(isSuppressed(this.state,p.email,p.domain))return fail('suppressed');
    if(!this.enabled)return fail('verifier_not_configured');if(!samePublisher(p.page_url,p.domain))return fail('publisher_mismatch');
    const origin=new URL(p.page_url).origin,queue=[p.email_source,p.page_url,origin+'/',origin+'/contact/',origin+'/contact-us/',origin+'/about/'],seen=new Set(),candidates=new Map();
    while(queue.length&&seen.size<6&&this.now()<deadline){
      const url=queue.shift();if(!url||seen.has(url)||!samePublisher(url,p.domain))continue;seen.add(url);
      const page=await this.page(url,p.domain);if(!page)continue;
      const source=/\/(?:author|writers?)\//i.test(new URL(url).pathname)?'author':/\/(?:contact(?:-us)?|about(?:-us)?|editorial|editors|team|write-for-us|contribute)(?:\/|$)/i.test(new URL(url).pathname)?'contact':'page';
      for(const c of extractEditorialCandidates(page.body,page.url,{domain:p.domain,author:p.author||'',source,now:this.now()}))if(!candidates.has(c.email)||candidates.get(c.email).rank<c.rank)candidates.set(c.email,c);
      for(const m of cleanPublisherHtml(page.body).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
        let link;try{link=new URL(decode(m[1]),url).href}catch{continue}
        if(samePublisher(link,p.domain)&&/contact|editorial|editors|team|about|author|write-for-us|contribute/i.test(link+' '+plain(m[2]))&&!/advertis|sponsor|partner/i.test(link))queue.unshift(link);
      }
    }
    const hasContact=(p.history||[]).some(h=>h.type==='initial'&&h.mode!=='draft');
    const ranked=[...candidates.values()].filter(c=>(!followup&&!hasContact)||c.email===normalizeEmail(p.email)).sort((a,b)=>b.rank-a.rank);
    if(!ranked.length)return fail('no_published_editorial_contact');let attempted=0;
    for(const c of ranked){if(++attempted>3||this.now()>=deadline)break;if(isSuppressed(this.state,c.email,p.domain))continue;
      const mx=await checkMx(c.email.split('@')[1],this.resolveMx);if(!mx.ok)continue;
      const v=await this.mailbox(c.email);if(usableVerification(v,c.email,this.now()))return {ok:true,email:c.email,evidence:c,verification:v};
    }
    return fail('no_verified_mailbox');
  }
}
