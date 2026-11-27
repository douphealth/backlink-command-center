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
/** The publisher's own contact/about pages, including the names indie blogs use (/contact-me, /about-me, /work-with-me). */
export const CONTACT_PAGE=/\/(?:contact(?:-us|-me)?|about(?:-us|-me)?|work-with-me|get-in-touch|editorial|editors|team|write-for-us|contribute)(?:\/|$)/i;
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
/** A screen-only answer (weekend screening with credits that would expire) is never a send proof, whatever it says. */
export function usableVerification(v,email,now=Date.now()){
  const checked=Date.parse(v?.checked_at||''),expires=Date.parse(v?.expires_at||'');
  return !!v&&v.policy_version===POLICY_VERSION&&v.email===normalizeEmail(email)&&v.status==='valid'&&v.smtp_check===true&&v.accept_all===false&&v.block===false&&v.disposable===false&&v.screen_only!==true&&checked<=now&&now-checked<=DAY&&expires>now&&expires<=checked+DAY;
}
export function hunterVerdict(data,email,now=Date.now()){
  const d=data?.data,valid=d?.email?.toLowerCase()===email&&d.status==='valid'&&d.regexp===true&&d.mx_records===true&&d.smtp_server===true&&d.smtp_check===true&&d.accept_all===false&&d.block===false&&d.disposable===false&&d.gibberish===false;
  return {policy_version:POLICY_VERSION,email,status:valid?'valid':d?.status==='invalid'?'invalid':'unknown',provider:'hunter',provider_status:d?.smtp_server===false?'hunter_smtp_server_unreachable':String(d?.status||'').slice(0,60),
    checked_at:new Date(now).toISOString(),expires_at:new Date(now+DAY).toISOString(),smtp_check:valid,accept_all:d?.accept_all!==false,block:d?.block!==false,disposable:d?.disposable!==false,catch_all:d?.accept_all===true};
}
/**
 * An "unknown" caused by the mail server itself (SMTP/DNS timeout, connection failure, server unavailable, greylisting),
 * not by the mailbox: any other address on that server would get the same answer, so it gets no credit this cycle.
 */
const SERVER_UNKNOWN=/^(?:Smtp\w+|Dns\w+|ServerTemporaryUnavailable|ServerDoesNotSupportInternationalMailboxes|LocalSenderAddressRejected|MailboxConnectionFailure|MailboxValidationTimeout|\w*Greylist\w*|hunter_smtp_server_unreachable)$/i;
export const serverUnknown=v=>v?.status==='unknown'&&!v.catch_all&&!v.reason&&SERVER_UNKNOWN.test(String(v.provider_status||''));
/**
 * DE/AT/CH: unsolicited business email generally needs prior consent there. A .de/.at/.ch publisher or address, or an
 * address taken from an Impressum/imprint/Kontakt page, is held before any credit is spent unless the owner opts in (OUTREACH_DACH=YES).
 */
const DACH_DOMAIN=/\.(?:de|at|ch)$/i,IMPRINT_PAGE=/(?:^|\/)(?:impressum|imprint|kontakt)(?:[\/._-]|$)/i;
export function jurisdictionHold({domain='',email='',source=''}={}){
  let path='';try{path=new URL(source).pathname}catch{}
  return [domain,String(email||'').split('@')[1]].some(d=>!!d&&DACH_DOMAIN.test(host(d)))||IMPRINT_PAGE.test(path);
}
const CATCH_ALL_OUT=/^(?:catch_all_domain|mailbox_accept_all)$/;
/** Daily verification ledger: counts only (never addresses), so it is safe to publish. */
export const LEDGER_KEYS=['checks','credits','valid','invalid','catch_all','unknown','hunter_checks','screen_only','emails_sent'];
const ledgerEntry=date=>({date,...Object.fromEntries(LEDGER_KEYS.map(k=>[k,0]))});
/**
 * Refresh state.verify_ledger (30 days kept; emails_sent recomputed from send history, so it is always the truth) and return
 * the last 14 days plus credits per email over the last 7 (Verifalia credits / emails sent; null when nothing was sent).
 */
