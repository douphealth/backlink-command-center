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
// v1: AES-GCM over the JSON text; v2: the JSON was gzipped before encryption ({z:'gzip'}), see scripts/autopilot/vault.mjs.
async function openVault(box,pass){
  if(!box||![1,2].includes(box.v)||!box.ct||(box.v===2&&box.z!=='gzip'))throw Error('Unrecognized vault format');
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pass),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:b64(box.salt),iterations:box.iterations},base,{name:'AES-GCM',length:256},false,['decrypt']);
  let plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(box.iv)},key,b64(box.ct));
  if(box.v===2){if(typeof DecompressionStream!=='function')throw Error('This browser cannot unpack the vault; update it');
    plain=await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()}
  return JSON.parse(new TextDecoder().decode(plain));
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

const STATUS_ORDER=['positive','won','replied','followed_up','sent','drafted','ready','form_ready','contact_form','no_contact','contact_unverifiable','already_linked','form_expired','declined','bounced','skipped_duplicate','rejected'];
const ui={filter:'active',vault:null,error:'',control:null,configured:null,tokenError:'',showConnect:false,msg:'',err:'',busy:'',settleUntil:0};
let reloadView=null,pollTimer=null;
export const FIELDS=[
  {name:'DATAFORSEO_LOGIN',label:'DataForSEO login (email)',type:'email',kind:'secret',required:true,help:'DataForSEO dashboard → API Access',link:'https://app.dataforseo.com/api-access'},
  {name:'DATAFORSEO_PASSWORD',label:'DataForSEO API password',type:'password',kind:'secret',required:true,help:'The API password, not your website login'},
  {name:'GMAIL_ADDRESS',label:'Gmail address that sends outreach',type:'email',kind:'secret',required:true},
  {name:'GMAIL_APP_PASSWORD',label:'Gmail app password (16 letters)',type:'password',kind:'secret',required:true,help:'Create one at myaccount.google.com/apppasswords (needs 2-Step Verification)',link:'https://myaccount.google.com/apppasswords'},
  {name:'SENDER_NAME',label:'Your name in emails',type:'text',kind:'setting',required:true,help:'Your own name, e.g. Alex Papas (not a site name: every site sends from this one address)'},
  {name:'SENDER_NAMES',label:'Sign-off per site (optional)',type:'textarea',kind:'setting',placeholder:'gearuptofit.com = Alex from GearUpToFit',help:'One per line, e.g. gearuptofit.com = Alex from GearUpToFit. Sites not listed use the name above'},
  {name:'SENDER_POSTAL_ADDRESS',label:'Postal address for the email footer',type:'text',kind:'setting',help:'A P.O. box or mailbox service works. Identifies the sender, as commercial-email rules such as CAN-SPAM expect'},
  {name:'OUTREACH_MODE',label:'Outreach mode',type:'select',kind:'setting',default:'draft',options:[['send','Hands-free: send pitches + 1 follow-up automatically'],['draft','Safe: write pitches into Gmail Drafts'],['off','Research only']]},
  {name:'OUTREACH_DAILY_LIMIT',label:'Max new pitches per day',type:'number',kind:'setting',help:'Starts at 5/day and ramps up by 2/day to this limit'},
  {name:'REPLY_MODE',label:'When a publisher replies',type:'select',kind:'setting',default:'draft',options:[['draft','Write an answer into Gmail Drafts for me (recommended)'],['send','Answer a plain yes automatically; drafts for everything else'],['off','Only alert me']]},
  {name:'LINK_EXCHANGE',label:'Offer a 3-way link exchange',type:'select',kind:'setting',default:'abc',options:[['abc','Yes: in return, one of my OTHER related sites links to them (never the site they link to)'],['off','No: ask for the link only']]},
  {name:'EXCHANGE_PER_SITE_MONTH',label:'Exchange links per partner site per month',type:'number',kind:'setting',min:0,max:20,placeholder:'6 (default)',help:'Caps how many return links any one of your sites gives out, so no site looks like a link farm'},
  {name:'SATURDAY_SENDS',label:'Saturday morning sending',type:'select',kind:'setting',default:'YES',options:[['YES','Yes: also send Saturday mornings (recipient\'s time)'],['NO','Weekdays only']]},
  {name:'LIST_UNSUBSCRIBE_HEADER',label:'Bulk-mail unsubscribe header',type:'select',kind:'setting',default:'off',options:[['off','Off: plain 1-to-1 email (each email still says one reply stops all email)'],['on','On: add the List-Unsubscribe header']]},
  {name:'FORM_QUEUE_DAILY',label:'Contact-form messages prepared per day',type:'number',kind:'setting',min:0,max:20,placeholder:'5 (default)',help:'For publishers with only a contact form: a ready-to-paste message appears on the dashboard. Never submitted automatically'},
  {name:'OUTREACH_DACH',label:'Germany, Austria, Switzerland',type:'select',kind:'setting',default:'NO',options:[['NO','Do not email publishers there (they need prior consent)'],['YES','Email them too (I have checked the rules)']]},
  {name:'ANTHROPIC_API_KEY',label:'Anthropic API key (optional)',type:'password',kind:'secret',help:'Claude writes a unique pitch for every page'},
  {name:'GROQ_API_KEY',label:'Groq API key (optional, free AI pitch writer)',type:'password',kind:'secret',help:'Free plan, no card. Used to write each pitch when no Anthropic key is set. console.groq.com → API Keys',link:'https://console.groq.com/keys'},
  {name:'GEMINI_API_KEY',label:'Gemini API key (optional, free AI pitch writer)',type:'password',kind:'secret',help:'Free plan from Google AI Studio. Used when no Anthropic key is set, after Groq if both are saved',link:'https://aistudio.google.com/apikey'},
  {name:'VERIFALIA_USERNAME',label:'Verifalia username (needed to send)',type:'text',kind:'secret',help:'Free plan: 25 credits every day, about 12 inbox checks. Create a dedicated user in the Verifalia client area',link:'https://verifalia.com/sign-up'},
  {name:'VERIFALIA_PASSWORD',label:'Verifalia password',type:'password',kind:'secret',help:'Only free daily credits are used, so verification never costs money'},
  {name:'EMAIL_VERIFY_DAILY_LIMIT',label:'Mailbox checks per day',type:'number',kind:'setting',min:0,max:100,placeholder:'25 (default)',help:'Leave blank for 25 a day (Verifalia\'s free daily credits, Standard checks, free credits only). 0 turns verification, and so sending, off'},
  {name:'GSC_SERVICE_ACCOUNT_JSON',label:'Google Search Console service-account JSON',type:'textarea',kind:'secret',help:'Paste the whole JSON key file. Add its client_email as a user on each Search Console property. Unlocks the Google index monitor and clicks tracking'},
  {name:'BING_WEBMASTER_API_KEY',label:'Bing Webmaster Tools API key',type:'password',kind:'secret',help:'Bing Webmaster Tools → Settings → API access. New and changed pages are submitted to Bing daily',link:'https://www.bing.com/webmasters'},
  {name:'BRAVE_SEARCH_API_KEY',label:'Brave Search API key (optional fallback search)',type:'password',kind:'secret',help:'Used only when DataForSEO cannot run a search (balance or cap used up). Capped at 900 requests a month',link:'https://brave.com/search/api/'},
  {name:'HUNTER_API_KEY',label:'Hunter API key (optional second opinion)',type:'password',kind:'secret',help:'Used within its own daily budget below: as a second opinion when Verifalia cannot decide (unknown, not catch-all), and as the fallback when Verifalia\'s free credits for the day are used up (most weekdays). Size the budget for both. hunter.io → API keys',link:'https://hunter.io/api-keys'},
  {name:'HUNTER_DAILY_LIMIT',label:'Hunter checks per day',type:'number',kind:'setting',min:0,max:50,placeholder:'0 (off)',help:'Check your Hunter plan\'s free monthly quota first; about quota / 30'},
];
// Settings travel as one encrypted secret (no Variables permission needed); this browser remembers them for display.
const local=(k,fallback)=>({get:()=>{try{return JSON.parse(localStorage.getItem(k))??fallback}catch{return fallback}},set:v=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}}});
const savedSettings=local('linkforge-settings',{});
const TAB=local('linkforge-ap-tab','overview');
const AP_TABS=['overview','pages','index','prospects','sites','learning'];
export const currentApTab=()=>AP_TABS.includes(TAB.get())?TAB.get():'overview';
/** Show one Autopilot section: the tab bar, the panes and the sidebar all follow. Works before the page is rendered too. */
export function showApTab(k){
  if(!AP_TABS.includes(k))return;TAB.set(k);
  document.querySelectorAll('[data-ap-tab]').forEach(x=>{const on=x.dataset.apTab===k;x.classList.toggle('active',on);x.setAttribute('aria-selected',String(on))});
  document.querySelectorAll('[data-ap-pane]').forEach(x=>x.classList.toggle('hidden',x.dataset.apPane!==k));
  document.querySelectorAll('.nav-link[data-tab]').forEach(x=>x.classList.toggle('active',x.dataset.tab===k&&!!document.querySelector('[data-ap-pane]')));
}
const navCount=(id,v,warn=false)=>{const x=document.getElementById(id);if(x){x.textContent=v==null?'—':Number(v).toLocaleString('en-US');x.classList.toggle('warn',!!(warn&&v))}};
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
  const summaryLine=`Last results ${ago(s.generated_at)} · ${n(t.pages_crawled)} pages audited · ${modeLabel.toLowerCase()}`;
  // The four things that decide how many pitches go out, readable at a glance; the full detail sits one click below.
  const o=s.outreach||{},v=c.verifier||{},w=s.stages?.outreach?.writer||{};
  const writerName={claude:'Claude',cloudflare:'Cloudflare AI (free)',groq:'Groq (free plan)',gemini:'Gemini (free plan)',custom:'Custom AI'}[c.ai_writer]||null;
  const aiWritten=(w.claude||0)+(w.free_ai||0);
  const chip=(label,value,note,tone='')=>`<div class="ap-chip ${tone}"><span>${e(label)}</span><strong>${e(value)}</strong><small>${e(note)}</small></div>`;
  const checksLeft=v.ready&&v.used_today<v.daily_limit;
  const chips=`<div class="ap-chips">${[
    chip('Ready to pitch',n(o.ready??f.ready),c.outreach_mode==='off'?'Research only: sending is off':o.cap_today!=null?`${n(o.sent_today||0)} of ${n(o.cap_today)} sent today`:modeLabel.toLowerCase()),
    chip('Inbox checks today',v.ready?`${n(v.used_today)} / ${n(v.daily_limit)}`:'Off',v.ready?(checksLeft?'Every pitch needs one verified inbox':'Used up: more after midnight UTC'):'Add a Verifalia login under Connect',checksLeft?'':'warn'),
    chip('Pitch writer',writerName||'Templates only',writerName?(aiWritten+(w.template_fallbacks||0)?`Last cycle: ${n(aiWritten)} AI-written, ${n(w.template_fallbacks||0)} template`:'Writes each pitch for that exact page'):'Built-in free writer was not reachable last cycle',writerName?'':'warn'),
    chip('Search spend',`$${s.spend.today_usd.toFixed(2)} today`,`$${s.spend.month_usd.toFixed(2)} this month · caps $${s.spend.daily_cap_usd} / $${s.spend.monthly_cap_usd}`),
  ].join('')}</div>`;
  const status=`<div class="ap-control"><div class="ap-state"><span class="ap-dot ${state[0]}"></span><div><strong>${e(state[1])}</strong><p>${e(state[2])}${ctl.run?.url?` · <a href="${e(ctl.run.url)}" target="_blank" rel="noopener">${ctl.running?'watch live':'last run log'} ↗</a>`:''}</p><p>${e(summaryLine)}</p></div></div>
    <div class="ap-buttons"><button class="ap-run" data-ap="run" ${ctl.running||ui.busy?'disabled':''}>${ui.busy==='run'?'Starting…':ctl.running?'Running…':'▶ Run'}</button><button class="ap-stop" data-ap="stop" ${(!ctl.enabled&&!ctl.running)||ui.busy?'disabled':''}>${ui.busy==='stop'?'Stopping…':'■ Stop'}</button><button class="outline-btn" data-ap="connect">⚙ Connect</button></div>${chips}<details class="ap-more"><summary>Sending and verification details</summary>${outreachLine(s,h)}</details></div>
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
  const setup=ui.showConnect||needsSetup||rejectedMsgs.length||!control.diagnosisOk(ui.diag)?connectPanel(h,s):'';
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
  const ix=s.indexation;
  const ixSum=k=>(ix?.sites||[]).reduce((a,x)=>a+(x[k]||0),0);
  const ixBlocking=ix?.blocking??ixSum('critical'),ixThin=ix?.thin??ixSum('thin'),ixReview=ix?.review??Math.max(0,(ix?.total_issues||0)-ixBlocking-ixThin);
  const ixSites=(ix?.sites||[]).filter(x=>x.problems||x.alert).sort((a,b)=>b.critical-a.critical||b.problems-a.problems).map(x=>`<tr><td><strong>${e(x.site)}</strong><small>${n(x.checked)} sitemap URLs checked</small>${x.alert?`<small class="ap-why">${e(x.alert)}</small>`:''}</td><td><strong>${n(x.critical)}</strong>${x.critical?`<small>${e([[x.not_found,'404'],[x.server_error,'server error'],[x.noindex,'noindex'],[x.canonical_mismatch,'wrong canonical']].filter(y=>y[0]).map(y=>y[0]+' '+y[1]).join(' · '))}</small>`:''}</td><td>${n(x.review??(x.problems-x.critical-(x.thin||0)))}</td><td>${n(x.thin||0)}</td><td>${n(x.healthy)}</td></tr>`);
  const ixRows=(ix?.issues||[]).slice(0,60).map(x=>`<tr><td>${external(x.url,new URL(x.url).pathname)}<small>${e(x.site)}</small></td><td><strong>${e(x.label)}</strong>${x.final_url?`<small>→ ${e(x.final_url)}</small>`:''}${x.canonical?`<small>canonical: ${e(x.canonical)}</small>`:''}${x.words?`<small>${n(x.words)} words</small>`:''}${x.detail?`<small>${e(x.detail)}</small>`:''}</td><td><small>${e(x.fix)}</small></td></tr>`);
  const sp=s.search_performance||[],gi=s.google_index,bg=s.bing,hs=s.history||[];
  const trend=k=>{const v=hs.filter(h=>h[k]!=null);if(v.length<2)return '';const d=v.at(-1)[k]-v[0][k];return `<small class="ap-delta ${d>0?'up':d<0?'down':''}">${d>0?'+':''}${n(d)} since ${e(v[0].date)}</small>`};
  const spPanel=sp.length?`<div class="ap-gap">${panel('Google search performance',`Last 7 days to ${e(sp[0].to)} (Search Console data lags ~3 days). Clicks: ${n(sp.reduce((a,x)=>a+x.clicks,0))} ${trend('search_clicks_7d')} · Impressions: ${n(sp.reduce((a,x)=>a+x.impressions,0))} ${trend('search_impressions_7d')}`,
    table(['Site','Clicks','Impressions','Avg position','Pages with impressions','Striking distance (4–20)'],[...sp].sort((a,b)=>b.impressions-a.impressions).map(x=>`<tr><td><strong>${e(x.site)}</strong></td><td>${n(x.clicks)}</td><td>${n(x.impressions)}</td><td>${x.position||'—'}</td><td>${n(x.pages_with_impressions)}</td><td>${n(x.striking_distance)}</td></tr>`)))}</div>`:'';
  const giPanel=gi?`<div class="ap-gap">${panel('Google index status (URL Inspection)',`${n(gi.sites.reduce((a,x)=>a+x.indexed,0))} indexed · ${n(gi.sites.reduce((a,x)=>a+x.not_indexed,0))} not indexed of ${n(gi.sites.reduce((a,x)=>a+x.checked,0))} important pages checked (rotating, re-checked every 3–14 days)`,
    table(['Site','Checked','Indexed','Unknown to Google','Discovered, not indexed','Crawled, not indexed','Other'],gi.sites.filter(x=>x.checked).map(x=>`<tr><td><strong>${e(x.site)}</strong></td><td>${n(x.checked)}</td><td>${n(x.indexed)}</td><td>${n(x.unknown||0)}</td><td>${n(x.discovered_not_indexed||0)}</td><td>${n(x.crawled_not_indexed||0)}</td><td>${n(x.not_indexed-(x.unknown||0)-(x.discovered_not_indexed||0)-(x.crawled_not_indexed||0))}</td></tr>`))+
    (gi.pages.length?table(['Page Google is ignoring','Status','Fix'],gi.pages.slice(0,40).map(x=>`<tr><td>${external(x.url,x.title||new URL(x.url).pathname)}<small>${e(x.site)}${x.promotion?` · promotion ${n(x.promotion)}`:''}</small></td><td><strong>${e(x.class.replaceAll('_',' '))}</strong><small>${e(x.coverage)}</small></td><td><small>${e(x.fix)}</small></td></tr>`)):''))}</div>`:'';
  const bgLine=bg?`<div class="ap-msg"><strong>Bing URL submission:</strong> ${n(bg.submitted_total)} URLs submitted so far${bg.last_run?.submitted?` (${n(bg.last_run.submitted)} this cycle)`:''}.${Object.keys(bg.errors||{}).length?` Issues: ${e(Object.entries(bg.errors).map(([d,x])=>d+': '+x.error).join(' · '))}. Add/verify those sites in Bing Webmaster Tools (import from Search Console works).`:''}</div>`:'';
  const ixPanel=ix?`<div class="ap-gap">${panel('Indexation health',`${n(ixBlocking)} sitemap URL${ixBlocking===1?'':'s'} cannot be indexed as ${ixBlocking===1?'it is':'they are'} (404, server error, noindex or wrong canonical): fix these first. ${n(ixReview)} need a look (redirect, blocked or no canonical). ${n(ixThin)} are indexable but thin. ${ix.note}`,
    ixRows.length?table(['Site','Cannot be indexed','Needs a look','Thin (indexable)','Healthy'],ixSites)+table(['URL','Problem','Fix'],ixRows):empty('No indexation problems found','Every crawled sitemap URL returns 200, is indexable and self-canonical.'))}</div>`:'';
  schedulePoll();
  const ixSitesHit=(ix?.sites||[]).filter(x=>x.critical).length;
  const replyRate=f.contacted?Math.round(1000*(f.replied||0)/f.contacted)/10:0;
  const kpis=[['Ready to pitch',f.ready,'✉',`${n(o.verified_ready||0)} inbox-verified · ${n(f.contact_form_only||0)} more have only a contact form`],
    ['Publishers contacted',f.contacted,'↗',`${n(o.sent_today||0)} sent today · ${n(f.bounced||0)} bounced in total`],
    ['Replies',f.replied,'↩',f.contacted?`${replyRate}% reply rate · ${n(f.positive||0)} positive`:'No pitches sent yet'],
    ['Backlinks won',f.won,'◇',`+${n(f.existing_links)} existing links found`],
    ['Cannot be indexed',ixBlocking,'⚠',ixBlocking?`On ${n(ixSitesHit)} site${ixSitesHit===1?'':'s'}: open the Indexation tab`:'Every checked sitemap URL can be indexed'],
    ['Best URLs to promote',t.promotable,'◎',`${n(t.promoting_now)} promoted now · ${n(t.internal_suggestions)} internal links to add`]];
  const kpiHtml=`<div class="kpi-grid ap-kpis">${kpis.map(([name,val,ico,note],i)=>`<div class="kpi${i===4&&val?' kpi-alert':''}"><div class="kpi-head">${e(name)}<span class="kpi-ico">${ico}</span></div><div class="kpi-value">${n(val)}</div><div class="kpi-foot">${e(note)}</div></div>`).join('')}</div>`;
  // One long page became five tabs; the choice is remembered on this device.
  // With the vault open, the contact-form count leaves out what this browser marked as pasted.
  const vp=ui.vault?Object.values(ui.vault.prospects||{}):null,pasted=vp?prunePasted(vp):{};
  const ny=ownerTasks(s,vp?{forms:formsLeft(vp,pasted)}:{}),shown=stripCodes(ny);
  const TABS=[['overview','Overview',ny.total,'warn'],['pages','Best pages',t.promotable,''],['index','Indexation',ixBlocking,'warn'],['prospects','Prospects & links',f.ready,''],['sites','Your sites',(s.sites||[]).length,''],['learning','Learning & log',0,'']];
  const tab=currentApTab();
  navCount('nav-ap-pages',t.promotable);{const x=document.getElementById('nav-ap-overview');if(x){x.textContent=n(ny.total);x.classList.toggle('hidden',!ny.total)}}navCount('nav-ap-index',ixBlocking,true);navCount('nav-ap-prospects',f.ready);navCount('nav-ap-sites',(s.sites||[]).length);
  // Every site in one table: what was checked, what is worth promoting, and what stops pages from being indexed.
  const ixBy=new Map((ix?.sites||[]).map(x=>[x.site,x]));
  const siteRows2=[...(s.sites||[])].sort((a,b)=>(ixBy.get(b.domain)?.critical||0)-(ixBy.get(a.domain)?.critical||0)||b.eligible-a.eligible).map(x=>{const i=ixBy.get(x.domain)||{};
    return `<tr><td><strong>${external('https://'+x.domain+'/',x.domain)}</strong><small>${n(x.pages)} pages checked of ${n(x.discovered)} in ${n(x.sitemaps)} sitemap${x.sitemaps===1?'':'s'}</small>${i.alert?`<small class="ap-why">${e(i.alert)}</small>`:''}</td><td><strong>${n(x.eligible)}</strong></td><td>${i.critical?`<span class="tag red">${n(i.critical)}</span>`:'0'}</td><td>${n(i.review||0)}</td><td>${n(i.thin||0)}</td><td>${x.top?external(x.top,new URL(x.top).pathname):'—'}</td></tr>`});
  const sitesPanel=panel('Your sites',`${n((s.sites||[]).length)} sites are crawled every cycle from their own sitemaps. "Cannot be indexed" counts 404s, server errors, noindex and wrong canonicals.`,
    siteRows2.length?table(['Site','Pages worth promoting','Cannot be indexed','Needs a look','Thin (indexable)','Best page to promote'],siteRows2):empty('No sites crawled yet','The next cycle crawls every configured site.'));
  const tabBar=`<div class="ap-tabs" role="tablist">${TABS.map(([k,label,count,tone])=>`<button type="button" role="tab" class="ap-tab${k===tab?' active':''}" data-ap-tab="${k}" aria-selected="${k===tab}">${label}${count?`<span class="${tone}">${n(count)}</span>`:''}</button>`).join('')}</div>`;
  const pane=(k,html)=>`<section class="ap-pane${k===tab?'':' hidden'}" data-ap-pane="${k}" role="tabpanel">${html}</section>`;
  const alerts=(s.attention||[]).filter(a=>a?.level==='action'&&!STRIP_CODES.has(a.code)&&!shown.has(a.code)).length;
  const pointerText=[ny.owner&&`${n(ny.owner)} decision${ny.owner===1?'':'s'}`,ny.other&&`${n(ny.other)} repl${ny.other===1?'y':'ies'} to answer`,ny.overdue&&`${n(ny.overdue)} return link${ny.overdue===1?'':'s'} overdue`,
    ny.forms&&`${n(ny.forms)} contact form${ny.forms===1?'':'s'} to paste`,alerts&&`${n(alerts)} alert${alerts===1?'':'s'}`].filter(Boolean).join(' · ');
  const attention=pointerText?`<button type="button" class="ap-pointer" data-ap="goto-overview"><span class="ap-needs-dot"></span><span><b>Needs you:</b> ${e(pointerText)}</span><span>Open Overview →</span></button>`:'';
  const bestPanel=`<div class="ap-gap">${panel('Best URLs to promote','Linkability × real search demand; templated duplicates and thin pages are demoted',best.length?table(['#','URL & why','Score','Internal links','Prospects'],best):empty('No promotable URLs yet','The next crawl will rank your pages.'))}</div>`;
  const internalPanel=`<div class="ap-gap">${panel('Internal link plan','Add these links on your own pages: highest-ROI, zero-cost ranking boost',internal.length?table(['On this page','Add anchor','Linking to'],internal):empty('No internal gaps found','Your best URLs are already well linked.'))}</div>`;
  const winsPanel=`<div class="ap-gap">${panel('Backlinks','Won after outreach, or already linking to you (verified on the live page)',wins.length?table(['Publisher','Page','Links to','Status','Found'],wins):empty('No verified backlinks yet','Pitched pages are re-checked every 4 days for 150 days.'))}</div>`;
  const logPanel=`<details class="data-note" open><summary><strong>Last run log</strong></summary><div class="pre-detail ap-log">${e((s.log||[]).join('\n'))}</div></details>`;
  return intro('autopilot','')+status+attention+banner+setup+kpiHtml+tabBar+
    pane('overview',needsYouStrip(s,h,ny)+`<div class="overview-grid ap-ov">${healthPanel(s,h,ny)}${sendingPanel(s,h)}</div><div class="overview-grid ap-ov-b ap-gap">${workingPanel(s,h)}${panel('Outreach funnel','Every number is a stored, verified record',funnel+exchangeFunnel(s,h))}</div><div class="ap-gap ap-stages">${panel('Last cycle','Each stage runs independently',`<div class="sites-list">${stageRows}</div>`)}</div>`)+
    pane('pages',bestPanel+internalPanel)+
    pane('index',ixPanel+spPanel+giPanel+bgLine)+
    pane('prospects',`<div class="ap-gap ap-anchor" id="ap-private">${privatePanel(h,s,ny)}</div>`+(vp?`<div class="ap-gap ap-anchor" id="ap-exchanges">${exchangesPanel(vp,h)}</div><div class="ap-gap ap-anchor" id="ap-forms">${formsPanel(vp,h,pasted)}</div>`:'')+winsPanel)+
    pane('sites',sitesPanel)+
    pane('learning',learningPanel(h,s)+logPanel);
}

const FP_LABEL={neighbor:'Sites recommended by qualified pages (free)',link_gap:'Competitor link gap (pages linking to rivals)',phrase_resources:'"page phrase" resources',phrase_links:'"page phrase" "useful links"',phrase_blog:'"page phrase" blog',link_roundup:'"link roundup" posts',weekly_roundup:'"weekly roundup" posts',best_of_web:'"best of the web" lists',further_reading:'"further reading" sections',helpful_resources:'"helpful resources" pages',recommended_tools:'"recommended tools" pages',mention:'Unlinked brand mentions',intent:'Same-topic articles',resources:'"{topic} resources"',intitle_resources:'intitle:resources',useful_links:'"useful links" pages',tools:'"{topic} tools"',free_tools:'"free {topic} tools"',best_resources:'"best {topic} resources"',useful_websites:'"useful websites"',statistics:'"{topic} statistics"',research_resources:'"research resources"',sources:'"{topic} sources"',blogs_to_follow:'"blogs to follow"',recommended_reading:'"recommended reading"',inurl_resources:'inurl:resources',inurl_links:'inurl:links',best_guides:'"best … guides"',k_resources:'"{page topic} resources"'};
function learningPanel(h,s){
  const {escapeHTML:e,external,n,panel,table,empty}=h,L=s.learning;
  if(!L)return '';
  const fps=(L.footprints||[]).slice(0,10).map(x=>`<tr><td><strong>${e(FP_LABEL[x.footprint]||x.footprint)}</strong></td><td>${n(x.queries)}</td><td>${n(x.ready)}</td><td><strong>${Math.round(x.rate*100)}%</strong><small>${x.queries<3?'still testing':''}</small></td></tr>`);
  const assets=(L.assets||[]).slice(0,10).map(x=>`<tr><td>${external(x.url,new URL(x.url).pathname)}</td><td>${n(x.sent)}</td><td>${n(x.replied)}</td><td>${n(x.positive)}</td><td>${n(x.won)}</td></tr>`);
  return `<div class="ap-gap">${panel('What Autopilot is learning: searches','Search patterns ranked by pitchable prospects found per search; the best ones are used first',fps.length?table(['Search pattern','Searches','Prospects','Yield'],fps):empty('Not enough data yet','Yields appear after the first searches.'))}</div><div class="ap-gap">${panel('Which of your pages earn replies','Pages with better reply and link rates get more prospecting',assets.length?table(['Page','Pitched','Replies','Positive','Links won'],assets):empty('No pitches yet','Results appear after the first pitches.'))}</div>`;
}
// ---- Overview: "what needs me, and is the engine working". Built from the public summary only (counts, code names). ----
const GMAIL_INBOX='https://mail.google.com/mail/u/0/#inbox',MiB=1048576;
/** A reply that waits for the owner's decision (sticky until the owner answers): the funnel's needs_owner rule. */
export const needsOwner=p=>!!p?.needs_owner&&!p.owner_decided_at;
/** Conditions in plain words. */
export const CONDITION_WORDS={paid:'fee',reciprocal:'link back',guest_post:'guest post'};
// The "Needs you" strip shows these itself, so the health list leaves them out while the strip is on screen.
const STRIP_CODES=new Set(['owner_decision_pending','replies_waiting']);
/** Replies waiting for the owner: decisions, plus other replies nobody has answered yet (awaiting_reply includes the decisions). */
export function needsYou(f){
  const int=x=>Math.max(0,Math.floor(Number(x)||0)),owner=int(f?.needs_owner),waiting=int(f?.awaiting_reply),other=Math.max(0,waiting-owner);
  return {owner,waiting,other,total:owner+other};
}
/**
 * Everything that waits for the owner, from the public summary (counts only): reply decisions and other unanswered replies,
 * promised return links that are overdue (owed: overdue plus those still due), and contact-form messages to paste.
 * `local.forms` replaces the public form count with what this browser has not marked as pasted (vault open).
 */
export function ownerTasks(s,local={}){
  const int=x=>Math.max(0,Math.floor(Number(x)||0)),ny=needsYou(s?.funnel),f=s?.funnel||{};
  const overdue=int(f.exchanges_overdue),owed=Math.max(overdue,int(f.exchanges_owed)),forms=int(local?.forms??s?.outreach?.form_queue?.ready);
  return {...ny,replies:ny.total,overdue,owed,forms,total:ny.total+overdue+forms};
}
/** The watchdog codes the strip shows itself while it is on screen (the health list and the alert count leave them out). */
export const stripCodes=t=>new Set([...(t?.replies?STRIP_CODES:[]),...(t?.overdue?['exchange_owed']:[]),...(t?.forms?['forms_ready']:[])]);
export function needsYouStrip(s,{escapeHTML:e,n},tasks=ownerTasks(s)){
  const t=tasks;if(!t.total)return '';
  const said=code=>(s.attention||[]).find(a=>a?.code===code)?.message||'';
  const mode=s.sender?.reply_mode||'draft';
  const replyNote={draft:'Autopilot writes an answer into Gmail Drafts for each one: check it and press Send.',send:'A plain yes is answered automatically; everything else (conditions, questions, anything unclear) gets a draft for you.',
    off:'Automatic drafts are off ("When a publisher replies: Only alert me"), so answer them in Gmail.'}[mode]||'Answer them in the same Gmail thread.';
  const item=(count,title,note,tone='')=>`<div class="ap-need ${tone}"><b>${n(count)}</b><div><strong>${e(title)}</strong><small>${e(note)}</small></div></div>`;
  const due=t.owed-t.overdue;
  const xNote=`${t.overdue===1?'The publisher':'The publishers'} already linked to you. Prospects > Exchanges shows the exact page and the link to add${due>0?`; ${n(due)} more ${due===1?'is':'are'} due within 7 days`:''}.${s?.exchanges?.paused?' New exchange offers pause until they are added.':''}`;
  const cls=k=>k?'secondary':'primary';
  const acts=[t.replies?`<a class="primary" href="${GMAIL_INBOX}" target="_blank" rel="noopener noreferrer">Open Gmail ↗</a><button class="secondary" type="button" data-ap="needs-you">Show in Prospects →</button>`:'',
    t.overdue?`<button class="${cls(t.replies)}" type="button" data-ap="goto-exchanges">Open Exchanges →</button>`:'',
    t.forms?`<button class="${cls(t.replies||t.overdue)}" type="button" data-ap="goto-forms">Open contact forms →</button>`:''].join('');
  return `<section class="ap-needs" aria-label="Needs you"><div class="ap-needs-head"><span class="ap-needs-dot"></span><strong>Needs you</strong><span>${t.replies?'A reply is the only step between a pitch and a link.':'Only you can do these: Autopilot never edits your sites or submits a form.'}</span></div><div class="ap-needs-items">${
    t.owner?item(t.owner,t.owner===1?'publisher said yes with a condition':'publishers said yes with a condition',said('owner_decision_pending')||'A fee, a link back or a guest post: your call. Autopilot never agrees to terms by itself.','urgent'):''}${
    t.other?item(t.other,`${t.owner?'other ':''}${t.other===1?'reply waits':'replies wait'} for an answer`,said('replies_waiting')||replyNote):''}${
    t.overdue?item(t.overdue,t.overdue===1?'return link you promised is overdue':'return links you promised are overdue',xNote,'urgent'):''}${
    t.forms?item(t.forms,t.forms===1?'contact-form message to paste':'contact-form messages to paste','These publishers publish no email address. Copy each prepared message into their form and send it yourself; Autopilot never submits a form.'):''}</div>
    <div class="ap-needs-actions">${acts}</div></section>`;
}
const LEVELS={action:['red','Do this'],warn:['amber','Watch'],info:['blue','Note']};
// Where each alert is fixed: the Connect form, or an outside page. Only for alerts that ask for something.
const CONNECT_FIX=new Set(['gmail_send_blocked','gmail_rejected','dataforseo_rejected','verifier_off','verifier_rejected','verifier_permission','hold_with_verified','sender_identity_incomplete','templates_only','mailbox_rebuild_pending']);
// Alerts fixed on this page: the button opens that section of the Prospects tab.
const GOTO_FIX={exchange_owed:['goto-exchanges','Open Exchanges'],exchange_due:['goto-exchanges','Open Exchanges']};
const LINK_FIX={owner_decision_pending:[GMAIL_INBOX,'Open Gmail'],replies_waiting:[GMAIL_INBOX,'Open Gmail'],dataforseo_funds:['https://app.dataforseo.com/','DataForSEO billing'],dataforseo_low:['https://app.dataforseo.com/','DataForSEO billing']};
/** Self-diagnosis (summary.attention) by level, each with its fix, plus whether the last cycle's stages ran and the vault size. */
export function healthPanel(s,h,tasks=ownerTasks(s)){
  const {escapeHTML:e,n,panel}=h,shown=stripCodes(tasks);
  const list=(s.attention||[]).filter(a=>a&&!shown.has(a.code));
  const lvl=a=>LEVELS[a.level]?a.level:'info',count={action:0,warn:0,info:0};for(const a of list)count[lvl(a)]++;
  const fix=a=>lvl(a)==='info'?'':CONNECT_FIX.has(a.code)?'<button class="outline-btn ap-fix" type="button" data-ap="open-connect">⚙ Open Connect</button>'
    :GOTO_FIX[a.code]?`<button class="outline-btn ap-fix" type="button" data-ap="${GOTO_FIX[a.code][0]}">${e(GOTO_FIX[a.code][1])} →</button>`
    :LINK_FIX[a.code]?`<a class="outline-btn ap-fix" href="${LINK_FIX[a.code][0]}" target="_blank" rel="noopener noreferrer">${e(LINK_FIX[a.code][1])} ↗</a>`:'';
  const rows=list.map(a=>{const [tone,label]=LEVELS[lvl(a)];return `<li class="ap-att ap-att-${tone}"><span class="tag ${tone}">${label}</span><div><strong>${e(a.message)}</strong><small>${e(a.fix)}</small>${fix(a)}</div></li>`}).join('');
  const st=Object.values(s.stages||{}),ran=st.filter(x=>x?.ok===true).length,failed=st.filter(x=>x?.ok===false).length,skipped=st.filter(x=>x?.ok===null).length;
  const sub=[`Last cycle ${ago(s.generated_at)}`,`${n(ran)} stage${ran===1?'':'s'} ran`,failed&&`${n(failed)} failed`,skipped&&`${n(skipped)} skipped`].filter(Boolean).join(' · ');
  const ok=!count.action&&!count.warn?`<div class="ap-health-ok"><span class="status-dot"></span><span><strong>Engine healthy.</strong> Nothing to fix from the last cycle${count.info?'; notes below':''}.</span></div>`:'';
  const counts=count.action||count.warn?`<p class="ap-note">${[count.action&&`<b>${n(count.action)}</b> to do`,count.warn&&`<b>${n(count.warn)}</b> to watch`,count.info&&`${n(count.info)} note${count.info===1?'':'s'}`].filter(Boolean).join(' · ')}</p>`:'';
  return panel('Engine health',sub,`<div class="panel-pad ap-health">${ok}${counts}${rows?`<ul class="ap-atts">${rows}</ul>`:''}${s.tuning?.max_queries?`<p class="ap-note">Self-tuning: up to ${n(s.tuning.max_queries)} searches next cycle.</p>`:''}${vaultLine(s.capabilities,h)}</div>`);
}
/** The funnel card's 3-way exchange counts (public): offered, accepted, owed by the owner (overdue in red) and fulfilled. */
export function exchangeFunnel(s,{escapeHTML:e,n}){
  const f=s?.funnel||{};if(f.exchanges_offered==null)return '';
  const int=x=>Math.max(0,Math.floor(Number(x)||0)),over=int(f.exchanges_overdue),owed=Math.max(over,int(f.exchanges_owed)),sites=int(s?.exchanges?.by_partner_site_count);
  const items=[['Offered',f.exchanges_offered,''],['Accepted',f.exchanges_accepted,''],[over?`Owed by you · ${n(over)} overdue`:'Owed by you',owed,over?'bad':owed?'warn':''],['Fulfilled',f.exchanges_fulfilled,'good']];
  const note=[s?.sender?.link_exchange==='off'?'New offers are off (setting: Offer a 3-way link exchange).':s?.exchanges?.paused?'New offers are paused until the overdue return links are added.':'Pitches offer a return link from a related page on another of your sites, never from the site they link to.',
    sites?`${n(sites)} of your sites ${sites===1?'gives or owes':'give or owe'} return links.`:''].filter(Boolean).join(' ');
  return `<div class="panel-pad ap-xfunnel"><h3 class="ap-sub">3-way link exchanges</h3><div class="ap-split ap-split-4">${items.map(([l,x,t])=>`<div class="ap-split-item ${t}"><strong>${n(int(x))}</strong><span>${e(l)}</span></div>`).join('')}</div><p class="ap-note">${e(note)}</p></div>`;
}
const shortDay=d=>{const t=new Date(String(d)+'T12:00:00Z');return Number.isNaN(t.getTime())?String(d||''):t.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})};
const LEDGER_COLS=[['checks','Checks'],['valid','Valid'],['invalid','Invalid'],['catch_all','Catch-all'],['unknown','Unknown'],['screen_only','Screen only'],['emails_sent','Sent']];
/** Sends against the cap, verification credits, the ready queue split and the 14-day verification ledger. */
/** When pitches can go out, in the recipient's own time: weekdays, plus Saturday mornings unless the owner turned them off. */
const sendDays=s=>s?.sender?.saturday===false?'weekdays':'weekdays and Saturday mornings';
export function sendingPanel(s,h){
  const {escapeHTML:e,n,niceTime,panel}=h,c=s.capabilities||{},o=s.outreach||{},v=c.verifier||{},mode=c.outreach_mode||o.mode;
  const pct=(a,b)=>b>0?Math.min(100,Math.round(100*a/b)):0;
  const meter=(label,value,note,fill,tone='')=>`<div class="ap-meter ${tone}"><div class="ap-meter-top"><span>${e(label)}</span><strong>${e(value)}</strong></div>${fill==null?'':`<div class="pipeline-track"><div class="pipeline-fill" data-w="${fill}"></div></div>`}<small>${e(note)}</small></div>`;
  const sent=Number(o.sent_today)||0,cap=Number(o.cap_today??c.daily_send_cap)||0;
  const sendM=mode==='send'?meter('Sent today',`${n(sent)} / ${n(cap)}`,cap&&sent>=cap?'Today\'s cap is used; more tomorrow (warm-up ramp)':o.sending_now?'Sending during this cycle':o.next_send_at?`Next pitches from ${niceTime(o.next_send_at)}`:`Waiting for recipients' business hours (${sendDays(s)})`,pct(sent,cap))
    :meter('Sending',mode==='draft'?'Drafts only':'Off',mode==='draft'?'Pitches are written into Gmail Drafts; nothing is sent automatically':'Research only: nothing is written or sent',null,'muted');
  const used=Number(v.used_today)||0,lim=Number(v.daily_limit)||0,hunter=Number(v.hunter_daily_limit)>0?` · Hunter ${n(v.hunter_used_today)} / ${n(v.hunter_daily_limit)}`:'';
  const checkM=v.ready?meter('Verification credits today',`${n(used)} / ${n(lim)}`,(used>=lim?'Used up: more after midnight UTC':'Free credits only; every email needs a fresh pass')+hunter,pct(used,lim),used>=lim?'warn':'')
    :meter('Verification credits today','Off',v.key?'The daily limit is 0, so nothing can be sent':'No verifier connected, so nothing can be sent',null,'warn');
  const cpe=Number(v.credits_per_email),cpeM=meter('Credits per email (7 days)',v.credits_per_email!=null&&Number.isFinite(cpe)?String(cpe):'—',
    v.credits_per_email!=null&&Number.isFinite(cpe)?'Verification credits spent for each email sent':Array.isArray(v.ledger)?'No email sent in the last 7 days':'Measured from the next cycle on',null);
  const split=o.sendable_now!=null?`<div class="ap-split">${[['Sendable now',o.sendable_now,'good'],['Retry later',o.retry_later,''],['Held for good',o.held_permanent,'muted']].map(([l,x,t])=>`<div class="ap-split-item ${t}"><strong>${n(x)}</strong><span>${l}</span></div>`).join('')}</div>
    <p class="ap-note">Of ${n(o.ready)} ready. Retry later: waiting for a re-check. Held for good: catch-all, invalid, no mail server, suppressed or emailed in the last 90 days.</p>`
    :o.ready!=null?`<p class="ap-note">${n(o.verified_ready)} of ${n(o.ready)} ready inboxes are verified.</p>`:'';
  const blocked=s.stages?.outreach?.result?.send_blocked;
  const alerts=[blocked&&`Gmail refused to send this cycle (${({gmail_auth:'login refused',gmail_limit:'sending limit reached'}[blocked]||String(blocked).replaceAll('_',' ')).slice(0,120)}), so sending stopped until the next cycle.`,
    c.rebuild_required&&'Sending is held until the mailbox has been read back into the new vault.'].filter(Boolean).map(x=>`<div class="ap-send-alert">${e(x)}</div>`).join('');
  const L=(Array.isArray(v.ledger)?v.ledger:[]).slice(-14).reverse(),tot=k=>L.reduce((a,x)=>a+(Number(x?.[k])||0),0);
  const ledger=L.length?`<div class="ap-mini ap-ledger table-wrap"><table><thead><tr><th>Day</th>${LEDGER_COLS.map(([,l])=>`<th>${l}</th>`).join('')}</tr></thead><tbody>${L.map(x=>`<tr><td>${e(shortDay(x.date))}</td>${LEDGER_COLS.map(([k])=>`<td>${n(x[k])}</td>`).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr><td>${L.length} days</td>${LEDGER_COLS.map(([k])=>`<td>${n(tot(k))}</td>`).join('')}</tr></tfoot></table></div><p class="ap-note">Catch-all and unknown never pass. Screen only: weekend checks with credits that would expire anyway; a send still needs a fresh check.</p>`
    :`<p class="ap-note">${Array.isArray(v.ledger)?'No mailbox checks in the last 14 days.':'The verification ledger appears after the next cycle.'}</p>`;
  return panel('Sending','Today against the caps, and what the verification credits bought',`<div class="panel-pad ap-send">${alerts}${sendM}${checkM}${cpeM}${split}<h3 class="ap-sub">Verification, last 14 days</h3>${ledger}</div>`);
}
const WRITER={claude:'Claude',cloudflare:'Cloudflare AI (free)',groq:'Groq (free)',gemini:'Gemini (free)',custom:'Custom AI',template:'Template'};
export const writerLabel=k=>WRITER[k]||String(k).replaceAll('_',' ');
export function variantLabel(k){
  if(k==='unrecorded')return 'Before tracking began';
  const [kind,...rest]=String(k).split(':');
  return rest.length?`${{ai:'AI',template:'Template'}[kind]||kind.replaceAll('_',' ')} · ${rest.join(':').replaceAll('_',' ')}`:String(k).replaceAll('_',' ');
}
const REASON={only_non_editorial_inbox_published:'only a non-editorial inbox',no_email_published:'no email published',publisher_pages_unreachable:'publisher pages unreachable',catch_all_domain:'mail server accepts everything',
  mailbox_accept_all:'mail server accepts everything',mailbox_invalid:'inbox does not exist',mailbox_unknown:'verifier could not decide',publisher_mismatch:'address of another domain',unrecorded:'reason not recorded'};
export const reasonLabel=k=>REASON[k]||String(k).replaceAll('_',' ');
/** "0.029" -> "2.9%"; whole percents from 10% up. */
export const pctText=x=>{const v=100*(Number(x)||0);return (v>0&&v<10?v.toFixed(1):String(Math.round(v)))+'%'};
/** Replies per email by writer and by message, with the Wilson 95% range drawn as a range, and what free screening retired. */
export function workingPanel(s,h){
  const {escapeHTML:e,n,panel,empty}=h,o=s.outreach||{};
  const groups=[['Pitch writer',o.by_writer,writerLabel],['Message',o.by_variant,variantLabel]].map(([t,m,label])=>[t,Object.entries(m&&typeof m==='object'?m:{}).filter(([,r])=>r&&Number(r.sent)>0),label]);
  const ci=r=>Array.isArray(r.reply_ci95)&&r.reply_ci95.length===2&&r.reply_ci95.every(Number.isFinite)?r.reply_ci95:null;
  const top=Math.max(0.1,...groups.flatMap(([,rows])=>rows.map(([,r])=>ci(r)?.[1]||0)));
  const at=x=>Math.min(100,Math.round(1000*(Number(x)||0)/top)/10);
  const rate=r=>{const c=ci(r);return `<strong>${pctText(r.reply_rate)}</strong>${c?`<small>range ${pctText(c[0])}–${pctText(c[1])}</small><span class="ap-range" aria-hidden="true"><i data-l="${at(c[0])}" data-w="${Math.max(1,at(c[1])-at(c[0]))}"></i><b data-l="${at(r.reply_rate)}"></b></span>`:''}`};
  const tbl=([title,rows,label])=>rows.length?`<div class="ap-mini ap-work table-wrap"><table><thead><tr><th>${e(title)}</th><th>Sent</th><th>Replies</th><th>Positive</th><th>Reply rate</th></tr></thead><tbody>${rows.map(([k,r])=>`<tr><td><strong>${e(label(k))}</strong>${Number.isFinite(r.exposure_days)?`<small>sending for ${n(r.exposure_days)} day${r.exposure_days===1?'':'s'}</small>`:''}</td><td>${n(r.sent)}</td><td>${n(r.replied)}</td><td>${n(r.positive)}</td><td class="ap-rate">${rate(r)}</td></tr>`).join('')}</tbody></table></div>`:'';
  const tables=groups.map(tbl).join('');
  const retired=Object.entries(o.retired_by_reason&&typeof o.retired_by_reason==='object'?o.retired_by_reason:{}).filter(([,x])=>Number(x)>0).sort((a,b)=>b[1]-a[1]);
  const ret=retired.length?`<div class="ap-retired"><h3 class="ap-sub">Retired by free screening</h3><div class="ap-chipline">${retired.map(([k,x])=>`<span>${e(reasonLabel(k))} <b>${n(x)}</b></span>`).join('')}</div><p class="ap-note">Their address could not meet the send rules, so no verification credit was spent on them.</p></div>`:'';
  return panel('What\'s working','Replies per email sent. The range is the 95% Wilson interval: while ranges overlap, it is too early to call a winner',
    tables||ret?`<div class="panel-pad ap-working">${tables||'<p class="ap-note">No sends to compare yet: results per writer and message appear after the first emails.</p>'}${ret}</div>`:empty('No sends to compare yet','Results per writer and message appear after the first emails.'));
}
/** Size and format of the sealed vault against Cloudflare Pages' 25 MiB per-file limit (warns at 15 MiB, alarms at 22 MiB, as health.mjs does). */
export function vaultLine(c,{escapeHTML:e}){
  const b=Number(c?.vault_bytes);if(!(b>0))return '';
  const size=b<MiB?`${Math.max(1,Math.round(b/1024))} KiB`:`${(b/MiB).toFixed(1)} MiB`,tone=b>=22*MiB?'red':b>=15*MiB?'amber':'';
  const fmt={'v2-gzip':'compressed (v2)',v1:'uncompressed (v1)'}[c.vault_format]||(c.vault_format?String(c.vault_format):'format unknown');
  return `<div class="ap-vault-line ${tone}"><span>Sealed vault: <b>${e(size)}</b> of Cloudflare's 25 MiB file limit · ${e(fmt)}${c.rebuild_required?' · mailbox read-back pending':''}</span><span class="ap-vault-bar"><i data-w="${Math.min(100,Math.round(1000*b/(25*MiB))/10)}"></i></span></div>`;
}
const ACTIVE=new Set(['positive','won','replied','followed_up','sent','drafted','ready','form_ready','contact_form','no_contact']);
const waitsForUs=p=>needsOwner(p)||!!p?.awaiting_us;
/** The prospect table: decisions first, then replies waiting for an answer, then by status and fit. 'needs_you' shows only those two. */
export function prospectView(all,filter='active'){
  return (all||[]).filter(p=>filter==='all'||(filter==='needs_you'?waitsForUs(p):filter==='active'?ACTIVE.has(p.status)||waitsForUs(p):p.status===filter))
    .sort((a,b)=>(+needsOwner(b)-+needsOwner(a))||(+!!b.awaiting_us-+!!a.awaiting_us)||STATUS_ORDER.indexOf(a.status)-STATUS_ORDER.indexOf(b.status)||(b.score||0)-(a.score||0));
}
/** The row badge for a reply that waits for the owner, with the condition in plain words. */
export function replyBadge(p,{escapeHTML:e}){
  if(!waitsForUs(p))return '';
  const d=p.reply_draft,fresh=!!d?.at&&!(Date.parse(d.at)<Date.parse(p.last_reply_at||'')),drafted=fresh&&d.mode==='draft';
  if(needsOwner(p))return `<span class="tag red ap-need-tag">Needs your answer</span><small class="ap-why">Condition: <b>${e(CONDITION_WORDS[p.condition]||(p.condition?'another condition':'not stated'))}</b>${p.condition==='paid'?' (a fee needs your explicit approval)':''}. ${drafted?'A draft answer is in Gmail Drafts: edit it to say yes or no.':'Answer in the same Gmail thread.'}</small>`;
  return `<span class="tag amber ap-need-tag">Reply waiting</span><small class="ap-why">${drafted?'An answer is drafted in Gmail Drafts: check it and send.':fresh&&d.mode==='none'&&d.reason?`Not drafted (${e(String(d.reason).replaceAll('_',' '))}): answer in Gmail.`:'Answer in the same Gmail thread.'}</small>`;
}
// The engine's live values (public summary) for the settings it publishes, so another device never flips them by accident.
const yesNo=(v,y,n)=>typeof v==='boolean'?(v?y:n):undefined;
const LIVE_SETTING={OUTREACH_MODE:s=>s?.capabilities?.outreach_mode,REPLY_MODE:s=>s?.sender?.reply_mode,OUTREACH_DACH:s=>yesNo(s?.sender?.allow_dach,'YES','NO'),
  LINK_EXCHANGE:s=>s?.sender?.link_exchange,SATURDAY_SENDS:s=>yesNo(s?.sender?.saturday,'YES','NO'),LIST_UNSUBSCRIBE_HEADER:s=>yesNo(s?.sender?.list_unsubscribe,'on','off')};
