/**
 * Outreach state machine (runs once per Autopilot cycle):
 *   replies/bounces -> follow-ups -> new pitches (send or Gmail draft) -> link checks.
 * Guardrails: one contact per publisher domain per 90 days, global suppression,
 * warm-up ramp, daily cap, opt-out honoured from any reply, no follow-up after a reply.
 */
import {buildMessage,newMessageId,smtpSend,Imap,classifyReply} from './mail.mjs';
import {followupPitch} from './pitch.mjs';
import {fetchPage,links,hostOf,sameSite,ageDays,NOW,sleep,DAY} from './util.mjs';
import {QUALIFY_VERSION} from './prospect.mjs';
import {assetStats,linkLikelihood} from './learn.mjs';
// At most this many new pitches per asset per day, so one page doesn't use up the whole daily cap.
export const PER_ASSET_DAILY=2;

/**
 * Send while the recipient is plausibly at work (by domain region), Monday–Friday.
 * Hours are UTC. Unknown/global TLDs use US business hours, where most English editors are.
 */
const REGIONS=[
  [/\.(uk|ie|de|fr|es|it|nl|be|pt|gr|se|no|dk|fi|pl|cz|at|ch|eu|za|ro|hu|sk|si|hr|bg|lt|lv|ee|lu|cy|mt)$/,[7,16]],
  [/\.(au|nz)$/,[21,6]],
  [/\.in$/,[3,12]],
  [/\.(jp|sg|my|ph|hk|kr|cn|id|th|vn|tw)$/,[0,9]],
];
export function sendWindowOpen(domain,now=new Date()){
  const [from,to]=(REGIONS.find(([re])=>re.test(domain))||[null,[13,21]])[1];
  const h=now.getUTCHours(),d=now.getUTCDay();
  if(d===0||d===6)return false;
  return from<to?h>=from&&h<to:h>=from||h<to;
}

/** First hour (UTC) from `from` when this recipient's send window is open; null if none within 8 days. */
export function nextSendWindow(domain,from=new Date()){
  if(sendWindowOpen(domain,from))return new Date(from);
  const t=new Date(from);t.setUTCMinutes(0,0,0);
  for(let h=0;h<24*8;h++){t.setUTCHours(t.getUTCHours()+1);if(sendWindowOpen(domain,t))return new Date(t)}
  return null;
}
/** Public outreach status: counts and times only (no publisher names or addresses). */
export function outreachStatus(state,{limit,mode,qualifyVersion}){
  const ready=Object.values(state.prospects||{}).filter(p=>p.status==='ready'&&p.email&&(p.qv||1)>=qualifyVersion);
  const cap=mode==='send'?dailyCap(state,limit):limit,sent=sentToday(state),now=new Date();
  // Today's limit used up: the next chance is tomorrow 00:00 UTC at the earliest.
  const from=sent>=cap?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1)):now;
  const next=ready.map(p=>nextSendWindow(p.domain,from)).filter(Boolean).sort((a,b)=>a-b)[0]||null;
  return {mode,ready:ready.length,sent_today:sent,cap_today:cap,next_send_at:mode==='off'?null:next?.toISOString()||null,
    sending_now:mode!=='off'&&sent<cap&&ready.some(p=>sendWindowOpen(p.domain,now))};
}

const ACTIVE=new Set(['sent','followed_up','drafted','replied','positive']);
export function dailyCap(state,limit){
  const first=state.first_send_at;if(!first)return Math.min(limit,5);
  return Math.min(limit,5+2*Math.floor(ageDays(first)));
}
export const sentToday=state=>Object.values(state.prospects||{}).reduce((n,p)=>n+(p.history||[]).filter(h=>h.type==='initial'&&h.at.startsWith(NOW().slice(0,10))).length,0);
export function suppressed(state,email,domain){return !!(state.suppression?.[email]||state.suppression?.[domain])}

