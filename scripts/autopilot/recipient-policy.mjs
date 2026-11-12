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
// Owner decision (Nov 2026): a site's general inbox may be used, strictly: own domain, published on its own
// contact/about page, only when no editorial or named-author address exists, and only after a
// Deliverable mailbox check (catch-all never). Sales/support/privacy etc. stay excluded via BAD_LOCAL.
const GENERIC_INBOX=/^(?:hello|hi|contact|info|team|mail|office|enquiries|enquiry|inquiries)$/;
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
    else if(source==='contact'&&GENERIC_INBOX.test(local)&&host(d)===host(domain)){rank=60;role='contact_page_inbox'}
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
  return {policy_version:POLICY_VERSION,email,status:valid?'valid':d?.status==='invalid'?'invalid':'unknown',provider:'hunter',checked_at:new Date(now).toISOString(),expires_at:new Date(now+DAY).toISOString(),smtp_check:valid,accept_all:d?.accept_all!==false,block:d?.block!==false,disposable:d?.disposable!==false,catch_all:d?.accept_all===true};
}
/**
 * Verifalia (verifalia.com): permanent free plan with daily free credits, HTTP Basic auth
 * (credentials never in URLs), REST API v2.6 as used by its official SDK (npm "verifalia" 5.x).
 * Only Deliverable + Success with no disposable flag counts; catch-all (ServerIsCatchAll),
 * Risky and Unknown never authorize a send. Undeliverable is a definitive negative.
 */
