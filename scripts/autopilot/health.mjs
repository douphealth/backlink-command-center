/**
 * Self-monitoring and self-tuning. After every cycle Autopilot
 *  1. tunes its own search volume to the time it really had (backs off after an overrun,
 *     grows when there was headroom), and
 *  2. publishes a short list of what it cannot fix by itself, with the exact fix,
 *     so nobody has to read logs to find out why links aren't coming in.
 */
export const TUNING={minQueries:8,maxQueries:40,step:4,start:24};

/** Next run's search budget from this run's prospect stage outcome. */
export function autotune(state,prospects,{envQueries}={}){
  state.tuning??={};
  if(envQueries!=null)return state.tuning.max_queries=envQueries; // an explicit owner setting always wins
  let q=Number(state.tuning.max_queries)||TUNING.start;
  const r=prospects?.result||{};
  if(prospects?.ok===false&&/time budget/.test(prospects.error||'')||r.deferred>0)q-=TUNING.step;      // ran out of time
  else if(prospects?.ok&&r.queries>=q&&(r.failed_queries||0)<=r.queries/4)q+=TUNING.step;              // used it all, cleanly
  state.tuning.max_queries=Math.max(TUNING.minQueries,Math.min(TUNING.maxQueries,q));
  state.tuning.updated_at=new Date().toISOString();
  return state.tuning.max_queries;
}

/** What needs the owner, most important first. Public data: no addresses, no prospect names. */
export function diagnose({stages={},capabilities={},outreach={},funnel={},spend={},held=true}){
  const out=[],add=(level,code,message,fix)=>out.push({level,code,message,fix});
  const v=capabilities.verifier||{},c=capabilities.connections||{};
  for(const [k,label] of [['dataforseo','DataForSEO'],['gmail','Gmail']])if(c[k]?.status==='rejected')
    add('action',`${k}_rejected`,`${label} rejected the saved login, so that part of the pipeline is stopped.`,`Re-enter the ${label} credentials under ⚙ Connect.`);
  if(!v.ready)add('action','verifier_off',v.key?'Inbox verification is switched off (daily limit is 0), so no email can ever be sent.':'No inbox verifier is connected, so no email can ever be sent.',
    v.key?'Set "Mailbox checks per day" to 12 under ⚙ Connect (or leave it blank).':'Add a free Verifalia login under ⚙ Connect.');
  // The verifier's most recent answer is the truth: old hold reasons never override a later successful login.
  const denied=v.balance?v.balance.error||'':(Object.keys(outreach.holds||{}).find(k=>/verifalia_(login_rejected|permission_denied)/.test(k))||'').replace(/^mailbox_verifalia_/,'');
  if(denied==='permission_denied')add('action','verifier_permission',
    `Verifalia accepted the login but the user is not allowed to ${v.balance?.endpoint==='submit_validation'?'submit email verifications':'view the credits balance'} (HTTP 403), so no inbox can be verified.`,
    'In app.verifalia.com → Users, edit the user saved under ⚙ Connect and allow both "view credits balance" and "submit/retrieve email validations" (or save your main account login instead). A browser app key will not work: it cannot read the balance.');
  else if(denied==='login_rejected'||stages.preverify?.ok===false&&/login/.test(stages.preverify.error||''))add('action','verifier_rejected',
    'Verifalia rejected the saved login (HTTP 401), so no inbox can be verified or emailed.',
    'Check, in this order: (1) the account email is confirmed; (2) you saved the Verifalia USERNAME shown in app.verifalia.com → Users (may differ from your sign-up email) and its password, with no extra spaces; (3) two-factor authentication is OFF for that user (create a dedicated API user without 2FA). Then re-save under ⚙ Connect and press Save & run now.');
  if(held&&outreach.mode==='off'&&(outreach.verified_ready||0)>0)
    add('action','hold_with_verified',`${outreach.verified_ready} verified inboxes are ready, but the workflow's outbound safety hold keeps sending off.`,'When you are ready to send, ask to lift the hold (one line in .github/workflows/autopilot.yml).');
  const holds=outreach.holds||{},heldCount=Object.values(holds).reduce((a,b)=>a+b,0);
  if(heldCount>=3){
    const [top,n]=Object.entries(holds).sort((a,b)=>b[1]-a[1])[0];
    const why={only_non_editorial_inbox_published:'the only address is not on the publisher\'s contact/about page or is not an accepted inbox type',
      no_email_published:'the publisher publishes no email address at all (contact form only)',publisher_pages_unreachable:'the publisher pages could not be fetched',
      catch_all_domain:'the mail server accepts every address, so no inbox can be proven',mailbox_invalid:'the inbox does not exist',
      'mailbox_verifalia_free_credits_used_up':'today\'s free verification credits are used up','mailbox_verification_budget_exhausted':'today\'s verification limit is used up'}[top]||top.replaceAll('_',' ');
    add('info','holds',`${heldCount} queued inboxes are held; most often (${n}) because ${why}.`,
      'Handled automatically; held inboxes are re-checked after 3 days.');
  }
  const p=stages.prospects;
  if(p?.ok&&p.result?.queries>=8&&!p.result?.qualified&&!p.result?.deferred)add('warn','no_qualified',`${p.result.queries} searches produced 0 qualified prospects this cycle.`,'Usually transient; if it repeats, the promoted pages may need stronger topical matches.');
  if(p?.result&&(p.result.failed_queries||0)>Math.max(2,p.result.queries/3))add('warn','dataforseo_errors',`${p.result.failed_queries} DataForSEO searches failed (provider errors); they are retried next cycle.`,'No action unless it persists for a day.');
  if(spend.daily_cap_usd&&spend.today_usd>=spend.daily_cap_usd*0.95)add('info','spend_cap','Today\'s DataForSEO spend cap is reached; prospecting resumes tomorrow.','Raise DATAFORSEO_DAILY_USD only if you want faster prospecting.');
  for(const [name,s] of Object.entries(stages))if(s?.ok===false&&!['prospects','preverify'].includes(name))add('warn',`stage_${name}`,`The ${name.replace('_',' ')} stage failed: ${String(s.error||'').slice(0,120)}`,'It retries automatically next cycle.');
  if((funnel.ready||0)<20&&!out.some(x=>x.level==='action'))add('info','queue_low','Fewer than 20 pitch-ready prospects are queued.','Autopilot widens its searches automatically; no action needed.');
  const rank={action:0,warn:1,info:2};
  return out.sort((a,b)=>rank[a.level]-rank[b.level]);
}