export function verifyLedger(state,{now=Date.now(),keep=30,publish=14}={}){
  const day=ms=>new Date(ms).toISOString().slice(0,10),today=day(now),since=n=>day(now-(n-1)*DAY),from=since(keep),sent={};
  for(const p of Object.values(state.prospects||{}))for(const h of p.history||[])if((h.type==='initial'||h.type==='followup')&&h.mode!=='draft'){
    const d=String(h.at||'').slice(0,10);if(d>=from&&d<=today)sent[d]=(sent[d]||0)+1}
  const by=new Map();
  for(const x of Array.isArray(state.verify_ledger)?state.verify_ledger:[])if(/^\d{4}-\d{2}-\d{2}$/.test(x?.date||'')&&x.date>=from&&x.date<=today)
    by.set(x.date,Object.assign(ledgerEntry(x.date),Object.fromEntries(LEDGER_KEYS.filter(k=>Number.isFinite(x[k])).map(k=>[k,x[k]]))));
  for(const d of Object.keys(sent))if(!by.has(d))by.set(d,ledgerEntry(d));
  for(const [d,x] of by)x.emails_sent=sent[d]||0;
  state.verify_ledger=[...by.values()].sort((a,b)=>a.date<b.date?-1:1);
  for(const k of ['email_verifier_usage','hunter_usage'])for(const d of Object.keys(state[k]||{}))if(d<from)delete state[k][d];
  const week=state.verify_ledger.filter(x=>x.date>=since(7)),credits=week.reduce((n,x)=>n+x.credits,0),emails=week.reduce((n,x)=>n+x.emails_sent,0);
  return {ledger:state.verify_ledger.filter(x=>x.date>=since(publish)).map(x=>({...x})),credits_per_email:emails?Math.round(credits/emails*100)/100:null};
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
    provider:'verifalia',provider_status:String(e.status||'').slice(0,60),provider_class:String(e.classification||'').slice(0,20),checked_at:new Date(now).toISOString(),expires_at:new Date(now+DAY).toISOString(),
    smtp_check:valid,accept_all:!valid,block:!valid,disposable:valid?false:e.isDisposableEmailAddress!==false,catch_all:catchAll};
}
/** Which kind of mail host serves a domain (from its MX records). Verification pass rates differ a lot by host. */
export function mxClass(records){
  const h=(records||[]).map(r=>String(r?.exchange||'').toLowerCase()).join(' ');
  if(!h.trim())return 'none';
  if(/(^|[ .])(google|googlemail)\.com/.test(h))return 'google';
  if(/outlook\.com|office365|microsoft/.test(h))return 'microsoft';
  if(/zoho\./.test(h))return 'zoho';
  if(/protonmail|proton\.me/.test(h))return 'proton';
  if(/messagingengine\.com/.test(h))return 'fastmail';
  if(/mx\.cloudflare\.net|improvmx|forwardemail|registrar-servers\.com|forwardmx/.test(h))return 'forwarder';
  if(/mimecast|pphosted|proofpoint|barracuda|mailchannels/.test(h))return 'gateway';
  if(/secureserver\.net/.test(h))return 'godaddy';
  return 'other';
}
/**
 * Learned chance that an inbox on this kind of mail host gets a positive verification:
 * (verified+1)/(checked+3), so untried hosts start at 1/3 and are still explored.
 */
