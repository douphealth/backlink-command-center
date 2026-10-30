/** Outreach state machine with mandatory recipient preflight and reply-health gate. */
import {createHash} from 'node:crypto';
import {buildMessage,newMessageId,smtpSend,Imap,classifyReply} from './mail.mjs';
import {followupPitch} from './pitch.mjs';
import {fetchPage,links,hostOf,sameSite,ageDays,NOW,sleep,DAY} from './util.mjs';
import {QUALIFY_VERSION} from './prospect.mjs';
import {assetStats,linkLikelihood} from './learn.mjs';
import {RecipientVerifier,isSuppressed,usableVerification,samePublisher,normalizeEmail} from './recipient-policy.mjs';
export const PER_ASSET_DAILY=2;
const REGIONS=[
 [/\.(uk|ie|de|fr|es|it|nl|be|pt|gr|se|no|dk|fi|pl|cz|at|ch|eu|za|ro|hu|sk|si|hr|bg|lt|lv|ee|lu|cy|mt)$/,[7,16],1],
 [/\.(au|nz)$/,[21,6],10],[/\.in$/,[3,12],5],[/\.(jp|sg|my|ph|hk|kr|cn|id|th|vn|tw)$/,[0,9],8]
];
const DEFAULT_REGION=[null,[13,21],-5];
export function sendWindowOpen(domain,now=new Date()){
 const [,[from,to],offset]=REGIONS.find(([re])=>re.test(domain))||DEFAULT_REGION;
 const h=now.getUTCHours(),d=new Date(now.getTime()+offset*36e5).getUTCDay();
 return d!==0&&d!==6&&(from<to?h>=from&&h<to:h>=from||h<to);
}
export function nextSendWindow(domain,from=new Date()){
 if(sendWindowOpen(domain,from))return new Date(from);
 const t=new Date(from);t.setUTCMinutes(0,0,0);
 for(let h=0;h<24*8;h++){t.setUTCHours(t.getUTCHours()+1);if(sendWindowOpen(domain,t))return new Date(t)}return null;
}
export function dailyCap(state,limit){
 const cap=Math.max(0,Math.floor(Number(limit)||0));
 return Math.min(cap,5+2*Math.max(0,Math.floor(state.first_send_at?ageDays(state.first_send_at):0)));
}
export const sentToday=state=>Object.values(state.prospects||{}).reduce((n,p)=>n+(p.history||[]).filter(h=>['initial','followup'].includes(h.type)&&h.mode!=='draft'&&String(h.at).startsWith(NOW().slice(0,10))).length,0);
const draftedToday=state=>Object.values(state.prospects||{}).reduce((n,p)=>n+(p.history||[]).filter(h=>h.mode==='draft'&&String(h.at).startsWith(NOW().slice(0,10))).length,0);
export const suppressed=isSuppressed;
export function outreachStatus(state,{limit,mode,qualifyVersion}){
 const ready=Object.values(state.prospects||{}).filter(p=>p.status==='ready'&&p.email&&(p.qv||1)>=qualifyVersion);
 const cap=mode==='send'?dailyCap(state,limit):limit,sent=sentToday(state),now=new Date();
 const from=sent>=cap?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)):now;
 const next=ready.map(p=>nextSendWindow(p.domain,from)).filter(Boolean).sort((a,b)=>a-b)[0]||null;
 const verified=ready.filter(p=>usableVerification(p.recipient_proof?.verification,p.email)&&!suppressed(state,p.email,p.domain));
 return {mode,ready:ready.length,verified_ready:verified.length,pending_verification:ready.length-verified.length,
  sent_today:sent,cap_today:cap,next_send_at:mode==='off'?null:next?.toISOString()||null,
  sending_now:mode==='send'&&sent<cap&&verified.some(p=>sendWindowOpen(p.domain,now)),reply_health:state.reply_health?.status||'unverified'};
}
/** Late replies from any contacted status, including won/lost, must still suppress. */
export async function processReplies({state,imap,log=()=>{}}){
 const stats={scanned:0,replies:0,positive:0,negative:0,bounces:0,delays:0};
 state.suppression??={};state.contacted??={};state.seen_replies??={};
 state.reply_health={status:'checking',checked_at:NOW()};
 // Migrate old bounce records, including queues previously switched to alternate inboxes.
 for(const p of Object.values(state.prospects||{})){
  const failures=(p.history||[]).filter(h=>h.type==='bounce');if(!failures.length)continue;
  for(const h of failures)if(h.to)state.suppression[h.to.toLowerCase()]??={reason:'Historical delivery failure',at:h.at||NOW()};
  p.no_followup=true;state.contacted[p.domain]??=NOW();if(p.status==='ready')p.status='bounced';
 }
 const byMsg=new Map(),byEmail=new Map();
 for(const p of Object.values(state.prospects||{})){
  if(!(p.history||[]).some(h=>h.type==='initial'))continue;
  for(const h of p.history||[]){if(h.message_id)byMsg.set(h.message_id,p);if(h.to)byEmail.set(h.to.toLowerCase(),p)}
  if(p.email)byEmail.set(p.email.toLowerCase(),p);
 }
 let msgs;
 try{msgs=await imap.recentHeaders(new Date(Date.now()-35*DAY),{cursor:state.mail_cursor});if(!Array.isArray(msgs))throw Error('Invalid mailbox response')}
 catch(e){state.reply_health={status:'failed',checked_at:NOW()};throw e}
 stats.scanned=msgs.length;
 for(const m of msgs){
  const ids=`${m.inReplyTo||''} ${m.references||''} ${m.body||''}`.match(/<lf-[^>]+>/g)||[];
  const from=String(m.from||'').toLowerCase();let p=ids.map(i=>byMsg.get(i)).find(Boolean)||byEmail.get(from);
  const kind=classifyReply(m);
  if(!p&&kind==='bounce'){for(const [e,q] of byEmail)if(String(m.body||'').toLowerCase().includes(e)){p=q;break}}
  if(!p||kind==='auto')continue;
  const identity=m.messageId||createHash('sha256').update(JSON.stringify([from,m.subject,m.body,m.uid])).digest('hex');
  const key=p.id+'|'+identity;if(state.seen_replies[key])continue;
  p.history??=[];
  if(kind==='bounce'){
   const delayed=/notification\s*\(delay\)|delivery (?:incomplete|delayed)|will retry|Action:\s*delayed|Status:\s*4\./i.test((m.subject||'')+'\n'+(m.body||''));
   const failed=(String(m.body||'').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)||[]).map(e=>e.toLowerCase()).find(e=>byEmail.get(e)===p)||p.email;
   p.history.push({type:delayed?'delivery_delay':'bounce',at:NOW(),to:failed});
   state.contacted[p.domain]??=NOW();
   p.status=delayed?'delivery_delayed':'bounced';p.no_followup=true;
   // Keep publisher deduplication intact. Do not try another person after any delivery failure.
   if(!delayed){stats.bounces++;if(failed)state.suppression[failed.toLowerCase()]={reason:'Delivery failure; re-contact prohibited',at:NOW()}}
   else stats.delays++;
  }else{
   stats.replies++;p.replied_at=NOW();p.no_followup=true;
   p.history.push({type:'reply',at:NOW(),from,sentiment:kind,subject:String(m.subject||'').slice(0,140)});
   if(kind==='negative'){stats.negative++;p.status='declined';state.suppression[p.domain]={reason:'Opt-out',at:NOW()};if(p.email)state.suppression[p.email.toLowerCase()]={reason:'Opt-out',at:NOW()}}
   else if(kind==='positive'){stats.positive++;p.status='positive';p.next_link_check=NOW()}
   else p.status='replied';
  }
  state.seen_replies[key]=NOW();
 }
 if(msgs.cursor)state.mail_cursor=msgs.cursor;
 state.reply_health={status:msgs.complete===false?'backlog':'ok',checked_at:NOW(),scanned:msgs.length};
 log(`replies: ${stats.scanned} scanned, ${stats.replies} replies, ${stats.bounces} failures, ${stats.delays} delays; ${state.reply_health.status}`);
 return stats;
}
export async function runOutreach({state,assets,sites,writer,mailer,config,deadline=Infinity,log=()=>{}}){
 state.contacted??={};state.suppression??={};
 const stats={followups:0,sent:0,drafted:0,skipped:0,deferred:0,cap:0,verification_held:0};
 if(!['send','draft'].includes(config.mode))return stats;
 const cap=config.mode==='send'?dailyCap(state,config.dailyLimit):Math.max(0,Number(config.dailyLimit)||0);stats.cap=cap;
 // The production Gmail transport supplies authorizeRecipient and independently
 // requires its proof at SMTP. Injected in-memory test transports cannot send mail.
 const verify=config.verifyRecipient||mailer.authorizeRecipient;
 const requiresProof=typeof verify==='function';
 const scanAge=Date.now()-Date.parse(state.reply_health?.checked_at||'');
 if(requiresProof&&config.mode==='send'&&(state.reply_health?.status!=='ok'||!Number.isFinite(scanAge)||scanAge<0||scanAge>25*60e3)){
  stats.blocked_reason='reply_scan_not_current_and_complete';log('outreach blocked: complete mailbox review required');return stats;
 }
 const assetByUrl=new Map(assets.map(a=>[a.url,a])),siteBy=new Map(sites.map(s=>[s.domain,s]));
 const outOfHours=p=>config.mode==='send'&&config.sendWindow&&!sendWindowOpen(p.domain,config.now?.()||new Date());
 let budget=Math.max(0,cap-(config.mode==='send'?sentToday(state):draftedToday(state))),checked=0;
 const prepare=async(p,followup)=>{
  if(!requiresProof)return true;
  if(Date.now()>deadline||++checked>24)return false;
  if(suppressed(state,p.email,p.domain))return false;
  let proof;try{proof=await verify(p,{state,followup,deadline})}catch{proof={ok:false,reason:'verification_error'}}
  const e=normalizeEmail(proof?.email),valid=proof?.ok===true&&e&&usableVerification(proof.verification,e)&&
   samePublisher(proof.evidence?.source,p.domain)&&proof.evidence?.email===e&&
   Number.isFinite(Date.parse(proof.evidence?.observed_at))&&Date.now()-Date.parse(proof.evidence.observed_at)>=0&&Date.now()-Date.parse(proof.evidence.observed_at)<DAY;
  if(!valid||suppressed(state,e,p.domain)||(followup&&e!==normalizeEmail(p.email))){
   p.contact_quality={status:'held',reason:proof?.reason||'recipient_not_verified',checked_at:NOW()};delete p.recipient_proof;stats.verification_held++;return false;
  }
  p.email=e;p.email_source=proof.evidence.source;p.email_rank=proof.evidence.rank;
  p.recipient_proof={...proof,publisher_domain:p.domain};p.contact_quality={status:'verified',checked_at:NOW()};return true;
 };
 const deliver=async(p,{subject,body},type,inReplyTo)=>{
  if(suppressed(state,p.email,p.domain)||(requiresProof&&!usableVerification(p.recipient_proof?.verification,p.email)))throw Error('Recipient verification no longer valid');
  const messageId=newMessageId(config.fromAddress.split('@')[1]);
  const footer=config.postalAddress?`\n\n${config.postalAddress}`:'';
  const raw=buildMessage({from:config.fromAddress,fromName:config.senderName,to:p.email,subject,text:body+footer,messageId,inReplyTo,references:inReplyTo,unsubscribe:true});
  if(config.mode==='send')await mailer.send({to:p.email,raw,recipientProof:p.recipient_proof});else await mailer.draft(raw);
  p.history??=[];p.history.push({type,at:NOW(),message_id:messageId,subject,to:p.email,mode:config.mode,writer:p.writer||'template'});p.last_subject=subject;
 };
 if(config.mode==='send')for(const p of Object.values(state.prospects||{})){
  if(budget<=0||Date.now()>deadline||checked>=24)break;
  if(p.status!=='sent'||p.replied_at||p.no_followup||(p.qv||1)<QUALIFY_VERSION||suppressed(state,p.email,p.domain))continue;
  const initial=p.history.find(h=>h.type==='initial'&&h.mode!=='draft');if(!initial||ageDays(initial.at)<config.followupDays)continue;
  if(outOfHours(p)){stats.deferred++;continue}if(!await prepare(p,true))continue;
  const asset=assetByUrl.get(p.asset_url)||{url:p.asset_url,title:p.asset_title};
  try{await deliver(p,followupPitch(p,asset,{senderName:config.senderName}),'followup',initial.message_id);p.status='followed_up';stats.followups++;budget--;await sleep(config.gapMs())}
  catch{p.status='delivery_uncertain';p.no_followup=true;log('follow-up held after uncertain delivery; no automatic retry');break}
 }
 const learned=assetStats(state),ready=Object.values(state.prospects||{}).filter(p=>p.status==='ready'&&p.email&&(p.qv||1)>=QUALIFY_VERSION)
  .map(p=>{p.likelihood=linkLikelihood(p,{assets:learned});return p}).sort((a,b)=>b.likelihood-a.likelihood||(b.score||0)-(a.score||0));
 const perAsset=new Map();for(const p of Object.values(state.prospects||{}))if((p.history||[]).some(h=>h.type==='initial'&&String(h.at).startsWith(NOW().slice(0,10))))perAsset.set(p.asset_url,(perAsset.get(p.asset_url)||0)+1);
 for(const p of ready){
  if(budget<=0||Date.now()>deadline||checked>=24)break;
  if((perAsset.get(p.asset_url)||0)>=PER_ASSET_DAILY)continue;if(outOfHours(p)){stats.deferred++;continue}
  const last=state.contacted[p.domain];
  if(suppressed(state,p.email,p.domain)||(last&&ageDays(last)<90)){p.status='skipped_duplicate';stats.skipped++;continue}
  const site=siteBy.get(p.site);if(!site){p.status='stale_asset';stats.skipped++;continue}
  if(!await prepare(p,false))continue;
  const asset=assetByUrl.get(p.asset_url)||{url:p.asset_url,title:p.asset_title||site.domain,type:p.kind==='mention'?'brand':'resource',description:''};
  const pitch=await writer.write(p,asset,site);p.writer=pitch.writer;
  try{await deliver(p,pitch,'initial');state.contacted[p.domain]=NOW();if(config.mode==='send')state.first_send_at??=NOW();
   p.status=config.mode==='send'?'sent':'drafted';p.next_link_check=new Date(Date.now()+5*DAY).toISOString();
   config.mode==='send'?stats.sent++:stats.drafted++;budget--;perAsset.set(p.asset_url,(perAsset.get(p.asset_url)||0)+1);if(config.mode==='send')await sleep(config.gapMs());
  }catch{p.status='delivery_uncertain';p.no_followup=true;state.contacted[p.domain]=NOW();log('delivery uncertain; recipient held without retry');break}
 }
 log(`outreach: ${stats.sent} sent, ${stats.followups} follow-ups, ${stats.drafted} drafts, ${stats.verification_held} held for verification`);return stats;
}
/** Existing link checking is unchanged; attribution hardening remains in PR 25. */
export async function checkLinks({state,ourDomains,fetchImpl=fetch,max=60,deadline=Infinity,log=()=>{}}){
 const stats={checked:0,won:0,lost:0};
 const due=Object.values(state.prospects||{}).filter(p=>{
  if(p.status==='won')return ageDays(p.won?.checked_at)>14;
  const first=(p.history||[]).find(h=>h.type==='initial');
  return first&&ageDays(first.at)<150&&!['declined','bounced'].includes(p.status)&&(!p.next_link_check||p.next_link_check<=NOW());
 }).slice(0,max);
 for(const p of due){if(Date.now()>deadline)break;
  const res=await fetchPage(p.page_url,{fetchImpl,timeout:12000,maxBytes:800000});stats.checked++;p.next_link_check=new Date(Date.now()+4*DAY).toISOString();if(res.status!==200)continue;
  const hit=links(res.body,res.url).find(l=>ourDomains.some(d=>sameSite(hostOf(l.url),d)));
  if(hit){if(p.status!=='won'){stats.won++;p.history.push({type:'won',at:NOW(),url:hit.url})}p.status='won';p.won={target:hit.url,anchor:hit.anchor,rel:hit.rel||'follow',found_at:p.won?.found_at||NOW(),checked_at:NOW()}}
  else if(p.status==='won'){stats.lost++;p.status='lost';p.history.push({type:'lost',at:NOW()})}
 }
 log(`link checks: ${stats.checked} pages, ${stats.won} new links won, ${stats.lost} lost`);return stats;
}
/** A second guard at the real SMTP boundary prevents missing-proof sends. */
export function gmailTransport(env){
 if(!env.GMAIL_ADDRESS||!env.GMAIL_APP_PASSWORD)return null;
 const user=env.GMAIL_ADDRESS,pass=env.GMAIL_APP_PASSWORD.replace(/\s+/g,'');let imap=null;
 const getImap=async()=>imap||(imap=await new Imap({user,pass}).open());
 const verifiers=new WeakMap();
 return {
  authorizeRecipient:async(p,{state,followup,deadline})=>{
   if(!verifiers.has(state))verifiers.set(state,new RecipientVerifier({state,fetchPage,env}));
   return verifiers.get(state).verify(p,{followup,deadline});
  },
  send:async({to,raw,recipientProof:p})=>{
   if(!usableVerification(p?.verification,to)||p?.email!==normalizeEmail(to)||!samePublisher(p?.evidence?.source,p?.publisher_domain))throw Error('SMTP blocked: verified recipient evidence required');
   return smtpSend({user,pass,from:user,to,raw});
  },
  draft:async raw=>(await getImap()).appendDraft(raw),imap:{recentHeaders:async(...a)=>(await getImap()).recentHeaders(...a)},
  check:async()=>{try{await getImap();await imap.close();imap=null;return {status:'connected'}}catch{return {status:'rejected',error:'Gmail login or connection failed; outgoing mail blocked'}}},
  close:async()=>{if(imap)await imap.close()}
 };
}
