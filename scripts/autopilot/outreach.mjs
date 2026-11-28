/** Outreach state machine with mandatory recipient preflight and reply-health gate. */
import {createHash} from 'node:crypto';
import {buildMessage,newMessageId,smtpSend,Imap,classifyReply,replyCondition,replyText,isQuestion,optOutSubject,lfIds,baseSubject} from './mail.mjs';
import {readSent,publisherDomain} from './rebuild.mjs';
import {followupPitch,reSubject} from './pitch.mjs';
import {fetchPage,links,hostOf,sameSite,ageDays,NOW,sleep,DAY,pool} from './util.mjs';
import {QUALIFY_VERSION} from './prospect.mjs';
import {assetStats,linkLikelihood} from './learn.mjs';
import {RecipientVerifier,isSuppressed,usableVerification,samePublisher,normalizeEmail,verifyPassRate} from './recipient-policy.mjs';
import {checkDead} from './broken.mjs';
import {normUrl as normUrlKey} from './util.mjs';
export const PER_ASSET_DAILY=2;
// Recipient regions: [TLD pattern, weekday window as UTC hours [from,to), UTC offset in hours]. The offset decides the
// recipient's own weekday, and places the Saturday-morning window in their local time.
const REGIONS=[
 [/\.(uk|ie|de|fr|es|it|nl|be|pt|gr|se|no|dk|fi|pl|cz|at|ch|eu|za|ro|hu|sk|si|hr|bg|lt|lv|ee|lu|cy|mt)$/,[7,16],1],
 [/\.(au|nz)$/,[21,6],10],[/\.in$/,[3,12],5],[/\.(jp|sg|my|ph|hk|kr|cn|id|th|vn|tw)$/,[0,9],8]
];
const DEFAULT_REGION=[null,[13,21],-5];
/** Saturday morning in the recipient's local time, [from,to) hours: EU 08-12 UTC, US (default) 14-18 UTC. Sunday never sends. */
export const SATURDAY_HOURS=[9,13];
const SEND_POLICY={saturday:true};
/**
 * Which days send (run.mjs sets it once per cycle from the owner's SATURDAY_SENDS setting; tests reset it).
 * Saturday mornings are on unless `saturday` is exactly false. Returns the policy now in force.
 */
export function setSendPolicy({saturday=true}={}){SEND_POLICY.saturday=saturday!==false;return {...SEND_POLICY}}
export const sendPolicy=()=>({...SEND_POLICY});
export function sendWindowOpen(domain,now=new Date()){
 const [,[from,to],offset]=REGIONS.find(([re])=>re.test(domain))||DEFAULT_REGION;
 const h=now.getUTCHours(),local=new Date(now.getTime()+offset*36e5),d=local.getUTCDay();
 if(d===6)return SEND_POLICY.saturday&&local.getUTCHours()>=SATURDAY_HOURS[0]&&local.getUTCHours()<SATURDAY_HOURS[1];
 return d!==0&&(from<to?h>=from&&h<to:h>=from||h<to);
}
export function nextSendWindow(domain,from=new Date()){
 if(sendWindowOpen(domain,from))return new Date(from);
 const t=new Date(from);t.setUTCMinutes(0,0,0);
 for(let h=0;h<24*8;h++){t.setUTCHours(t.getUTCHours()+1);if(sendWindowOpen(domain,t))return new Date(t)}return null;
}
export function dailyCap(state,limit){
 const cap=Math.max(0,Math.floor(Number(limit)||0)),start=state.ramp_started_at||state.first_send_at;
 return Math.min(cap,5+2*Math.max(0,Math.floor(start?ageDays(start):0)));
}
/** Newest real (non-draft) send, or null. */
export const lastSendAt=state=>Object.values(state.prospects||{}).flatMap(p=>(p.history||[]).filter(h=>['initial','followup'].includes(h.type)&&h.mode!=='draft').map(h=>h.at)).sort().pop()||null;
/** After a week without sending, the warm-up ramp starts again at 5/day: a sudden burst from a quiet inbox hurts deliverability. */
export function restartRampIfIdle(state,days=7){
 const last=lastSendAt(state);if(!last||ageDays(last)>days)state.ramp_started_at=NOW();
}
export const sentToday=state=>Object.values(state.prospects||{}).reduce((n,p)=>n+(p.history||[]).filter(h=>['initial','followup'].includes(h.type)&&h.mode!=='draft'&&String(h.at).startsWith(NOW().slice(0,10))).length,0);
const draftedToday=state=>Object.values(state.prospects||{}).reduce((n,p)=>n+(p.history||[]).filter(h=>h.mode==='draft'&&String(h.at).startsWith(NOW().slice(0,10))).length,0);
export const suppressed=isSuppressed;
/** Wilson 95% interval [low, high] for k successes in n trials (null without trials). */
export function wilson(k,n,z=1.96){
 if(!(n>0))return null;const p=Math.min(1,Math.max(0,k/n)),d=1+z*z/n,c=p+z*z/(2*n),m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n));
 return [Number(Math.max(0,(c-m)/d).toFixed(3)),Number(Math.min(1,(c+m)/d).toFixed(3))];
}
/** ISO 8601 week of a timestamp, e.g. "2026-W48" (null when unparseable). */
export function isoWeek(t){
 const d=new Date(t);if(!Number.isFinite(d.getTime()))return null;
 d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()+3-(d.getUTCDay()+6)%7); // the Thursday of that week decides the year
 const y=d.getUTCFullYear();return `${y}-W${String(1+Math.floor((d-Date.UTC(y,0,1))/(7*DAY))).padStart(2,'0')}`;
}
/**
 * Results per writer, per message variant and per send week (counts only, keys are code names or ISO weeks). Every
 * real send counts once; a publisher's first reply is credited to the message it answered (reply.in_reply_to), else to
 * that publisher's first pitch; positive = any positive reply (or status positive/won) from a publisher who replied.
 * Sends recorded before variants existed are 'unrecorded', and their follow-ups were always the fixed template.
 * exposure_days = days since that writer, variant or week first went out, so a young variant's wide interval reads as
 * "too early", not "worse". Rates are per message sent.
 */
export function sendStats(state,now=Date.now()){
 const DIMS=['writer','variant','week'],by={writer:{},variant:{},week:{}},key=s=>String(s).replace(/[^a-z0-9:_.-]/gi,'_').slice(0,60);
 const keyOf=h=>({writer:key(h.variant||h.type==='initial'?h.writer||'template':'template'),variant:key(h.variant||'unrecorded'),week:isoWeek(h.at)||'unknown'});
 const row=(dim,k)=>by[dim][k]??={sent:0,replied:0,positive:0,first_at:null};
 for(const p of Object.values(state.prospects||{})){
  const sends=(p.history||[]).filter(h=>(h.type==='initial'||h.type==='followup')&&h.mode!=='draft');if(!sends.length)continue;
  for(const h of sends){const k=keyOf(h);for(const dim of DIMS){const r=row(dim,k[dim]);r.sent++;if(h.at&&(!r.first_at||h.at<r.first_at))r.first_at=h.at}}
  const replies=(p.history||[]).filter(h=>h.type==='reply');if(!replies.length&&!p.replied_at)continue;
  const first=replies[0],answered=(first?.in_reply_to&&sends.find(h=>h.message_id===first.in_reply_to))||sends.find(h=>h.type==='initial')||sends[0];
  const k=keyOf(answered),positive=replies.some(h=>h.sentiment==='positive')||['positive','won'].includes(p.status);
  for(const dim of DIMS){const r=row(dim,k[dim]);r.replied++;if(positive)r.positive++}
 }
 const fmt=([k,r])=>[k,{sent:r.sent,replied:r.replied,positive:r.positive,reply_rate:Number((r.replied/r.sent).toFixed(3)),reply_ci95:wilson(r.replied,r.sent),
  exposure_days:r.first_at?Math.max(0,Math.floor((now-Date.parse(r.first_at))/DAY)):null}];
 const top=m=>Object.fromEntries(Object.entries(m).sort((a,b)=>b[1].sent-a[1].sent).slice(0,20).map(fmt));
 return {by_writer:top(by.writer),by_variant:top(by.variant),by_week:Object.fromEntries(Object.entries(by.week).sort((a,b)=>a[0].localeCompare(b[0])).slice(-12).map(fmt))};
}
/** Holds no wait can fix: the publisher's mail server accepts everything, the inbox is gone or has no usable MX. */
const PERMANENT_HOLD=/^(?:catch_all_domain|mailbox_accept_all|mailbox_invalid|suppressed|mx_(?:null_mx|no_explicit_mx|unusable_mx))$/;
export function outreachStatus(state,{limit,mode,qualifyVersion,now=new Date()}){
 const ready=Object.values(state.prospects||{}).filter(p=>p.status==='ready'&&p.email&&(p.qv||1)>=qualifyVersion);
 const cap=mode==='send'?dailyCap(state,limit):limit,sent=sentToday(state);
 const from=sent>=cap?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)):now;
 const next=ready.map(p=>nextSendWindow(p.domain,from)).filter(Boolean).sort((a,b)=>a-b)[0]||null;
 const isVerified=p=>usableVerification(p.recipient_proof?.verification,p.email)&&!suppressed(state,p.email,p.domain);
 const verified=ready.filter(isVerified);
 // Why queued inboxes are held, by reason only (no addresses): drives the dashboard and self-diagnosis.
 // Our-side holds older than the verifier's latest successful answer are stale (e.g. a login that has since been fixed).
 const fixedAt=state.verifier_balance&&!state.verifier_balance.error?Date.parse(state.verifier_balance.checked_at):0;
 const holds={};for(const p of ready)if(p.contact_quality?.status==='held'){const k=p.contact_quality.detail||p.contact_quality.reason||'unknown';
  if(!publisherHold(k)&&Date.parse(p.contact_quality.checked_at)<fixedAt)continue;holds[k]=(holds[k]||0)+1}
 // The ready queue split by what can happen next (counts only): sendable now (verified, or free to be verified this cycle),
 // waiting for a publisher-side re-check or a cached answer to expire, or held for good (catch-all, invalid, no MX,
 // suppressed, or the publisher was emailed in the last 90 days).
 const split={sendable_now:0,retry_later:0,held_permanent:0};let toVerify=0;
 for(const p of ready){
  const q=p.contact_quality,d=q?.status==='held'?q.detail||q.reason||'':'';
  if(suppressed(state,p.email,p.domain)||(state.contacted?.[p.domain]&&ageDays(state.contacted[p.domain])<90)||PERMANENT_HOLD.test(d))split.held_permanent++;
  else if(isVerified(p))split.sendable_now++;
  else if(d&&(coolingDown(p,now.getTime())||publisherHold(d)&&ageDays(q.checked_at)<3))split.retry_later++;
  else{split.sendable_now++;toVerify++}
 }
 // Prospects the free screening retired, by the exact reason (counts only), so parser gaps show up as numbers.
 const retired={};for(const p of Object.values(state.prospects||{}))if(p.status==='contact_unverifiable'){const k=String(p.contact_quality?.detail||'unrecorded').replace(/[^a-z0-9:_-]/gi,'_').slice(0,60);retired[k]=(retired[k]||0)+1}
 return {mode,ready:ready.length,verified_ready:verified.length,pending_verification:ready.length-verified.length,holds,
  ...split,to_verify:toVerify,retired_by_reason:retired,...sendStats(state,now.getTime()),
  sent_today:sent,cap_today:cap,next_send_at:mode==='off'?null:next?.toISOString()||null,
  sending_now:mode==='send'&&sent<cap&&verified.some(p=>sendWindowOpen(p.domain,now)),reply_health:state.reply_health?.status||'unverified'};
}
/** A later message can raise, never lower, how far a conversation got: declined (opt-out) > won/lost > positive > replied. */
const SETTLED=new Set(['positive','won','lost','declined']);
// Which condition matters most when a publisher raises more than one: a fee always needs the owner's explicit approval.
const CONDITION_RANK={guest_post:1,reciprocal:2,paid:3};
/** An opt-out: declined, no follow-up, and the publisher domain plus every address involved suppressed for good. */
export function applyOptOut(state,p,from){
 state.suppression??={};const at=NOW();
 p.status='declined';p.awaiting_us=false;p.no_followup=true;
 if(p.domain)state.suppression[p.domain]={reason:'Opt-out',at};
 for(const e of new Set([p.email,from].map(x=>normalizeEmail(String(x||'').toLowerCase())).filter(Boolean)))state.suppression[e]={reason:'Opt-out',at};
 // The publisher closed the conversation: nothing is left for the owner to decide (the flag itself stays).
 if(p.needs_owner&&!p.owner_decided_at){p.owner_decided_at=at;p.owner_decision='closed_by_opt_out'}
 // A 3-way exchange they had not linked for yet is off (one whose link is already live is still owed to them).
 if(['offered','accepted'].includes(p.exchange?.status)){p.exchange.status='declined';p.exchange.declined_at=at}
 delete p.exchange_draft;
}
/**
 * A condition (fee, link back, guest post) raises the owner flag; the strongest one is kept. `at`: when the message was
 * received, so a decision the owner already made after it is not re-opened. Returns whether the flag is (re)opened.
 */