export async function processReplies({state,imap,log=()=>{}}){
  const stats={scanned:0,replies:0,positive:0,negative:0,bounces:0};
  const byMsg=new Map(),byEmail=new Map();
  for(const p of Object.values(state.prospects||{})){
    if(!ACTIVE.has(p.status))continue;
    for(const h of p.history||[])if(h.message_id)byMsg.set(h.message_id,p);
    if(p.email)byEmail.set(p.email,p);
  }
  if(!byMsg.size&&!byEmail.size)return stats;
  const msgs=await imap.recentHeaders(new Date(Date.now()-35*DAY));stats.scanned=msgs.length;
  state.seen_replies??={};
  for(const m of msgs){
    const ids=`${m.inReplyTo} ${m.references} ${m.body}`.match(/<lf-[^>]+>/g)||[];
    let p=ids.map(i=>byMsg.get(i)).find(Boolean)||byEmail.get(m.from);
    const kind=classifyReply(m);
    if(!p&&kind==='bounce'){for(const [e,q] of byEmail)if(m.body.toLowerCase().includes(e)){p=q;break}}
    if(!p||kind==='auto')continue;
    const key=`${p.id}|${m.subject}|${m.from}`;if(state.seen_replies[key])continue;state.seen_replies[key]=NOW();
    if(kind==='bounce'){
      stats.bounces++;p.history.push({type:'bounce',at:NOW(),to:p.email});
      const next=(p.alternates||[]).find(e=>e!==p.email&&!suppressed(state,e,p.domain));
      if(next){p.email=next;p.status='ready';delete state.contacted[p.domain]}else p.status='bounced';
      continue;
    }
    stats.replies++;p.replied_at=NOW();p.history.push({type:'reply',at:NOW(),from:m.from,sentiment:kind,subject:m.subject.slice(0,140)});
    if(kind==='negative'){stats.negative++;p.status='declined';state.suppression[p.domain]={reason:'Asked not to be contacted',at:NOW()};if(p.email)state.suppression[p.email]={reason:'Opt-out reply',at:NOW()}}
    else if(kind==='positive'){stats.positive++;p.status='positive';p.next_link_check=NOW()}
    else p.status='replied';
  }
  log(`replies: scanned ${stats.scanned}, ${stats.replies} replies (${stats.positive} positive, ${stats.negative} opt-out), ${stats.bounces} bounces`);
  return stats;
}

export async function runOutreach({state,assets,sites,writer,mailer,config,deadline=Infinity,log=()=>{}}){
  state.contacted??={};state.suppression??={};
  const stats={followups:0,sent:0,drafted:0,skipped:0,deferred:0,cap:0};
  const now=config.now?.()||new Date();
  const outOfHours=p=>config.mode==='send'&&config.sendWindow&&!sendWindowOpen(p.domain,now);
  const assetByUrl=new Map(assets.map(a=>[a.url,a])),siteBy=new Map(sites.map(s=>[s.domain,s]));
  const deliver=async(p,{subject,body},type,inReplyTo)=>{
    const messageId=newMessageId(config.fromAddress.split('@')[1]);
    const footer=config.postalAddress?`\n\n${config.postalAddress}`:'';
    const raw=buildMessage({from:config.fromAddress,fromName:config.senderName,to:p.email,subject,text:body+footer,messageId,inReplyTo,references:inReplyTo,unsubscribe:true});
    if(config.mode==='send')await mailer.send({to:p.email,raw});else await mailer.draft(raw);
    p.history.push({type,at:NOW(),message_id:messageId,subject,to:p.email,mode:config.mode,writer:p.writer||'template'});
    p.last_subject=subject;return messageId;
  };
  // 1. Follow-ups (send mode only; drafts may never have been sent).
  if(config.mode==='send'){
    for(const p of Object.values(state.prospects)){
      if(Date.now()>deadline)break;
      if(p.status!=='sent'||p.replied_at||p.no_followup||(p.qv||1)<QUALIFY_VERSION||suppressed(state,p.email,p.domain))continue;
      const initial=p.history.find(h=>h.type==='initial');if(!initial||ageDays(initial.at)<config.followupDays)continue;
      if(outOfHours(p)){stats.deferred++;continue}
      const asset=assetByUrl.get(p.asset_url)||{url:p.asset_url,title:p.asset_title};
      try{await deliver(p,followupPitch(p,asset,{senderName:config.senderName}),'followup',initial.message_id);p.status='followed_up';stats.followups++;await sleep(config.gapMs())}
      catch(e){log('follow-up failed: '+e.message);break}
    }
  }
  // 2. New pitches, best prospects first, within the warm-up/daily cap.
  const cap=config.mode==='send'?dailyCap(state,config.dailyLimit):config.dailyLimit;stats.cap=cap;
  let budget=Math.max(0,cap-sentToday(state));
  // Most likely to link first: daily sends are the scarce resource.
  const learned=assetStats(state);
  const ready=Object.values(state.prospects).filter(p=>p.status==='ready'&&p.email&&(p.qv||1)>=QUALIFY_VERSION)
    .map(p=>{p.likelihood=linkLikelihood(p,{assets:learned});return p}).sort((a,b)=>b.likelihood-a.likelihood||(b.score||0)-(a.score||0));
  const perAsset=new Map();
  for(const p of Object.values(state.prospects))if((p.history||[]).some(h=>h.type==='initial'&&h.at.startsWith(NOW().slice(0,10))))perAsset.set(p.asset_url,(perAsset.get(p.asset_url)||0)+1);
  for(const p of ready){
    if(budget<=0||Date.now()>deadline)break;
    if((perAsset.get(p.asset_url)||0)>=PER_ASSET_DAILY)continue;
    if(outOfHours(p)){stats.deferred++;continue}
    const lastDomain=state.contacted[p.domain];
    if(suppressed(state,p.email,p.domain)||(lastDomain&&ageDays(lastDomain)<90)){p.status='skipped_duplicate';stats.skipped++;continue}
    const site=siteBy.get(p.site);
    if(!site){p.status='stale_asset';stats.skipped++;continue}
    // Pages can drop out of this run's top list; fall back to what was stored when the prospect was found.
    const asset=assetByUrl.get(p.asset_url)||{url:p.asset_url,title:p.asset_title||site.domain,type:p.kind==='mention'?'brand':'resource',description:''};
    const pitch=await writer.write(p,asset,site);p.writer=pitch.writer;
    try{
      await deliver(p,pitch,'initial');
      state.contacted[p.domain]=NOW();if(config.mode==='send')state.first_send_at??=NOW();
      p.status=config.mode==='send'?'sent':'drafted';p.next_link_check=new Date(Date.now()+5*DAY).toISOString();
      config.mode==='send'?stats.sent++:stats.drafted++;budget--;perAsset.set(p.asset_url,(perAsset.get(p.asset_url)||0)+1);
      if(config.mode==='send')await sleep(config.gapMs());
    }catch(e){log('delivery failed: '+e.message);p.delivery_error=String(e.message).slice(0,160);break}
  }
  log(`outreach (${config.mode}): ${stats.sent} sent, ${stats.drafted} drafted, ${stats.followups} follow-ups, ${stats.deferred} waiting for recipients' business hours, cap ${cap}`);
  return stats;
}

