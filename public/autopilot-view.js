/**
 * Autopilot view: reads the engine's public summary (/data/autopilot.json) and,
 * once unlocked with LINKFORGE_DATA_KEY, decrypts prospect details from
 * /data/vault.json entirely in this browser. The key never leaves the device.
 */
const KEY='linkforge-autopilot-key';
const REPO='https://github.com/douphealth/backlink-command-center';
const store={get:()=>{try{return localStorage.getItem(KEY)||''}catch{return ''}},set:v=>{try{v?localStorage.setItem(KEY,v):localStorage.removeItem(KEY)}catch{}}};
// One-click unlock link: https://…pages.dev/#key=YOUR_KEY (hash is never sent to the server).
if(location.hash.startsWith('#key=')){store.set(decodeURIComponent(location.hash.slice(5)));history.replaceState(null,'',location.pathname+'#autopilot')}

const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function openVault(box,pass){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pass),'PBKDF2',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:b64(box.salt),iterations:box.iterations},base,{name:'AES-GCM',length:256},false,['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(box.iv)},key,b64(box.ct))));
}
const fetchJson=async url=>{const r=await fetch(url,{cache:'no-store'});if(!r.ok||!(r.headers.get('content-type')||'').includes('json'))return null;return r.json()};
const ago=t=>{if(!t)return 'never';const m=Math.round((Date.now()-Date.parse(t))/60000);return m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':Math.round(m/1440)+' d ago'};
function nextRun(){const now=new Date(),slots=[[5,40],[14,10]].map(([h,m])=>{const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),h,m));if(d<=now)d.setUTCDate(d.getUTCDate()+1);return d});return new Date(Math.min(...slots))}

const STATUS_ORDER=['positive','won','replied','followed_up','sent','drafted','ready','contact_form','no_contact','already_linked','declined','bounced','skipped_duplicate','rejected'];
const ui={filter:'active',vault:null,error:''};