export function noteCondition(p,condition,{at=null}={}){
 if((CONDITION_RANK[condition]||0)>(CONDITION_RANK[p.condition]||0))p.condition=condition;
 if(at&&Date.parse(p.owner_decided_at)>=Date.parse(at))return false;
 p.needs_owner=true;delete p.owner_decided_at;delete p.owner_decision;return true;
}
import {replyConditions,exchangeIntent} from './mail.mjs';
/** 3-way exchange states in which our offer still stands: a reply about the link back is about this offer. */
const EXCHANGE_OPEN=new Set(['offered','accepted','their_link_live']);
/**
 * An exchange offer from an answer draft (replies.mjs, kind exchange_offer) counts as offered only once the owner has
 * sent that draft: their reply to its id, or its id in the Sent folder. Never when another exchange is on record.
 * Sending it is the owner's answer to the link-back request that draft answered.
 */
export function promoteExchangeDraft(p,at=NOW()){
 const d=p.exchange_draft;if(!d||p.exchange)return false;
 const {message_id,at:drafted,...offer}=d;p.exchange={...offer,status:'offered',offered_at:at,via:'email'};delete p.exchange_draft;
 settleLinkBack(p,'exchange_offer_sent',at);return true;
}
/** A pending owner flag raised only by a link-back request is settled once our own 3-way offer answers it (a fee or guest post is not). */
function settleLinkBack(p,decision,at=NOW()){if(p.needs_owner&&!p.owner_decided_at&&p.condition==='reciprocal'){p.owner_decided_at=at;p.owner_decision=decision}}
const ADDRESS=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const REPLY_SUBJECT=/^\s*(?:re|aw|sv|antw|fwd?|fw|wg|tr)\s*(?:\[\d+\])?\s*:/i;
/** When their message was written (Date header), never in the future; null when missing or implausible. */
function sentAt(m,now=Date.now()){const t=Date.parse(m?.date||'');return Number.isFinite(t)&&t>now-90*DAY?new Date(Math.min(t,now)).toISOString():null}
/**
 * Late replies from any contacted status, including won/lost, must still suppress.
 * Status only moves forward: a later neutral or question reply never turns a positive, won or lost conversation
 * back into "replied"; an opt-out always wins (declined + domain and address suppression). A condition and the
 * owner flag stay set once raised. Every new human reply that is not an opt-out marks the conversation as waiting
 * for our answer (awaiting_us) until the owner's own answer shows up in Sent (reconcileSent) or replies.mjs answers.
 *
 * 3-way exchange (p.exchange, offered by our email or contact-form message): a reply that accepts (a yes, or the link
 * back we offered ourselves: "sure, if you link back", "deal", "happy to swap") sets the exchange to accepted and the
 * conversation to positive, with no owner flag, since the owner approved these exchanges in advance. A fee, a guest post,
 * or a link back from the site they were pitched or from a site we did not offer still needs the owner (exchangeIntent).
 * An opt-out declines the exchange. A reply from an address at the domain of a prospect waiting in the contact-form queue
 * (status form_ready) is recorded on it when nothing else matches.
 */
