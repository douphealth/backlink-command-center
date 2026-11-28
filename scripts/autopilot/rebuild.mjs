/**
 * Fresh-vault guard. A new vault (no vault file, or the dashboard's "Create a new vault key") starts with no record
 * of who was emailed or who opted out, so the 90-day rule and every opt-out would rest on the 30-day Sent check
 * alone. state.rebuild_required holds all sending (outreach and automatic replies; drafts are fine) until the
 * mailbox has been read back over ~400 days:
 *   - Gmail's Sent folder restores state.contacted (publisher domain -> last email) and the recipient addresses
 *     (state.restored_sent, so a free-mail recipient is linked to its publisher once that prospect reappears);
 *   - All Mail, classified with mail.mjs classifyReply, restores suppression: hard bounces (address) and opt-outs
 *     (address and publisher domain) of anything that answered our outreach, including a mail client's unsubscribe
 *     button ("unsubscribe lf-...@..." in the subject, also sent from a forwarding address).
 * Our own message ids are kept (state.restored_ids, id -> recipient), so a later opt-out that quotes one is still tied to
 * that recipient and publisher. Only counts that concern the outreach are published; how much mail the account holds
 * stays in the vault (state.rebuild.counts).
 * Read-only: nothing is sent, moved or marked. If a mailbox cannot be read in full, the flag stays set; an unfinished
 * All Mail scan continues next cycle from its own cursor.
 */
import {classifyReply,lfIds,optOutSubject} from './mail.mjs';
import {normalizeEmail} from './recipient-policy.mjs';
import {NOW,DAY,ageDays} from './util.mjs';

export const REBUILD={days:400,contactDays:90,sentPage:1000,sentPages:12,inboxPage:400};
const WEBMAIL=/^(?:gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|aol|icloud|me|mac|proton|protonmail|pm|gmx|web|yandex|mail|zoho)\.(?:com|me|net|de|ru|co\.uk|fr|ch|at)$/;
const DAEMON=/^(?:mailer-daemon|postmaster|no-?reply|bounces?|mail-?delivery)(?:[+.-]|$)/;
const DELAYED=/notification\s*\(delay\)|delivery (?:incomplete|delayed)|will retry|Action:\s*delayed|Status:\s*4\./i;
const host=s=>String(s||'').toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
const domainOf=e=>host(String(e||'').split('@')[1]);
/** The publisher an address belongs to: its domain, unless that is a webmail domain (gmail.com names no publisher). */
export const publisherDomain=e=>{const d=domainOf(e);return d&&!WEBMAIL.test(d)?d:''};
// Addresses a bounce names, without message identifiers (ours are <lf-...@sender-domain>) and header lines that carry them.
const ID_LINES=/^(?:message-id|in-reply-to|references|dkim-signature|arc-[\w-]+|x-[\w-]+):.*$/gim;
const emailsIn=s=>[...new Set((String(s||'').replace(/<lf-[^>]+>/gi,' ').replace(ID_LINES,' ').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)||[])
  .map(x=>normalizeEmail(x.toLowerCase())).filter(e=>e&&!/^lf-/.test(e)))];

/** Start a new vault in the held state. `why`: 'no_vault_file' or 'dashboard_reset'. */
export function requireRebuild(state,why,at=NOW()){
  state.rebuild_required=at;state.rebuild={reason:why,requested_at:at};return state;
}
/** Why sending is held, or '' when it is not. `st` is this cycle's rebuild stage record, if any. */
export function rebuildHold(state,st){
  if(!state?.rebuild_required)return '';
  const why=st?.ok===false?`the mailbox could not be read: ${st.error}`:st?.ok===null?st.skipped:st?.result?.why||'the mailbox has not been read yet';
  return `new vault: nothing is sent until contact history and opt-outs are restored from Gmail (${why})`;
}
/**
 * Every cycle (cheap): a prospect found again whose address was emailed before the vault was replaced counts as
 * contacted from that send (the 90-day rule then applies as usual); one whose address opted out has its publisher
 * domain suppressed too, as a reply matched to the prospect would have done. This links free-mail recipients
 * (blogger@gmail.com on their own blog), whose publisher the mailbox alone cannot name.
 */
