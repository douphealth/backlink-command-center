/**
 * Autopilot view: reads the engine's public summary (/data/autopilot.json) and,
 * once unlocked with LINKFORGE_DATA_KEY, decrypts prospect details from
 * /data/vault.json entirely in this browser. The key never leaves the device.
 */
import * as control from './github-control.js';
const KEY='linkforge-autopilot-key';
const REPO='https://github.com/'+control.REPO;
const store={get:()=>{try{return localStorage.getItem(KEY)||''}catch{return ''}},set:v=>{try{v?localStorage.setItem(KEY,v):localStorage.removeItem(KEY)}catch{}}};
// One-click unlock link: https://…pages.dev/#key=YOUR_KEY (hash is never sent to the server).
if(location.hash.startsWith('#key=')){store.set(decodeURIComponent(location.hash.slice(5)));history.replaceState(null,'',location.pathname+'#autopilot')}

const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function openVault(box,pass){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pass),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:b64(box.salt),iterations:box.iterations},base,{name:'AES-GCM',length:256},false,['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(box.iv)},key,b64(box.ct))));
}
// One retry on network failure, then a clear error the view can explain (instead of a raw "Failed to fetch").
const fetchJson=async url=>{
  for(let attempt=0;;attempt++){
    try{const r=await fetch(url,{cache:'no-store'});if(!r.ok||!(r.headers.get('content-type')||'').includes('json'))return null;return await r.json()}
    catch(err){if(attempt>=1){const e=Error('offline');e.offline=true;throw e}await new Promise(r=>setTimeout(r,1200))}
  }
};
const LIVE='https://backlink-command-center.pages.dev/#autopilot';
function offlineCard(h){
  const local=!/\.pages\.dev$/.test(location.hostname);
  return h.intro('autopilot','')+`<div class="alert-warning ap-missing"><strong>This page can't reach its server right now.</strong> ${local?`You're on a local or preview copy (<code>${h.escapeHTML(location.host)}</code>) that is no longer running. Open the live dashboard instead: <a href="${LIVE}">backlink-command-center.pages.dev</a>.`:'Check your internet connection, then reload the page. Nothing you saved has been lost.'}</div>`;
}
const ago=t=>{if(!t)return 'never';const m=Math.round((Date.now()-Date.parse(t))/60000);return m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':Math.round(m/1440)+' d ago'};
function nextRun(last){const t=Math.max(Date.parse(last||0)+5*36e5,Date.now());const d=new Date(t);if(d.getUTCMinutes()>23)d.setUTCHours(d.getUTCHours()+1);d.setUTCMinutes(23,0,0);return d}

const STATUS_ORDER=['positive','won','replied','followed_up','sent','drafted','ready','contact_form','no_contact','already_linked','declined','bounced','skipped_duplicate','rejected'];
const ui={filter:'active',vault:null,error:'',control:null,configured:null,tokenError:'',showConnect:false,msg:'',err:'',busy:'',settleUntil:0};
let reloadView=null,pollTimer=null;
const FIELDS=[
  {name:'DATAFORSEO_LOGIN',label:'DataForSEO login (email)',type:'email',kind:'secret',required:true,help:'DataForSEO dashboard → API Access',link:'https://app.dataforseo.com/api-access'},
  {name:'DATAFORSEO_PASSWORD',label:'DataForSEO API password',type:'password',kind:'secret',required:true,help:'The API password, not your website login'},
  {name:'GMAIL_ADDRESS',label:'Gmail address that sends outreach',type:'email',kind:'secret',required:true},
  {name:'GMAIL_APP_PASSWORD',label:'Gmail app password (16 letters)',type:'password',kind:'secret',required:true,help:'Create one at myaccount.google.com/apppasswords (needs 2-Step Verification)',link:'https://myaccount.google.com/apppasswords'},
  {name:'SENDER_NAME',label:'Your name in emails',type:'text',kind:'setting',required:true,help:'e.g. Alex from GearUpToFit'},
  {name:'OUTREACH_MODE',label:'Outreach mode',type:'select',kind:'setting',options:[['send','Hands-free: send pitches + 1 follow-up automatically'],['draft','Safe: write pitches into Gmail Drafts'],['off','Research only']]},
  {name:'OUTREACH_DAILY_LIMIT',label:'Max new pitches per day',type:'number',kind:'setting',help:'Starts at 5/day and ramps up by 2/day to this limit'},
  {name:'ANTHROPIC_API_KEY',label:'Anthropic API key (optional)',type:'password',kind:'secret',help:'Claude writes a unique pitch for every page'},
];
// Settings travel as one encrypted secret (no Variables permission needed); this browser remembers them for display.
const local=(k,fallback)=>({get:()=>{try{return JSON.parse(localStorage.getItem(k))??fallback}catch{return fallback}},set:v=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}}});
const savedSettings=local('linkforge-settings',{});
const vaultResetAt=local('linkforge-vault-reset-at','');
async function refreshControl(){
  try{ui.control=await control.status()}catch(err){ui.control={error:err.message}}
  // The token check costs 4 GitHub calls; reuse it for 5 minutes unless something changed.
  if(!control.token.get())ui.diag=null;
  else if(!ui.diag||ui.forceDiag||Date.now()-(ui.diagAt||0)>300000){ui.diag=await control.diagnose({probeActions:!!ui.forceDiag||!ui.diag});ui.diagAt=Date.now();ui.forceDiag=false}
  ui.configured=ui.diag?.secrets?{secrets:ui.diag.secretNames}:null;
}
function schedulePoll(){
  clearTimeout(pollTimer);
  const live=ui.control?.running||Date.now()<ui.settleUntil;
  if(!live||ui.showConnect||!reloadView)return;
  pollTimer=setTimeout(()=>{if(!location.hash||location.hash==='#autopilot')reloadView()},control.token.get()?15000:60000);
}