export async function processReplies({state,imap,self='',log=()=>{}}){
 const stats={scanned:0,replies:0,positive:0,negative:0,bounces:0,delays:0};
 state.suppression??={};state.contacted??={};state.seen_replies??={};
 state.reply_health={status:'checking',checked_at:NOW()};
 // Migrate old bounce records, including queues previously switched to alternate inboxes.
 for(const p of Object.values(state.prospects||{})){
  const failures=(p.history||[]).filter(h=>h.type==='bounce');if(!failures.length)continue;
  for(const h of failures)if(h.to)state.suppression[h.to.toLowerCase()]??={reason:'Historical delivery failure',at:h.at||NOW()};
  p.no_followup=true;state.contacted[p.domain]??=NOW();if(p.status==='ready')p.status='bounced';
 }
 // One-time repair: before status became monotonic, a later message overwrote a positive reply with "replied"
 // (2026-11-24/25), and no conversation was ever marked as waiting for an answer. Restore both from stored replies.
 state.migrations??={};
 if(!state.migrations.reply_status_v2){
  let restored=0,waiting=0;
  for(const p of Object.values(state.prospects||{})){
   const rs=(p.history||[]).filter(h=>h.type==='reply');if(!rs.length)continue;
   if(p.status==='replied'&&rs.some(h=>h.sentiment==='positive')){p.status='positive';p.next_link_check=NOW();restored++}
   const last=rs.at(-1);
   if(p.awaiting_us===undefined&&last.sentiment!=='negative'&&p.status!=='declined'&&ageDays(last.at)<30&&!suppressed(state,p.email,p.domain)){p.awaiting_us=true;p.last_reply_at??=last.at;waiting++}
  }
  state.migrations.reply_status_v2=NOW();
  if(restored||waiting)log(`repair: ${restored} positive replies restored after being overwritten, ${waiting} replies marked as waiting for an answer`);
 }
 // One-time repair: replies stored under the narrower rules (before 2026-11-27) are read again. "No" with a signature,
 // "please remove us", "we have never linked" and fee or swap wording the old patterns missed become what they are.
 if(!state.migrations.reply_class_v3){
  let optOuts=0,flagged=0;
  for(const p of Object.values(state.prospects||{}))for(const h of (p.history||[]).filter(h=>h.type==='reply'&&h.sentiment!=='negative')){
   const msg={from:h.from,subject:h.subject||'',body:h.excerpt||''},k=classifyReply(msg);
   if(k==='negative'){h.sentiment='negative';h.reread=true;applyOptOut(state,p,h.from);optOuts++;continue}
   if((k==='positive'||k==='neutral')&&k!==h.sentiment){h.sentiment=k;h.reread=true}
   if(!h.condition&&!h.exchange){const c=replyCondition(msg);if(c){h.condition=c;if(p.status!=='declined'&&noteCondition(p,c,{at:h.at}))flagged++}}
  }
  state.migrations.reply_class_v3=NOW();
  if(optOuts||flagged)log(`repair: ${optOuts} earlier replies re-read as opt-outs (suppressed), ${flagged} as replies with a condition (flagged for you)`);
 }
 const byMsg=new Map(),byEmail=new Map(),byDomain=new Map(),bySubject=new Map();
 for(const p of Object.values(state.prospects||{})){
  if(!(p.history||[]).some(h=>h.type==='initial'))continue;
  for(const h of p.history||[]){if(h.message_id&&h.type!=='reply')byMsg.set(h.message_id,p);if(h.to)byEmail.set(h.to.toLowerCase(),p)
   if(['initial','followup'].includes(h.type)&&h.subject){const k=baseSubject(h.subject);if(k.length>=8)(bySubject.get(k)||bySubject.set(k,new Set()).get(k)).add(p)}}
  if(p.email)byEmail.set(p.email.toLowerCase(),p);
  if(p.domain)(byDomain.get(p.domain)||byDomain.set(p.domain,[]).get(p.domain)).push(p);
 }
 const lastContact=p=>Math.max(0,...(p.history||[]).filter(h=>h.type==='initial'||h.type==='followup').map(h=>Date.parse(h.at)||0));
 // The contact-form queue (forms.mjs): nobody was emailed, so only the sender's domain can tie a reply to it.
 const byForm=new Map();
 for(const p of Object.values(state.prospects||{}))if(p.status==='form_ready'&&p.domain){const d=String(p.domain).toLowerCase().replace(/^www\./,'');(byForm.get(d)||byForm.set(d,[]).get(d)).push(p)}
 const formMatch=(from,m)=>{
  let h=String(from.split('@')[1]||'').toLowerCase().replace(/^www\./,'');const written=Date.parse(m.date||'');
  // An address at the prospect's domain (or a subdomain of it), written after the message was prepared; the newest first.
  for(;h.includes('.');h=h.slice(h.indexOf('.')+1)){
   const q=(byForm.get(h)||[]).filter(q=>!(Number.isFinite(written)&&Date.parse(q.form_message?.at)>written)).sort((a,b)=>(Date.parse(b.form_message?.at)||0)-(Date.parse(a.form_message?.at)||0))[0];
   if(q)return q;
  }
  return null;
 };
 const me=normalizeEmail(String(self||'').toLowerCase());
 let msgs;
 try{msgs=await imap.recentHeaders(new Date(Date.now()-35*DAY),{cursor:state.mail_cursor});if(!Array.isArray(msgs))throw Error('Invalid mailbox response')}
 catch(e){state.reply_health={status:'failed',checked_at:NOW()};throw e}
 stats.scanned=msgs.length;
 for(const m of msgs){
  // Our ids, most specific first: the message they answer, its thread, the List-Unsubscribe subject, then quoted text.
  const replyTo=lfIds(m.inReplyTo),refs=lfIds(m.references).reverse(),inSubject=lfIds(m.subject),ids=[...replyTo,...refs,...inSubject,...lfIds(m.body)];
  const from=String(m.from||'').toLowerCase();let p=ids.map(i=>byMsg.get(i)).find(Boolean)||byEmail.get(from);
  const kind=classifyReply(m);
  if(!p&&kind==='bounce'){for(const [e,q] of byEmail)if(String(m.body||'').toLowerCase().includes(e)){p=q;break}}
  // Not in our thread and not from an address we wrote to: a colleague at the publisher, or someone answering a forwarded copy.
  // An opt-out is tied to a publisher by any of: a pitched address quoted in it (the forwarded header), the sender's own
  // publisher domain (never a webmail domain), or our exact subject when only one publisher got it. Anything else is
  // tied only when it is about our email (our subject) and comes from that publisher or quotes its address.
  const fromDomain=publisherDomain(from),subject=baseSubject(m.subject);
  const bySubj=subject.length>=8?[...(bySubject.get(subject)||[])]:[];
  if(!p&&kind!=='bounce'&&kind!=='auto'){
   const quoted=[...new Set((String(m.body||'').match(ADDRESS)||[]).map(e=>e.toLowerCase()))].map(e=>byEmail.get(e)).filter(Boolean);
   const sameDomain=(fromDomain&&byDomain.get(fromDomain)||[]).slice().sort((a,b)=>lastContact(b)-lastContact(a));
   p=kind==='negative'?quoted[0]||sameDomain[0]||(bySubj.length===1?bySubj[0]:null):[...quoted,...sameDomain].find(q=>bySubj.includes(q))||null;
  }
  // Nothing else matched: an address at the domain of a publisher whose contact-form message is waiting for the owner.
  const viaForm=!p&&kind!=='bounce'&&kind!=='auto'&&!!(p=formMatch(from,m));
  const indirect=!!p&&!viaForm&&!ids.some(i=>byMsg.get(i)===p)&&byEmail.get(from)!==p&&kind!=='bounce';
  if(!p){
   // An opt-out we cannot tie to a prospect (forwarded inbox, state lost, an email sent before the vault was replaced):
   // never silently dropped when it answers our outreach. Counted (no addresses in logs); the sender's address is
   // suppressed, and so are the recipient and publisher an id restored from the Sent folder names, and a publisher
   // domain we are known to have emailed.
   if(kind==='negative'){
    const restored=ids.map(i=>state.restored_ids?.[i]).find(x=>x?.to);
    const contactedDomain=fromDomain&&state.contacted?.[fromDomain]?fromDomain:'';
    const ours=ids.length>0||optOutSubject(m.subject)||!!restored||bySubj.length>0||REPLY_SUBJECT.test(String(m.subject||''))||!!contactedDomain||(me&&String(m.body||'').toLowerCase().includes(me));
    if(ours){
     stats.unmatched_optouts=(stats.unmatched_optouts||0)+1;const at=NOW(),reason='Opt-out (not matched to a prospect)';
     for(const e of new Set([from,restored?.to].map(x=>normalizeEmail(String(x||'').toLowerCase())).filter(x=>x&&x!==me)))state.suppression[e]??={reason,at};
     for(const d of new Set([contactedDomain,publisherDomain(restored?.to||'')].filter(Boolean)))state.suppression[d]??={reason,at};
    }
   }
   continue;
  }
  if(kind==='auto')continue;
  const identity=m.messageId||createHash('sha256').update(JSON.stringify([from,m.subject,m.body,m.uid])).digest('hex');
  const key=p.id+'|'+identity;if(state.seen_replies[key])continue;
  if(indirect)stats.matched_indirectly=(stats.matched_indirectly||0)+1;
  if(viaForm)stats.form_replies=(stats.form_replies||0)+1;
  p.history??=[];
  if(kind==='bounce'){
   const delayed=/notification\s*\(delay\)|delivery (?:incomplete|delayed)|will retry|Action:\s*delayed|Status:\s*4\./i.test((m.subject||'')+'\n'+(m.body||''));
   const failed=(String(m.body||'').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)||[]).map(e=>e.toLowerCase()).find(e=>byEmail.get(e)===p)||p.email;
   p.history.push({type:delayed?'delivery_delay':'bounce',at:NOW(),to:failed});
   state.contacted[p.domain]??=NOW();
   // A delivery problem with a later email (an answer, a thank-you) never undoes a reply, a yes, a won link or a decline.
   if(!SETTLED.has(p.status)&&p.status!=='replied')p.status=delayed?'delivery_delayed':'bounced';p.no_followup=true;
   // Keep publisher deduplication intact. Do not try another person after any delivery failure.
   if(!delayed){stats.bounces++;if(failed)state.suppression[failed.toLowerCase()]={reason:'Delivery failure; re-contact prohibited',at:NOW()}}
   else stats.delays++;
  }else{
   stats.replies++;p.replied_at=NOW();p.no_followup=true;
   const negative=kind==='negative',conds=negative?[]:replyConditions(m),question=!negative&&isQuestion(m);
   const theirId=String(m.messageId||'').match(/<[^<>\s]+>/)?.[0]||null,answers=ids.find(i=>byMsg.get(i)===p)||null;
   if(negative&&inSubject.length&&byMsg.get(inSubject[0])===p)stats.unsubscribe_links=(stats.unsubscribe_links||0)+1;
   // An exchange offered in an answer draft: their reply to that draft shows the owner sent it.
   if(p.exchange_draft&&[...replyTo,...refs].includes(p.exchange_draft.message_id)&&promoteExchangeDraft(p))stats.exchange_offers_sent=(stats.exchange_offers_sent||0)+1;
   // How this reply answers a 3-way exchange we offered (null when none is open or it says nothing about it).
   const ex=!negative&&EXCHANGE_OPEN.has(p.exchange?.status)?p.exchange:null;
   const intent=ex?exchangeIntent(m,{offer:ex,site:p.site,domain:p.domain,sentiment:kind,question}):null;
   const mark=intent==='accept'?(ex.status==='offered'?'accepted':'agreed'):intent==='decline'?'declined':intent==='counter'||intent==='question'?intent:null;
   // The link back we offered ourselves is not a condition for the owner; a different one (from A, another site) is, and
   // so is a fee or a guest post raised alongside it (that one is kept: the link back was ours).
   const condition=(intent==='owner'?conds.find(c=>c!=='reciprocal'):conds[0])||(mark==='counter'?'reciprocal':null),owned=condition&&!['accepted','agreed','question','declined'].includes(mark);
   const written=sentAt(m);
   // Stored only in the encrypted vault: the dashboard shows what they asked for without opening Gmail.
   p.history.push({type:'reply',at:NOW(),...(written?{written_at:written}:{}),from,sentiment:kind,...(condition?{condition}:{}),...(mark?{exchange:mark}:{}),question,message_id:theirId,in_reply_to:answers,
    subject:String(m.subject||'').slice(0,140),excerpt:replyText(m).replace(/\s+/g,' ').slice(0,600)});
   if(!(Date.parse(p.last_reply_at)>=Date.parse(written||NOW())))p.last_reply_at=written||NOW();
   // A new condition re-opens the owner's decision even if an earlier one was already answered.
   if(owned){noteCondition(p,condition);stats.conditional=(stats.conditional||0)+1}
   if(mark==='accepted'){ex.status='accepted';ex.accepted_at=NOW();stats.exchange_accepted=(stats.exchange_accepted||0)+1;settleLinkBack(p,'exchange_accepted')}
   else if(mark==='counter')stats.exchange_counter=(stats.exchange_counter||0)+1;
   // They want nothing back: an exchange they have not linked for yet is off (a link already live stays owed).
   else if(mark==='declined'&&['offered','accepted'].includes(ex.status)){ex.status='declined';ex.declined_at=NOW();stats.exchange_declined=(stats.exchange_declined||0)+1}
   if(negative){stats.negative++;applyOptOut(state,p,from)}
   else{
    if(kind==='positive'||mark==='accepted'){if(kind==='positive')stats.positive++;if(!SETTLED.has(p.status))p.status='positive';if(p.status!=='declined')p.next_link_check=NOW()}
    else if(!SETTLED.has(p.status))p.status='replied';
    if(question)stats.questions=(stats.questions||0)+1;
    // A suppressed or declined conversation is never answered again, so it never waits for us either.
    p.awaiting_us=p.status!=='declined'&&!suppressed(state,p.email,p.domain);
   }
  }
  state.seen_replies[key]=NOW();
 }
 if(msgs.cursor)state.mail_cursor=msgs.cursor;
 state.reply_health={status:msgs.complete===false?'backlog':'ok',checked_at:NOW(),scanned:msgs.length};
 log(`replies: ${stats.scanned} scanned, ${stats.replies} replies, ${stats.bounces} failures, ${stats.delays} delays; ${state.reply_health.status}${stats.unmatched_optouts?`; ${stats.unmatched_optouts} opt-outs not matched to a prospect (sender suppressed)`:''}${stats.exchange_accepted?`; ${stats.exchange_accepted} 3-way exchanges accepted`:''}${stats.form_replies?`; ${stats.form_replies} replies to contact-form messages`:''}`);
 return stats;
}
/** Accept a recipient proof only if it is complete, current, first-party and unsuppressed; record the outcome on the prospect. */
export function applyProof(state,p,proof,{followup=false}={}){
 const e=normalizeEmail(proof?.email),valid=proof?.ok===true&&e&&usableVerification(proof.verification,e)&&
  samePublisher(proof.evidence?.source,p.domain)&&proof.evidence?.email===e&&
  Number.isFinite(Date.parse(proof.evidence?.observed_at))&&Date.now()-Date.parse(proof.evidence.observed_at)>=0&&Date.now()-Date.parse(proof.evidence.observed_at)<DAY;
 if(!valid||suppressed(state,e,p.domain)||(followup&&e!==normalizeEmail(p.email))){
  const detail=proof?.detail?String(proof.detail).slice(0,60):undefined,prev=p.contact_quality;
  p.contact_quality={status:'held',reason:proof?.reason||'recipient_not_verified',...(detail?{detail}:{}),checked_at:NOW(),
   ...(Date.parse(proof?.retry_after||'')>Date.now()?{retry_after:proof.retry_after}:{})};delete p.recipient_proof;
  // Two publisher-side failures in a row: this publisher has no verifiable editorial inbox. Retire it from the
  // ready queue (record kept) so each cycle's checks go to prospects that can actually be emailed. A catch-all server
  // can never give a positive answer (the recipient rules hold it for good), so a catch-all hold retires on the first strike.
  if(!followup&&p.status==='ready'&&(CATCH_ALL_HOLD.test(detail||'')||publisherHold(detail)&&prev?.status==='held'&&publisherHold(prev.detail))){p.status='contact_unverifiable';p.reason=`No verifiable editorial inbox (${detail})`}
  return false;
 }
 p.email=e;p.email_source=proof.evidence.source;p.email_rank=proof.evidence.rank;
 p.recipient_proof={...proof,publisher_domain:p.domain};p.contact_quality={status:'verified',checked_at:NOW()};return true;
}
/**
 * Holds caused by the publisher (no address, wrong inbox type, DNS, catch-all, invalid/unknown mailbox) wait 3 days.
 * Holds caused on our side (login, permissions, credits, provider outage, time budget) or with no recorded reason
 * are re-checked on the next run: fixing a login must not leave inboxes stuck for days.
 */