export function linkRestoredSends(state){
  const sent=state.restored_sent&&typeof state.restored_sent==='object'?state.restored_sent:{};
  const optedOut=new Set(Object.entries(state.suppression||{}).filter(([k,v])=>k.includes('@')&&v?.restored&&/^Opt-out/.test(v.reason||'')).map(([k])=>k));
  if(!Object.keys(sent).length&&!optedOut.size)return 0;
  state.contacted??={};let linked=0;
  for(const p of Object.values(state.prospects||{})){
    if(!p?.domain)continue;
    const addrs=[p.email,...(p.history||[]).map(h=>h?.to)].map(x=>normalizeEmail(String(x||'').toLowerCase())).filter(Boolean);
    const last=addrs.map(e=>sent[e]).filter(Boolean).sort().pop();
    if(last&&!(Date.parse(state.contacted[p.domain])>=Date.parse(last))){state.contacted[p.domain]=last;linked++}
    if(addrs.some(e=>optedOut.has(e))&&!state.suppression[p.domain]){state.suppression[p.domain]={reason:'Opt-out (restored from the mailbox)',at:NOW(),restored:true};linked++}
  }
  return linked;
}
/** Restored Sent recipients older than the rebuild window carry no information any more. */
export function pruneRestoredSends(state,days=REBUILD.days){
  for(const k of ['restored_sent','restored_ids']){
    if(!state[k])continue;
    for(const [e,v] of Object.entries(state[k]))if(!(ageDays(typeof v==='string'?v:v?.at)<=days))delete state[k][e];
    if(!Object.keys(state[k]).length)delete state[k];
  }
}

/** Sent folder, newest first in pages of up to `pageSize` messages, back to `since` (also the per-cycle Sent check). */
export async function readSent(imap,since,{now=()=>Date.now(),deadline=Infinity,pages=REBUILD.sentPages,pageSize=REBUILD.sentPage}={}){
  const out=[];let before=null,complete=false,oldest=Infinity;
  for(let page=0;page<pages&&now()<deadline;page++){
    const batch=await imap.sentRecipients(since,{max:pageSize,...(before?{before}:{})});
    if(!Array.isArray(batch))throw Error('Invalid Sent mailbox response');
    out.push(...batch);
    const times=batch.map(m=>Date.parse(m?.at)).filter(Number.isFinite);if(times.length)oldest=Math.min(oldest,...times);
    if(batch.complete!==false){complete=true;break}
    // BEFORE is a whole, exclusive day: ask again up to and including the oldest day seen (duplicates are harmless).
    if(!times.length)break;
    const d=new Date(Math.min(...times)),next=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1));
    if(before&&next>=before)break; // a single day holds more than one page: no progress possible
    before=next;
  }
  return {sent:out,complete,oldest};
}