export async function renderAutopilot(h){
  const {escapeHTML:e,external,n,niceTime,statusTag,panel,table,empty,intro}=h;
  let s;try{s=await fetchJson('/data/autopilot.json')}catch(err){if(err.offline)return offlineCard(h);throw err}
  if(!s)return intro('autopilot')+`<div class="focus-bar"><div><strong>Autopilot has not published its first run yet.</strong><p>It runs twice a day in GitHub Actions and redeploys this dashboard automatically. Start it now from GitHub.</p></div><a class="primary" target="_blank" rel="noopener" href="${REPO}/actions/workflows/autopilot.yml">Run Autopilot ↗</a></div>`;
  await refreshControl();
  const key=store.get();
  // A freshly created key keeps retrying until the run that re-seals the vault has deployed.
  if(key&&!ui.vault&&(!ui.error||ui.pendingVault)){const box=await fetchJson('/data/vault.json').catch(()=>null);if(box){try{ui.vault=await openVault(box,key);ui.pendingVault=false;ui.error=''}catch{ui.pendingVault=vaultResetAt.get()>(box.sealed_at||'');if(ui.pendingVault)ui.settleUntil=Math.max(ui.settleUntil,Date.now()+60000);ui.error=ui.pendingVault?'New vault key saved. It unlocks automatically once the next Autopilot run finishes.':'That key does not unlock this vault. Check you pasted the vault key (not the GitHub token), or create a new vault key.'}}}
  const c=s.capabilities,f=s.funnel||{},t=s.totals;
  const missing=s.setup.filter(x=>!x.done);
  const modeLabel={send:'HANDS-FREE SENDING',draft:'DRAFTS TO GMAIL',off:'RESEARCH ONLY'}[c.outreach_mode];
  const ctl=ui.control||{};
  if(ctl.running)ui.settleUntil=Date.now()+150000; // keep refreshing until Pages has deployed the new results
  // GitHub's scheduler can run hours late or skip slots. If a cycle is overdue while the schedule is on
  // (not stopped), opening the dashboard starts a catch-up run, at most once per 30 minutes.
  const overdueHours=(Date.now()-Date.parse(s.generated_at))/36e5,lastCatchUp=Number(local('linkforge-catch-up-at',0).get());
  if(control.diagnosisOk(ui.diag)&&ctl.enabled&&!ctl.running&&!ui.busy&&overdueHours>7&&Date.now()-lastCatchUp>30*60e3){
    local('linkforge-catch-up-at',0).set(Date.now());
    try{await control.run();ui.settleUntil=Date.now()+600000;ui.msg=`The last cycle was ${Math.round(overdueHours)} h ago (GitHub's scheduler ran late), so a catch-up run was started.`;ctl.running=true}
    catch(err){ui.err='Catch-up run could not start: '+err.message}
  }
  const state=ctl.error?['off','STATUS UNAVAILABLE',ctl.error]:ctl.running?['running','RUNNING NOW',`Started ${ago(ctl.run.started)}; results appear here automatically`]:ctl.enabled?['on','ON · AUTOPILOT',`Next automatic cycle around ${niceTime(nextRun(s.generated_at).toISOString())} (checked hourly)`]:['off','STOPPED','No automatic runs until you press Run'];
  const summaryLine=`Last results ${ago(s.generated_at)} · ${n(t.pages_crawled)} pages audited · ${modeLabel.toLowerCase()} · DataForSEO $${s.spend.today_usd.toFixed(2)} today / $${s.spend.month_usd.toFixed(2)} month (caps $${s.spend.daily_cap_usd} / $${s.spend.monthly_cap_usd})`;
  const status=`<div class="ap-control"><div class="ap-state"><span class="ap-dot ${state[0]}"></span><div><strong>${e(state[1])}</strong><p>${e(state[2])}${ctl.run?.url?` · <a href="${e(ctl.run.url)}" target="_blank" rel="noopener">${ctl.running?'watch live':'last run log'} ↗</a>`:''}</p><p>${e(summaryLine)}</p>${outreachLine(s,h)}</div></div>
    <div class="ap-buttons"><button class="ap-run" data-ap="run" ${ctl.running||ui.busy?'disabled':''}>${ui.busy==='run'?'Starting…':ctl.running?'Running…':'▶ Run'}</button><button class="ap-stop" data-ap="stop" ${(!ctl.enabled&&!ctl.running)||ui.busy?'disabled':''}>${ui.busy==='stop'?'Stopping…':'■ Stop'}</button><button class="outline-btn" data-ap="connect">⚙ Connect</button></div></div>
    ${ui.msg?`<div class="ap-msg">${e(ui.msg)}</div>`:''}${ui.err?`<div class="alert-warning">${e(ui.err)}</div>`:''}`;
  const needsSetup=missing.some(x=>x.required)&&!fullyConfigured();
  // Say plainly what is still unconnected: pressing Run alone never saves credentials.
  const notConnected=ui.configured?[['DataForSEO',['DATAFORSEO_LOGIN','DATAFORSEO_PASSWORD']],['Gmail',['GMAIL_ADDRESS','GMAIL_APP_PASSWORD']]].filter(([,keys])=>keys.some(k=>!ui.configured.secrets.has(k))).map(([label])=>label):[];
  // A rejection only counts if that run used the credentials saved now (not ones re-entered since).
  const conn=s.capabilities.connections||{},updated=ui.diag?.secretUpdated||{};
  const SERVICES={dataforseo:['DataForSEO',['DATAFORSEO_LOGIN','DATAFORSEO_PASSWORD']],gmail:['Gmail',['GMAIL_ADDRESS','GMAIL_APP_PASSWORD']]};
  ui.rejected=new Set();const rejectedMsgs=[];
  for(const [k,[label,keys]] of Object.entries(SERVICES)){
    if(conn[k]?.status!=='rejected')continue;
    if(keys.some(x=>updated[x]&&updated[x]>s.generated_at))continue; // re-entered after this run: wait for the next one
    keys.forEach(x=>ui.rejected.add(x));rejectedMsgs.push(`<li><b>${label}:</b> ${e(conn[k].error||'login rejected')}</li>`);
  }
  const okList=Object.entries(SERVICES).filter(([k])=>conn[k]?.status==='connected').map(([,[l]])=>l);
  const banner=(rejectedMsgs.length?`<div class="alert-warning ap-missing"><strong>The last run couldn't log in:</strong><ul class="ap-list">${rejectedMsgs.join('')}</ul>Re-enter them in <b>step 2</b> below and press <b>Save &amp; run now</b>.</div>`:'')
    +(notConnected.length?`<div class="alert-warning ap-missing"><strong>Not connected yet: ${e(notConnected.join(' and '))}.</strong> Runs do research only until you fill in <b>step 2</b> below and press <b>Save &amp; run now</b>. ▶ Run by itself doesn't save credentials.</div>`:'')
    +(!rejectedMsgs.length&&!notConnected.length&&okList.length?`<div class="ap-msg">✓ Verified by the last run: ${e(okList.join(' and '))} logged in successfully.</div>`:'');
  const setup=ui.showConnect||needsSetup||rejectedMsgs.length||!control.diagnosisOk(ui.diag)?connectPanel(h):'';
  const kpis=[['Best URLs to promote',t.promotable,'◎',`${n(t.promoting_now)} being promoted now`],['Internal link fixes',t.internal_suggestions,'⇄','Free ranking boosts on your own sites'],['Publishers contacted',f.contacted,'↗',`${n(f.ready)} ready · ${n(f.replied)} replied`],['Backlinks won',f.won,'◇',`+${n(f.existing_links)} existing links found`]];
  const kpiHtml=`<div class="kpi-grid">${kpis.map(([name,v,ico,note])=>`<div class="kpi"><div class="kpi-head">${e(name)}<span class="kpi-ico">${ico}</span></div><div class="kpi-value">${n(v)}</div><div class="kpi-foot">${e(note)}</div></div>`).join('')}</div>`;
  // Change since the previous day's record, so progress is visible even when totals look similar.
  const hist=s.history||[],prev=hist.length>1?hist[hist.length-2]:null;
  const delta=k=>{if(!prev)return '';const d=(f[k]||0)-(prev[k]||0);return d?`<small class="ap-delta ${d>0?'up':'down'}">${d>0?'+':''}${n(d)} today</small>`:'<small class="ap-delta">no change today</small>'};
  const steps=[['Prospects evaluated','prospects_evaluated'],['Qualified publishers','qualified'],['Contacted','contacted'],['Replied','replied'],['Links won','won']];
  const top=Math.max(1,f.prospects_evaluated||0);
  const funnel=`<div class="panel-pad pipeline ap-funnel">${steps.map(([k,key])=>`<div class="pipeline-row"><span>${k}</span><div class="pipeline-track"><div class="pipeline-fill" data-w="${Math.min(100,100*(f[key]||0)/top)}"></div></div><strong>${n(f[key])}${delta(key)}</strong></div>`).join('')}</div>`;
  const stageRows=Object.entries(s.stages).map(([k,v])=>`<div class="site-row"><div class="site-monogram">${v.ok?'✓':v.ok===false?'!':'–'}</div><div><strong>${e(k.replace('_',' '))}</strong><small>${e(v.ok===false?v.error:v.skipped?'Skipped: '+v.skipped:v.result?Object.entries(v.result).filter(([,x])=>typeof x!=='object').map(([a,b])=>`${a.replaceAll('_',' ')} ${b}`).join(' · '):'ok')}</small></div>${statusTag(v.ok?'completed':v.ok===false?'failed':'hold')}</div>`).join('');
  const best=(s.best_urls||[]).slice(0,40).map((a,i)=>`<tr><td><strong>${String(i+1).padStart(2,'0')}</strong></td><td>${external(a.url,a.title)}<small>${e(a.site)} · ${e(a.type.replaceAll('_',' '))}${a.promoting?' · promoting now':''}</small><small class="ap-why">${e((a.reasons||[]).join(' · '))}</small></td><td><strong>${n(a.promotion)}</strong><small>link ${n(a.linkability)}${a.demand!=null?' · demand '+n(a.demand):''}</small></td><td>${n(a.internal_inlinks)}<small>${n(a.internal_link_suggestions)} to add</small></td><td>${n(a.prospects)}</td></tr>`);
  const internal=(s.internal_links||[]).slice(0,60).map(x=>`<tr><td>${external(x.from,x.from_title||x.from)}<small>${e(x.site)}</small></td><td><strong>“${e(x.anchor)}”</strong></td><td>${external(x.to,x.to_title||x.to)}</td></tr>`);
  const wins=(s.wins||[]).map(w=>`<tr><td><strong>${e(w.publisher)}</strong><small>${e(w.site)}</small></td><td>${external(w.page_url,w.title||w.page_url)}</td><td>${w.target?external(w.target,new URL(w.target).pathname):'—'}<small>${e(w.anchor)}</small></td><td>${statusTag(w.kind==='won'?'won':'existing')} ${w.rel?`<small>${e(w.rel)}</small>`:''}</td><td>${e(niceTime(w.found_at))}</td></tr>`);
  schedulePoll();
  return intro('autopilot','')+status+banner+setup+kpiHtml+
    `<div class="overview-grid">${panel('Outreach funnel','Every number is a stored, verified record',funnel)}${panel('Last cycle','Each stage runs independently',`<div class="sites-list">${stageRows}</div>`)}</div>`+
    `<div class="ap-gap">${panel('Best URLs to promote','Linkability × real search demand; templated duplicates and thin pages are demoted',best.length?table(['#','URL & why','Score','Internal links','Prospects'],best):empty('No promotable URLs yet','The next crawl will rank your pages.'))}</div>`+
    learningPanel(h,s)+
    `<div class="ap-gap">${panel('Internal link plan','Add these links on your own pages: highest-ROI, zero-cost ranking boost',internal.length?table(['On this page','Add anchor','Linking to'],internal):empty('No internal gaps found','Your best URLs are already well linked.'))}</div>`+
    `<div class="ap-gap">${panel('Backlinks','Won after outreach, or already linking to you (verified on the live page)',wins.length?table(['Publisher','Page','Links to','Status','Found'],wins):empty('No verified backlinks yet','Pitched pages are re-checked every 4 days for 150 days.'))}</div>`+
    `<div class="ap-gap">${privatePanel(h)}</div>`+
    `<details class="data-note"><summary><strong>Last run log</strong></summary><div class="pre-detail ap-log">${e((s.log||[]).join('\n'))}</div></details>`;
}