export const OUR_SIDE_HOLD=/^(?:mailbox_(?:verifalia_|verification_|verifier_|recently_inconclusive$|unknown_server$)|time_budget$|verification_error$|recipient_not_verified$|email_source_unreachable$)/;
export const publisherHold=detail=>!!detail&&!OUR_SIDE_HOLD.test(detail);
/** Holds that mean "this mail server accepts every address": no check can ever pass there. */
export const CATCH_ALL_HOLD=/^(?:mailbox_accept_all|catch_all_domain)$/;
import {POLICY_VERSION} from './recipient-policy.mjs';
/** Retirements decided by the address parser (not by a mailbox check): the only ones a parser improvement can change. */
const PARSER_RETIREMENT=new Set(['no_email_published','only_non_editorial_inbox_published','publisher_pages_unreachable','email_source_unreachable']);
const retiredDetail=p=>p.contact_quality?.detail||(String(p.reason||'').match(/\(([a-z_]+)\)$/)||[])[1]||'';
/**
 * Free queue screening (no verification credits): every ready prospect is checked against the strict,
 * first-party recipient rules once every 14 days. A publisher-side failure is held and screened again a day
 * later; two in a row retire the prospect from the ready queue. Passing prospects carry their best strictly
 * qualified address, so outreach's checks go only to sendable inboxes. After the address parser improves
 * (POLICY_VERSION), retired prospects that were never emailed get one free re-screen and return to 'ready' if they pass.
 */
export async function screenQueue({state,mailer,max=40,rescreenMax=30,deadline=Infinity,log=()=>{}}){
 const stats={screened:0,kept:0,held:0,retired:0,address_updated:0,rescreened:0,recovered:0};
 if(typeof mailer?.screenRecipient!=='function')return stats;
 const due=Object.values(state.prospects||{}).filter(p=>p.status==='ready'&&p.email&&ageDays(p.screened_at)>(p.screen_strike?1:14)&&!suppressed(state,p.email,p.domain))
  .sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,max);
 // Our side (pages that did not load, an unreachable address source) is never held against the publisher: retried next cycle.
 const theirs=r=>publisherHold(r?.detail)&&r.detail!=='publisher_pages_unreachable';
 const byReason=(k,detail)=>{stats[k]??={};stats[k][detail]=(stats[k][detail]||0)+1};
 await pool(due,4,async p=>{
  if(Date.now()>deadline)return;
  let r;try{r=await mailer.screenRecipient(p,{state,deadline})}catch{return}
  stats.screened++;
  if(r?.ok){stats.kept++;p.screened_at=NOW();delete p.screen_strike;if(p.contact_quality?.via==='screen')delete p.contact_quality;
   const e=normalizeEmail(r.email);if(e&&e!==normalizeEmail(p.email)){p.email=e;p.email_source=r.evidence?.source;p.email_rank=r.evidence?.rank;stats.address_updated++}}
  else if(theirs(r)){
   p.screened_at=NOW();p.contact_quality={status:'held',reason:r.reason,detail:r.detail,checked_at:NOW(),via:'screen'};
   if(p.screen_strike){p.status='contact_unverifiable';p.reason=`No verifiable editorial inbox (${r.detail})`;delete p.screen_strike;stats.retired++;byReason('retired_by',r.detail)}
   else{p.screen_strike={detail:r.detail,at:NOW()};stats.held++}
  }
 });
 const retired=Object.values(state.prospects||{}).filter(p=>p.status==='contact_unverifiable'&&(p.screen_v||1)<POLICY_VERSION&&p.page_url&&PARSER_RETIREMENT.has(retiredDetail(p))&&
   !(p.history||[]).some(h=>h.type==='initial'||h.type==='followup')&&!state.contacted?.[p.domain]&&!suppressed(state,p.email,p.domain))
  .sort((a,b)=>(b.score||0)-(a.score||0)).slice(0,Math.max(0,rescreenMax));
 await pool(retired,4,async p=>{
  if(Date.now()>deadline)return;
  let r;try{r=await mailer.screenRecipient(p,{state,deadline})}catch{return}
  stats.rescreened++;
  const e=r?.ok?normalizeEmail(r.email):'';
  if(e&&!suppressed(state,e,p.domain)){
   Object.assign(p,{status:'ready',email:e,email_source:r.evidence?.source,email_rank:r.evidence?.rank,screened_at:NOW(),screen_v:POLICY_VERSION,recovered_at:NOW()});
   delete p.reason;delete p.contact_quality;delete p.screen_strike;stats.recovered++;return;
  }
  // An unreachable publisher gets two more tries in later cycles before this parser version is settled for it.
  if(!theirs(r)&&(p.rescreen_tries=(p.rescreen_tries||0)+1)<3)return;
  p.screen_v=POLICY_VERSION;delete p.rescreen_tries;
 });
 log(`queue screening (free, nothing sent): ${stats.screened} checked, ${stats.kept} sendable, ${stats.held} held for a second look, ${stats.retired} retired, ${stats.address_updated} switched to a better published address`+
  (stats.rescreened?`; ${stats.rescreened} retired prospects re-screened under the improved address rules, ${stats.recovered} back in the queue`:''));
 return stats;
}
/**
 * Make the Sent folder the ground truth for "already emailed". A prospect whose address is in Sent but whose
 * record has no pitch (state lost or overwritten, as on 2026-11-25 when two cycles overlapped) is marked as
 * contacted so it is never pitched again; anyone who received two emails within a day gets no further email.
 * It also notices the owner's own answers: mail to a publisher who replied, sent after that reply and not by
 * Autopilot, means the owner has answered (awaiting_us cleared) and has decided any condition they raised. A 3-way
 * exchange offer Autopilot saved as an answer draft becomes an offer on record once that draft is in Sent.
 *
 * The whole contact window (90 days) is read, paging back past the newest 1000 messages; if it cannot be read in
 * full this throws, so the stage fails and nothing is sent. `index` (a Map, optional) receives every recipient
 * address with its newest send time, so the send step can check an address chosen after this ran (in memory only).
 */
