/**
 * Self-monitoring and self-tuning. After every cycle Autopilot
 *  1. tunes its own search volume to the time it really had (backs off after an overrun,
 *     grows when there was headroom),
 *  2. publishes a short list of what it cannot fix by itself, with the exact fix,
 *     so nobody has to read logs to find out why links aren't coming in, and
 *  3. watches its own outcomes over time (sends per weekday, inflow, paid yield), so a stall is
 *     raised within about 2 weekdays instead of lasting until someone happens to look.
 * Everything published from here is counts only: no addresses, no prospect names or domains, no reply text.
 */
import {sendWindowOpen} from './outreach.mjs';

export const TUNING={minQueries:8,maxQueries:40,step:4,start:24};
const DAY=864e5,MiB=1048576;
const EMAIL=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const isoDay=t=>new Date(t).toISOString().slice(0,10);
/** Monday to Friday (UTC) for a YYYY-MM-DD date or a timestamp. */
export const isWeekday=t=>{const d=new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(t))?`${t}T12:00:00Z`:t).getUTCDay();return d>0&&d<6};
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
const sum=(xs,f)=>xs.reduce((n,x)=>n+(Number(f(x))||0),0);

/** Next run's search budget from this run's prospect stage outcome. */
export function autotune(state,prospects,{envQueries}={}){
  state.tuning??={};
  if(envQueries!=null)return state.tuning.max_queries=envQueries; // an explicit owner setting always wins
  let q=Number(state.tuning.max_queries)||TUNING.start;
  const r=prospects?.result||{};
  const yieldPerQuery=r.queries?(r.candidates||0)/r.queries:null;
  if(prospects?.ok===false&&/time budget/.test(prospects.error||'')||r.deferred>0)q-=TUNING.step;      // ran out of time
  else if(r.queries>=8&&yieldPerQuery<0.2)q=Math.floor(q/2);                                         // searches find almost nothing new: stop paying for them
  else if(prospects?.ok&&r.queries>=q&&yieldPerQuery>=1&&(r.failed_queries||0)<=r.queries/4)q+=TUNING.step; // productive and used it all
  state.tuning.max_queries=Math.max(TUNING.minQueries,Math.min(TUNING.maxQueries,q));
  state.tuning.updated_at=new Date().toISOString();
  return state.tuning.max_queries;
}

// ---- Outcome history (inputs to the watchdog; all counts) ----

/** Real (non-draft) emails sent on one UTC day, from the stored send records. */
export function sendsOn(state,date){
  let first=0,fu=0;
  for(const p of Object.values(state.prospects||{}))for(const h of p.history||[])
    if(h.mode!=='draft'&&String(h.at||'').startsWith(date)){if(h.type==='initial')first++;else if(h.type==='followup')fu++}
  return {first_pitches:first,followups:fu,sent:first+fu};
}
/** True when at least one queued inbox is inside its recipient's business hours right now (a cycle that could have sent). */
export const inSendWindow=(state,now=new Date())=>Object.values(state.prospects||{}).some(p=>p.status==='ready'&&p.email&&p.domain&&sendWindowOpen(p.domain,now));
/**
 * The day's history entry: one per UTC day, overwritten by every cycle that day. `base` holds the funnel and
 * the older fields; the outcome fields are counts only. Cycle counters add up over the day's cycles.
 */
export function dailyEntry(prev,base,{state,newWithEmail=0,readySendable=null,inWindow=false,cap=null,verifierUsed=0}={}){
  const p=prev?.date===base.date?prev:{},s=sendsOn(state||{},base.date);
  return {...base,first_pitches:s.first_pitches,followups:s.followups,sent:s.sent,verifier_used:Number(verifierUsed)||0,
    new_with_email:(Number(p.new_with_email)||0)+(Number(newWithEmail)||0),ready_sendable:readySendable,
    cycles:(Number(p.cycles)||0)+1,in_window_cycles:(Number(p.in_window_cycles)||0)+(inWindow?1:0),...(Number.isFinite(cap)?{cap}:{})};
}
/**
 * One record per cycle of what discovery found, last 12 cycles (vault only, counts only).
 * paid_queries: DataForSEO searches that returned results; serp_candidates: new sites those searches admitted
 * (a cycle that mixed in fallback searches counts all search candidates, so the paid-search breaker errs toward "alive");
 * with_email: new publisher addresses this cycle (new prospects with an address plus second-look finds).
 */