const FP_LABEL={mention:'Unlinked brand mentions',intent:'Same-topic articles',resources:'"{topic} resources"',intitle_resources:'intitle:resources',useful_links:'"useful links" pages',tools:'"{topic} tools"',free_tools:'"free {topic} tools"',best_resources:'"best {topic} resources"',useful_websites:'"useful websites"',statistics:'"{topic} statistics"',research_resources:'"research resources"',sources:'"{topic} sources"',blogs_to_follow:'"blogs to follow"',recommended_reading:'"recommended reading"',inurl_resources:'inurl:resources',inurl_links:'inurl:links',best_guides:'"best … guides"',k_resources:'"{page topic} resources"'};
function learningPanel(h,s){
  const {escapeHTML:e,external,n,panel,table,empty}=h,L=s.learning;
  if(!L)return '';
  const fps=(L.footprints||[]).slice(0,10).map(x=>`<tr><td><strong>${e(FP_LABEL[x.footprint]||x.footprint)}</strong></td><td>${n(x.queries)}</td><td>${n(x.ready)}</td><td><strong>${Math.round(x.rate*100)}%</strong><small>${x.queries<3?'still testing':''}</small></td></tr>`);
  const assets=(L.assets||[]).slice(0,10).map(x=>`<tr><td>${external(x.url,new URL(x.url).pathname)}</td><td>${n(x.sent)}</td><td>${n(x.replied)}</td><td>${n(x.positive)}</td><td>${n(x.won)}</td></tr>`);
  return `<div class="ap-gap">${panel('What Autopilot is learning: searches','Search patterns ranked by pitchable prospects found per search; the best ones are used first',fps.length?table(['Search pattern','Searches','Prospects','Yield'],fps):empty('Not enough data yet','Yields appear after the first searches.'))}</div><div class="ap-gap">${panel('Which of your pages earn replies','Pages with better reply and link rates get more prospecting',assets.length?table(['Page','Pitched','Replies','Positive','Links won'],assets):empty('No pitches yet','Results appear after the first pitches.'))}</div>`;
}
/** Plain answer to "why aren't more pitches going out?" */
function outreachLine(s,{escapeHTML:e,n,niceTime}){
  const o=s.outreach;if(!o||o.mode==='off')return '';
  const next=o.next_send_at?niceTime(o.next_send_at):null;
  const why=o.sent_today>=o.cap_today?`today's warm-up limit is used (${n(o.sent_today)}/${n(o.cap_today)})`:o.sending_now?'sending during this run':`waiting for recipients' business hours (weekdays)`;
  return `<p class="ap-outreach"><b>Pitches:</b> ${n(o.ready)} ready · ${e(why)}${next&&!o.sending_now?` · next pitches from <b>${e(next)}</b>`:''}</p>`;
}
function fullyConfigured(){
  const c=ui.configured;if(!c)return false;
  return FIELDS.filter(f=>f.required).every(f=>fieldDone(f,c))&&c.secrets.has('LINKFORGE_DATA_KEY');
}
function fieldDone(f,c){
  // Settings are saved together; the terminal setup script stores them as plain secrets.
  return f.kind==='secret'?c.secrets.has(f.name):c.secrets.has(control.SETTINGS_SECRET)||c.secrets.has(f.name);
}
function tokenStep(h){
  const {escapeHTML:e}=h,d=ui.diag,has=!!control.token.get(),ok=control.diagnosisOk(d);
  const row=(state,label,fix)=>`<div class="ap-check ${state===true?'done':''}"><span>${state===true?'✓':state===false?'✗':'…'}</span><div><strong>${e(label)}</strong>${state===false&&fix?`<small>${fix}</small>`:''}</div></div>`;
  const EDIT='<a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">Open your tokens ↗</a>, click the token, then <b>Edit</b>';
  const checks=has?`<div class="ap-checklist">
      ${row(d?.valid,d?.valid?`Token saved in this browser and accepted by GitHub${d.login?' ('+d.login+')':''}`:'Token rejected by GitHub',e(d?.error||'')+' Paste a fresh token below.')}
      ${d?.valid?row(d.secrets,'Can save secrets (DataForSEO, Gmail)',`${EDIT} → <b>Repository access</b>: <b>Only select repositories</b> → <b>backlink-command-center</b>, and <b>Permissions → Secrets</b>: <b>Read and write</b> → <b>Update</b>.`):''}
      ${d?.valid?row(d.actions,'Can press Run / Stop',`${EDIT} → <b>Permissions → Actions</b>: <b>Read and write</b> → <b>Update</b>.`):''}
    </div>${d?.valid&&!ok?'<p class="ap-hint">After updating the token on GitHub, click <b>Check again</b>. You do not need a new token.</p>':''}`:'';
  const storage=has&&!control.token.persistent?'<div class="alert-warning">This browser blocks saving data for this site (private window or strict privacy setting), so the token lasts only until you close this tab. Allow site data for this page to keep it.</div>':'';
  const intro=has?'':`<ol class="ap-steps">
      <li><a class="primary" href="${e(control.TOKEN_URL)}" target="_blank" rel="noopener">Create control token ↗</a> The name and permissions (Actions and Secrets: read &amp; write) are pre-filled. <b>Already made one?</b> Just paste it below.</li>
      <li>On GitHub, set <b>Repository access</b> to <b>Only select repositories</b> → <b>backlink-command-center</b>. This is the step that's easy to miss: the default ("Public repositories") ignores the permissions. Then click <b>Generate token</b>.</li>
      <li>Copy the token (starts with <code>github_pat_</code>) and paste it below.</li></ol>`;
  return `<section class="ap-step-card"><h3>1 · GitHub control token ${ok?'<b class="ap-ok">✓ ready</b>':''}</h3>${intro}${checks}${storage}
    <form id="ap-token-form" class="inline-form ap-token-row"><input id="ap-token" type="password" autocomplete="off" placeholder="${has?'Replace token (optional)':'Paste github_pat_… here'}" ${has?'':'required'} minlength="20">
      <button class="primary" type="submit">${has?'Replace token':'Save token'}</button>${has?'<button class="outline-btn" type="button" data-ap="recheck">Check again</button><button class="outline-btn" type="button" data-ap="forget">Forget token</button>':''}</form></section>`;
}
function connectPanel(h){
  const {escapeHTML:e,panel}=h,ready=control.diagnosisOk(ui.diag);
  const c=ui.configured||{secrets:new Set()};
  const done=f=>fieldDone(f,c),settings=savedSettings.get();
  const field=f=>{const bad=ui.rejected?.has(f.name),ok=done(f)&&!bad,cur=f.kind==='setting'?settings[f.name]||'':'';
    const input=f.type==='select'?`<select class="selector" name="${f.name}">${f.options.map(([v,l])=>`<option value="${v}" ${(cur||'send')===v?'selected':''}>${e(l)}</option>`).join('')}</select>`
      :`<input name="${f.name}" type="${f.type}" ${f.type==='number'?'min="1" max="50"':''} autocomplete="${f.type==='password'?'new-password':'off'}" value="${e(cur)}" placeholder="${ok&&!cur?(f.kind==='secret'?'Connected; leave blank to keep':'Saved; type to change'):f.type==='number'?'12':''}" ${f.required&&!ok?'required':''}>`;
    return `<label class="ap-field"><span>${e(f.label)} ${bad?'<b class="ap-need">✗ rejected: re-enter</b>':ok?'<b class="ap-ok">✓ saved</b>':f.required?'<b class="ap-need">needed</b>':''}</span>${input}${f.help?`<small>${f.link?`<a href="${f.link}" target="_blank" rel="noopener">${e(f.help)} ↗</a>`:e(f.help)}</small>`:''}</label>`};
  return panel('Connect Autopilot','Two steps, once. Everything is encrypted in your browser before it reaches GitHub; nothing can read it back.',
    `<div class="panel-pad ap-connect">${tokenStep(h)}
    <section class="ap-step-card ${ready?'':'ap-locked'}"><h3>2 · DataForSEO, Gmail and your settings</h3>
      ${ready?'':'<p class="ap-hint">Finish step 1 first; then these fields unlock.</p>'}
      <form id="ap-connect-form"><fieldset ${ready?'':'disabled'}><div class="ap-fields">${FIELDS.map(field).join('')}</div>
      <div class="ap-buttons"><button class="primary" type="submit" ${ui.busy?'disabled':''}>${ui.busy==='connect'?'Saving…':'Save & run now'}</button><button class="outline-btn" type="button" data-ap="close">Close</button></div></fieldset></form></section></div>`,
    ready?`<span class="panel-link">${c.secrets.has('LINKFORGE_DATA_KEY')?'✓ vault key set':'vault key missing'}</span>`:'');
}