export async function renderAutopilot(h){
  const {escapeHTML:e,external,n,niceTime,statusTag,panel,table,empty,intro}=h;
  const s=await fetchJson('/data/autopilot.json');
  if(!s)return intro('autopilot')+`<div class="focus-bar"><div><strong>Autopilot has not published its first run yet.</strong><p>It runs twice a day in GitHub Actions and redeploys this dashboard automatically. Start it now from GitHub.</p></div><a class="primary" target="_blank" rel="noopener" href="${REPO}/actions/workflows/autopilot.yml">Run Autopilot ↗</a></div>`;
  const key=store.get();
  if(key&&!ui.vault&&!ui.error){const box=await fetchJson('/data/vault.json');if(box){try{ui.vault=await openVault(box,key)}catch{ui.error='That key does not unlock this vault.';store.set('')}}}
  const c=s.capabilities,f=s.funnel||{},t=s.totals;
  const missing=s.setup.filter(x=>!x.done);
  const modeLabel={send:'HANDS-FREE SENDING',draft:'DRAFTS TO GMAIL',off:'RESEARCH ONLY'}[c.outreach_mode];
  const status=`<div class="focus-bar"><div><strong>Autopilot ran ${e(ago(s.generated_at))} · next run ${e(niceTime(nextRun().toISOString()))}</strong><p>${n(t.pages_crawled)} pages audited across ${n(t.sites)} sites in ${n(s.duration_s)}s · DataForSEO ${e('$'+s.spend.today_usd.toFixed(2))} today / ${e('$'+s.spend.month_usd.toFixed(2))} this month (caps $${s.spend.daily_cap_usd} / $${s.spend.monthly_cap_usd})</p></div><em>${e(modeLabel)}</em></div>`;
  const setup=missing.length?panel('Finish autopilot setup',`${s.setup.length-missing.length} of ${s.setup.length} connected · run "npm run autopilot:setup" once, or add them in GitHub`,`<div class="panel-pad ap-checklist">${s.setup.map(x=>`<div class="ap-check ${x.done?'done':''}"><span>${x.done?'✓':x.required?'!':'+'}</span><div><strong>${e(x.label)}</strong><small>${e(x.unlocks)}</small></div><code>${e(x.key)}</code></div>`).join('')}</div>`,`<a class="panel-link" target="_blank" rel="noopener" href="${REPO}/settings/secrets/actions">Open GitHub secrets ↗</a>`):'';
  const kpis=[['Best URLs to promote',t.promotable,'◎',`${n(t.promoting_now)} being promoted now`],['Internal link fixes',t.internal_suggestions,'⇄','Free ranking boosts on your own sites'],['Publishers contacted',f.contacted,'↗',`${n(f.ready)} ready · ${n(f.replied)} replied`],['Backlinks won',f.won,'◇',`+${n(f.existing_links)} existing links found`]];
  const kpiHtml=`<div class="kpi-grid">${kpis.map(([name,v,ico,note])=>`<div class="kpi"><div class="kpi-head">${e(name)}<span class="kpi-ico">${ico}</span></div><div class="kpi-value">${n(v)}</div><div class="kpi-foot">${e(note)}</div></div>`).join('')}</div>`;
  const steps=[['Prospects evaluated',f.prospects_evaluated],['Qualified publishers',f.qualified],['Contacted',f.contacted],['Replied',f.replied],['Links won',f.won]];
  const top=Math.max(1,f.prospects_evaluated||0);
  const funnel=`<div class="panel-pad pipeline">${steps.map(([k,v])=>`<div class="pipeline-row"><span>${k}</span><div class="pipeline-track"><div class="pipeline-fill" style="width:${Math.min(100,100*(v||0)/top)}%"></div></div><strong>${n(v)}</strong></div>`).join('')}</div>`;
  const stageRows=Object.entries(s.stages).map(([k,v])=>`<div class="site-row"><div class="site-monogram">${v.ok?'✓':v.ok===false?'!':'–'}</div><div><strong>${e(k.replace('_',' '))}</strong><small>${e(v.ok===false?v.error:v.skipped?'Skipped: '+v.skipped:v.result?Object.entries(v.result).filter(([,x])=>typeof x!=='object').map(([a,b])=>`${a.replaceAll('_',' ')} ${b}`).join(' · '):'ok')}</small></div>${statusTag(v.ok?'completed':v.ok===false?'failed':'hold')}</div>`).join('');
  const best=(s.best_urls||[]).slice(0,40).map((a,i)=>`<tr><td><strong>${String(i+1).padStart(2,'0')}</strong></td><td>${external(a.url,a.title)}<small>${e(a.site)} · ${e(a.type.replaceAll('_',' '))}${a.promoting?' · promoting now':''}</small><small class="ap-why">${e((a.reasons||[]).join(' · '))}</small></td><td><strong>${n(a.promotion)}</strong><small>link ${n(a.linkability)}${a.demand!=null?' · demand '+n(a.demand):''}</small></td><td>${n(a.internal_inlinks)}<small>${n(a.internal_link_suggestions)} to add</small></td><td>${n(a.prospects)}</td></tr>`);
  const internal=(s.internal_links||[]).slice(0,60).map(x=>`<tr><td>${external(x.from,x.from_title||x.from)}<small>${e(x.site)}</small></td><td><strong>“${e(x.anchor)}”</strong></td><td>${external(x.to,x.to_title||x.to)}</td></tr>`);
  const wins=(s.wins||[]).map(w=>`<tr><td><strong>${e(w.publisher)}</strong><small>${e(w.site)}</small></td><td>${external(w.page_url,w.title||w.page_url)}</td><td>${w.target?external(w.target,new URL(w.target).pathname):'—'}<small>${e(w.anchor)}</small></td><td>${statusTag(w.kind==='won'?'won':'existing')} ${w.rel?`<small>${e(w.rel)}</small>`:''}</td><td>${e(niceTime(w.found_at))}</td></tr>`);
  return intro('autopilot',`<a class="secondary" target="_blank" rel="noopener" href="${REPO}/actions/workflows/autopilot.yml">▶ Run now on GitHub</a>`)+status+setup+kpiHtml+
    `<div class="overview-grid">${panel('Outreach funnel','Every number is a stored, verified record',funnel)}${panel('Last cycle','Each stage runs independently',`<div class="sites-list">${stageRows}</div>`)}</div>`+
    `<div style="margin-top:19px">${panel('Best URLs to promote','Linkability × real search demand; templated duplicates and thin pages are demoted',best.length?table(['#','URL & why','Score','Internal links','Prospects'],best):empty('No promotable URLs yet','The next crawl will rank your pages.'))}</div>`+
    `<div style="margin-top:19px">${panel('Internal link plan','Add these links on your own pages: highest-ROI, zero-cost ranking boost',internal.length?table(['On this page','Add anchor','Linking to'],internal):empty('No internal gaps found','Your best URLs are already well linked.'))}</div>`+
    `<div style="margin-top:19px">${panel('Backlinks','Won after outreach, or already linking to you (verified on the live page)',wins.length?table(['Publisher','Page','Links to','Status','Found'],wins):empty('No verified backlinks yet','Pitched pages are re-checked every 4 days for 150 days.'))}</div>`+
    `<div style="margin-top:19px">${privatePanel(h)}</div>`+
    `<details class="data-note"><summary><strong>Last run log</strong></summary><div class="pre-detail" style="max-width:none;margin-top:10px">${e((s.log||[]).join('\n'))}</div></details>`;
}