export function recordDiscovery(state,{stages={},spentUsd=0,now=new Date()}={}){
  const r=stages.prospects?.result||{};
  const entry={at:now.toISOString(),paid_queries:Math.max(0,(r.queries||0)-(r.fallback_queries||0)),candidates:r.candidates||0,serp_candidates:r.new_domains||0,
    linkgap_calls:r.linkgap_calls||0,with_email:(r.with_email||0)+(stages.second_look?.result?.found||0),spend:Number((Number(spentUsd)||0).toFixed(4))};
  state.discovery_log=[...(state.discovery_log||[]),entry].slice(-12);
  return entry;
}
/**
 * Paid searches that keep finding nothing are switched off for a while instead of being paid for. From 2026-11-06 to
 * 11-19 every Google result was discarded while queries were still bought (about $4.7). After `cycles` cycles with paid
 * searches and 0 new search candidates (cycles without paid searches neither count nor break the run), paid SERP
 * searches pause for `pauseDays` (state.paid_serp_paused_until, read by discovery); free sources keep running. Only
 * evidence gathered after the previous pause ended counts, so an expired pause is not re-armed by old records.
 */
export function paidDiscoveryBreaker(state,{now=new Date(),cycles=3,pauseDays=3}={}){
  const until=Date.parse(state.paid_serp_paused_until||'');
  if(until>now.getTime())return {dead:true,paused_until:state.paid_serp_paused_until,...(state.paid_serp_paused||{}),paused_now:false};
  const since=Number.isFinite(until)?until:0;
  const paid=(state.discovery_log||[]).filter(e=>Date.parse(e.at)>since&&e.paid_queries>0).slice(-cycles);
  if(paid.length<cycles||paid.some(e=>(e.serp_candidates??e.candidates??0)>0))return {dead:false};
  state.paid_serp_paused_until=new Date(now.getTime()+pauseDays*DAY).toISOString();
  state.paid_serp_paused={at:now.toISOString(),cycles:paid.length,queries:sum(paid,e=>e.paid_queries),spend_usd:Number(sum(paid,e=>e.spend).toFixed(2))};
  return {dead:true,paused_until:state.paid_serp_paused_until,...state.paid_serp_paused,paused_now:true};
}
/** Reply-side counts for the watchdog (no addresses, no text): decisions the owner owes, and replies nobody answered. */
export function replySignals(state,now=new Date()){
  const ps=Object.values(state.prospects||{}),pending=p=>p.needs_owner&&!p.owner_decided_at,owner=ps.filter(pending);
  const owner_conditions={};for(const p of owner){const k=/^[a-z_]{1,20}$/.test(p.condition||'')?p.condition:'other';owner_conditions[k]=(owner_conditions[k]||0)+1}
  const since=owner.map(p=>Date.parse(p.last_reply_at||p.replied_at||'')).filter(Number.isFinite);
  const waiting=ps.filter(p=>p.awaiting_us&&!pending(p));
  // Only an answer that really sits in Gmail Drafts counts as drafted (an automatic send that failed is not one).
  const drafted=waiting.filter(p=>p.reply_draft?.at&&(p.reply_draft.mode==='draft'||p.reply_draft.mode==='send'&&!p.reply_draft.reason)&&!(Date.parse(p.reply_draft.at)<Date.parse(p.last_reply_at||'')));
  return {owner_conditions,owner_oldest_days:since.length?Math.max(0,Math.floor((now.getTime()-Math.min(...since))/DAY)):null,
    replies_unanswered:waiting.length,replies_drafted:drafted.length};
}

