// The dashboard's owner tasks for 3-way exchanges and contact forms: the exact "Add this link" instruction with the HTML
// to copy (overdue first, in red; closed ones collapsed), the contact-form messages with copy buttons and per-browser
// "pasted" marks, the Needs-you strip and the funnel counts from the public summary, and the new settings' safe defaults.
// No network: fetch is injected, and the DOM is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
const mem=new Map();
globalThis.localStorage={getItem:k=>mem.get(k)??null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)};
globalThis.location={hash:'',pathname:'/',hostname:'backlink-command-center.pages.dev',host:'backlink-command-center.pages.dev'};
globalThis.history={replaceState(){}};
globalThis.document={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}};
const view=await import('../../public/autopilot-view.js');
const {sealJson}=await import('../../scripts/autopilot/vault.mjs');

const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const h={escapeHTML,n:x=>Number(x||0).toLocaleString('en-US'),external:(url,label)=>`<a target="_blank" rel="noopener noreferrer" href="${escapeHTML(url)}">${escapeHTML(label||url)} ↗</a>`,
  niceTime:t=>t?String(t).slice(0,10):'Not recorded',statusTag:s=>`<span class="tag">${escapeHTML(s)}</span>`,
  panel:(title,sub,body,link='')=>`<section class="panel"><h2>${escapeHTML(title)}</h2><p>${escapeHTML(sub)}</p>${link}${body}</section>`,
  table:(hd,rows)=>`<div class="table-wrap"><table><thead><tr>${hd.map(x=>`<th>${escapeHTML(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
  empty:(t='',d='')=>`<div class="empty"><strong>${escapeHTML(t)}</strong>${escapeHTML(d)}</div>`,intro:()=>'<section class="intro"></section>'};
const DAY=864e5,ago=d=>new Date(Date.now()-d*DAY).toISOString();
const EMAIL=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const xp=(id,status,extra={},p={})=>({id,domain:`${id}.example`,site:'gearuptofit.com',page_url:`https://${id}.example/a/`,title:'Marathon recovery foods | Run Daily',asset_url:'https://gearuptofit.com/shoe-finder',asset_title:'Shoe Finder',status:'won',email:`ed@${id}.example`,...p,
  exchange:{partner_site:'gearuptogrow.com',partner_page:`https://gearuptogrow.com/p-${id}/`,partner_title:'Growing food for runners',their_url:`https://${id}.example/a/`,their_title:'Marathon recovery foods | Run Daily',status,offered_at:ago(20),via:'email',...extra}});
const fp=(id,at,extra={})=>({id,domain:`${id}.example`,site:'gearuptofit.com',page_url:`https://${id}.example/x/`,title:'Race day',status:'form_ready',contact_form:`https://${id}.example/contact/`,
  form_message:{subject:`A resource for "${id}"`,body:`Hi there,\n\nOne link for your readers.\n\nIf it's not a fit, just say so and I won't follow up.`,form_url:`https://${id}.example/contact/`,at,variant:'template:form'},...extra});
const ids=html=>[...html.matchAll(/ id="([^"]+)"/g)].map(m=>m[1]);
const copyTargets=html=>[...html.matchAll(/data-ap="copy" data-copy="([^"]+)"/g)].map(m=>m[1]);

test('Add this link: the exact page, their URL and a natural anchor, with the HTML to copy; overdue first and red',()=>{
  const all=[xp('due','their_link_live',{their_link_at:ago(2),owed_by:ago(-5)}),xp('late','their_link_live',{their_link_at:ago(9),owed_by:ago(2)}),xp('agreed','accepted',{accepted_at:ago(3)})];
  const html=view.exchangesPanel(all,h);
  const rows=[...html.matchAll(/<tr class="(ap-x[^"]+)">/g)].map(m=>m[1]);
  assert.deepEqual(rows,['ap-xrow ap-late','ap-xdo ap-late','ap-xrow ap-owed','ap-xdo ap-owed','ap-xrow'],'the overdue one first, each live link followed by its instruction; the agreed one has none');
  const late=html.slice(html.indexOf('<tr class="ap-xdo ap-late">'),html.indexOf('<tr class="ap-xrow ap-owed">'));
  assert.match(late,/<strong>Add this link now: it is overdue<\/strong>/);
  assert.match(late,/On <a[^>]+href="https:\/\/gearuptogrow\.com\/p-late\/">https:\/\/gearuptogrow\.com\/p-late\/ ↗<\/a>, add a link to <a[^>]+href="https:\/\/late\.example\/a\/">https:\/\/late\.example\/a\/ ↗<\/a> inside the body text, with a natural anchor such as <b>“Marathon recovery foods”<\/b>/);
  assert.ok(late.includes('<code id="apx-0">&lt;a href=&quot;https://late.example/a/&quot;&gt;Marathon recovery foods&lt;/a&gt;</code>'),'the snippet, shown as text');
  assert.ok(late.includes('<span class="tag red">')===false&&html.includes('<span class="tag red">Their link is live: add yours</span><small>Overdue since'),'the overdue status is red');
  assert.match(html,/<span class="tag amber">Their link is live: add yours<\/span><small>Due by/);
  // Every copy button points at an element that exists on the page, and opens nothing.
  const targets=copyTargets(html),present=new Set(ids(html));
  assert.deepEqual(targets,['apx-0','apx-0-u','apx-1','apx-1-u']);for(const t of targets)assert.ok(present.has(t),t);
  assert.ok(!/<form|method=|action=/.test(html),'copy only');
  // No partner page link from the target site A, and the panel never shows a prospect's email.
  assert.ok(!EMAIL.test(html.replace(/https?:\/\/\S+/g,'')),'no email addresses');
});

test('the return-link HTML is safe to paste and to show: hostile titles and URLs are escaped; a non-web URL gets no snippet',()=>{
  assert.equal(view.returnLinkHtml('https://b.example/a?x=1&y="2"','Fish & <chips>'),'<a href="https://b.example/a?x=1&amp;y=&quot;2&quot;">Fish &amp; &lt;chips&gt;</a>');
  assert.equal(view.naturalAnchor({their_title:'Marathon recovery foods | Run Daily'}),'Marathon recovery foods');
  assert.equal(view.naturalAnchor({their_title:'Tips | A very long site name here'}),'Tips | A very long site name here','a short head keeps the whole title');
  assert.equal(view.naturalAnchor({},{title:'Their page title — Blog'}),'Their page title');
  assert.equal(view.naturalAnchor({},{domain:'b.example'}),'b.example');
  const evil=xp('evil','their_link_live',{owed_by:ago(1),their_title:'"><img src=x onerror=alert(1)>',partner_title:'<script>alert(2)</script>',their_url:'https://evil.example/a/"><svg onload=alert(3)>'});
  const html=view.exchangesPanel([evil],h);
  assert.ok(!/<img|<script|<svg/i.test(html),'nothing from the vault becomes markup');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const js=view.exchangesPanel([xp('js','their_link_live',{owed_by:ago(-3),their_url:'javascript:alert(1)'})],h);
  assert.ok(!js.includes('<code')&&!js.includes('data-ap="copy"'),'no snippet for a URL that is not http(s)');
  assert.match(js,/add a link to their article \(open it from the first column\)/);
});

test('contact forms: subject and message with copy buttons, the form in a new tab, the prepared date; pasted marks collapse',()=>{
  const all=[fp('old',ago(3)),fp('new',ago(1),{exchange:{status:'offered',via:'form',partner_site:'gearuptogrow.com'}}),fp('gone',ago(30),{status:'form_expired'})];
  const html=view.formsPanel(all,h);
  assert.match(html,/<h2>Contact forms<\/h2><p>2 ready to paste: these publishers publish no email address\. Autopilot never submits a form/);
  assert.ok(html.indexOf('new.example')<html.indexOf('old.example'),'newest first');
  assert.match(html,/<a target="_blank" rel="noopener noreferrer" href="https:\/\/new\.example\/contact\/">Open contact form ↗<\/a>/);
  assert.match(html,/Prepared [\d-]{10} · offers a link from gearuptogrow\.com/);
  const targets=copyTargets(html),present=new Set(ids(html));
  assert.deepEqual(targets,['apf-0-s','apf-0-b','apf-1-s','apf-1-b']);for(const t of targets)assert.ok(present.has(t),t);
  assert.ok(html.includes('<input id="apf-0-s" class="ap-form-copy" type="text" readonly value="A resource for &quot;new&quot;">'));
  assert.match(html,/<textarea id="apf-0-b" class="ap-form-copy" rows="8" readonly>Hi there,\n\nOne link for your readers\.\n\nIf it&#39;s not a fit, just say so and I won&#39;t follow up\.<\/textarea>/);
  assert.ok(!html.includes('gone.example'),'an expired message is not offered');
  assert.ok(!/<form|type="submit"/.test(html),'copy only: nothing on the page can submit their form');
  // Marked as pasted in this browser: moved to a collapsed group, with an undo.
  const marked=view.formsPanel(all,h,{new:'2026-11-27T10:00:00Z'});
  const top=marked.slice(0,marked.indexOf('<details')),closed=marked.slice(marked.indexOf('<details'));
  assert.match(marked,/2 ready to paste \(1 marked as pasted here\)/);
  assert.ok(top.includes('old.example')&&!top.includes('new.example'));
  assert.match(closed,/^<details class="ap-closed"><summary>1 marked as pasted in this browser<\/summary>/);assert.match(closed,/data-id="new">Undo: not pasted yet/);
  assert.equal(view.formsLeft(all,{new:'x'}),1);assert.equal(view.formsLeft(all,{}),2);
  assert.match(view.formsPanel(all,h,{new:'x',old:'y'}),/Every prepared message is marked as pasted in this browser/);
  assert.match(view.formsPanel([],h),/No contact-form messages waiting/);
});

const summary=(over={})=>({schema:'linkforge-autopilot/1',generated_at:new Date(Date.now()-30*60e3).toISOString(),setup:[],totals:{pages_crawled:10,promotable:3,promoting_now:1,internal_suggestions:2},
  spend:{today_usd:0,month_usd:1.5,daily_cap_usd:0.5,monthly_cap_usd:10},history:[],sites:[],
  capabilities:{ai_writer:'groq',outreach_mode:'send',daily_send_cap:12,connections:{},verifier:{ready:true,key:true,providers:['verifalia'],daily_limit:25,used_today:3}},
  sender:{sender_name:true,postal_address:true,per_site_names:0,reply_mode:'draft',allow_dach:false,list_unsubscribe:false,saturday:true,link_exchange:'abc',form_queue_daily:5},
  stages:{crawl:{ok:true,result:{pages:10}}},
  funnel:{prospects_evaluated:100,qualified:50,ready:40,contacted:70,replied:10,positive:4,won:1,existing_links:2,needs_owner:0,awaiting_reply:0,
    exchanges_offered:9,exchanges_accepted:4,exchanges_owed:3,exchanges_overdue:2,exchanges_fulfilled:1},
  exchanges:{by_partner_site_count:2,paused:false},
  outreach:{mode:'send',ready:40,verified_ready:6,sent_today:2,cap_today:12,form_queue:{ready:4,prepared_today:2,expired:1}},
  attention:[{level:'action',code:'exchange_owed',message:'2 return links you promised are overdue.',fix:'Open Prospects > Exchanges.'},
    {level:'info',code:'forms_ready',message:'4 contact-form messages are prepared for you to paste.',fix:'Optional.'}],...over});

test('Needs you: overdue return links and contact forms, each with a button to its section; replies keep Gmail',()=>{
  const t=view.ownerTasks(summary());
  assert.deepEqual({o:t.overdue,w:t.owed,f:t.forms,r:t.replies,total:t.total},{o:2,w:3,f:4,r:0,total:6});
  assert.equal(view.ownerTasks(summary(),{forms:1}).forms,1,'this browser\'s count wins when the vault is open');
  assert.deepEqual([...view.stripCodes(t)].sort(),['exchange_owed','forms_ready']);
  const html=view.needsYouStrip(summary(),h);
  assert.match(html,/<div class="ap-need urgent"><b>2<\/b><div><strong>return links you promised are overdue<\/strong><small>The publishers already linked to you\. Prospects &gt; Exchanges shows the exact page and the link to add; 1 more is due within 7 days\.<\/small>/);
  assert.match(html,/<b>4<\/b><div><strong>contact-form messages to paste<\/strong>/);
  assert.match(html,/<button class="primary" type="button" data-ap="goto-exchanges">Open Exchanges →<\/button><button class="secondary" type="button" data-ap="goto-forms">Open contact forms →<\/button>/);
  assert.ok(!html.includes('mail.google.com')&&!html.includes('data-ap="needs-you"'),'no reply buttons without replies');
  assert.match(html,/Only you can do these: Autopilot never edits your sites or submits a form\./);
  assert.match(view.needsYouStrip(summary({exchanges:{paused:true}}),h),/New exchange offers pause until they are added\./);
  // With replies too: Gmail stays the primary action.
  const both=view.needsYouStrip(summary({funnel:{...summary().funnel,needs_owner:1,awaiting_reply:2}}),h);
  assert.match(both,/Open Gmail ↗<\/a><button class="secondary" type="button" data-ap="needs-you">Show in Prospects →<\/button><button class="secondary" type="button" data-ap="goto-exchanges">/);
  assert.match(both,/A reply is the only step between a pitch and a link\./);
  // Only forms, or nothing at all.
  const forms=view.needsYouStrip(summary({funnel:{exchanges_offered:0}}),h);
  assert.match(forms,/<button class="primary" type="button" data-ap="goto-forms">/);assert.ok(!forms.includes('goto-exchanges'));
  assert.equal(view.needsYouStrip(summary({funnel:{},outreach:{}}),h),'');
  assert.equal(view.needsYouStrip(summary({funnel:{exchanges_overdue:'x'},outreach:{form_queue:{ready:-2}}}),h),'','junk counts are zero');
});

test('engine health leaves out what the strip shows; a due (not yet overdue) return link points to Exchanges',()=>{
  const html=view.healthPanel(summary(),h);
  assert.ok(!html.includes('return links you promised are overdue')&&!html.includes('contact-form messages are prepared'),'shown in the strip instead');
  const due=view.healthPanel(summary({funnel:{exchanges_owed:1,exchanges_overdue:0},outreach:{},attention:[{level:'warn',code:'exchange_due',message:'1 publisher has linked to you.',fix:'Add the link.'}]}),h);
  assert.match(due,/1 publisher has linked to you\.[\s\S]*?<button class="outline-btn ap-fix" type="button" data-ap="goto-exchanges">Open Exchanges →<\/button>/);
  // When the strip does not show the forms (none left in this browser), the note stays in the health list.
  assert.ok(view.healthPanel(summary(),h,view.ownerTasks(summary(),{forms:0})).includes('contact-form messages are prepared'));
});

test('the funnel card counts exchanges offered, accepted, owed (overdue in red) and fulfilled; older summaries show nothing',()=>{
  const html=view.exchangeFunnel(summary(),h);
  assert.deepEqual([...html.matchAll(/<div class="ap-split-item ([a-z]*)"><strong>(\d+)<\/strong><span>([^<]+)<\/span>/g)].map(m=>`${m[3]}=${m[2]}${m[1]?':'+m[1]:''}`),
    ['Offered=9','Accepted=4','Owed by you · 2 overdue=3:bad','Fulfilled=1:good']);
  assert.match(html,/2 of your sites give or owe return links\./);assert.match(html,/never from the site they link to/);
  assert.match(view.exchangeFunnel(summary({funnel:{exchanges_offered:3,exchanges_owed:1,exchanges_overdue:0}}),h),/Owed by you<\/span>/);
  assert.match(view.exchangeFunnel(summary({sender:{link_exchange:'off'}}),h),/New offers are off/);
  assert.match(view.exchangeFunnel(summary({exchanges:{paused:true}}),h),/New offers are paused until the overdue return links are added/);
  assert.equal(view.exchangeFunnel(summary({funnel:{ready:2}}),h),'');assert.equal(view.exchangeFunnel({},h),'');
});

test('settings: the new fields default to 3-way exchanges on, Saturday mornings on and the List-Unsubscribe header off',()=>{
  const F=Object.fromEntries(view.FIELDS.map(f=>[f.name,f]));
  for(const s of [null,{},{sender:{reply_mode:'draft'}}]){
    assert.equal(view.settingValue(F.LINK_EXCHANGE,{},s),'abc');assert.equal(view.settingValue(F.SATURDAY_SENDS,{},s),'YES');assert.equal(view.settingValue(F.LIST_UNSUBSCRIBE_HEADER,{},s),'off');
  }
  const sel=f=>view.settingsField(f,{},h).match(/<option value="([^"]+)" selected>/)[1];
  assert.equal(sel(F.LINK_EXCHANGE),'abc');assert.equal(sel(F.SATURDAY_SENDS),'YES');assert.equal(sel(F.LIST_UNSUBSCRIBE_HEADER),'off');
  assert.match(view.settingsField(F.LINK_EXCHANGE,{},h),/one of my OTHER related sites links to them \(never the site they link to\)/);
  assert.match(view.settingsField(F.FORM_QUEUE_DAILY,{},h),/<input name="FORM_QUEUE_DAILY" type="number" min="0" max="20"[^>]*placeholder="5 \(default\)"/);
  assert.match(view.settingsField(F.EXCHANGE_PER_SITE_MONTH,{},h),/min="0" max="20"[^>]*placeholder="6 \(default\)"/);
  assert.equal(view.settingValue(F.LINK_EXCHANGE,{LINK_EXCHANGE:'paid'},null),'abc','an unknown value falls back to the default');
});

test('the whole page: strip and funnel from public counts, Exchanges and Contact forms only with the vault open',async()=>{
  const KEY='dashboard-exchange-test-key-123';
  const prospects=Object.fromEntries([xp('late','their_link_live',{their_link_at:ago(9),owed_by:ago(2)}),xp('due','their_link_live',{their_link_at:ago(2),owed_by:ago(-5)}),xp('done','fulfilled',{fulfilled_at:ago(1)}),
    fp('f1',ago(1)),fp('f2',ago(2))].map(p=>[p.id,p]));
  const files={'/data/autopilot.json':summary(),'/data/vault.json':await sealJson(JSON.stringify({prospects}),KEY)};
  globalThis.fetch=async url=>{
    const json=(b,status=200)=>new Response(JSON.stringify(b),{status,headers:{'content-type':'application/json'}});
    if(files[url])return json(files[url]);
    if(String(url).startsWith('https://api.github.com/')){const u=new URL(url);return u.pathname.endsWith('/runs')?json({workflow_runs:[]}):u.pathname.endsWith('/autopilot.yml')?json({state:'active'}):json({message:'Not Found'},404)}
    throw Error('unexpected fetch '+url);
  };
  const pane=(html,k)=>{const i=html.indexOf(`data-ap-pane="${k}"`);assert.ok(i>0,k);const j=html.indexOf('data-ap-pane=',i+20);return html.slice(i,j<0?undefined:j)};
  // Locked: the strip and the funnel come from public counts; the Prospects tab says what unlocking shows.
  localStorage.removeItem('linkforge-autopilot-key');
  const locked=await view.renderAutopilot(h);
  assert.match(locked,/<b>Needs you:<\/b> 2 return links overdue · 4 contact forms to paste<\/span>/,'the exchange alert is not counted twice');
  assert.match(locked,/data-ap-tab="overview" aria-selected="true">Overview<span class="warn">6<\/span>/);
  const ov=pane(locked,'overview');
  assert.match(ov,/<h3 class="ap-sub">3-way link exchanges<\/h3>/);
  for(const d of ['late.example','due.example','f1.example','gearuptogrow.com/p-'])assert.ok(!locked.includes(d),`nothing from the vault without the key: ${d}`);
  assert.ok(!EMAIL.test(ov),'the overview is built from counts only');
  assert.match(pane(locked,'prospects'),/<b>Unlock to see:<\/b> 3 return links to add \(2 overdue\) and 4 contact-form messages to paste, with the exact pages and text\./);
  assert.ok(!locked.includes('id="ap-exchanges"')&&!locked.includes('id="ap-forms"'));
  // Unlocked, with one message marked as pasted in this browser: the strip counts what is left here.
  localStorage.setItem('linkforge-autopilot-key',KEY);
  localStorage.setItem('linkforge-forms-pasted',JSON.stringify({f2:'2026-11-27T10:00:00Z',gone:'2026-11-01T00:00:00Z'}));
  const open=await view.renderAutopilot(h);
  assert.match(open,/<b>Needs you:<\/b> 2 return links overdue · 1 contact form to paste<\/span>/);
  assert.deepEqual(JSON.parse(localStorage.getItem('linkforge-forms-pasted')),{f2:'2026-11-27T10:00:00Z'},'marks for messages no longer waiting are dropped');
  const pr=pane(open,'prospects');
  assert.ok(pr.indexOf('id="ap-private"')<pr.indexOf('id="ap-exchanges"')&&pr.indexOf('id="ap-exchanges"')<pr.indexOf('id="ap-forms"'));
  assert.match(pr,/<h2>Exchanges<\/h2><p>2 return links to add \(1 overdue\)/,'one is overdue in the vault');
  assert.ok(pr.indexOf('late.example')<pr.indexOf('due.example'),'overdue first');
  assert.match(pr,/<summary>1 fulfilled<\/summary>/);
  assert.match(pr,/<h2>Contact forms<\/h2><p>2 ready to paste \(1 marked as pasted here\)/);
  localStorage.removeItem('linkforge-forms-pasted');localStorage.removeItem('linkforge-autopilot-key');
});