export async function reconcileSent({state,imap,days=90,index=null,now=()=>Date.now(),deadline=Infinity,log=()=>{}}){
 // Published: outreach counts only. How much mail the owner's account sent (the 90 days read) is not published.
 const stats={restored:0,duplicates:0};
 // Until this cycle's check succeeds, an earlier cycle's timestamp must not pass for a current one (automatic answers read it).
 delete state.sent_reconciled_at;
 if(typeof imap?.sentRecipients!=='function')return stats;
 const since=new Date(now()-days*DAY),{sent,complete,oldest}=await readSent(imap,since,{now,deadline,pages:10,pageSize:1000});
 if(!Array.isArray(sent))throw Error('Invalid Sent mailbox response');
 if(!complete&&!(oldest<=since.getTime()+DAY))throw Error(`the Sent folder could not be read back ${days} days in full, so nothing is sent this cycle`);
 state.contacted??={};
 if(index instanceof Map)for(const m of sent){const e=normalizeEmail(String(m?.to||'').toLowerCase()),t=Date.parse(m?.at);if(e&&Number.isFinite(t)&&!(index.get(e)>=t))index.set(e,t)}
 const byTo=new Map(),ownBy=new Map();
 // An answer Autopilot saved in Gmail Drafts carries our <lf-...> id: if the owner sends that draft and Gmail keeps the id,
 // it is still the owner's answer.
 const draftIds=new Set(Object.values(state.prospects||{}).flatMap(p=>(p.history||[]).filter(h=>h.type==='answer'&&h.via==='draft'&&h.message_id).map(h=>h.message_id)));
 for(const m of sent){const e=normalizeEmail(m.to);if(!e)continue;(byTo.get(e)||byTo.set(e,[]).get(e)).push(Date.parse(m.at)||Date.now());
  // Only mail with a real Date, and without one of our own <lf-...> ids (unless it is a draft we saved for the owner), can be the owner's answer.
  const t=Date.parse(m.at),id=String(m.message_id||m.messageId||'');if(Number.isFinite(t)&&(!/<lf-/.test(id)||draftIds.has(id.match(/<lf-[^>]+>/)?.[0])))(ownBy.get(e)||ownBy.set(e,[]).get(e)).push(t)}
 // An exchange offer saved as an answer draft is on record once the owner has sent that draft (its id is in Sent).
 const sentById=new Map();for(const m of sent){const id=String(m?.message_id||m?.messageId||'').match(/<lf-[^>]+>/)?.[0],t=Date.parse(m?.at);if(id&&Number.isFinite(t))sentById.set(id,t)}
 let answered=0;
 for(const p of Object.values(state.prospects||{})){
  const offerSent=sentById.get(p.exchange_draft?.message_id);
  if(offerSent&&promoteExchangeDraft(p,new Date(offerSent).toISOString()))stats.exchange_offers_sent=(stats.exchange_offers_sent||0)+1;
  const addrs=new Set([p.email,...(p.history||[]).map(h=>h.to)].map(x=>normalizeEmail(x||'')).filter(Boolean));
  if(p.awaiting_us&&Date.parse(p.last_reply_at)){
   // Mail Autopilot sent itself (pitches, follow-ups, automatic answers) is in the history: it is not the owner's answer.
   const ours=(p.history||[]).filter(h=>h.to&&(['initial','followup'].includes(h.type)?h.mode!=='draft':h.via==='send')).map(h=>[normalizeEmail(h.to),Date.parse(h.at)]);
   const people=new Set([...addrs,...(p.history||[]).filter(h=>h.type==='reply').map(h=>normalizeEmail(h.from||''))].filter(Boolean));
   const after=Date.parse(p.last_reply_at);
   const hit=[...people].flatMap(e=>(ownBy.get(e)||[]).map(t=>[e,t])).find(([e,t])=>t>after&&!ours.some(([oe,ot])=>oe===e&&Math.abs(ot-t)<15*60e3));
   if(hit){p.awaiting_us=false;p.owner_answered_at=new Date(hit[1]).toISOString();if(p.needs_owner&&!p.owner_decided_at){p.owner_decided_at=NOW();p.owner_decision='answered_in_gmail'}answered++}
  }
  const times=[...addrs].flatMap(e=>byTo.get(e)||[]).sort((a,b)=>a-b);if(!times.length)continue;
  const first=new Date(times[0]).toISOString(),last=new Date(times.at(-1)).toISOString();
  if(!(p.history||[]).some(h=>h.type==='initial'&&h.mode!=='draft')){
   (p.history??=[]).push({type:'initial',at:first,to:normalizeEmail(p.email||'')||[...addrs][0],mode:'send',reconciled:true});
   if(['ready','drafted','contact_form','no_contact'].includes(p.status))p.status='sent';
   p.next_link_check??=new Date(times[0]+5*DAY).toISOString();stats.restored++;
  }
  if(!(Date.parse(state.contacted[p.domain])>=times.at(-1)))state.contacted[p.domain]=last;
  // Two emails less than a day apart is never intended (a follow-up comes days later): do not write to them again.
  // The hold applies to every pair; a pair sent after the publisher replied (the owner's or an automatic answer) is a
  // conversation, so it is counted apart from accidental duplicates.
  if(times.some((t,i)=>i>0&&t-times[i-1]<DAY)&&!p.duplicate_sent){
   p.duplicate_sent=true;p.no_followup=true;
   const firstReply=(p.history||[]).find(h=>h.type==='reply'),replied=Date.parse(firstReply?.written_at||firstReply?.at||'');
   const cold=Number.isFinite(replied)?times.filter(t=>t<replied):times;
   if(cold.some((t,i)=>i>0&&t-cold[i-1]<DAY)){p.no_followup_reason='Received a duplicate email';stats.duplicates++}
   else{p.no_followup_reason??='Two emails within a day in a conversation';stats.conversation_pairs=(stats.conversation_pairs||0)+1}
  }
 }
 if(answered)stats.owner_answered=answered;
 state.sent_reconciled_at=NOW();
 log(`sent-folder check (last ${days} days, complete): ${stats.restored} unrecorded pitches restored to the record, ${stats.duplicates} recipients found with a duplicate email (no further email to them)${answered?`, ${answered} replies answered by you in Gmail`:''}`);
 return stats;
}
const NO_CREDITS=/credits_used_up|budget_exhausted/;
/** The verifier already holds an inconclusive answer for this inbox that cannot change yet: asking again only wastes a slot. */
export const coolingDown=(p,now=Date.now())=>p.contact_quality?.status==='held'&&Date.parse(p.contact_quality.retry_after||'')>now;
/** A publisher-side hold (screen or mailbox check) waits 3 days: the same pages and mailbox give the same answer before then. */
export const heldByPublisher=(p,now=Date.now())=>p.contact_quality?.status==='held'&&publisherHold(p.contact_quality.detail)&&now-Date.parse(p.contact_quality.checked_at)<3*DAY;
/**
 * Every address already emailed, with its newest send (ms): pitches, follow-ups and automatic answers on record, the
 * addresses restored from the Sent folder after a vault reset (state.restored_sent), and this cycle's Sent-folder read
 * (`sentIndex`). One person who publishes the same address on two sites is still one person.
 */
export function emailedAddresses(state,{sentIndex=null}={}){
 const out=new Map(),mark=(e,t)=>{e=normalizeEmail(String(e||'').toLowerCase());const ms=typeof t==='number'?t:Date.parse(t);if(e&&Number.isFinite(ms)&&!(out.get(e)>=ms))out.set(e,ms)};
 for(const p of Object.values(state.prospects||{}))for(const h of p.history||[])if(((h.type==='initial'||h.type==='followup')&&h.mode!=='draft')||(h.type==='answer'&&h.via==='send'))mark(h.to,h.at);
 for(const [e,t] of Object.entries(state.restored_sent||{}))mark(e,t);
 if(sentIndex instanceof Map)for(const [e,t] of sentIndex)mark(e,t);
 return out;
}
/** When this address was last emailed (ms) if that was within the 90-day contact window, else 0. */
export const emailedWithin=(emailed,e,now=Date.now())=>{const t=emailed.get(normalizeEmail(String(e||'').toLowerCase()));return Number.isFinite(t)&&now-t<90*DAY?t:0};
/**
 * The pitched page's search demand when its first email goes out (counts only, from the demand data the cycle already
 * fetched): the "before" value that traffic around a won link is later compared with. Recorded once per page.
 */
export function noteBaseline(state,url,demand){
 const k=normUrlKey(url),d=k&&demand?.[k];if(!d||state.asset_baseline?.[k])return false;
 const pick=Object.fromEntries(['impressions','clicks','position','etv','keywords','striking','top3'].filter(f=>d[f]!==null&&d[f]!==''&&Number.isFinite(Number(d[f]))).map(f=>[f,Number(d[f])]));
 if(!Object.keys(pick).length)return false;
 (state.asset_baseline??={})[k]={at:NOW(),source:d.source==='gsc'?'gsc':'dataforseo',...pick};return true;
}
/** Free DNS lookups: learn the mail-host class of queued inboxes (at most `max` per cycle, 30-day memory). */
export async function classifyQueue(state,mailer,list,{max=80}={}){
 if(typeof mailer?.mxClassOf!=='function')return 0;
 const due=list.filter(p=>p.email&&!(p.mx_class&&ageDays(p.mx_checked_at)<30)).slice(0,max);
 await pool(due,8,async p=>{const c=await mailer.mxClassOf(p,{state}).catch(()=>null);if(c){p.mx_class=c;p.mx_checked_at=NOW()}});
 return due.length;
}
/**
 * Expected value of spending one verification credit here: chance the inbox verifies x chance the pitch earns a link.
 * A recent weekend screen that found the mailbox deliverable makes a pass likely, so that inbox goes first in its window
 * (the screen itself is never a send proof: a fresh check is still bought).
 */
export const prescreened=(p,now=Date.now())=>p?.prescreen?.result==='valid'&&now-Date.parse(p.prescreen.at)<7*DAY;
export const creditValue=(state,p,likelihood,now=Date.now())=>likelihood*(prescreened(p,now)?Math.max(0.9,verifyPassRate(state,p.mx_class)):verifyPassRate(state,p.mx_class));
const utcDay=ms=>new Date(ms).toISOString().slice(0,10);
/**
 * Verify the best queued inboxes ahead of their send window (no email is sent). Runs every cycle on the day's free
 * credits, so a cycle inside the window can send at once instead of spending its time verifying. Only inboxes whose
 * window opens within `withinHours` are checked, so every proof is still under 24 h old when the email goes out.
 *
 * Order: due follow-ups first (only when follow-ups are sent; a re-check of an address that passed days ago is the best use of a credit), then new
 * prospects by expected value. A follow-up due later today, beyond the horizon, keeps a credit reserved. Checking stops
 * once fresh proofs plus reserved follow-ups fill each sending day's remaining capacity (cap minus sent that day): any
 * further proof would expire before it could be used.
 *
 * Saturday mornings are send windows (setSendPolicy), so Friday's and Saturday's credits back Saturday sends like any
 * weekday's; Sunday never sends, and its credits back Monday's windows from the moment those are within the horizon.
 *
 * When nothing can be sent before today's credits reset (no queued inbox's window opens within the horizon of any moment
 * before the reset: Saturday afternoon and evening once the last Saturday window has closed, or Friday night and all of
 * Saturday with Saturday sending off), the leftover credits screen the best queued inboxes instead: "invalid" and
 * catch-all retire the inbox, "valid" only raises its rank (p.prescreen); a screen is never a send proof. Sunday's credits
 * are never screened away: Monday's windows come within the horizon later that day.
 */