// ---- Self-diagnosis ----
const HOLD_WHY={only_non_editorial_inbox_published:'the only address is not on the publisher\'s contact/about page or is not an accepted inbox type',
  no_email_published:'the publisher publishes no email address at all (contact form only)',publisher_pages_unreachable:'the publisher pages could not be fetched',
  catch_all_domain:'the mail server accepts every address, so no inbox can be proven',mailbox_invalid:'the inbox does not exist',
  'mailbox_verifalia_free_credits_used_up':'today\'s free verification credits are used up','mailbox_verification_budget_exhausted':'today\'s verification limit is used up'};
const holdWhy=k=>HOLD_WHY[k]||String(k).replaceAll('_',' ');
/**
 * Which outcome rules this cycle could evaluate (published as summary.watchdog, read by notify.mjs): the stall and
 * throughput rules are quiet on weekends, holds, other modes, dry runs and a locked vault; the Gmail-block rule only
 * speaks when a send was attempted. A rule that did not run says nothing about whether its problem is fixed.
 */
export function watchdogStatus({signals={},stages={}}={}){
  const now=signals.now?new Date(signals.now):new Date(),vault_open=signals.vault?.open!==false;
  const reason=signals.dry_run?'dry_run':!vault_open?'vault_locked':signals.hold?'hold':signals.mode!=='send'?'not_sending':!isWeekday(now)?'weekend':null;
  return {quiet:!!reason,...(reason?{reason}:{}),vault_open,send_attempted:(Number(stages.outreach?.result?.attempted)||0)>0};
}
/** Days that could have sent: weekdays before today with at least one in-window cycle in send mode without a hold. */
const sendDays=(history,today)=>history.filter(h=>h&&h.date<today&&isWeekday(h.date)&&(Number(h.in_window_cycles)||0)>0);

/**
 * What needs the owner, most important first. Public data: no addresses, no prospect names.
 * `history` is summary.history (one entry per UTC day); `signals` are count-only facts about this cycle:
 * {now, dry_run, hold, mode, reply_mode, vault:{key,open}, discovery:[...], paid_discovery, owner_conditions,
 *  owner_oldest_days, replies_unanswered, replies_drafted}. `sender` is summary.sender (booleans only).
 */