/** Re-check pitched pages for a live link to any owned domain; also re-verify won links. */
export async function checkLinks({state,ourDomains,fetchImpl=fetch,max=60,deadline=Infinity,log=()=>{}}){
  const stats={checked:0,won:0,lost:0};
  const due=Object.values(state.prospects||{}).filter(p=>{
    if(p.status==='won')return ageDays(p.won?.checked_at)>14;
    const first=(p.history||[]).find(h=>h.type==='initial');
    return first&&ageDays(first.at)<150&&!['declined','bounced'].includes(p.status)&&(!p.next_link_check||p.next_link_check<=NOW());
  }).slice(0,max);
  for(const p of due){
    if(Date.now()>deadline)break;
    const res=await fetchPage(p.page_url,{fetchImpl,timeout:12000,maxBytes:800000});stats.checked++;
    p.next_link_check=new Date(Date.now()+4*DAY).toISOString();
    if(res.status!==200)continue;
    const hit=links(res.body,res.url).find(l=>ourDomains.some(d=>sameSite(hostOf(l.url),d)));
    if(hit){
      if(p.status!=='won'){stats.won++;p.history.push({type:'won',at:NOW(),url:hit.url})}
      p.status='won';p.won={target:hit.url,anchor:hit.anchor,rel:hit.rel||'follow',found_at:p.won?.found_at||NOW(),checked_at:NOW()};
    }else if(p.status==='won'){stats.lost++;p.status='lost';p.history.push({type:'lost',at:NOW()})}
  }
  log(`link checks: ${stats.checked} pages, ${stats.won} new links won, ${stats.lost} lost`);
  return stats;
}

/** Real mail transport built from env; `null` when Gmail is not configured. */
export function gmailTransport(env){
  if(!env.GMAIL_ADDRESS||!env.GMAIL_APP_PASSWORD)return null;
  const user=env.GMAIL_ADDRESS,pass=env.GMAIL_APP_PASSWORD.replace(/\s+/g,'');
  let imap=null;
  const getImap=async()=>imap||(imap=await new Imap({user,pass}).open());
  return {
    send:({to,raw})=>smtpSend({user,pass,from:user,to,raw}),
    draft:async raw=>(await getImap()).appendDraft(raw),
    imap:{recentHeaders:async(...a)=>(await getImap()).recentHeaders(...a)},
    /** Logs in over IMAP with the same app password used for sending; sends nothing. */
    check:async()=>{
      // Close right away: the socket's idle timeout would otherwise drop it before replies are read.
      try{await getImap();await imap.close();imap=null;return {status:'connected'}}
      catch(e){return {status:'rejected',error:/AUTHENTICATIONFAILED|Invalid credentials|LOGIN (NO|BAD)|Application-specific password/i.test(e.message)
        ?'Gmail rejected the login. Use the full Gmail address and a 16-letter app password from myaccount.google.com/apppasswords (2-Step Verification must be on).'
        :'Gmail could not be reached: '+String(e.message).slice(0,100)}}
    },
    close:async()=>{if(imap)await imap.close()},
  };
}