export async function preverify({state,mailer,max=5,withinHours=20,now=()=>new Date(),deadline=Infinity,followups=true,followupDays=6,cap=Infinity,drafts=false,sentIndex=null,log=()=>{}}){
 const stats={checked:0,verified:0,held:0},extra={followups_checked:0,followups_verified:0,reserved_for_followups:0,capacity_full:0,catch_all_retired:0,screened:0,prescreen_valid:0,prescreen_retired:0};
 if(typeof mailer?.authorizeRecipient!=='function')return stats;
 const t=now(),nowMs=t.getTime(),horizon=withinHours*36e5,today=utcDay(nowMs),all=Object.values(state.prospects||{});
 // Catch-all servers accept every address, so no check can ever pass there: such holds leave the queue at once.
 for(const p of all)if(p.status==='ready'&&p.contact_quality?.status==='held'&&CATCH_ALL_HOLD.test(p.contact_quality.detail||'')){
  p.status='contact_unverifiable';p.reason=`No verifiable editorial inbox (${p.contact_quality.detail})`;extra.catch_all_retired++}
 const learned=assetStats(state);
 const waiting=p=>heldByPublisher(p)|| // only publisher-side holds wait 3 days
  coolingDown(p,nowMs); // a cached "inconclusive" answer cannot change yet
 // An address already emailed (for another publisher, or before the vault was replaced) is never pitched again: no credit for it.
 const emailed=emailedAddresses(state,{sentIndex});
 const proofUntil=p=>usableVerification(p.recipient_proof?.verification,p.email)?Date.parse(p.recipient_proof.verification.expires_at):0; // proofs are judged on the real clock, as at send time
 // Due follow-ups: the first email went out and the follow-up is due by the time its send window opens.
 const fus=[];if(followups)for(const p of all){
  if(p.status!=='sent'||p.replied_at||p.no_followup||!p.email||(p.qv||1)<QUALIFY_VERSION||suppressed(state,p.email,p.domain))continue;
  // A follow-up only goes in the same thread: a pitch restored from the Sent folder (no message id) is never followed up.
  const initial=(p.history||[]).find(h=>h.type==='initial'&&h.mode!=='draft');if(!initial?.message_id)continue;
  const w=nextSendWindow(p.domain,new Date(Math.max(nowMs,(Date.parse(initial.at)||nowMs)+followupDays*DAY)));if(w)fus.push({p,w:w.getTime()});
 }
 const fresh=all.filter(p=>p.status==='ready'&&p.email&&(p.qv||1)>=QUALIFY_VERSION&&!suppressed(state,p.email,p.domain)&&!(state.contacted?.[p.domain]&&ageDays(state.contacted[p.domain])<90)&&!emailedWithin(emailed,p.email))
  .map(p=>({p,w:nextSendWindow(p.domain,t)?.getTime()})).filter(x=>x.w);
 const inH=x=>x.w-nowMs<=horizon; // a proof bought now must not expire before the window
 // Sending capacity per UTC day: cap minus what was already sent (in draft mode: drafted) that day, minus proofs and
 // reservations already covering it. A page gets at most PER_ASSET_DAILY first emails a day (runOutreach), so a proof for
 // a prospect whose page is already full that day would expire unused.
 const sentOn={},assetOn={},counts=h=>(h.type==='initial'||h.type==='followup')&&(drafts?h.mode==='draft':h.mode!=='draft');
 for(const p of all)for(const h of p.history||[])if(counts(h)){const d=String(h.at||'').slice(0,10);sentOn[d]=(sentOn[d]||0)+1;if(h.type==='initial'&&p.asset_url){const k=d+'|'+p.asset_url;assetOn[k]=(assetOn[k]||0)+1}}
 const capN=Number.isFinite(Number(cap))?Number(cap):Infinity,room={},left=d=>(room[d]??=Math.max(0,capN-(sentOn[d]||0))),take=d=>{room[d]=left(d)-1};
 const aRoom={},aLeft=(d,u)=>(aRoom[d+'|'+u]??=Math.max(0,PER_ASSET_DAILY-(assetOn[d+'|'+u]||0))),aTake=(d,u)=>{aRoom[d+'|'+u]=aLeft(d,u)-1};
 for(const x of fus)if(inH(x)&&proofUntil(x.p)>x.w)take(utcDay(x.w));
 for(const x of fresh)if(inH(x)&&proofUntil(x.p)>x.w){take(utcDay(x.w));aTake(utcDay(x.w),x.p.asset_url)}
 let reserved=0;for(const x of fus)if(!inH(x)&&utcDay(x.w)===today&&!proofUntil(x.p)&&!waiting(x.p)){reserved++;take(today)}
 // The window to plan for: the inbox's next window on a day that still has room (today's may already be full), within the horizon.
 const slot=x=>{let w=x.w;for(let i=0;i<2&&w&&left(utcDay(w))<=0;i++){const d=new Date(w);w=nextSendWindow(x.p.domain,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1)))?.getTime()}
  return w&&w-nowMs<=horizon&&left(utcDay(w))>0?w:null};
 extra.reserved_for_followups=reserved;
 const credits=typeof mailer.verifierCredits==='function'?async screen=>{try{const n=await mailer.verifierCredits({state,screen});return Number.isFinite(n)?n:Infinity}catch{return Infinity}}:async()=>Infinity;
 const ranked=async list=>{await classifyQueue(state,mailer,list.map(x=>x.p));
  return list.map(x=>({...x,v:creditValue(state,x.p,linkLikelihood(x.p,{assets:learned}),nowMs)})).sort((a,b)=>b.v-a.v)};
 const resetAt=Date.UTC(t.getUTCFullYear(),t.getUTCMonth(),t.getUTCDate()+1);
 // Today's credits can still back a send if a queued inbox's window comes within the horizon before they reset.
 const backable=x=>x.w-resetAt<horizon;
 let n=0;
 if([...fus,...fresh].some(backable)){
  // Credits are the scarce resource: follow-ups first, then where (chance to verify) x (chance of a link) is highest.
  const due=fus.filter(x=>inH(x)&&!proofUntil(x.p)&&!waiting(x.p)).sort((a,b)=>a.w-b.w);
  const queue=[...due.map(x=>({...x,followup:true})),...await ranked(fresh.filter(x=>inH(x)&&!proofUntil(x.p)&&!waiting(x.p)))];
  for(const x of queue){
   if(n>=max)break;
   const w=slot(x);if(!w){extra.capacity_full++;continue} // the sends it could go out with are already covered
   if(!x.followup&&aLeft(utcDay(w),x.p.asset_url)<=0){extra.asset_full=(extra.asset_full||0)+1;continue} // its page already has its first emails for that day
   if(!x.followup&&(await credits(false))-reserved<=0){stats.out_of_credits=true;break} // the rest is kept for follow-ups due later today
   // A single slow mail server can take ~2 minutes to verify: never start one without that much time left.
   if(deadline-Date.now()<150e3)break;n++;stats.checked++;if(x.followup)extra.followups_checked++;
   let proof;try{proof=await mailer.authorizeRecipient(x.p,{state,followup:!!x.followup,deadline})}catch{proof={ok:false,reason:'verification_error'}}
   // Out of credits for today: stop, and leave the remaining inboxes untouched instead of marking each one "held".
   if(!proof?.ok&&NO_CREDITS.test(`${proof?.reason||''} ${proof?.detail||''}`)){stats.checked--;if(x.followup)extra.followups_checked--;stats.out_of_credits=true;break}
   if(applyProof(state,x.p,proof,{followup:!!x.followup})){stats.verified++;if(x.followup)extra.followups_verified++;take(utcDay(w));if(!x.followup)aTake(utcDay(w),x.p.asset_url)}else stats.held++;
  }
 }else if(typeof mailer.prescreenRecipient==='function'){
  const list=await ranked(fresh.filter(x=>!proofUntil(x.p)&&!waiting(x.p)&&!(nowMs-Date.parse(x.p.prescreen?.at||'')<7*DAY)));
  for(const x of list){
   if(n>=max||deadline-Date.now()<150e3)break;
   if((await credits(true))<=0){stats.out_of_credits=true;break}
   n++;let r;try{r=await mailer.prescreenRecipient(x.p,{state,deadline})}catch{r=null}
   if(!r||r.ok)continue; // a screen never authorises anything
   if(NO_CREDITS.test(`${r.reason||''} ${r.detail||''}`)){stats.out_of_credits=true;break}
   if(!r.screened){applyProof(state,x.p,r);continue} // failed a free rule before any check (DE/AT/CH, no published inbox...): an ordinary hold
   if(/^(?:mailbox_(?:verifalia_|verification_|verifier_)|time_budget$|verification_error$)/.test(r.detail||''))continue; // no answer (our side): screen it again later
   extra.screened++;const at=NOW();x.p.prescreen={result:r.screened||'unknown',at};
   if(r.screened==='valid')extra.prescreen_valid++;
   else if(x.p.status==='ready'&&(r.screened==='invalid'||r.screened==='catch_all')){
    x.p.status='contact_unverifiable';x.p.reason=`No verifiable editorial inbox (${r.detail})`;x.p.contact_quality={status:'held',reason:'no_verified_mailbox',detail:r.detail,checked_at:at};extra.prescreen_retired++}
  }
 }
 for(const [k,v] of Object.entries(extra))if(v)stats[k]=v; // only what happened (keeps the published stage result small)
 log(`pre-verify (nothing sent): ${stats.checked} top inboxes checked${extra.followups_checked?` (${extra.followups_checked} due follow-ups first)`:''}, ${stats.verified} verified, ${stats.held} held`+
  `${reserved?`, ${reserved} credits kept for follow-ups due later today`:''}${extra.capacity_full?`, ${extra.capacity_full} skipped (the day's sends are already covered)`:''}${extra.asset_full?`, ${extra.asset_full} skipped (their page already has its first emails for that day)`:''}${extra.catch_all_retired?`, ${extra.catch_all_retired} catch-all holds retired`:''}`+
  `${extra.screened?`; no send window before the credits reset, so ${extra.screened} inboxes screened (${extra.prescreen_valid} deliverable, ${extra.prescreen_retired} retired; a screen is never a send proof)`:''}`);
 return stats;
}
/**
 * Footer under every email once a postal address is configured: who sends it and, in plain text, the site where
 * the recipient's address was published (no tracking pixel, no tracked link).
 */
export function emailFooter(postalAddress,source){
 const a=String(postalAddress||'').trim();if(!a)return '';
 let host='';try{host=new URL(source).hostname.replace(/^www\./,'')}catch{}
 return `\n\n${a}${host?`\nYou're receiving this because this address is published on ${host}.`:''}`;
}
const GMAIL_LIMIT=/\b5\.4\.5\b|sending (?:limit|quota)|daily user sending|\b4\.7\.\d{1,2}\b|too many (?:login attempts|messages|recipients)|rate limit/i;
const BEFORE_DATA=new Set(['precheck','connect','auth','mail_from','rcpt']);
/**
 * What a failed send means, from the SMTP stage it failed at (smtpSend tags err.stage and err.code). Nothing can
 * have been delivered before DATA; from DATA on, or when the stage is unknown, delivery is uncertain. Gmail
 * refusing the login or the sending quota ('block') stops sending for the rest of the cycle.
 */