export function diagnose({stages={},capabilities={},outreach={},funnel={},spend={},held=true,noPitchSites=[],indexation=null,history=[],signals={},sender=null}){
  const out=[],add=(level,code,message,fix)=>out.push({level,code,message:String(message).replace(EMAIL,'[email]'),fix:String(fix).replace(EMAIL,'[email]')});
  const now=signals.now?new Date(signals.now):new Date(),today=isoDay(now),mode=signals.mode??outreach.mode;
  const v=capabilities.verifier||{},c=capabilities.connections||{};
  // A positive reply that waits for a decision is the only step between a pitch and a link: it goes first.
  const owner=Number(funnel.needs_owner)||0;
  if(owner>0){
    // Count only: which condition a publisher attached (a fee, a link back) is their private negotiation, and joined with
    // the public list of won links it would name a publisher that sold a link. The kinds show only in the unlocked vault.
    const days=signals.owner_oldest_days;
    add('action','owner_decision_pending',`${plural(owner,'publisher reply is','publisher replies are')} waiting for your decision${Number.isFinite(days)?`; the oldest has waited ${plural(days,'day','days')}`:''}. Autopilot never answers these or agrees to terms by itself.`,
      'Read the thread in Gmail, or in the dashboard\'s Prospects tab (unlock the vault; "Needs your answer" rows sort first, with what each one asks for), and answer it yourself in the same thread. A fee needs your explicit approval; a link swap or guest post is your call.');
  }
  if(signals.vault?.key&&signals.vault.open===false)add('action','vault_locked','The private vault could not be opened with the saved key, so prospecting, outreach and reply reading are stopped, and the published funnel is from an earlier cycle.',
    'Restore the LINKFORGE_DATA_KEY secret that sealed public/data/vault.json (GitHub → Settings → Secrets and variables → Actions). Use "Create a new vault key" only if the old key is truly lost: a new vault forgets who was contacted and who opted out.');
  // A pending mailbox rebuild (a new vault) holds every send: pitches, follow-ups and automatic answers (rebuild.mjs).
  if(capabilities.rebuild_required){
    const rb=stages.rebuild,days=Number(signals.rebuild_days)||0,stuck=rb?.ok!==true||days>=2;
    const why=rb?.ok===false?`reading the mailbox failed (${String(rb.error||'unknown error').slice(0,100)})`:rb?.ok===null?`the mailbox could not be read (${String(rb.skipped||'').slice(0,100)})`
      :!rb?'the mailbox was not read this cycle':`the mailbox is still being read${rb.result?.why?` (${String(rb.result.why).replaceAll('_',' ').slice(0,100)})`:''}`;
    add(stuck?'action':'info','mailbox_rebuild_pending',`A new vault was started, so nothing is sent (no pitch, follow-up or automatic answer) until who was emailed and who opted out are restored from Gmail; ${why}${days?`. Pending for ${plural(days,'day','days')}`:''}.`,
      stuck?'Check the Gmail connection under ⚙ Connect (app password, IMAP on, the Sent Mail and All Mail folders visible to IMAP), then press Save & run now. Sending resumes by itself once the mailbox has been read back; never skip this step, it is what keeps opt-outs and the 90-day rule intact.'
        :'Handled automatically: sending resumes by itself once the mailbox has been read back.');
  }
  const blocked=stages.outreach?.result?.send_blocked;
  if(blocked){
    const why=({gmail_auth:'login refused',gmail_limit:'sending limit reached'}[blocked]||String(blocked)).replace(EMAIL,'[email]').slice(0,120);
    add('action','gmail_send_blocked',`Gmail refused to send (${why}), so sending stopped for the rest of this cycle.`,
      /auth|login|password|credential|53[45]/i.test(why)?'Create a new Gmail app password (Google Account → Security → App passwords) and save it under ⚙ Connect, then press Save & run now.'
      :/limit|quota|rate|too many|daily/i.test(why)?'Gmail\'s sending limit was reached. Sending resumes by itself on a later cycle; if this repeats, lower the daily limit under ⚙ Connect.'
      :'Open the Gmail account and check for a security alert or a sending block, then press Save & run now.');
  }
  // A whole site failing is the most expensive problem there is: Google drops URLs that keep answering 5xx.
  for(const s of indexation?.sites||[])if(s.alert&&s.server_error>=10)add('action','site_failing',`${s.site}: ${s.alert}`,
    'Fix the site itself first (hosting, database or plan limits, firewall). Links are not built to pages that fail, and this is re-checked every cycle.');
  for(const [k,label] of [['dataforseo','DataForSEO'],['gmail','Gmail']])if(c[k]?.status==='rejected')
    add('action',`${k}_rejected`,k==='dataforseo'?'DataForSEO rejected the saved login, so paid searches and link-gap discovery are stopped; the free sources (link neighbourhood, pages we cite, second looks) keep running.'
      :`${label} rejected the saved login, so that part of the pipeline is stopped.`,`Re-enter the ${label} credentials under ⚙ Connect.`);
  if(!v.ready)add('action','verifier_off',v.key?'Inbox verification is switched off (daily limit is 0), so no email can ever be sent.':'No inbox verifier is connected, so no email can ever be sent.',
    v.key?'Set "Mailbox checks per day" to 25 under ⚙ Connect (or leave it blank for 25, the Verifalia free plan\'s daily credits).':'Add a free Verifalia login under ⚙ Connect.');
  // The verifier's most recent answer is the truth: old hold reasons never override a later successful login.
  const denied=v.balance?v.balance.error||'':(Object.keys(outreach.holds||{}).find(k=>/verifalia_(login_rejected|permission_denied)/.test(k))||'').replace(/^mailbox_verifalia_/,'');
  if(denied==='permission_denied')add('action','verifier_permission',
    `Verifalia accepted the login but the user is not allowed to ${v.balance?.endpoint==='submit_validation'?'submit email verifications':'view the credits balance'} (HTTP 403), so no inbox can be verified.`,
    'In app.verifalia.com → Users, edit the user saved under ⚙ Connect and allow both "view credits balance" and "submit/retrieve email validations" (or save your main account login instead). A browser app key will not work: it cannot read the balance.');
  else if(denied==='login_rejected'||stages.preverify?.ok===false&&/login/.test(stages.preverify.error||''))add('action','verifier_rejected',
    'Verifalia rejected the saved login (HTTP 401), so no inbox can be verified or emailed.',
    'Check, in this order: (1) the account email is confirmed; (2) you saved the Verifalia USERNAME shown in app.verifalia.com → Users (may differ from your sign-up email) and its password, with no extra spaces; (3) two-factor authentication is OFF for that user (create a dedicated API user without 2FA). Then re-save under ⚙ Connect and press Save & run now.');
  // Proofs last 24 h and no inbox is verified while outreach is off, so this only names proofs bought while sending was on.
  // Under the deliberate OUTREACH_HOLD brake it is a note, not a request to switch sending back on.
  if(held&&outreach.mode==='off'&&(outreach.verified_ready||0)>0)
    add(signals.brake?'info':'action','hold_with_verified',`${outreach.verified_ready} verified inboxes are ready, but outreach is off${signals.brake?' (OUTREACH_HOLD=YES)':''}; their proofs expire within 24 hours.`,
      signals.brake?'Nothing to do while the brake is on on purpose. To send again, remove the OUTREACH_HOLD repository variable.':'Set the outreach mode to Hands-free under ⚙ Connect, and make sure repository variable OUTREACH_HOLD is not YES.');
  const holds=outreach.holds||{},heldCount=Object.values(holds).reduce((a,b)=>a+b,0);
  const topHold=Object.entries(holds).sort((a,b)=>b[1]-a[1])[0]||null;
  // ---- Outcome watchdog: sending that should happen but does not. Never on weekends, deliberate holds, dry runs or a locked vault. ----
  const quiet=!!signals.dry_run||!!signals.hold||mode!=='send'||!isWeekday(now)||signals.vault?.open===false;
  const ready=Number(funnel.ready)||0;let stalled=false;
  if(!quiet&&v.ready&&ready>0){
    const days=sendDays(history,today).slice(-2),base=days.length===2?history.filter(h=>h.date<days[0].date).at(-1):null;
    const recent=days.length===2&&Date.parse(today)-Date.parse(days[1].date)<=4*DAY; // Friday counts on Monday, older stretches do not
    const capUsed=days.length===2&&days.every(h=>Number.isFinite(h.sent)&&h.cap>0&&h.sent>=h.cap); // follow-ups filled the cap: not a stall
    if(recent&&!capUsed&&Number.isFinite(base?.contacted)&&(Number(funnel.contacted)||0)<=base.contacted){
      stalled=true;
      // Stable wording within a day (the issue body is rewritten only when this text changes).
      const credits=days.every(h=>Number.isFinite(h.verifier_used))?`${sum(days,h=>h.verifier_used)} verification credits were used on those days (daily limit ${v.daily_limit||0})`:`${v.used_today||0} of ${v.daily_limit||0} verification credits used today`;
      const skipped=stages.outreach?.skipped?` The outreach stage was skipped: ${String(stages.outreach.skipped).slice(0,120)}.`
        :stages.outreach?.result?.blocked_reason?` Sending was blocked: ${String(stages.outreach.result.blocked_reason).replaceAll('_',' ')}.`:'';
      // Out of credits with Verifalia's free balance at 0 (or fewer used than the daily limit): the credits were never there.
      const outOf=!!(stages.outreach?.result?.out_of_credits||stages.preverify?.result?.out_of_credits),used=days.every(h=>Number.isFinite(h.verifier_used))?sum(days,h=>h.verifier_used):null;
      const empty=outOf&&!v.balance?.error&&(Number(v.balance?.free_credits)===0||(used!=null&&v.daily_limit>0&&used<v.daily_limit*days.length));
      const reset=String(v.balance?.reset_in||'').replace(/[^0-9:.]/g,'').slice(0,12);
      add('action','sending_stalled',`No new publisher was emailed on the last 2 weekdays with open send windows, although ${ready} prospects are ready (${outreach.verified_ready||0} verified now).${empty?` Verifalia's free credit balance was empty${reset?` (it resets in ${reset})`:''}, so no inbox could be verified.`:topHold?` Most held inboxes wait because ${holdWhy(topHold[0])} (${topHold[1]}).`:''} ${credits}.${skipped}`,
        empty?'Check the Verifalia account (app.verifalia.com → Credits): whether the free plan and its daily credits are still active, and whether another tool or user spends the same free credits (give Autopilot its own sub-user). Autopilot uses only free credits unless VERIFALIA_ALLOW_PAID=YES, which is your decision.'
          :'Autopilot keeps retrying every cycle. If the outreach stage is skipped, fix that setting under ⚙ Connect; if credits run out before any inbox passes, the queue needs fresher, author-level addresses. To pause sending on purpose, set repository variable OUTREACH_HOLD=YES (this alert then stays quiet).');
    }
  }
  if(!quiet&&!stalled&&v.ready&&ready>0){
    const days=sendDays(history,today).filter(h=>Number.isFinite(h.sent)).slice(-5);
    if(days.length===5&&Date.parse(today)-Date.parse(days[4].date)<=4*DAY){
      const sent=sum(days,h=>h.sent),cap=sum(days,h=>Number.isFinite(h.cap)?h.cap:capabilities.daily_send_cap);
      if(cap>0&&sent<0.4*cap){
        const dry=days.filter(h=>v.daily_limit>0&&h.verifier_used>=v.daily_limit).length;
        add('warn','low_throughput',`${plural(sent,'email','emails')} went out over the last 5 weekdays, ${Math.round(100*sent/cap)}% of the ${cap} the daily cap allowed, while ${ready} prospects are ready.${dry?` Verification credits ran out on ${dry} of those days.`:''}${topHold?` Most held inboxes wait because ${holdWhy(topHold[0])}.`:''}`,
          'Usually the verification credits and the pass rate of queued inboxes set this ceiling (catch-all and unknown answers never pass). Fresher, author-level addresses raise it; a larger verification budget is your decision (paid credits stay off unless VERIFALIA_ALLOW_PAID=YES).');
      }
    }
  }
  const pd=signals.paid_discovery;
  if(pd?.dead)add('action','paid_discovery_dead',`Paid searches in the last ${plural(pd.cycles||3,'cycle','cycles')}${Number.isFinite(pd.queries)?` (${plural(pd.queries,'query','queries')}, ${(Number(pd.spend_usd)||0).toFixed(2)} USD)`:''} found 0 new sites, so paid search is paused until ${String(pd.paused_until||'').slice(0,16).replace('T',' ')} UTC; free sources continue.`,
    'Usually the search provider changed its result format or the searches are exhausted: check one raw DataForSEO SERP response against scripts/autopilot/serp-unwrap.mjs. Paid search resumes by itself after the pause, and this alert returns if it still finds nothing.');
  if(heldCount>=3){
    const [top,n]=topHold;
    add('info','holds',`${heldCount} queued inboxes are held; most often (${n}) because ${holdWhy(top)}.`,
      'Handled automatically; held inboxes are re-checked after 3 days.');
  }
  // Fresh verifiable addresses are the next bottleneck after verification: say so before the queue runs dry.
  if(signals.vault?.open!==false){
    const dl=Array.isArray(signals.discovery)?signals.discovery:[];let zero=0;for(let i=dl.length-1;i>=0&&!(dl[i]?.with_email>0);i--)zero++;
    const pool=Number(outreach.to_verify),limit=Number(v.daily_limit)||0;
    const poolLow=mode==='send'&&!signals.hold&&v.ready&&limit>0&&Number.isFinite(pool)&&pool<2*limit;
    if(zero>=3||poolLow)add('warn','prospect_inflow_low',[zero>=3?`No new publisher addresses were found in the last ${zero} cycles`:'',
      poolLow?`only ${plural(pool,'queued inbox is','queued inboxes are')} left to verify, under 2 days of verification credits (${limit} a day)`:''].filter(Boolean).join('; ').replace(/^./,x=>x.toUpperCase())+'.',
      'Free sources (the link neighbourhood and second-look checks) keep running by themselves. More inflow needs your decision on funding discovery: a DataForSEO top-up within the existing caps, or a Brave Search key.');
  }
  const vb=Number(capabilities.vault_bytes);
  if(Number.isFinite(vb)&&vb>=15*MiB)add(vb>=22*MiB?'action':'warn','vault_size',`The sealed vault is ${(vb/MiB).toFixed(1)} MiB. Cloudflare Pages rejects any file over 25 MiB, so every dashboard deploy fails once it gets there.`,
    'Outreach keeps running either way. Old rejected prospects are pruned automatically; if the size keeps rising, a developer must shrink or move public/data/vault.json before it reaches 25 MiB.');
  if(mode==='send'&&sender&&(!sender.postal_address||!sender.sender_name)){
    const missing=[!sender.sender_name&&'a sender name (SENDER_NAME), so nothing is sent',!sender.postal_address&&'a postal address for the email footer (SENDER_POSTAL_ADDRESS)'].filter(Boolean);
    add(sender.sender_name?'warn':'action','sender_identity_incomplete',`Hands-free sending is on without ${missing.join(' and without ')}.`,
      'Add it under ⚙ Connect (a P.O. box or mailbox service works for the postal address). Commercial-email rules such as CAN-SPAM expect a postal address in every email; sending is not paused for it.');
  }
  // Every cycle while a reply waits (also the one that drafted its answer): a draft is not an answer until the owner sends it.
  const waiting=Number(signals.replies_unanswered??funnel.awaiting_reply)||0,rd=stages.reply_drafts;
  if(waiting>0){
    const drafted=Math.min(waiting,Number(signals.replies_drafted)||0);
    const why=drafted>=waiting?`${drafted===1?'its answer is':'their answers are'} drafted in Gmail Drafts, waiting for you to send`
      :signals.reply_mode==='off'?'automatic reply drafts are off (REPLY_MODE=off)':rd?.ok===false?'drafting an answer failed this cycle'
      :rd?.skipped?`reply drafting was skipped (${String(rd.skipped).slice(0,80)})`:!rd?'no reply drafting ran this cycle':'no answer could be drafted automatically';
    add('warn','replies_waiting',`${plural(waiting,'publisher reply is','publisher replies are')} waiting for an answer; ${why}${drafted&&drafted<waiting?` (${drafted} already drafted)`:''}.`,
      'Answer in the same Gmail thread (drafts Autopilot wrote are in Gmail Drafts), or see the dashboard\'s Prospects tab. A reply is the only step between a pitch and a link.');
  }
  if(noPitchSites.length)add('warn','no_pitchable_page',`${noPitchSites.length} site${noPitchSites.length>1?'s have':' has'} no page worth pitching (${noPitchSites.slice(0,6).join(', ')}), so nothing is pitched for ${noPitchSites.length>1?'them':'it'}.`,
    'Editors link to tools, original data and in-depth guides. List that site\'s best such page under "assets" in functions/_lib/sites.js, or publish one.');
  const bal=c.dataforseo?.balance_usd,ext=spend.external||{};
  if(c.dataforseo?.status==='connected'&&Number.isFinite(bal)){
    if(bal<0.05)add('action','dataforseo_funds',`The DataForSEO balance is used up (${Math.max(0,bal).toFixed(2)} USD), so paid search and link-gap discovery are paused; free sources (the link neighbourhood and second-look checks) continue.`,
      'Top up at app.dataforseo.com (Billing) within the existing caps; paid discovery resumes by itself on the next cycle. How discovery is funded (a top-up or a Brave Search key) is your decision.');
    else if(bal<1.5)add('warn','dataforseo_low',`The DataForSEO balance is down to ${bal.toFixed(2)} USD.`,'Top up at app.dataforseo.com (Billing) before prospecting stops.');
  }
  if((ext.last_7d_usd||0)>=1)add('warn','dataforseo_external',`${ext.last_7d_usd.toFixed(2)} USD of the DataForSEO balance was spent outside Autopilot in the last 7 days.`,
    'Another tool or session uses the same DataForSEO account. Check the usage log at app.dataforseo.com, or give Autopilot its own account so its budget is protected.');
  const p=stages.prospects;
  // Guard against a silent provider format change: in Nov 2026 every Google result arrived as a google.com
  // redirect link and 100% were dropped as "platforms" for two weeks while queries were still paid for.
  const pr=p?.result||{},plat=pr.filtered?.platform_or_giant||0;
  if(pr.serp_results>=30&&plat>=pr.serp_results*0.9)add('action','serp_format',`${plat} of ${pr.serp_results} search results were discarded as platforms, which means the search provider's result format has probably changed.`,
    'Prospecting from searches is effectively stopped. Check one raw DataForSEO SERP response for the url/domain fields and update scripts/autopilot/serp-unwrap.mjs.');
  if(pr.linkgap_failed&&!pr.linkgap_calls)add('info','linkgap_unavailable','Competitor link-gap mining could not run (DataForSEO Backlinks API refused or failed).',
    'If your DataForSEO plan lacks the Backlinks API, activate it at app.dataforseo.com (it is retried automatically after 7 days).');
  if(capabilities.claude===false&&!capabilities.ai_writer&&(funnel.contacted||0)>=20)add('warn','templates_only',`All ${funnel.contacted} pitches so far were fixed templates (${funnel.replied||0} replies).`,
    'Add an Anthropic API key, or a free Groq or Gemini API key, under ⚙ Connect so every pitch is written for that exact page and link.');
  if(p?.ok&&p.result?.queries>=8&&!p.result?.candidates&&!p.result?.from_queue)add('warn','discovery_saturated',`${p.result.queries} searches found no site that has not been evaluated already.`,'Handled automatically: search volume is halved and long-tail searches built from each page\'s own phrases take priority.');
  else if(p?.ok&&p.result?.queries>=8&&!p.result?.qualified&&!p.result?.deferred)add('warn','no_qualified',`${p.result.queries} searches produced 0 qualified prospects this cycle.`,'Usually transient; if it repeats, the promoted pages may need stronger topical matches.');
  if(p?.result&&(p.result.failed_queries||0)>Math.max(2,p.result.queries/3))add('warn','dataforseo_errors',`${p.result.failed_queries} DataForSEO searches failed (provider errors); they are retried next cycle.`,'No action unless it persists for a day.');
  if(spend.daily_cap_usd&&spend.today_usd>=spend.daily_cap_usd*0.95)add('info','spend_cap','Today\'s DataForSEO spend cap is reached; prospecting resumes tomorrow.','Raise DATAFORSEO_DAILY_USD only if you want faster prospecting.');
  for(const [name,s] of Object.entries(stages))if(s?.ok===false&&!['prospects','preverify','rebuild'].includes(name))add('warn',`stage_${name}`,`The ${name.replace('_',' ')} stage failed: ${String(s.error||'').slice(0,120)}`,'It retries automatically next cycle.');
  if((funnel.ready||0)<20&&!out.some(x=>x.level==='action'))add('info','queue_low','Fewer than 20 pitch-ready prospects are queued.','Autopilot widens its searches automatically; no action needed.');
  const rank={action:0,warn:1,info:2};
  return out.sort((a,b)=>rank[a.level]-rank[b.level]);
}
