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
  if(stages.preverify?.ok===false&&/login/.test(stages.preverify.error||''))add('action','verifier_rejected','Verifalia rejected the login.','Re-enter the Verifalia username and password under ⚙ Connect.');
  if(held&&outreach.mode==='off'&&(outreach.verified_ready||0)>0)
    add('action','hold_with_verified',`${outreach.verified_ready} verified inboxes are ready, but the workflow's outbound safety hold keeps sending off.`,'When you are ready to send, ask to lift the hold (one line in .github/workflows/autopilot.yml).');
  const p=stages.prospects;
  if(p?.ok&&p.result?.queries>=8&&!p.result?.qualified&&!p.result?.deferred)add('warn','no_qualified',`${p.result.queries} searches produced 0 qualified prospects this cycle.`,'Usually transient; if it repeats, the promoted pages may need stronger topical matches.');
  if(p?.result&&(p.result.failed_queries||0)>Math.max(2,p.result.queries/3))add('warn','dataforseo_errors',`${p.result.failed_queries} DataForSEO searches failed (provider errors); they are retried next cycle.`,'No action unless it persists for a day.');
  if(spend.daily_cap_usd&&spend.today_usd>=spend.daily_cap_usd*0.95)add('info','spend_cap','Today\'s DataForSEO spend cap is reached; prospecting resumes tomorrow.','Raise DATAFORSEO_DAILY_USD only if you want faster prospecting.');
  for(const [name,s] of Object.entries(stages))if(s?.ok===false&&!['prospects','preverify'].includes(name))add('warn',`stage_${name}`,`The ${name.replace('_',' ')} stage failed: ${String(s.error||'').slice(0,120)}`,'It retries automatically next cycle.');
  if((funnel.ready||0)<20&&!out.some(x=>x.level==='action'))add('info','queue_low','Fewer than 20 pitch-ready prospects are queued.','Autopilot widens its searches automatically; no action needed.');
  const rank={action:0,warn:1,info:2};
  return out.sort((a,b)=>rank[a.level]-rank[b.level]);
}