export function sendFailure(e){
 const stage=typeof e?.stage==='string'?e.stage:null,code=typeof e?.code==='number'?e.code:null,text=String(e?.message||'');
 const block=code&&code>=400&&GMAIL_LIMIT.test(text)?'gmail_limit'
  :(stage==='auth'&&code>=500)||[530,534,535].includes(code)||/username and password not accepted|application-specific password required/i.test(text)?'gmail_auth':null;
 const uncertain=!BEFORE_DATA.has(stage);
 return {stage,code,block,uncertain,refused:stage==='rcpt'&&code>=500&&!block,retry_recipient:stage==='rcpt'&&code>=400&&code<500&&!block};
}
export async function runOutreach({state,assets,sites,writer,mailer,config,deadline=Infinity,log=()=>{}}){
 state.contacted??={};state.suppression??={};
 const stats={followups:0,sent:0,drafted:0,skipped:0,deferred:0,cap:0,verification_held:0};
 if(!['send','draft'].includes(config.mode))return stats;
 if(config.mode==='send')restartRampIfIdle(state);
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
  if(!proof?.ok&&NO_CREDITS.test(`${proof?.reason||''} ${proof?.detail||''}`)){checked=24;stats.out_of_credits=true;return false} // nothing more can be verified today
  if(!applyProof(state,p,proof,{followup})){stats.verification_held++;return false}
  return true;
 };
 // Which code version wrote each email, so replies can later be counted per writer and variant.
 const rev=config.rev||process.env.GITHUB_SHA?.slice(0,7)||'local';
 // Each site's pitches are signed with that site's sender name (SENDER_NAMES), else SENDER_NAME.
 const senderFor=p=>config.senderNames?.[String(p.site||'').toLowerCase()]||config.senderName;
 const deliver=async(p,pitch,type,{inReplyTo,senderName=config.senderName}={})=>{
  if(suppressed(state,p.email,p.domain)||(requiresProof&&!usableVerification(p.recipient_proof?.verification,p.email))){const e=Error('Recipient verification no longer valid');e.stage='precheck';throw e}
  const messageId=newMessageId(config.fromAddress.split('@')[1]),{subject,body}=pitch;
  // List-Unsubscribe marks mail as bulk: off unless the owner turns it on (LIST_UNSUBSCRIBE_HEADER=on). The body's closing
  // sentence (pitch.mjs OPT_OUT) is the opt-out either way.
  const raw=buildMessage({from:config.fromAddress,fromName:senderName,to:p.email,subject,text:body+emailFooter(config.postalAddress,p.email_source),messageId,inReplyTo,references:inReplyTo,unsubscribe:config.listUnsubscribe===true});
  const verified=usableVerification(p.recipient_proof?.verification,p.email),by=pitch.writer||'template';
  if(config.mode==='send'){stats.attempted=(stats.attempted||0)+1;await mailer.send({to:p.email,raw,recipientProof:p.recipient_proof})}else await mailer.draft(raw);
  p.history??=[];p.history.push({type,at:NOW(),message_id:messageId,subject,to:p.email,mode:config.mode,writer:by,
   variant:pitch.variant||`${by==='template'?'template':'ai'}:${type==='followup'?'followup':'pitch'}`,rev,verified,
   facts_used:Array.isArray(pitch.facts_used)?pitch.facts_used:[],sender_name:senderName||null,...(pitch.base_variant?{base_variant:pitch.base_variant}:{})});
  p.last_subject=subject;
 };
 /** Book a failed send. Returns true when nothing more may be sent this cycle. */
 const failed=(p,e,type)=>{
  const f=sendFailure(e);
  if(f.block)stats.send_blocked=f.block;
  if(f.uncertain){
   // The message may have gone out: hold the recipient for good, never retry automatically.
   p.status='delivery_uncertain';p.no_followup=true;if(type==='initial')state.contacted[p.domain]=NOW();
   log(type==='followup'?'follow-up held after uncertain delivery; no automatic retry':'delivery uncertain; recipient held without retry');
   if(f.block)log(`outreach: Gmail refused to send (${f.block==='gmail_auth'?'login rejected':'sending limit reached'}); nothing more is sent this cycle`);
   return true;
  }
  if(f.stage==='precheck'){stats.skipped++;return false}
  if(f.refused){
   // The mail server refused this mailbox before any message was transmitted: a bounce in all but name.
   const to=normalizeEmail(p.email);(p.history??=[]).push({type:'bounce',at:NOW(),to,stage:'rcpt',code:f.code});
   p.status='bounced';p.no_followup=true;if(to)state.suppression[to]={reason:'Mailbox refused by the mail server; re-contact prohibited',at:NOW()};
   state.contacted[p.domain]??=NOW(); // as with any delivery failure: no other person at this publisher is tried automatically
   stats.rcpt_refused=(stats.rcpt_refused||0)+1;log('a recipient mailbox was refused by the mail server before sending; treated as a bounce');return false;
  }
  // Nothing was transmitted: the prospect keeps its place (and its proof) for the next cycle.
  stats.not_sent=(stats.not_sent||0)+1;
  if(f.retry_recipient){log('the mail server deferred one recipient before sending; it is tried again next cycle');return false}
  log(f.block?`outreach: Gmail refused to send (${f.block==='gmail_auth'?'login rejected':'sending limit reached'}); nothing was delivered and nothing more is sent this cycle`
   :`outreach: the mail server failed before the message was transmitted (${f.stage||'unknown'} stage); nothing was delivered and nothing more is sent this cycle`);
  return true;
 };
 let fuChecks=0,stop=false;
 if(config.mode==='send')for(const p of Object.values(state.prospects||{})){
  if(stop||budget<=0||Date.now()>deadline||checked>=24)break;
  if(p.status!=='sent'||p.replied_at||p.no_followup||(p.qv||1)<QUALIFY_VERSION||suppressed(state,p.email,p.domain))continue;
  const initial=p.history.find(h=>h.type==='initial'&&h.mode!=='draft');if(!initial||ageDays(initial.at)<config.followupDays)continue;
  // A follow-up goes in the same thread. A pitch restored from the Sent folder has no message id to reply to.
  if(!initial.message_id){p.no_followup=true;p.no_followup_reason='Original email not on record, so it cannot be followed up in the same thread';stats.followups_unthreaded=(stats.followups_unthreaded||0)+1;continue}
  if(outOfHours(p)){stats.deferred++;continue}
  // Follow-ups get at most 8 of the run's 24 verification checks, so new pitches always get a turn.
  if(++fuChecks>8)break;
  if(!await prepare(p,true)){
   // The original address no longer passes the recipient rules (most were sent before they existed):
   // retire the follow-up for good instead of re-checking it every cycle.
   const d=p.contact_quality?.detail;
   if(publisherHold(d)&&d!=='publisher_pages_unreachable'){p.no_followup=true;p.no_followup_reason=`Recipient no longer verifiable (${d})`;stats.followups_retired=(stats.followups_retired||0)+1}
   continue;
  }
  const asset=assetByUrl.get(p.asset_url)||{url:p.asset_url,title:p.asset_title};
  if(p.broken_link){const r=await (config.recheckBroken||(u=>checkDead(u)))(p.broken_link.url).catch(()=>null);if(!r?.dead){p.broken_link_cleared_at=NOW();delete p.broken_link}}
  // Same name as the first email (older records: SENDER_NAME, which signed them), same thread, same subject.
  const site=siteBy.get(p.site)||{domain:p.site||'',topic:''},senderName=initial.sender_name||config.senderName;
  const subject=reSubject(initial.subject||p.last_subject||asset.title||site.domain);
  let pitch=null;try{pitch=await writer.write(p,asset,site,{situation:'followup',senderName,subject})}catch{}
  if(typeof pitch?.body!=='string'||!pitch.body.trim())pitch=followupPitch(p,asset,{senderName,site,subject});
  pitch={...pitch,subject};
  try{await deliver(p,pitch,'followup',{inReplyTo:initial.message_id,senderName});p.status='followed_up';stats.followups++;budget--;
   if(pitch.facts_used?.length)p.facts_used=[...new Set([...(p.facts_used||[]),...pitch.facts_used])];
   await sleep(config.gapMs())}
  catch(e){if(failed(p,e,'followup')){stop=true;break}}
 }
 // An address already emailed is never pitched again within 90 days, whichever publisher it is found on now. Checked before
 // and after verification, which may switch to another published address.
 const emailed=emailedAddresses(state,{sentIndex:config.sentIndex});
 const sameAddress=(p,t)=>{p.status='skipped_duplicate';p.skip_reason='This address was already emailed';
  if(!(Date.parse(state.contacted[p.domain])>=t))state.contacted[p.domain]=new Date(t).toISOString();stats.skipped++;stats.address_already_emailed=(stats.address_already_emailed||0)+1};
 const learned=assetStats(state),ready=Object.values(state.prospects||{}).filter(p=>p.status==='ready'&&p.email&&(p.qv||1)>=QUALIFY_VERSION)
  .map(p=>{p.likelihood=linkLikelihood(p,{assets:learned});return p}).sort((a,b)=>b.likelihood-a.likelihood||(b.score||0)-(a.score||0));
 // Already-verified inboxes go first (they need no credit); the rest by expected value per verification credit.
 if(requiresProof&&!stop){
  await classifyQueue(state,mailer,ready.filter(p=>!usableVerification(p.recipient_proof?.verification,p.email)));
  const key=p=>usableVerification(p.recipient_proof?.verification,p.email)?1e6+p.likelihood:creditValue(state,p,p.likelihood);
  ready.sort((a,b)=>key(b)-key(a));
 }
 const perAsset=new Map();for(const p of Object.values(state.prospects||{}))if((p.history||[]).some(h=>h.type==='initial'&&String(h.at).startsWith(NOW().slice(0,10))))perAsset.set(p.asset_url,(perAsset.get(p.asset_url)||0)+1);
 // 3-way exchange (cfg.exchange.mode 'abc'): exchange.mjs picks a related page on another of our sites (C) whose link to the
 // editor's article is offered in return. Only first pitches; never a mention; never C = A, and C must be one of our sites.
 const bare=d=>String(d||'').trim().toLowerCase().replace(/^[a-z]+:\/\//,'').replace(/^www\./,'').replace(/[/?#:].*$/,''),ours=new Set(sites.map(s=>bare(s.domain)));
 const offerFor=(p,site)=>{
  if(config.exchange?.mode!=='abc'||typeof config.exchangePartner!=='function'||p.kind==='mention')return null;
  if(p.exchange&&!['declined','lapsed'].includes(p.exchange.status))return null; // one open promise per publisher
  let o=null;try{o=config.exchangePartner(p,site)||null}catch{o=null}
  if(!o)return null;
  const c=bare(o.partner_site);
  if(!c||!ours.has(c)||c===bare(site.domain)||!String(o.partner_title||'').trim()||!sameSite(hostOf(o.partner_page),c)||!sameSite(hostOf(o.their_url),bare(p.domain))){stats.exchange_refused=(stats.exchange_refused||0)+1;return null}
  return o;
 };
 const madeOffer=(pitch,o)=>bare(pitch.exchange?.partner_site)===bare(o.partner_site)&&String(pitch.body||'').toLowerCase().includes(bare(o.partner_site));
 for(const p of ready){
  if(stop||budget<=0||Date.now()>deadline||checked>=24)break;
  if((perAsset.get(p.asset_url)||0)>=PER_ASSET_DAILY)continue;if(outOfHours(p)){stats.deferred++;continue}
  const last=state.contacted[p.domain];
  if(suppressed(state,p.email,p.domain)||(last&&ageDays(last)<90)){p.status='skipped_duplicate';stats.skipped++;continue}
  const site=siteBy.get(p.site);if(!site){p.status='stale_asset';stats.skipped++;continue}
  if(config.blockedAssets?.has(normUrlKey(p.asset_url))){stats.asset_not_indexable=(stats.asset_not_indexable||0)+1;continue} // wait until the page is fixed
  {const t=emailedWithin(emailed,p.email);if(t){sameAddress(p,t);continue}}
  // No slot for a cached answer, nor for a publisher-side hold under 3 days old: the same pages give the same answer, and a
  // second check minutes after the free screen would count as the second strike and retire the prospect the same cycle.
  if(requiresProof&&(coolingDown(p)||heldByPublisher(p))&&!usableVerification(p.recipient_proof?.verification,p.email)){stats.cooling=(stats.cooling||0)+1;continue}
  if(!await prepare(p,false))continue;
  {const t=emailedWithin(emailed,p.email);if(t){sameAddress(p,t);delete p.recipient_proof;continue}}
  // Pitch only a page an editor would link to: a prospect paired with a thin, templated or review page is
  // re-paired with the site's best pitchable page for that editor's topic before anything is written.
  if(config.pickAsset&&p.kind!=='mention'){
   // A dead link was matched to one of our pages: that page stays the replacement while it is still pitchable.
   if(p.broken_link)p.broken_link.asset_url??=p.asset_url;
   const pinned=p.broken_link?.asset_url;
   const pick=pinned&&pinned!==p.asset_url&&assetByUrl.has(pinned)&&config.pickAsset({...p,asset_url:pinned},site)===undefined
    ?{asset:assetByUrl.get(pinned)}:config.pickAsset(p,site);
   if(pick===null){stats.no_pitchable_page=(stats.no_pitchable_page||0)+1;continue}
   if(pick&&pick.asset.url!==p.asset_url){p.asset_repaired_from=p.asset_url;p.asset_url=pick.asset.url;p.asset_title=pick.asset.title;if(p.competitor_link&&pick.match)p.competitor_link.match=pick.match;stats.repaired=(stats.repaired||0)+1}
   // Otherwise the "replacement" could be unrelated to the dead link: drop the dead-link framing instead.
   if(p.broken_link&&p.broken_link.asset_url!==p.asset_url){p.broken_link_dropped_reason='Pitched page changed, so it is no longer the replacement for the dead link';p.broken_link_dropped_at=NOW();delete p.broken_link;stats.broken_link_dropped=(stats.broken_link_dropped||0)+1}
  }
  const asset=assetByUrl.get(p.asset_url)||{url:p.asset_url,title:p.asset_title||site.domain,type:p.kind==='mention'?'brand':'resource',description:''};
  // The email states that a link is dead: confirm it still is, seconds before writing it.
  if(p.broken_link){const r=await (config.recheckBroken||(u=>checkDead(u)))(p.broken_link.url).catch(()=>null);if(!r?.dead){p.broken_link_cleared_at=NOW();delete p.broken_link}else stats.broken_link_pitches=(stats.broken_link_pitches||0)+1}
  const senderName=senderFor(p),offer=offerFor(p,site);
  const pitch=await writer.write(p,asset,site,{senderName,...(offer?{exchange:offer}:{})});p.writer=pitch.writer;
  try{await deliver(p,pitch,'initial',{senderName});state.contacted[p.domain]=NOW();emailed.set(normalizeEmail(p.email),Date.now()); // also a draft: one address gets one pitch per run
   // The return-link promise is recorded only once the email that makes it is delivered (or saved as the owner's draft),
   // and only when the email really makes it: a writer that left the offer out promised nothing.
   if(offer&&pitch.exchange&&madeOffer(pitch,offer)){p.exchange={...offer,status:'offered',offered_at:NOW(),via:'email'};stats.exchange_offered=(stats.exchange_offered||0)+1}
   else if(offer)stats.exchange_not_included=(stats.exchange_not_included||0)+1;
   if(config.mode==='send'){state.first_send_at??=NOW();noteBaseline(state,p.asset_url,config.demand)}
   // The facts this email states: a follow-up may add only a fact that is not among them.
   if(Array.isArray(pitch.facts_used))p.facts_used=pitch.facts_used;else delete p.facts_used;
   p.status=config.mode==='send'?'sent':'drafted';p.next_link_check=new Date(Date.now()+5*DAY).toISOString();
   config.mode==='send'?stats.sent++:stats.drafted++;budget--;perAsset.set(p.asset_url,(perAsset.get(p.asset_url)||0)+1);if(config.mode==='send')await sleep(config.gapMs());
  }catch(e){if(failed(p,e,'initial')){stop=true;break}}
 }
 log(`outreach: ${stats.sent} sent, ${stats.followups} follow-ups, ${stats.drafted} drafts, ${stats.verification_held} held for verification${stats.followups_retired?`, ${stats.followups_retired} follow-ups retired (address no longer verifiable)`:''}${stats.exchange_offered?`, ${stats.exchange_offered} with a return-link offer`:''}${stats.send_blocked?`; sending stopped (${stats.send_blocked})`:''}`);return stats;
}
/**
 * Won and lost links from the live page (attribution hardening remains in PR 25). 3-way exchanges (exchange.mjs): a link to
 * the pitched site A on a page with an open offer starts our return-link obligation in the same cycle (owed within
 * `fulfilDays`), and its removal before our link is up cancels it. Offers made on a contact form (no email in the history)
 * are checked too.
 */
