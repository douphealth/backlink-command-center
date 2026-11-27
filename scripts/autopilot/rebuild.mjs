/**
 * Fresh-vault guard. A new vault (no vault file, or the dashboard's "Create a new vault key") starts with no record
 * of who was emailed or who opted out, so the 90-day rule and every opt-out would rest on the 30-day Sent check
 * alone. state.rebuild_required holds all sending (outreach and automatic replies; drafts are fine) until the
 * mailbox has been read back over ~400 days:
 *   - Gmail's Sent folder restores state.contacted (publisher domain -> last email) and the recipient addresses
 *     (state.restored_sent, so a free-mail recipient is linked to its publisher once that prospect reappears);
 *   - All Mail, classified with mail.mjs classifyReply, restores suppression: hard bounces (address) and opt-outs
 *     (address and publisher domain) of anything that answered our outreach.
 * Read-only: nothing is sent, moved or marked. If a mailbox cannot be read in full, the flag stays set; an unfinished
 * All Mail scan continues next cycle from its own cursor.
 */
import {classifyReply} from './mail.mjs';
import {normalizeEmail} from './recipient-policy.mjs';
import {NOW,DAY,ageDays} from './util.mjs';

export const REBUILD={days:400,contactDays:90,sentPage:1000,sentPages:12,inboxPage:400};
const WEBMAIL=/^(?:gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|aol|icloud|me|mac|proton|protonmail|pm|gmx|web|yandex|mail|zoho)\.(?:com|me|net|de|ru|co\.uk|fr|ch|at)$/;
const DAEMON=/^(?:mailer-daemon|postmaster|no-?reply|bounces?|mail-?delivery)(?:[+.-]|$)/;
const DELAYED=/notification\s*\(delay\)|delivery (?:incomplete|delayed)|will retry|Action:\s*delayed|Status:\s*4\./i;
const host=s=>String(s||'').toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
const domainOf=e=>host(String(e||'').split('@')[1]);
const publisherDomain=e=>{const d=domainOf(e);return d&&!WEBMAIL.test(d)?d:''};
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
  if(!state.restored_sent)return;
  for(const [e,t] of Object.entries(state.restored_sent))if(!(ageDays(t)<=days))delete state.restored_sent[e];
  if(!Object.keys(state.restored_sent).length)delete state.restored_sent;
}

/** Sent folder, newest first in pages of up to 1000 messages, back to `since`. */
async function readSent(imap,since,{now,deadline}){
  const out=[];let before=null,complete=false,oldest=Infinity;
  for(let page=0;page<REBUILD.sentPages&&now()<deadline;page++){
    const batch=await imap.sentRecipients(since,{max:REBUILD.sentPage,...(before?{before}:{})});
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
  const stats={complete:false,sent_read:0,contacted_restored:0,addresses_restored:0,inbox_read:0,pages:0,bounces:0,opt_outs:0,replies:0};
  if(!state.rebuild_required){stats.complete=true;return stats}
  if(typeof imap?.sentRecipients!=='function'||typeof imap?.recentHeaders!=='function')throw Error('the mail transport cannot read the Sent folder and All Mail');
  state.contacted??={};state.suppression??={};state.rebuild??={};
  const me=normalizeEmail(String(self||'').toLowerCase()),since=new Date(now()-REBUILD.days*DAY),at=new Date(now()).toISOString();
  // ---- 1. Sent folder: who was emailed, and when ----
  const {sent,complete:sentComplete,oldest}=await readSent(imap,since,{now,deadline});
  const sentTo=new Map(),byMsg=new Map();
  for(const m of sent){
    const e=normalizeEmail(String(m?.to||'').toLowerCase()),t=Date.parse(m?.at);if(!e||e===me)continue;stats.sent_read++;
    const iso=Number.isFinite(t)?new Date(Math.min(t,now())).toISOString():at; // an undated message counts as sent now (holds longest)
    if(!(sentTo.get(e)>=iso))sentTo.set(e,iso);
    if(m.message_id)byMsg.set(String(m.message_id).trim(),e);
  }
  const sentDomains=new Set([...sentTo.keys()].map(publisherDomain).filter(Boolean));
  state.restored_sent??={};
  for(const [e,t] of sentTo){
    if(!(state.restored_sent[e]>=t)){state.restored_sent[e]=t;stats.addresses_restored++}
    const d=publisherDomain(e);if(d&&!(Date.parse(state.contacted[d])>=Date.parse(t))){state.contacted[d]=t;stats.contacted_restored++}
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
    stats.pages++;stats.inbox_read+=msgs.length;
    for(const m of msgs){
      const kind=classifyReply(m);if(kind==='auto')continue;
      const from=normalizeEmail(String(m.from||'').toLowerCase()),text=`${m.subject||''}\n${m.body||''}`;
      const ids=`${m.inReplyTo||''} ${m.references||''} ${m.body||''}`.match(/<lf-[^>]+>/g)||[],ours=ids.length>0;
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
        stats.opt_outs++;
      }else if(ours||sentTo.has(from))stats.replies++;
    }
    if(msgs.cursor){cursor=msgs.cursor;state.rebuild.cursor=cursor}
    if(msgs.complete!==false){inboxDone=true;break}
    if(!msgs.cursor)break; // cannot advance: try again next cycle
  }
  stats.complete=sentCovered&&inboxDone;
  if(stats.complete){
    delete state.rebuild_required;delete state.rebuild.cursor;state.rebuild.completed_at=at;
    log(`rebuild: contact history and opt-outs restored from Gmail (${stats.sent_read} sent emails, ${stats.inbox_read} messages read; ${stats.contacted_restored} publishers marked contacted, ${stats.bounces} bounces and ${stats.opt_outs} opt-outs suppressed); sending may resume`);
  }else{
    stats.why=now()>=deadline?'out of time this cycle; continues next cycle':!sentCovered?'the Sent folder could not be read back 90 days':'All Mail is still being read; continues next cycle';
    log(`rebuild: not finished (${stats.why}); sending stays held`);
  }
  return stats;
}