function privatePanel(h){
  const {escapeHTML:e,external,n,niceTime,statusTag,panel,table,empty}=h;
  if(!ui.vault)return panel('Prospects & conversations','Encrypted in the public repo · unlock on this device with your LINKFORGE_DATA_KEY',
    `<form class="inline-form" id="ap-unlock" style="margin:0 23px 22px"><input id="ap-key" type="password" autocomplete="off" placeholder="Paste LINKFORGE_DATA_KEY" minlength="16" required><button class="primary" type="submit">Unlock</button></form>${ui.error?`<div class="alert-warning" style="margin:0 23px 22px">${e(ui.error)}</div>`:''}`);
  const all=Object.values(ui.vault.prospects||{});
  const active=new Set(['positive','won','replied','followed_up','sent','drafted','ready','contact_form','no_contact']);
  const rows=all.filter(p=>ui.filter==='all'||(ui.filter==='active'?active.has(p.status):p.status===ui.filter))
    .sort((a,b)=>STATUS_ORDER.indexOf(a.status)-STATUS_ORDER.indexOf(b.status)||(b.score||0)-(a.score||0)).slice(0,200)
    .map(p=>{const last=(p.history||[]).at(-1);return `<tr><td><strong>${e(p.domain)}</strong><small>${e(p.site)} · fit ${n(p.score)}</small></td><td>${external(p.page_url,p.title||p.page_url)}<small>${e(p.reason||p.fit_section||p.query||'')}</small></td><td>${p.email?e(p.email):p.contact_form?external(p.contact_form,'Contact form'):'—'}</td><td>${external(p.asset_url,(p.asset_title||'').slice(0,60))}</td><td>${statusTag(p.status)}<small>${last?e(last.type+' · '+niceTime(last.at)):''}</small></td></tr>`});
  const counts={};for(const p of all)counts[p.status]=(counts[p.status]||0)+1;
  const opts=['active','all',...STATUS_ORDER.filter(x=>counts[x])].map(x=>`<option value="${x}" ${ui.filter===x?'selected':''}>${x==='active'?'In progress':x==='all'?'All prospects':x.replaceAll('_',' ')} ${counts[x]?`(${counts[x]})`:''}</option>`).join('');
  return panel('Prospects & conversations',`${n(all.length)} publishers tracked · decrypted locally`,
    `<div class="table-toolbar"><select class="selector" id="ap-filter">${opts}</select><button class="outline-btn" id="ap-lock" type="button">Lock</button></div>${rows.length?table(['Publisher','Their page','Contact','Our asset','Status'],rows):empty('Nothing in this view','Change the filter to see more prospects.')}`);
}

export function bindAutopilot(reload){
  document.addEventListener('submit',async ev=>{if(ev.target.id!=='ap-unlock')return;ev.preventDefault();store.set(document.getElementById('ap-key').value.trim());ui.vault=null;ui.error='';await reload()});
  document.addEventListener('change',async ev=>{if(ev.target.id==='ap-filter'){ui.filter=ev.target.value;await reload()}});
  document.addEventListener('click',async ev=>{if(ev.target.id==='ap-lock'){store.set('');ui.vault=null;ui.error='';await reload()}});
}