export async function checkLinks({state,ourDomains,fetchImpl=fetch,max=60,deadline=Infinity,fulfilDays=7,log=()=>{}}){
 const stats={checked:0,won:0,lost:0,unverifiable:0};
 const due=Object.values(state.prospects||{}).filter(p=>{
  if(p.status==='won')return ageDays(p.won?.checked_at)>14;
  const first=(p.history||[]).find(h=>h.type==='initial')||(p.exchange?.via==='form'&&p.exchange.offered_at?{at:p.exchange.offered_at}:null);
  return first&&ageDays(first.at)<150&&!['declined','bounced'].includes(p.status)&&(!p.next_link_check||p.next_link_check<=NOW());
 }).slice(0,max);
 const xch=due.some(p=>p.exchange)?await import('./exchange.mjs'):null;
 for(const p of due){if(Date.now()>deadline)break;
  const res=await fetchPage(p.page_url,{fetchImpl,timeout:12000,maxBytes:800000});stats.checked++;p.next_link_check=new Date(Date.now()+4*DAY).toISOString();
  // A page that does not answer 200 cannot show whether the link is there: recorded as unverifiable, never read as won or lost.
  p.link_check={status:res.status||0,at:NOW(),...(res.error?{error:String(res.error).slice(0,40)}:{})};
  if(res.status!==200){stats.unverifiable++;continue}
  const all=links(res.body,res.url),hit=all.find(l=>ourDomains.some(d=>sameSite(hostOf(l.url),d)));
  if(hit){if(p.status!=='won'){stats.won++;(p.history??=[]).push({type:'won',at:NOW(),url:hit.url})}p.status='won';p.won={target:hit.url,anchor:hit.anchor,rel:hit.rel||'follow',found_at:p.won?.found_at||NOW(),checked_at:NOW()}}
  else if(p.status==='won'){stats.lost++;p.status='lost';(p.history??=[]).push({type:'lost',at:NOW()})}
  // Only a link to A itself counts for an exchange (a link to C would make it a direct swap).
  if(xch&&p.exchange){if(p.site&&all.some(l=>sameSite(hostOf(l.url),p.site))){if(xch.noteTheirLink(p,{fulfilDays}))stats.exchange_links=(stats.exchange_links||0)+1}else xch.noteTheirLinkLost(p)}
 }
 log(`link checks: ${stats.checked} pages, ${stats.won} new links won, ${stats.lost} lost${stats.exchange_links?`, ${stats.exchange_links} exchange partners linked (return links now owed)`:''}${stats.unverifiable?`, ${stats.unverifiable} pages did not load (unverifiable this time)`:''}`);return stats;
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
  mxClassOf:async(p,{state})=>{
   if(!verifiers.has(state))verifiers.set(state,new RecipientVerifier({state,fetchPage,env}));
   return verifiers.get(state).mxClassOf(p.email);
  },
  screenRecipient:async(p,{state,deadline})=>{
   if(!verifiers.has(state))verifiers.set(state,new RecipientVerifier({state,fetchPage,env}));
   return verifiers.get(state).verify(p,{deadline,screenOnly:true});
  },
  // Weekend screening with credits that would expire: never returns a proof (see RecipientVerifier.verify prescreen).
  prescreenRecipient:async(p,{state,deadline})=>{
   if(!verifiers.has(state))verifiers.set(state,new RecipientVerifier({state,fetchPage,env}));
   return verifiers.get(state).verify(p,{deadline,prescreen:true});
  },
  verifierCredits:async({state,screen=false})=>{
   if(!verifiers.has(state))verifiers.set(state,new RecipientVerifier({state,fetchPage,env}));
   return verifiers.get(state).creditsLeft({screen});
  },
  send:async({to,raw,recipientProof:p})=>{
   if(!usableVerification(p?.verification,to)||p?.email!==normalizeEmail(to)||!samePublisher(p?.evidence?.source,p?.publisher_domain))throw Error('SMTP blocked: verified recipient evidence required');
   return smtpSend({user,pass,from:user,to,raw});
  },
  draft:async raw=>(await getImap()).appendDraft(raw),imap:{recentHeaders:async(...a)=>(await getImap()).recentHeaders(...a),sentRecipients:async(...a)=>(await getImap()).sentRecipients(...a)},
  check:async()=>{try{await getImap();await imap.close();imap=null;return {status:'connected'}}catch{return {status:'rejected',error:'Gmail login or connection failed; outgoing mail blocked'}}},
  // Drop a stalled mailbox connection so the next call opens a fresh one.
  reset:async()=>{try{await imap?.close()}catch{}imap=null},
  close:async()=>{if(imap)await imap.close()}
 };
}