function privatePanel(h){
  const {escapeHTML:e,external,n,niceTime,statusTag,panel,table,empty}=h;
  if(!ui.vault){
    const canReset=!!ui.diag?.secrets;
    return panel('Prospects & conversations','Encrypted in the public repo · unlocked only in your browser with the vault key',
    `<div class="ap-inset ap-vault-help"><p>The <b>vault key</b> is not your GitHub token. It is the separate <code>LINKFORGE_DATA_KEY</code> created during setup (saved on the setup computer in <code>.linkforge/autopilot-unlock-key.txt</code>). Don't have it? Create a new one: this browser and GitHub get the same new key automatically.</p></div>
    <form class="inline-form ap-inset" id="ap-unlock"><input id="ap-key" type="password" autocomplete="off" placeholder="Paste vault key (LINKFORGE_DATA_KEY)" minlength="16" required><button class="primary" type="submit">Unlock</button>
      <button class="outline-btn" type="button" data-ap="newvault" ${canReset&&!ui.busy?'':'disabled'} title="${canReset?'':'Needs a working GitHub token (step 1 above)'}">${ui.busy==='newvault'?'Creating…':'Create a new vault key'}</button></form>${ui.error?`<div class="alert-warning ap-inset">${e(ui.error)}</div>`:''}`);
  }
  const all=Object.values(ui.vault.prospects||{});
  const active=new Set(['positive','won','replied','followed_up','sent','drafted','ready','contact_form','no_contact']);
  const rows=all.filter(p=>ui.filter==='all'||(ui.filter==='active'?active.has(p.status):p.status===ui.filter))
    .sort((a,b)=>STATUS_ORDER.indexOf(a.status)-STATUS_ORDER.indexOf(b.status)||(b.score||0)-(a.score||0)).slice(0,200)
    .map(p=>{const last=(p.history||[]).at(-1);return `<tr><td><strong>${e(p.domain)}</strong><small>${e(p.site)} · fit ${n(p.score)}</small></td><td>${external(p.page_url,p.title||p.page_url)}<small>${e(p.reason||p.fit_section||p.query||'')}</small></td><td>${p.email?e(p.email):p.contact_form?external(p.contact_form,'Contact form'):'—'}</td><td>${external(p.asset_url,(p.asset_title||'').slice(0,60))}</td><td>${statusTag(p.status)}<small>${last?e(last.type+' · '+niceTime(last.at)):''}</small></td></tr>`});
  const counts={};for(const p of all)counts[p.status]=(counts[p.status]||0)+1;
  const opts=['active','all',...STATUS_ORDER.filter(x=>counts[x])].map(x=>`<option value="${x}" ${ui.filter===x?'selected':''}>${x==='active'?'In progress':x==='all'?'All prospects':x.replaceAll('_',' ')} ${counts[x]?`(${counts[x]})`:''}</option>`).join('');
  return panel('Prospects & conversations',`${n(all.length)} publishers tracked · decrypted locally`,
    `<div class="table-toolbar"><select class="selector" id="ap-filter">${opts}</select><button class="outline-btn" id="ap-lock" type="button">Lock</button><button class="outline-btn" type="button" data-ap="copykey">Copy vault key</button></div>${rows.length?table(['Publisher','Their page','Contact','Our asset','Status'],rows):empty('Nothing in this view','Change the filter to see more prospects.')}`);
}