const SENDER_SET={SENDER_NAME:x=>!!x.sender_name,SENDER_POSTAL_ADDRESS:x=>!!x.postal_address,SENDER_NAMES:x=>Number(x.per_site_names)>0};
/**
 * The value a setting shows: what this browser saved; for a dropdown without one, the engine's live value, then the safe default
 * (drafts for outreach and replies, no DACH). Secrets never show a value.
 */
export function settingValue(f,saved={},s=null){
  if(f.kind!=='setting')return '';
  const mine=saved?.[f.name];
  if(f.type!=='select')return mine==null?'':String(mine);
  const ok=x=>f.options.some(([v])=>v===x);
  return [mine,LIVE_SETTING[f.name]?.(s),f.default].find(ok)??f.options[0][0];
}
/** One field of the Connect form. `saved`: this browser's settings; `done`: GitHub has it; `bad`: the last run's login failed with it. */
export function settingsField(f,{saved={},s=null,done=false,bad=false}={},{escapeHTML:e}){
  const cur=settingValue(f,saved,s),mine=f.kind==='setting'&&saved?.[f.name]!=null&&saved[f.name]!=='';
  // Sender details: the last run says whether the engine really has them (one settings secret holds them all).
  const has=f.kind==='setting'&&!mine&&SENDER_SET[f.name]&&s?.sender?SENDER_SET[f.name](s.sender):done;
  const ok=has&&!bad,blank=f.type==='select'?'':cur;
  const input=f.type==='textarea'?`<textarea name="${f.name}" rows="4" spellcheck="false" autocomplete="off" placeholder="${e(f.kind==='setting'?ok&&!mine?'Saved; type all lines again to change':f.placeholder||'':ok?'Connected; leave blank to keep':'{ "type": "service_account", ... }')}">${e(blank)}</textarea>`
    :f.type==='select'?`<select class="selector" name="${f.name}">${f.options.map(([v,l])=>`<option value="${e(v)}" ${cur===v?'selected':''}>${e(l)}</option>`).join('')}</select>`
    :`<input name="${f.name}" type="${f.type}" ${f.type==='number'?`min="${f.min??1}" max="${f.max??50}"`:''} autocomplete="${f.type==='password'?'new-password':'off'}" value="${e(blank)}" placeholder="${e(ok&&!blank?(f.kind==='secret'?'Connected; leave blank to keep':'Saved; type to change'):f.placeholder||(f.type==='number'?'12':''))}" ${f.required&&!ok?'required':''}>`;
  return `<label class="ap-field"><span>${e(f.label)} ${bad?'<b class="ap-need">✗ rejected: re-enter</b>':ok?'<b class="ap-ok">✓ saved</b>':f.required?'<b class="ap-need">needed</b>':f.name==='SENDER_POSTAL_ADDRESS'&&s?.capabilities?.outreach_mode==='send'?'<b class="ap-need">missing while sending</b>':''}</span>${input}${f.help?`<small>${f.link?`<a href="${f.link}" target="_blank" rel="noopener">${e(f.help)} ↗</a>`:e(f.help)}</small>`:''}</label>`;
}