export const VERIFALIA_API=['https://api-1.verifalia.com/v2.6','https://api-2.verifalia.com/v2.6','https://api-3.verifalia.com/v2.6'];
export const VERIFALIA_COST={Standard:1,High:2,Extreme:4}; // credits per address (Verifalia result-quality levels)
export function verifaliaVerdict(entry,email,now=Date.now()){
  const e=entry||{},addr=normalizeEmail(String(e.emailAddress||e.inputData||'').toLowerCase());
  const valid=addr===email&&e.classification==='Deliverable'&&e.status==='Success'&&e.isDisposableEmailAddress!==true;
  const catchAll=e.status==='ServerIsCatchAll';
  return {policy_version:POLICY_VERSION,email,status:valid?'valid':addr===email&&e.classification==='Undeliverable'?'invalid':catchAll?'accept_all':'unknown',
    provider:'verifalia',provider_status:String(e.status||'').slice(0,60),checked_at:new Date(now).toISOString(),expires_at:new Date(now+DAY).toISOString(),
    smtp_check:valid,accept_all:!valid,block:!valid,disposable:valid?false:e.isDisposableEmailAddress!==false,catch_all:catchAll};
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
  /** Configured providers, cheapest first: Verifalia's free daily credits, then Hunter. */
  get providers(){
    const out=[];
    if(this.env.VERIFALIA_USERNAME&&this.env.VERIFALIA_PASSWORD)out.push('verifalia');
    if(this.env.HUNTER_API_KEY&&this.env.HUNTER_API_KEY!=='test-api-key')out.push('hunter');
    return out;
  }
  get enabled(){return this.env.EMAIL_VERIFICATION_ENABLED==='YES'&&this.providers.length>0&&Number(this.env.EMAIL_VERIFY_DAILY_LIMIT)>0}
  /** Count one provider request against the owner's daily cap (uncertain calls count too). */
  spend(){
    const day=new Date(this.now()).toISOString().slice(0,10),limit=Math.min(100,Math.floor(Number(this.env.EMAIL_VERIFY_DAILY_LIMIT)||0)),usage=this.state.email_verifier_usage;
    if((usage[day]||0)>=limit)return false;usage[day]=(usage[day]||0)+1;return true;
  }
  async mailbox(email){
    if(!this.enabled)return {status:'unknown',reason:'verifier_not_configured'};
    const key=createHash('sha256').update(email).digest('hex'),cached=this.state.email_verifications[key],nowMs=this.now();
    if(usableVerification(cached,email,nowMs))return cached;
    // Don't buy the same inconclusive answer again: unknown for 3 days, catch-all for 30.
    const age=cached?nowMs-Date.parse(cached.checked_at):Infinity;
    if(cached?.status==='unknown'&&age<3*DAY||cached?.catch_all&&age<30*DAY)return {...cached,reason:'recently_inconclusive'};
    let last='verification_unavailable';
    for(const provider of this.providers){
      const r=await (provider==='verifalia'?this.verifalia(email):this.hunter(email));
      if(r.verdict){
        const v=r.verdict;this.state.email_verifications[key]=v;
        if(v.status==='invalid'){this.state.suppression??={};this.state.suppression[email]={reason:'Mailbox verifier returned invalid',at:new Date(nowMs).toISOString()}}
        if(v.catch_all){this.state.catch_all_domains??={};this.state.catch_all_domains[email.split('@')[1]]=new Date(nowMs).toISOString()}
        return v;
      }
      last=r.reason;if(r.stop)break; // budget exhausted: no other provider either
    }
    return {status:'unknown',reason:last};
  }
  async hunter(email){
    if(!this.spend())return {reason:'verification_budget_exhausted',stop:true};
    try{const response=await this.fetch('https://api.hunter.io/v2/email-verifier?email='+encodeURIComponent(email),{headers:{'X-API-KEY':this.env.HUNTER_API_KEY,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(25000)});
      if(response.status!==200)return {reason:'verification_unavailable'};
      return {verdict:hunterVerdict(await response.json(),email,this.now())};
    }catch{return {reason:'verification_unavailable'}}
  }
  /** One Verifalia API call. Only idempotent GET/DELETE fail over to another endpoint; a POST is never re-sent. */
  async vcall(method,path,body){
    const auth='Basic '+Buffer.from(`${this.env.VERIFALIA_USERNAME}:${this.env.VERIFALIA_PASSWORD}`).toString('base64');
    for(const base of method==='POST'?VERIFALIA_API.slice(0,1):VERIFALIA_API){
      try{const r=await this.fetch(base+path,{method,headers:{Authorization:auth,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(45000)});
        if(r.status>=500&&method!=='POST')continue;return r}
      catch{if(method==='POST')return null}
    }
    return null;
  }
  /**
   * 401 = the login itself failed (wrong username/password, unconfirmed account, or 2FA on the user);
   * 403 = login is fine but the user lacks a permission (per Verifalia's SDK: AuthorizationError).
   * Recorded (no credentials) so the dashboard can say exactly what to change.
   */
  verifaliaDenied(status,endpoint){
    const error=status===403?'permission_denied':'login_rejected';
    this.verifaliaOff='verifalia_'+error;
    this.state.verifier_balance={provider:'verifalia',error,http_status:status,endpoint,checked_at:new Date(this.now()).toISOString()};
    return {reason:this.verifaliaOff};
  }
  async verifalia(email){
    if(this.verifaliaOff)return {reason:this.verifaliaOff};
    // Standard (1 credit) by default: twice as many free checks per day as High; a Deliverable answer is still a
    // positive mailbox check, and inconclusive answers hold. VERIFALIA_QUALITY=High|Extreme for more passes.
    const quality=Object.hasOwn(VERIFALIA_COST,this.env.VERIFALIA_QUALITY)?this.env.VERIFALIA_QUALITY:'Standard',cost=VERIFALIA_COST[quality];
    // Free credits only, unless the owner explicitly allows paid credit packs: this provider can never cost money by default.
    const paid=this.env.VERIFALIA_ALLOW_PAID==='YES';
    if(!paid){
      if(this.verifaliaFree==null){
        const b=await this.vcall('GET','/credits/balance');
        if(b?.status===401||b?.status===403)return this.verifaliaDenied(b.status,'credits_balance');
        const bal=b?.status===200?await b.json().catch(()=>null):null;
        if(!bal){return {reason:'verifalia_unavailable'}}
        this.verifaliaFree=Number(bal.freeCredits)||0;
        this.state.verifier_balance={provider:'verifalia',free_credits:this.verifaliaFree,reset_in:bal.freeCreditsResetIn||null,checked_at:new Date(this.now()).toISOString()};
      }
      if(this.verifaliaFree<cost)return {reason:'verifalia_free_credits_used_up'};
    }
    if(!this.spend())return {reason:'verification_budget_exhausted',stop:true};
    if(!paid){this.verifaliaFree-=cost;if(this.state.verifier_balance)this.state.verifier_balance.free_credits=this.verifaliaFree}
    const res=await this.vcall('POST','/email-validations?waitTime=30000',{entries:[{inputData:email}],quality});
    if(!res)return {reason:'verification_unavailable'};
    if(res.status===401||res.status===403)return this.verifaliaDenied(res.status,'submit_validation');
    if(res.status===402){this.verifaliaFree=0;this.verifaliaOff='verifalia_no_credits';return {reason:this.verifaliaOff}}
    if(res.status!==200&&res.status!==202)return {reason:'verification_unavailable'};
    let job=await res.json().catch(()=>null);const id=job?.overview?.id;
    for(let i=0;i<2&&id&&job?.overview?.status!=='Completed';i++){
      const r=await this.vcall('GET',`/email-validations/${encodeURIComponent(id)}?waitTime=30000`);
      if(!r||(r.status!==200&&r.status!==202))break;job=await r.json().catch(()=>null);
    }
    // Data minimisation: the job (with the address) is deleted from Verifalia once read.
    if(id)await this.vcall('DELETE',`/email-validations/${encodeURIComponent(id)}`).catch(()=>null);
    if(job?.overview?.status!=='Completed')return {reason:'verification_pending'};
    return {verdict:verifaliaVerdict(job.entries?.data?.[0],email,this.now())};
  }
  async page(url,domain){
    if(!samePublisher(url,domain))return null;if(this.pages.has(url))return this.pages.get(url);
    const pending=Promise.resolve().then(()=>this.fetchPage(url,{timeout:8000,maxBytes:300000,redirects:2})).then(r=>r.status===200&&r.body&&samePublisher(r.url,domain)?r:null).catch(()=>null);
    this.pages.set(url,pending);return pending;
  }
  /**
   * screenOnly: apply every free, first-party rule (pages, address type, suppression) and stop before DNS and
   * the paid mailbox check. Used to clean the ready queue without spending verification credits.
   */
  async verify(p,{followup=false,deadline=Infinity,screenOnly=false}={}){
    // `detail` says exactly why (no addresses): it is aggregated on the dashboard to tune the pipeline.
    const fail=(reason,detail)=>({ok:false,reason,...(detail?{detail}:{})}),published=new Set();let fetched=0;if(isSuppressed(this.state,p.email,p.domain))return fail('suppressed');
    if(!this.enabled&&!screenOnly)return fail('verifier_not_configured');if(!samePublisher(p.page_url,p.domain))return fail('publisher_mismatch');
    const origin=new URL(p.page_url).origin,queue=[p.email_source,p.page_url,origin+'/',origin+'/contact/',origin+'/contact-us/',origin+'/about/'],seen=new Set(),candidates=new Map();
    while(queue.length&&seen.size<6&&this.now()<deadline){
      const url=queue.shift();if(!url||seen.has(url)||!samePublisher(url,p.domain))continue;seen.add(url);
      const page=await this.page(url,p.domain);if(!page)continue;fetched++;
      for(const m of cleanPublisherHtml(page.body).matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi)){const e=normalizeEmail(m[0].toLowerCase());if(e&&host(e.split('@')[1])===host(p.domain))published.add(e)}
      const source=/\/(?:author|writers?)\//i.test(new URL(url).pathname)?'author':/\/(?:contact(?:-us)?|about(?:-us)?|editorial|editors|team|write-for-us|contribute)(?:\/|$)/i.test(new URL(url).pathname)?'contact':'page';
      for(const c of extractEditorialCandidates(page.body,page.url,{domain:p.domain,author:p.author||'',source,now:this.now()}))if(!candidates.has(c.email)||candidates.get(c.email).rank<c.rank)candidates.set(c.email,c);
      for(const m of cleanPublisherHtml(page.body).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
        let link;try{link=new URL(decode(m[1]),url).href}catch{continue}
        if(samePublisher(link,p.domain)&&/contact|editorial|editors|team|about|author|write-for-us|contribute/i.test(link+' '+plain(m[2]))&&!/advertis|sponsor|partner/i.test(link))queue.unshift(link);
      }
    }
    const hasContact=(p.history||[]).some(h=>h.type==='initial'&&h.mode!=='draft');
    let ranked=[...candidates.values()].filter(c=>(!followup&&!hasContact)||c.email===normalizeEmail(p.email)).sort((a,b)=>b.rank-a.rank);
    // A general inbox is a last resort: never used while an editorial or named-author address exists.
    if(ranked.some(c=>c.role!=='contact_page_inbox'))ranked=ranked.filter(c=>c.role!=='contact_page_inbox');
    if(!ranked.length)return fail('no_published_editorial_contact',!fetched?'publisher_pages_unreachable':published.size?'only_non_editorial_inbox_published':'no_email_published');
    if(screenOnly){const c=ranked.find(x=>!isSuppressed(this.state,x.email,p.domain));return c?{ok:true,screened:true,email:c.email,evidence:c}:fail('no_published_editorial_contact','suppressed')}
    let attempted=0;const outcomes=[];
    for(const c of ranked){if(++attempted>3||this.now()>=deadline)break;if(isSuppressed(this.state,c.email,p.domain)){outcomes.push('suppressed');continue}
      // A catch-all mail server accepts every address, so no provider can prove this inbox: don't spend a credit.
      const seenCatchAll=this.state.catch_all_domains?.[c.email.split('@')[1]];if(seenCatchAll&&this.now()-Date.parse(seenCatchAll)<90*DAY){outcomes.push('catch_all_domain');continue}
      const mx=await checkMx(c.email.split('@')[1],this.resolveMx);if(!mx.ok){outcomes.push('mx_'+mx.reason);continue}
      const v=await this.mailbox(c.email);if(usableVerification(v,c.email,this.now()))return {ok:true,email:c.email,evidence:c,verification:v};
      outcomes.push(v.status==='unknown'?'mailbox_'+(v.reason||'unknown'):'mailbox_'+v.status);
    }
    return fail('no_verified_mailbox',outcomes[0]||'time_budget');
  }
}