async function act(kind,fn,ok){
  ui.busy=kind;ui.err='';ui.msg='';await reloadView();
  try{await fn();ui.msg=ok}catch(err){ui.err=err.message}
  ui.busy='';await reloadView();
}
export function bindAutopilot(reload){
  reloadView=reload;
  // The CSP forbids inline style attributes; set bar widths through the CSSOM instead.
  const main=document.getElementById('main');
  if(main)new MutationObserver(()=>main.querySelectorAll('[data-w]').forEach(el=>{el.style.width=el.dataset.w+'%'})).observe(main,{childList:true});
  document.addEventListener('click',async ev=>{
    const b=ev.target.closest('[data-ap]');if(!b)return;const a=b.dataset.ap;
    if(a==='connect'){ui.showConnect=!ui.showConnect;return reload()}
    if(a==='close'){ui.showConnect=false;return reload()}
    if(a==='forget'){control.token.set('');ui.configured=null;ui.diag=null;return reload()}
    if(a==='recheck'){ui.msg='';ui.err='';ui.showConnect=true;ui.forceDiag=true;return reload()}
    if(a==='copykey'){try{await navigator.clipboard.writeText(store.get());ui.msg='Vault key copied. Paste it on your other devices to unlock there.'}catch{ui.err='Clipboard blocked by the browser.'}return reload()}
    if(a==='newvault'){
      if(!confirm('Create a new vault key?\n\nThe current vault can no longer be opened, so private history (prospects, who was contacted, opt-outs) starts fresh on the next run. Only do this if you never had the old key.'))return;
      ui.forceDiag=true;
      return act('newvault',async()=>{
        const key=[...crypto.getRandomValues(new Uint8Array(24))].map(b=>b.toString(16).padStart(2,'0')).join('');
        await control.setSecret('LINKFORGE_DATA_KEY',key);
        const at=new Date().toISOString();
        await control.setSecret('LINKFORGE_VAULT_RESET_AT',at);
        store.set(key);vaultResetAt.set(at);ui.vault=null;ui.error='';
        await control.run();ui.settleUntil=Date.now()+600000;
      },'New vault key saved in this browser and on GitHub. The run that just started creates the new vault; it unlocks here automatically afterwards. Use "Copy vault key" to unlock on other devices.');
    }
    if(!control.token.get()){ui.showConnect=true;ui.err='Connect the dashboard to GitHub first (one-time token below).';return reload()}
    if(a==='run')return act('run',async()=>{await control.run();ui.settleUntil=Date.now()+600000},'Autopilot started. This page refreshes on its own while it runs.');
    if(a==='stop'){if(!confirm('Stop Autopilot? Automatic runs pause until you press Run.'))return;return act('stop',control.stop,'Autopilot stopped. Press Run to start it again.')}
  });
  document.addEventListener('submit',async ev=>{
    if(ev.target.id==='ap-token-form'){ev.preventDefault();const v=document.getElementById('ap-token').value.trim();if(v){control.token.set(v);ui.forceDiag=true}ui.showConnect=true;ui.err='';return reload()}
    if(ev.target.id!=='ap-connect-form')return;
    ev.preventDefault();
    const form=new FormData(ev.target),values=FIELDS.map(f=>[f,String(form.get(f.name)||'').trim()]).filter(([,v])=>v);
    const bad=values.find(([f,v])=>(f.type==='email'&&!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v))||(f.name==='GMAIL_APP_PASSWORD'&&v.replace(/\s+/g,'').length!==16));
    if(bad){ui.err=bad[0].name==='GMAIL_APP_PASSWORD'?'A Gmail app password is exactly 16 letters.':`${bad[0].label} doesn't look like an email address.`;return reload()}
    const secrets=values.filter(([f])=>f.kind==='secret');
    const settings={...savedSettings.get(),...Object.fromEntries(values.filter(([f])=>f.kind==='setting').map(([f,v])=>[f.name,v]))};
    // The mode/limit dropdowns always carry a value, so only rewrite settings when the name is known.
    const writeSettings=!!settings.SENDER_NAME;
    if(!writeSettings&&!ui.configured?.secrets.has(control.SETTINGS_SECRET)){ui.err='Please enter your name for the emails.';return reload()}
    ui.forceDiag=true;
    await act('connect',async()=>{
      for(const [f,v] of secrets)await control.setSecret(f.name,f.name==='GMAIL_APP_PASSWORD'?v.replace(/\s+/g,''):v);
      if(writeSettings){await control.setSecret(control.SETTINGS_SECRET,JSON.stringify(settings));savedSettings.set(settings)}
      await control.run();ui.showConnect=false;ui.settleUntil=Date.now()+600000;
    },`Saved ${secrets.length+(writeSettings?1:0)} item${secrets.length+(writeSettings?1:0)===1?'':'s'} and started Autopilot. Results appear here in about 5 minutes.`);
  });
  document.addEventListener('submit',async ev=>{
    if(ev.target.id!=='ap-unlock')return;ev.preventDefault();
    const v=document.getElementById('ap-key').value.trim();
    if(/^(github_pat_|ghp_|gho_)/.test(v)){ui.error='That is your GitHub token, not the vault key. Put the token in step 1 of "Connect Autopilot" above. If you don\'t have the vault key, click "Create a new vault key".';return reload()}
    store.set(v);ui.vault=null;ui.error='';await reload();
  });
  document.addEventListener('change',async ev=>{if(ev.target.id==='ap-filter'){ui.filter=ev.target.value;await reload()}});
  document.addEventListener('click',async ev=>{if(ev.target.id==='ap-lock'){store.set('');ui.vault=null;ui.error='';await reload()}});
}