export async function rebuildFromMailbox({state,imap,self='',now=()=>Date.now(),deadline=Infinity,log=()=>{}}){
  // Published (the stage result): outreach counts only. The size of the owner's mailbox stays in the vault.
  const stats={complete:false,bounces:0,opt_outs:0,replies:0},counts={sent_read:0,contacted_restored:0,addresses_restored:0,inbox_read:0,pages:0};
  if(!state.rebuild_required){stats.complete=true;return stats}
  if(typeof imap?.sentRecipients!=='function'||typeof imap?.recentHeaders!=='function')throw Error('the mail transport cannot read the Sent folder and All Mail');
  state.contacted??={};state.suppression??={};state.rebuild??={};
  const me=normalizeEmail(String(self||'').toLowerCase()),since=new Date(now()-REBUILD.days*DAY),at=new Date(now()).toISOString();
  // ---- 1. Sent folder: who was emailed, and when ----
  const {sent,complete:sentComplete,oldest}=await readSent(imap,since,{now,deadline});
  const sentTo=new Map(),byMsg=new Map();
  for(const m of sent){
    const e=normalizeEmail(String(m?.to||'').toLowerCase()),t=Date.parse(m?.at);if(!e||e===me)continue;counts.sent_read++;
    const iso=Number.isFinite(t)?new Date(Math.min(t,now())).toISOString():at; // an undated message counts as sent now (holds longest)
    if(!(sentTo.get(e)>=iso))sentTo.set(e,iso);
    if(m.message_id)byMsg.set(String(m.message_id).trim(),e);
  }
  // Our own ids (lf-...) and who each went to, so a later opt-out quoting one still names its recipient (processReplies).
  state.restored_ids??={};
  for(const m of sent){const id=String(m?.message_id||'').trim(),e=byMsg.get(id),t=Date.parse(m?.at);
    if(/^<lf-[^<>\s]+>$/i.test(id)&&e&&!state.restored_ids[id])state.restored_ids[id]={to:e,at:Number.isFinite(t)?new Date(Math.min(t,now())).toISOString():at}}
  if(!Object.keys(state.restored_ids).length)delete state.restored_ids;
  const sentDomains=new Set([...sentTo.keys()].map(publisherDomain).filter(Boolean));
  state.restored_sent??={};
  for(const [e,t] of sentTo){
    if(!(state.restored_sent[e]>=t)){state.restored_sent[e]=t;counts.addresses_restored++}
    const d=publisherDomain(e);if(d&&!(Date.parse(state.contacted[d])>=Date.parse(t))){state.contacted[d]=t;counts.contacted_restored++}
  }
  if(!Object.keys(state.restored_sent).length)delete state.restored_sent;
  // The 90-day rule needs every email of the last 90 days; older ones only help match old replies.
  const sentCovered=sentComplete||oldest<=now()-REBUILD.contactDays*DAY;
  // ---- 2. All Mail: bounces and opt-outs that answered our outreach ----
  const suppress=(key,reason)=>{if(key)state.suppression[key]??={reason,at,restored:true}};
  let cursor=state.rebuild.cursor,inboxDone=false;
  while(now()<deadline){
    const msgs=await imap.recentHeaders(since,{max:REBUILD.inboxPage,cursor});
    if(!Array.isArray(msgs))throw Error('Invalid mailbox response');
    counts.pages++;counts.inbox_read+=msgs.length;
    for(const m of msgs){
      const kind=classifyReply(m);if(kind==='auto')continue;
      const from=normalizeEmail(String(m.from||'').toLowerCase()),text=`${m.subject||''}\n${m.body||''}`;
      // Our ids wherever they appear, as processReplies reads them: In-Reply-To, References, the subject (the
      // List-Unsubscribe mailto puts a bare, possibly URL-encoded "unsubscribe lf-...@..." there) and quoted text.
      const ids=[...new Set([m.inReplyTo,m.references,m.subject,m.body].flatMap(x=>lfIds(x)))],ours=ids.length>0||optOutSubject(m.subject);
      const mapped=[...new Set(ids.map(i=>byMsg.get(i)).filter(Boolean))];
      if(kind==='bounce'){
        if(DELAYED.test(text))continue; // a temporary delay is not a failure
        const named=emailsIn(m.body).filter(e=>e!==me&&!DAEMON.test(e.split('@')[0]));
        let failed=named.filter(e=>sentTo.has(e));
        if(!failed.length)failed=mapped;
        if(!failed.length&&ours)failed=named; // ours, but older than the Sent pages read: the addresses it names
        for(const e of failed){suppress(e,'Delivery failure; re-contact prohibited (restored from the mailbox)');const d=publisherDomain(e);if(d)state.contacted[d]??=at}
        if(failed.length)stats.bounces++;
      }else if(kind==='negative'){
        if(!(ours||sentTo.has(from)||sentDomains.has(publisherDomain(from))))continue; // not an answer to our outreach
        const who=[...new Set([from,...mapped].filter(Boolean))];
        for(const e of who)suppress(e,'Opt-out (restored from the mailbox)');
        for(const d of new Set(who.map(publisherDomain).filter(Boolean)))suppress(d,'Opt-out (restored from the mailbox)');
        if(who.length)stats.opt_outs++;
      }else if(ours||sentTo.has(from))stats.replies++;
    }
    if(msgs.cursor){cursor=msgs.cursor;state.rebuild.cursor=cursor}
    if(msgs.complete!==false){inboxDone=true;break}
    if(!msgs.cursor)break; // cannot advance: try again next cycle
  }
  stats.complete=sentCovered&&inboxDone;
  state.rebuild.counts={...counts,at}; // this cycle's read (vault only)
  if(stats.complete){
    delete state.rebuild_required;delete state.rebuild.cursor;state.rebuild.completed_at=at;
    log(`rebuild: contact history and opt-outs restored from Gmail (${stats.bounces} bounces and ${stats.opt_outs} opt-outs suppressed); sending may resume`);
  }else{
    stats.why=now()>=deadline?'out of time this cycle; continues next cycle':!sentCovered?'the Sent folder could not be read back 90 days':'All Mail is still being read; continues next cycle';
    log(`rebuild: not finished (${stats.why}); sending stays held`);
  }
  return stats;
}