/** Plain answer to "why aren't more pitches going out?" */
function outreachLine(s,{escapeHTML:e,n,niceTime}){
  const o=s.outreach,v=s.capabilities?.verifier;
  const bal=v?.balance?.error==='login_rejected'?' · ✗ Verifalia rejected the login (HTTP 401): see "Needs you" above':v?.balance?.error==='permission_denied'?' · ✗ Verifalia user lacks a permission (HTTP 403): see "Needs you" above':v?.balance?` · Verifalia free credits left today: ${n(v.balance.free_credits)}`:'';
  const verify=v?`<p class="ap-outreach"><b>Mailbox verifier:</b> ${v.ready?`${e((v.providers||[]).join(' → '))} · ${n(v.used_today)}/${n(v.daily_limit)} checks used today${bal}${v.catch_all_domains_skipped?` · ${n(v.catch_all_domains_skipped)} catch-all domains skipped`:''}`:v.key?'login saved, but the daily limit is 0 (set "Mailbox checks per day")':'not connected. Add a free Verifalia login under ⚙ Connect, or nothing can be sent'}${o?` · ${n(o.verified_ready)} of ${n(o.ready)} queued inboxes verified`:''}${o?.holds&&Object.keys(o.holds).length?`<br><small>Held: ${Object.entries(o.holds).sort((a,b)=>b[1]-a[1]).map(([k,c])=>`${e(k.replaceAll('_',' '))} ${n(c)}`).join(' · ')}</small>`:''}</p>`:'';
  if(!o||o.mode==='off')return verify;
  const next=o.next_send_at?niceTime(o.next_send_at):null;
  const why=o.sent_today>=o.cap_today?`today's warm-up limit is used (${n(o.sent_today)}/${n(o.cap_today)})`:o.sending_now?'sending during this run':`waiting for recipients' business hours (${sendDays(s)})`;
  return `<p class="ap-outreach"><b>Pitches:</b> ${n(o.ready)} ready · ${e(why)}${next&&!o.sending_now?` · next pitches from <b>${e(next)}</b>`:''}</p>`+verify;
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
function connectPanel(h,s=null){
  const {escapeHTML:e,panel}=h,ready=control.diagnosisOk(ui.diag);
  const c=ui.configured||{secrets:new Set()};
  const settings=savedSettings.get()||{};
  const field=f=>settingsField(f,{saved:settings,s,done:fieldDone(f,c),bad:!!ui.rejected?.has(f.name)},h);
  // All settings travel as one secret that GitHub cannot return: a browser without its own copy rewrites every one of them.
  const sd=s?.sender||{},kept=[sd.postal_address&&'the postal address',Number(sd.per_site_names)>0&&`sign-offs for ${Number(sd.per_site_names)} site${Number(sd.per_site_names)===1?'':'s'}`].filter(Boolean);
  const fresh=ready&&!Object.keys(settings).length&&c.secrets.has(control.SETTINGS_SECRET)?`<p class="ap-hint ap-warn-hint">This browser has no copy of the settings saved from another device. Typing your name below saves <b>every</b> setting again, so fill in each one you use${kept.length?` (saved now: ${e(kept.join(' and '))})`:''}. Leave your name blank to keep them as they are.</p>`:'';
  return panel('Connect Autopilot','Two steps, once. Everything is encrypted in your browser before it reaches GitHub; nothing can read it back.',
    `<div class="panel-pad ap-connect">${tokenStep(h)}
    <section class="ap-step-card ${ready?'':'ap-locked'}"><h3>2 · DataForSEO, Gmail and your settings</h3>
      ${ready?'':'<p class="ap-hint">Finish step 1 first; then these fields unlock.</p>'}${fresh}
      <form id="ap-connect-form"><fieldset ${ready?'':'disabled'}><div class="ap-fields">${FIELDS.map(field).join('')}</div>
      <div class="ap-buttons"><button class="primary" type="submit" ${ui.busy?'disabled':''}>${ui.busy==='connect'?'Saving…':'Save & run now'}</button><button class="outline-btn" type="button" data-ap="close">Close</button></div></fieldset></form></section></div>`,
    ready?`<span class="panel-link">${c.secrets.has('LINKFORGE_DATA_KEY')?'✓ vault key set':'vault key missing'}</span>`:'');
}

// 3-way link exchanges (vault only, decrypted in this browser): what the owner promised, where, and by when.
const XCH_OPEN=['their_link_live','accepted','offered'],XCH_CLOSED=['fulfilled','declined','lapsed'],XCH_ORDER=[...XCH_OPEN,...XCH_CLOSED];
const XCH_WORDS={their_link_live:'Their link is live: add yours',accepted:'Agreed: waiting for their link',offered:'Offered, no answer yet',fulfilled:'Done: both links verified',declined:'Declined',lapsed:'Lapsed'};
const LAPSE_WORDS={no_reply:'no answer within 60 days',no_link:'no link within 120 days of their answer',bounced:'the email bounced'};
const lateOwed=(x,now)=>x?.status==='their_link_live'&&Date.parse(x.owed_by)<now;
const httpUrl=u=>/^https?:\/\/\S+$/i.test(String(u||'').trim())?String(u).trim():'';
/** A natural anchor for the return link: their article's title without a site-name suffix ("Title | Site"), else the domain. */
export function naturalAnchor(x,p={}){
  const t=String(x?.their_title||p?.title||'').replace(/\s+/g,' ').trim(),head=t.split(/\s+[|–—·]\s+/)[0].trim();
  return (head.length>=12?head:t)||String(p?.domain||'their article');
}
/** The exact HTML the owner pastes on the partner page (HTML-escaped as markup, so it is safe to paste as is). */
export const returnLinkHtml=(url,anchor)=>`<a href="${String(url).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'%3C').replace(/>/g,'%3E')}">${String(anchor).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</a>`;
/** Every exchange: overdue return links first, then those due, agreed and offered; then fulfilled, declined and lapsed (newest first). */
export function exchangeView(all,now=Date.now()){
  const when=x=>String(x.owed_by||x.accepted_at||x.offered_at||''),ended=x=>String(x.fulfilled_at||x.declined_at||x.lapsed_at||x.offered_at||'');
  const rank=x=>lateOwed(x,now)?-1:XCH_ORDER.indexOf(x.status);
  return (all||[]).filter(p=>XCH_ORDER.includes(p?.exchange?.status))
    .sort((a,b)=>rank(a.exchange)-rank(b.exchange)||(XCH_CLOSED.includes(a.exchange.status)?ended(b.exchange).localeCompare(ended(a.exchange)):when(a.exchange).localeCompare(when(b.exchange))));
}
const copyBtn=(id,label)=>`<button class="outline-btn ap-copy" type="button" data-ap="copy" data-copy="${id}">${label}</button>`;
/**
 * Prospects > Exchanges: which publisher (B) and article, which page of ours links back (C), the page they link to (A),
 * and the status. A live link of theirs gets the exact "Add this link" instruction with the HTML to paste; overdue ones
 * come first, in red. Fulfilled, declined and lapsed exchanges sit collapsed below.
 */
export function exchangesPanel(all,h,now=Date.now()){
  const {escapeHTML:e,external,niceTime,panel,table,empty}=h,list=exchangeView(all,now);
  const open=list.filter(p=>XCH_OPEN.includes(p.exchange.status)),closed=list.filter(p=>XCH_CLOSED.includes(p.exchange.status));
  const owed=open.filter(p=>p.exchange.status==='their_link_live').length,late=open.filter(p=>lateOwed(p.exchange,now)).length;
  const HEAD=['Publisher and their article','Your page that links back','Their link goes to','Status'];
  const row=(p,i)=>{const x=p.exchange,overdue=lateOwed(x,now),live=x.status==='their_link_live';
    const tone=overdue?'red':live?'amber':x.status==='fulfilled'?'green':XCH_CLOSED.includes(x.status)?'':'blue';
    const note=live?`${overdue?'Overdue since':'Due by'} ${niceTime(x.owed_by)}`:x.status==='fulfilled'?`Verified ${niceTime(x.fulfilled_at)}`
      :x.status==='accepted'?`Agreed ${niceTime(x.accepted_at)}`:x.status==='declined'?`Declined ${niceTime(x.declined_at)}`
      :x.status==='lapsed'?`Lapsed ${niceTime(x.lapsed_at)}${LAPSE_WORDS[x.lapse_reason]?`: ${LAPSE_WORDS[x.lapse_reason]}`:''}`
      :`Offered ${niceTime(x.offered_at)}${x.via==='form'?' on their contact form':''}`;
    const main=`<tr class="ap-xrow${overdue?' ap-late':live?' ap-owed':''}"><td data-th="Publisher (B)"><strong>${e(p.domain)}</strong><small>${external(x.their_url||p.page_url,(x.their_title||p.title||x.their_url||'').slice(0,80))}</small></td><td data-th="Your page that links back (C)">${external(x.partner_page,(x.partner_title||x.partner_page||'').slice(0,80))}<small>on ${e(x.partner_site)}: a contextual link to their article, in the text</small></td><td data-th="Their link goes to (A)">${external(p.asset_url,(p.asset_title||p.asset_url||'').slice(0,60))}<small>${e(p.site)}</small></td><td data-th="Status"><span class="tag ${tone}">${e(XCH_WORDS[x.status])}</span><small>${e(note)}</small></td></tr>`;
    if(!live)return main;
    const url=httpUrl(x.their_url),anchor=naturalAnchor(x,p),id=`apx-${i}`;
    return main+`<tr class="ap-xdo${overdue?' ap-late':' ap-owed'}"><td colspan="4"><div class="ap-addlink"><strong>Add this link${overdue?' now: it is overdue':''}</strong>
      <p>On ${external(x.partner_page,x.partner_page)}, add a link to ${url?external(url,url):'their article (open it from the first column)'} inside the body text, with a natural anchor such as <b>“${e(anchor)}”</b>.</p>
      ${url?`<div class="ap-snippet"><code id="${id}">${e(returnLinkHtml(url,anchor))}</code>${copyBtn(id,'Copy HTML')}<span class="ap-hidden-copy" id="${id}-u">${e(url)}</span>${copyBtn(id+'-u','Copy URL')}</div>`:''}
      <small>Autopilot finds the link on the next crawl and marks this exchange done.</small></div></td></tr>`};
  const f=closed.filter(p=>p.exchange.status==='fulfilled').length,gone=closed.length-f;
  const closedHtml=closed.length?`<details class="ap-closed"><summary>${[f&&`${f} fulfilled`,gone&&`${gone} declined or lapsed`].filter(Boolean).join(' · ')}</summary><div class="ap-stack">${table(HEAD,closed.map((p,i)=>row(p,open.length+i)))}</div></details>`:'';
  const body=open.length?`<div class="ap-stack">${table(HEAD,open.map(row))}</div>`:closed.length?`<p class="ap-note ap-pad">No open exchanges right now.</p>`:'';
  return panel('Exchanges',owed?`${owed} return link${owed===1?'':'s'} to add${late?` (${late} overdue)`:''}. Autopilot verifies each one from the next crawl. Decrypted locally.`:'3-way exchanges: they link to one of your sites, you link back from a related page on another of your sites. Decrypted locally.',
    list.length?body+closedHtml:empty('No link exchanges yet','Pitches offer one when a genuinely related page on another of your sites can link back.'));
}
/** Contact-form messages waiting to be pasted, newest first (Autopilot never submits a form). */
export function formQueueView(all){
  return (all||[]).filter(p=>p?.status==='form_ready'&&p.form_message?.body).sort((a,b)=>String(b.form_message.at||'').localeCompare(String(a.form_message.at||'')));
}
// Which prepared messages the owner marked as pasted, in this browser only (the engine cannot see a form being sent).
const PASTED=local('linkforge-forms-pasted',{});
/** Prospects > Contact forms: the publisher, their form (new tab), the subject and message to copy, and when it was prepared. Copy only. */
export function formsPanel(all,h,pasted={}){
  const {escapeHTML:e,external,niceTime,panel,table,empty}=h,list=formQueueView(all),done=p=>!!pasted?.[p.id];
  const row=(p,i)=>{const m=p.form_message,id=`apf-${i}`,form=httpUrl(m.form_url),was=done(p);
    return `<tr class="${was?'ap-pasted':''}"><td data-th="Publisher"><strong>${e(p.domain)}</strong><small>${external(p.page_url,(p.title||p.page_url||'').slice(0,80))}</small><small>Prepared ${e(niceTime(m.at))}${p.exchange?.via==='form'&&p.exchange.status==='offered'?` · offers a link from ${e(p.exchange.partner_site)}`:''}</small></td><td data-th="Form">${form?external(form,'Open contact form'):'—'}<small>Opens their site in a new tab. Paste, check and send it there yourself.</small><button class="outline-btn ap-mark" type="button" data-ap="form-pasted" data-id="${e(p.id)}">${was?'Undo: not pasted yet':'Mark as pasted'}</button></td><td data-th="Subject and message"><div class="ap-copyhead"><span>Subject</span>${copyBtn(id+'-s','Copy subject')}</div><input id="${id}-s" class="ap-form-copy" type="text" readonly value="${e(m.subject)}"><div class="ap-copyhead"><span>Message</span>${copyBtn(id+'-b','Copy message')}</div><textarea id="${id}-b" class="ap-form-copy" rows="8" readonly>${e(m.body)}</textarea></td></tr>`};
  const HEAD=['Publisher','Form','Subject and message'],todo=list.filter(p=>!done(p)),marked=list.filter(done);
  const markedHtml=marked.length?`<details class="ap-closed"><summary>${marked.length} marked as pasted in this browser</summary><div class="ap-stack">${table(HEAD,marked.map((p,i)=>row(p,todo.length+i)))}</div></details>`:'';
  return panel('Contact forms',`${list.length} ready to paste${marked.length?` (${marked.length} marked as pasted here)`:''}: these publishers publish no email address. Autopilot never submits a form, and expires a message after 21 days. Decrypted locally.`,
    list.length?(todo.length?`<div class="ap-stack">${table(HEAD,todo.map(row))}</div>`:'<p class="ap-note ap-pad">Every prepared message is marked as pasted in this browser.</p>')+markedHtml
      :empty('No contact-form messages waiting','Up to the daily setting are prepared each day for publishers that only have a contact form.'));
}
/** Prepared messages not yet marked as pasted in this browser (the vault is open), for the Needs-you count. */
export const formsLeft=(all,pasted={})=>formQueueView(all).filter(p=>!pasted?.[p.id]).length;

function privatePanel(h,s=null,tasks=ownerTasks(s)){
  const {escapeHTML:e,external,n,niceTime,statusTag,panel,table,empty}=h;
  const vline=vaultLine(s?.capabilities,h),vaultInfo=vline?`<div class="ap-inset">${vline}</div>`:'';
  if(!ui.vault){
    const canReset=!!ui.diag?.secrets;
    const waiting=[tasks.owed&&`${n(tasks.owed)} return link${tasks.owed===1?'':'s'} to add${tasks.overdue?` (${n(tasks.overdue)} overdue)`:''}`,tasks.forms&&`${n(tasks.forms)} contact-form message${tasks.forms===1?'':'s'} to paste`].filter(Boolean);
    return panel('Prospects & conversations','Encrypted in the public repo · unlocked only in your browser with the vault key',
    `${vaultInfo}${waiting.length?`<div class="ap-inset ap-unlock-why"><b>Unlock to see:</b> ${e(waiting.join(' and '))}, with the exact pages and text.</div>`:''}<div class="ap-inset ap-vault-help"><p>The <b>vault key</b> is not your GitHub token. It is the separate <code>LINKFORGE_DATA_KEY</code> created during setup (saved on the setup computer in <code>.linkforge/autopilot-unlock-key.txt</code>). Don't have it? Create a new one: this browser and GitHub get the same new key automatically.</p></div>
    <form class="inline-form ap-inset" id="ap-unlock"><input id="ap-key" type="password" autocomplete="off" placeholder="Paste vault key (LINKFORGE_DATA_KEY)" minlength="16" required><button class="primary" type="submit">Unlock</button>
      <button class="outline-btn" type="button" data-ap="newvault" ${canReset&&!ui.busy?'':'disabled'} title="${canReset?'':'Needs a working GitHub token (step 1 above)'}">${ui.busy==='newvault'?'Creating…':'Create a new vault key'}</button></form>${ui.error?`<div class="alert-warning ap-inset">${e(ui.error)}</div>`:''}`);
  }
  const all=Object.values(ui.vault.prospects||{});
  const rows=prospectView(all,ui.filter).slice(0,200)
    .map(p=>{const last=(p.history||[]).at(-1);const lastReply=[...(p.history||[])].reverse().find(h=>h.type==='reply');return `<tr><td><strong>${e(p.domain)}</strong><small>${e(p.site)} · fit ${n(p.score)}</small></td><td>${external(p.page_url,p.title||p.page_url)}<small>${e(p.reason||p.fit_section||p.query||'')}</small>${p.broken_link?`<small class="ap-why">Dead link to replace: “${e(p.broken_link.anchor||p.broken_link.host)}” (${e(p.broken_link.host)}, ${e(String(p.broken_link.reason).replaceAll('_',' '))})</small>`:''}</td><td>${p.email?e(p.email):p.contact_form?external(p.contact_form,'Contact form'):'—'}${p.contact_quality?`<small>${e(p.contact_quality.status==='verified'?'✓ inbox verified':'held: '+String(p.contact_quality.reason||'').replaceAll('_',' '))}</small>`:''}</td><td>${external(p.asset_url,(p.asset_title||'').slice(0,60))}</td><td>${statusTag(p.status)}${replyBadge(p,h)}${lastReply?.excerpt?`<small>“${e(lastReply.excerpt.slice(0,160))}”</small>`:''}<small>${last?e(last.type+' · '+niceTime(last.at)):''}</small></td></tr>`});
  const counts={needs_you:all.filter(waitsForUs).length};for(const p of all)counts[p.status]=(counts[p.status]||0)+1;
  const opts=[...(counts.needs_you||ui.filter==='needs_you'?['needs_you']:[]),'active','all',...STATUS_ORDER.filter(x=>counts[x])].map(x=>`<option value="${x}" ${ui.filter===x?'selected':''}>${x==='needs_you'?'Needs you':x==='active'?'In progress':x==='all'?'All prospects':x.replaceAll('_',' ')} ${counts[x]?`(${counts[x]})`:''}</option>`).join('');
  return panel('Prospects & conversations',`${n(all.length)} publishers tracked · decrypted locally`,
    `${vaultInfo}<div class="table-toolbar"><select class="selector" id="ap-filter">${opts}</select><button class="outline-btn" id="ap-lock" type="button">Lock</button><button class="outline-btn" type="button" data-ap="copykey">Copy vault key</button></div>${rows.length?table(['Publisher','Their page','Contact','Our asset','Status'],rows):empty('Nothing in this view','Change the filter to see more prospects.')}`);
}

/** This browser's "pasted" marks, kept only for messages still waiting to be pasted. */
function prunePasted(all){
  const marks=PASTED.get()||{},live=new Set(formQueueView(all).map(p=>p.id)),kept=Object.fromEntries(Object.entries(marks).filter(([id])=>live.has(id)));
  if(Object.keys(kept).length!==Object.keys(marks).length)PASTED.set(kept);
  return kept;
}
/** Copy a field's text: the Clipboard API, else a selection and execCommand (older or non-secure contexts). */
async function copyText(el){
  const text=el?('value' in el?el.value:el.textContent):'';if(!text)return false;
  try{await navigator.clipboard.writeText(text);return true}catch{}
  try{if(typeof el.select==='function')el.select();else{const r=document.createRange();r.selectNodeContents(el);const sel=getSelection();sel.removeAllRanges();sel.addRange(r)}return document.execCommand('copy')}catch{return false}
}
/** Open a Prospects section; with the vault locked, the unlock form (and the section opens once it is unlocked). */
function jumpTo(id){
  showApTab('prospects');const el=document.getElementById(id);
  if(el){ui.jump='';el.scrollIntoView({behavior:'smooth',block:'start'});return}
  ui.jump=id;document.getElementById('ap-private')?.scrollIntoView({behavior:'smooth',block:'start'});document.getElementById('ap-key')?.focus({preventScroll:true});
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
  if(main)new MutationObserver(()=>{main.querySelectorAll('[data-w]').forEach(el=>{el.style.width=el.dataset.w+'%'});main.querySelectorAll('[data-l]').forEach(el=>{el.style.left=el.dataset.l+'%'})}).observe(main,{childList:true});
  document.addEventListener('click',async ev=>{
    const tb=ev.target.closest('[data-ap-tab]');
    if(tb){showApTab(tb.dataset.apTab);return}
    const b=ev.target.closest('[data-ap]');if(!b)return;const a=b.dataset.ap;
    if(a==='connect'){ui.showConnect=!ui.showConnect;return reload()}
    if(a==='close'){ui.showConnect=false;return reload()}
    if(a==='open-connect'){ui.showConnect=true;await reload();document.querySelector('.ap-connect')?.scrollIntoView({behavior:'smooth',block:'start'});return}
    if(a==='goto-overview'){showApTab('overview');window.scrollTo({top:0,behavior:'smooth'});return}
    if(a==='needs-you'){ui.filter='needs_you';showApTab('prospects');await reload();window.scrollTo({top:0});return}
    if(a==='goto-exchanges'||a==='goto-forms')return jumpTo(a==='goto-forms'?'ap-forms':'ap-exchanges');
    if(a==='copy'){const ok=await copyText(document.getElementById(b.dataset.copy));b.dataset.label??=b.textContent;b.textContent=ok?'Copied ✓':'Copy blocked: select the text';b.classList.toggle('ap-copied',ok);
      clearTimeout(b._t);b._t=setTimeout(()=>{b.textContent=b.dataset.label;b.classList.remove('ap-copied')},1800);return}
    if(a==='form-pasted'){const marks={...(PASTED.get()||{})},id=b.dataset.id;if(marks[id])delete marks[id];else marks[id]=new Date().toISOString();PASTED.set(marks);return reload()}
    if(a==='forget'){control.token.set('');ui.configured=null;ui.diag=null;return reload()}
    if(a==='recheck'){ui.msg='';ui.err='';ui.showConnect=true;ui.forceDiag=true;return reload()}
    if(a==='copykey'){try{await navigator.clipboard.writeText(store.get());ui.msg='Vault key copied. Paste it on your other devices to unlock there.'}catch{ui.err='Clipboard blocked by the browser.'}return reload()}
    if(a==='newvault'){
      if(!confirm('Create a new vault key?\n\nThe current vault can no longer be opened, so the prospect list starts fresh on the next run. Who was emailed and who opted out are read back from Gmail first, and nothing is sent until that has finished. Only do this if you never had the old key.'))return;
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
    const gscJson=values.find(([f])=>f.name==='GSC_SERVICE_ACCOUNT_JSON');
    if(gscJson){try{const j=JSON.parse(gscJson[1]);if(j.type!=='service_account'||!j.private_key||!j.client_email)throw 0}catch{ui.err='The Search Console field must be the complete service-account JSON key file (type "service_account").';return reload()}}
    if(bad){ui.err=bad[0].name==='GMAIL_APP_PASSWORD'?'A Gmail app password is exactly 16 letters.':`${bad[0].label} doesn't look like an email address.`;return reload()}
    const secrets=values.filter(([f])=>f.kind==='secret');
    const settings={...savedSettings.get(),...Object.fromEntries(values.filter(([f])=>f.kind==='setting').map(([f,v])=>[f.name,v]))};
    // A positive daily limit is the owner's opt-in to paid mailbox checks; 0 switches them off.
    if(settings.EMAIL_VERIFY_DAILY_LIMIT!=null&&settings.EMAIL_VERIFY_DAILY_LIMIT!=='')settings.EMAIL_VERIFICATION_ENABLED=Number(settings.EMAIL_VERIFY_DAILY_LIMIT)>0?'YES':'NO';
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
    if(ui.jump&&ui.vault)jumpTo(ui.jump);
  });
  document.addEventListener('change',async ev=>{if(ev.target.id==='ap-filter'){ui.filter=ev.target.value;await reload()}});
  document.addEventListener('click',async ev=>{if(ev.target.id==='ap-lock'){store.set('');ui.vault=null;ui.error='';await reload()}});
}