export function verifyPassRate(state,cls){
  const s=state?.verify_stats?.[cls];
  if(s&&s.n>0)return (s.valid+1)/(s.n+3);
  const all=Object.values(state?.verify_stats||{}).reduce((a,x)=>({n:a.n+x.n,valid:a.valid+x.valid}),{n:0,valid:0});
  return (all.valid+1)/(all.n+3);
}
export async function checkMx(domain,resolveMx){
  try{const records=await resolveMx(domain);
    if(!Array.isArray(records)||!records.length)return {ok:false,reason:'no_explicit_mx'};
    if(records.some(r=>r.exchange==='.'||r.exchange===''))return {ok:false,reason:'null_mx'};
    if(!records.some(r=>typeof r.exchange==='string'&&r.exchange.includes('.')))return {ok:false,reason:'unusable_mx'};
    return {ok:true,reason:'mx_present_not_mailbox_proof',class:mxClass(records)};
  }catch{return {ok:false,reason:'dns_unverified'}}
}
export class RecipientVerifier{
  constructor({state,fetchPage,fetchImpl=fetch,env=process.env,resolveMx,now=()=>Date.now()}={}){
    if(!state||typeof fetchPage!=='function')throw Error('Recipient verifier requires state and bounded page fetch');
    Object.assign(this,{state,fetchPage,fetch:fetchImpl,env,now});this.resolveMx=resolveMx||((d)=>new Resolver({timeout:4000,tries:1}).resolveMx(d));
    state.email_verifications??={};state.email_verifier_usage??={};this.pages=new Map();
    this.requests=0;this.serverDown=new Set(); // per cycle: mail domains whose server gave a server-level "unknown"
  }
  /** Configured providers, cheapest first: Verifalia's free daily credits, then Hunter (only with its own daily budget above 0). */
  get providers(){
    const out=[];
    if(this.env.VERIFALIA_USERNAME&&this.env.VERIFALIA_PASSWORD)out.push('verifalia');
    if(this.env.HUNTER_API_KEY&&this.env.HUNTER_API_KEY!=='test-api-key'&&this.hunterLimit>0)out.push('hunter');
    return out;
  }
  get enabled(){return this.env.EMAIL_VERIFICATION_ENABLED==='YES'&&this.providers.length>0&&Number(this.env.EMAIL_VERIFY_DAILY_LIMIT)>0}
  get dailyLimit(){return Math.min(100,Math.max(0,Math.floor(Number(this.env.EMAIL_VERIFY_DAILY_LIMIT)||0)))}
  /** Hunter's own daily budget (default 0 = never used); it never shares Verifalia's counter. */
  get hunterLimit(){return Math.min(50,Math.max(0,Math.floor(Number(this.env.HUNTER_DAILY_LIMIT)||0)))}
  get cost(){return VERIFALIA_COST[Object.hasOwn(VERIFALIA_COST,this.env.VERIFALIA_QUALITY)?this.env.VERIFALIA_QUALITY:'Standard']}
  get allowDach(){return this.env.OUTREACH_DACH==='YES'}
  day(){return new Date(this.now()).toISOString().slice(0,10)}
  /** Add counts to today's verification ledger (counts only). */
  tally(add){
    const date=this.day();let l=this.state.verify_ledger;if(!Array.isArray(l))l=this.state.verify_ledger=[];
    let x=l.find(e=>e?.date===date);if(!x)l.push(x=ledgerEntry(date));
    for(const [k,n] of Object.entries(add))x[k]=(Number(x[k])||0)+n;
  }
  /** Count one provider request against that provider's own daily cap (uncertain calls count too). */
  spend(provider='verifalia',{cost=1,screen=false}={}){
    const day=this.day(),hunter=provider==='hunter',usage=hunter?(this.state.hunter_usage??={}):this.state.email_verifier_usage,limit=hunter?this.hunterLimit:this.dailyLimit;
    if((usage[day]||0)>=limit)return false;usage[day]=(usage[day]||0)+1;this.requests++;
    this.tally({checks:1,...(hunter?{hunter_checks:1}:{credits:cost}),...(screen?{screen_only:1}:{})});return true;
  }
  /**
   * How many more checks can run today without paying: min(owner's daily limit, live free credits) on Verifalia, plus
   * Hunter's own budget (never for screening). Reading the balance is free.
   */
  async creditsLeft({screen=false}={}){
    if(!this.enabled)return 0;const day=this.day();let n=0;
    if(this.providers.includes('verifalia')&&!this.verifaliaOff){
      const left=Math.max(0,this.dailyLimit-(this.state.email_verifier_usage[day]||0));
      if(this.env.VERIFALIA_ALLOW_PAID==='YES')n+=left;
      else if(!await this.verifaliaBalance())n+=Math.min(left,Math.floor(Math.max(0,this.verifaliaFree)/this.cost));
    }
    if(!screen&&this.providers.includes('hunter'))n+=Math.max(0,this.hunterLimit-(this.state.hunter_usage?.[day]||0));
    return n;
  }
  /** Free DNS lookup: the mail-host class of an address's domain (cached for the run). */
  async mxClassOf(email){
    const d=String(email||'').split('@')[1];if(!d)return null;
    this.mxCache??=new Map();
    if(!this.mxCache.has(d)){const r=await checkMx(d,this.resolveMx);this.mxCache.set(d,r.ok?r.class:r.reason==='dns_unverified'?null:'none')}
    return this.mxCache.get(d);
  }
  /**
   * screen: a weekend screen with Verifalia credits that would otherwise expire. Its answer is stored as screen_only,
   * which usableVerification never accepts, so it can never back a send; Hunter's budget is never used for it.
   */
  async mailbox(email,{mxClass:cls,screen=false}={}){
    if(!this.enabled)return {status:'unknown',reason:'verifier_not_configured'};
    const key=createHash('sha256').update(email).digest('hex'),cached=this.state.email_verifications[key],nowMs=this.now();
    if(usableVerification(cached,email,nowMs))return cached;
    // Don't buy the same inconclusive answer again: unknown for 3 days, catch-all for 30.
    // An address that stays "unknown" waits twice as long each time (3, 6, 12, 24 days) instead of costing a credit every 3 days.
    const age=cached?nowMs-Date.parse(cached.checked_at):Infinity;
    const wait=cached?.catch_all?30*DAY:cached?.status==='unknown'?3*DAY*Math.min(8,2**((cached.unknown_count||1)-1)):0;
    if(wait&&age<wait)return {...cached,reason:'recently_inconclusive',retry_after:new Date(Date.parse(cached.checked_at)+wait).toISOString()};
    const ps=this.providers,before=this.requests;let v=null,vReason=null,hReason=null;
    if(ps.includes('verifalia')){const r=await this.verifalia(email,{screen});if(r.verdict)v=r.verdict;else vReason=r.reason}
    else if(screen)vReason='verification_budget_exhausted'; // screening only ever uses Verifalia's free credits
    // Hunter, within its own budget: a second opinion when Verifalia could not decide (Unknown, not catch-all, not Risky), or the
    // fallback when Verifalia cannot answer today (free credits used up, not configured, login or outage). It passes only valid + not accept-all.
    if(!screen&&ps.includes('hunter')&&(v?v.status==='unknown'&&!v.catch_all&&v.provider_class!=='Risky':vReason!=='verification_pending')){
      const r=await this.hunter(email);
      if(r.verdict){if(!v||r.verdict.status!=='unknown'||r.verdict.catch_all)v=r.verdict}else hReason=r.reason;
    }
    if(this.requests>before)this.tally({[!v?'unknown':v.status==='valid'?'valid':v.status==='invalid'?'invalid':v.catch_all?'catch_all':'unknown']:1});
    // Out of credits on Verifalia wins over a Hunter error, so the caller stops for the day instead of trying every inbox.
    if(!v)return {status:'unknown',reason:vReason&&(/credits_used_up|budget_exhausted/.test(vReason)||!hReason)?vReason:hReason||vReason||'verification_unavailable'};
    if(screen)v.screen_only=true;
    if(v.status==='unknown'&&cached?.status==='unknown')v.unknown_count=(cached.unknown_count||1)+1;
    this.state.email_verifications[key]=v;
    // Learn which mail hosts actually verify (and which are catch-all), so credits go where a "deliverable" answer is likely.
    if(cls){const st=(this.state.verify_stats??={})[cls]??={n:0,valid:0};if(st.n>=200){st.n/=2;st.valid/=2;if(st.catch_all)st.catch_all/=2}st.n++;if(v.status==='valid')st.valid++;if(v.catch_all)st.catch_all=(st.catch_all||0)+1}
    if(v.status==='invalid'){this.state.suppression??={};this.state.suppression[email]={reason:'Mailbox verifier returned invalid',at:new Date(nowMs).toISOString()}}
    if(v.catch_all){this.state.catch_all_domains??={};this.state.catch_all_domains[email.split('@')[1]]=new Date(nowMs).toISOString()}
    return v;
  }
  async hunter(email){
    if(!this.spend('hunter'))return {reason:'verification_budget_exhausted',stop:true};
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
  /** Live free-credit balance (a free GET), read once per run and again when the UTC day changes. Returns a failure, or null when known. */
  async verifaliaBalance(){
    const day=this.day();if(this.verifaliaDay!==day){this.verifaliaFree=null;this.verifaliaDay=day}
    if(this.verifaliaFree!=null)return null;
    const b=await this.vcall('GET','/credits/balance');
    if(b?.status===401||b?.status===403)return this.verifaliaDenied(b.status,'credits_balance');
    const bal=b?.status===200?await b.json().catch(()=>null):null;
    if(!bal)return {reason:'verifalia_unavailable'};
    this.verifaliaFree=Number(bal.freeCredits)||0;
    this.state.verifier_balance={provider:'verifalia',free_credits:this.verifaliaFree,reset_in:bal.freeCreditsResetIn||null,checked_at:new Date(this.now()).toISOString()};
    return null;
  }
  async verifalia(email,{screen=false}={}){
    if(this.verifaliaOff)return {reason:this.verifaliaOff};
    // Standard (1 credit) by default: twice as many free checks per day as High; a Deliverable answer is still a
    // positive mailbox check, and inconclusive answers hold. VERIFALIA_QUALITY=High|Extreme for more passes.
    const quality=Object.hasOwn(VERIFALIA_COST,this.env.VERIFALIA_QUALITY)?this.env.VERIFALIA_QUALITY:'Standard',cost=VERIFALIA_COST[quality];
    // Free credits only, unless the owner explicitly allows paid credit packs: this provider can never cost money by default.
    // Each day spends min(owner's daily limit, live free credits).
    const paid=this.env.VERIFALIA_ALLOW_PAID==='YES';
    if(!paid){
      const failed=await this.verifaliaBalance();if(failed)return failed;
      if(this.verifaliaFree<cost)return {reason:'verifalia_free_credits_used_up'};
    }
    if(!this.spend('verifalia',{cost,screen}))return {reason:'verification_budget_exhausted',stop:true};
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
   * prescreen: weekend screening with free credits that would otherwise expire. It runs the full check but never returns
   * ok (no proof, no `verification`): `screened` says what the mailbox check found, for ranking and retiring only.
   */
  async verify(p,{followup=false,deadline=Infinity,screenOnly=false,prescreen=false}={}){
    // `detail` says exactly why (no addresses): it is aggregated on the dashboard to tune the pipeline.
    const fail=(reason,detail,extra)=>({ok:false,reason,...(detail?{detail}:{}),...(extra||{})}),published=new Set();let fetched=0;if(isSuppressed(this.state,p.email,p.domain))return fail('suppressed');
    if(!this.enabled&&!screenOnly)return fail('verifier_not_configured');if(!samePublisher(p.page_url,p.domain))return fail('publisher_mismatch','publisher_mismatch');
    // DE/AT/CH publishers and Impressum-sourced addresses: held before any page fetch or credit unless the owner opted in.
    if(!screenOnly&&!this.allowDach&&jurisdictionHold({domain:p.domain,source:p.email_source}))return fail('jurisdiction_consent_required','jurisdiction_consent_required');
    const origin=new URL(p.page_url).origin,queue=[p.email_source,p.page_url,origin+'/',origin+'/contact/',origin+'/contact-us/',origin+'/about/'],seen=new Set(),candidates=new Map();
    while(queue.length&&seen.size<6&&this.now()<deadline){
      const url=queue.shift();if(!url||seen.has(url)||!samePublisher(url,p.domain))continue;seen.add(url);
      const page=await this.page(url,p.domain);if(!page)continue;fetched++;
      for(const m of cleanPublisherHtml(page.body).matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi)){const e=normalizeEmail(m[0].toLowerCase());if(e&&host(e.split('@')[1])===host(p.domain))published.add(e)}
      const source=/\/(?:author|writers?)\//i.test(new URL(url).pathname)?'author':CONTACT_PAGE.test(new URL(url).pathname)?'contact':'page';
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
    let attempted=0,retryAfter=null;const outcomes=[];
    for(const c of ranked){if(++attempted>3||this.now()>=deadline)break;if(isSuppressed(this.state,c.email,p.domain)){outcomes.push('suppressed');continue}
      const d=c.email.split('@')[1];
      if(!this.allowDach&&jurisdictionHold({email:c.email,source:c.source})){outcomes.push('jurisdiction_consent_required');continue} // costs no credit
      // A catch-all mail server accepts every address, so no provider can prove this inbox: don't spend a credit.
      const seenCatchAll=this.state.catch_all_domains?.[d];if(seenCatchAll&&this.now()-Date.parse(seenCatchAll)<90*DAY){outcomes.push('catch_all_domain');continue}
      // This cycle the server already timed out or was unavailable: another address there would get the same answer.
      if(this.serverDown.has(d)){outcomes.push('mailbox_unknown_server');continue}
      const mx=await checkMx(d,this.resolveMx);if(!mx.ok){outcomes.push('mx_'+mx.reason);continue}
      const v=await this.mailbox(c.email,{mxClass:mx.class,screen:prescreen});
      if(prescreen&&v.status==='valid'&&!v.reason)return {ok:false,reason:'screen_only',screened:'valid',email:c.email,outcomes:[...outcomes,'mailbox_valid']};
      if(!prescreen&&usableVerification(v,c.email,this.now()))return {ok:true,email:c.email,evidence:c,verification:v};
      if(v.retry_after&&!outcomes.length)retryAfter=v.retry_after;
      if(serverUnknown(v)){this.serverDown.add(d);outcomes.push('mailbox_unknown_server');continue}
      outcomes.push(v.status==='unknown'?'mailbox_'+(v.reason||'unknown'):'mailbox_'+v.status);
    }
    // A catch-all answer retires the prospect at once, so it is the reason only when every inbox tried was catch-all.
    const other=CATCH_ALL_OUT.test(outcomes[0]||'')?outcomes.find(o=>!CATCH_ALL_OUT.test(o)&&o!=='suppressed'):null,detail=other||outcomes[0]||'time_budget';
    if(prescreen){const tried=outcomes.filter(o=>o!=='suppressed');
      return {ok:false,reason:'screen_only',detail,outcomes,screened:!tried.length?'held':tried.every(o=>o==='mailbox_invalid')?'invalid':tried.every(o=>CATCH_ALL_OUT.test(o)||o==='mailbox_invalid')?'catch_all':'unknown'}}
    return fail('no_verified_mailbox',detail,retryAfter&&outcomes.every(o=>o==='mailbox_recently_inconclusive')?{retry_after:retryAfter}:null);
  }
}
