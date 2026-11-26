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
  const yieldPerQuery=r.queries?(r.candidates||0)/r.queries:null;
  if(prospects?.ok===false&&/time budget/.test(prospects.error||'')||r.deferred>0)q-=TUNING.step;      // ran out of time
  else if(r.queries>=8&&yieldPerQuery<0.2)q=Math.floor(q/2);                                         // searches find almost nothing new: stop paying for them
  else if(prospects?.ok&&r.queries>=q&&yieldPerQuery>=1&&(r.failed_queries||0)<=r.queries/4)q+=TUNING.step; // productive and used it all
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
    add('action','hold_with_verified',`${outreach.verified_ready} verified inboxes are ready, but outreach is off.`,'Set the outreach mode to Hands-free under ⚙ Connect, and make sure repository variable OUTREACH_HOLD is not YES.');
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
  const bal=c.dataforseo?.balance_usd,ext=spend.external||{};
  if(c.dataforseo?.status==='connected'&&Number.isFinite(bal)){
    if(bal<0.05)add('action','dataforseo_funds',`The DataForSEO balance is used up (${Math.max(0,bal).toFixed(2)} USD), so no new prospects can be found.`,
      'Top up at app.dataforseo.com (Billing). Prospecting resumes by itself on the next cycle.');
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
  if(capabilities.claude===false&&(funnel.contacted||0)>=20)add('warn','templates_only',`All ${funnel.contacted} pitches so far were fixed templates (${funnel.replied||0} replies).`,
    'Add an Anthropic API key under ⚙ Connect so every pitch is written for that exact page and link.');
  if(p?.ok&&p.result?.queries>=8&&!p.result?.candidates&&!p.result?.from_queue)add('warn','discovery_saturated',`${p.result.queries} searches found no site that has not been evaluated already.`,'Handled automatically: search volume is halved and long-tail searches built from each page\'s own phrases take priority.');
  else if(p?.ok&&p.result?.queries>=8&&!p.result?.qualified&&!p.result?.deferred)add('warn','no_qualified',`${p.result.queries} searches produced 0 qualified prospects this cycle.`,'Usually transient; if it repeats, the promoted pages may need stronger topical matches.');
  if(p?.result&&(p.result.failed_queries||0)>Math.max(2,p.result.queries/3))add('warn','dataforseo_errors',`${p.result.failed_queries} DataForSEO searches failed (provider errors); they are retried next cycle.`,'No action unless it persists for a day.');
  if(spend.daily_cap_usd&&spend.today_usd>=spend.daily_cap_usd*0.95)add('info','spend_cap','Today\'s DataForSEO spend cap is reached; prospecting resumes tomorrow.','Raise DATAFORSEO_DAILY_USD only if you want faster prospecting.');
  for(const [name,s] of Object.entries(stages))if(s?.ok===false&&!['prospects','preverify'].includes(name))add('warn',`stage_${name}`,`The ${name.replace('_',' ')} stage failed: ${String(s.error||'').slice(0,120)}`,'It retries automatically next cycle.');
  if((funnel.ready||0)<20&&!out.some(x=>x.level==='action'))add('info','queue_low','Fewer than 20 pitch-ready prospects are queued.','Autopilot widens its searches automatically; no action needed.');
  const rank={action:0,warn:1,info:2};
  return out.sort((a,b)=>rank[a.level]-rank[b.level]);
}
