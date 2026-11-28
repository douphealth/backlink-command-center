// The Autopilot overview answers "what needs me, and is the engine working" from the public summary alone:
// the Needs-you strip, engine health by level, the Sending card with the 14-day verification ledger, what's working
// (Wilson ranges), the vault size line, the prospect table's reply badges, and the Connect form's safe defaults.
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

// The same helpers app.js hands the view.
const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>Number(x||0).toLocaleString('en-US');
const external=(url,label)=>`<a href="${escapeHTML(url)}">${escapeHTML(label||url)} ↗</a>`;
const panel=(title,subtitle,body,link='')=>`<section class="panel"><h2>${escapeHTML(title)}</h2><p>${escapeHTML(subtitle)}</p>${link}${body}</section>`;
const h={escapeHTML,n,external,niceTime:t=>t?String(t).slice(0,16):'Not recorded',statusTag:s=>`<span class="tag">${escapeHTML(s)}</span>`,panel,
  table:(hd,rows)=>`<table><tr>${hd.map(x=>`<th>${escapeHTML(x)}</th>`).join('')}</tr>${rows.join('')}</table>`,
  empty:(t='',d='')=>`<div class="empty"><strong>${escapeHTML(t)}</strong>${escapeHTML(d)}</div>`,intro:()=>'<section class="intro"></section>'};
const EMAIL=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const DAY=864e5,day=k=>new Date(Date.now()-k*DAY).toISOString().slice(0,10);

const ledger=Array.from({length:16},(_,i)=>({date:day(15-i),checks:24,credits:24,valid:7,invalid:5,catch_all:7,unknown:5,hunter_checks:0,screen_only:i%7===0?3:0,emails_sent:6}));
function summary(over={}){
  return {schema:'linkforge-autopilot/1',generated_at:new Date(Date.now()-30*60e3).toISOString(),setup:[],totals:{pages_crawled:10,promotable:3,promoting_now:1,internal_suggestions:2},
    spend:{today_usd:0,month_usd:1.5,daily_cap_usd:0.5,monthly_cap_usd:10},history:[],
    capabilities:{ai_writer:'groq',outreach_mode:'send',daily_send_cap:12,connections:{},vault_bytes:Math.round(16.4*1048576),vault_format:'v2-gzip',rebuild_required:false,
      verifier:{ready:true,key:true,providers:['verifalia'],daily_limit:25,used_today:24,hunter_daily_limit:10,hunter_used_today:2,ledger:ledger.slice(-14),credits_per_email:3.4}},
    sender:{sender_name:true,postal_address:false,per_site_names:0,reply_mode:'draft',allow_dach:false},
    stages:{crawl:{ok:true,result:{pages:10}},outreach:{ok:true,result:{sent:5,send_blocked:'gmail_limit'}},reply_drafts:{ok:true,result:{drafted:1,sent:0,skipped:0,owner_needed:1}},bing_submit:{ok:null,skipped:'no key'}},
    funnel:{prospects_evaluated:100,qualified:50,ready:40,contacted:70,replied:10,positive:4,won:0,existing_links:2,needs_owner:2,awaiting_reply:4},
    outreach:{mode:'send',ready:40,verified_ready:6,sendable_now:14,retry_later:13,held_permanent:13,sent_today:5,cap_today:12,holds:{},
      by_writer:{claude:{sent:21,replied:4,positive:2,reply_rate:0.19,reply_ci95:[0.077,0.4],exposure_days:13},template:{sent:28,replied:3,positive:1,reply_rate:0.107,reply_ci95:[0.037,0.272],exposure_days:40}},
      by_variant:{'ai:list_inclusion':{sent:14,replied:2,positive:1,reply_rate:0.143,reply_ci95:[0.04,0.4],exposure_days:5},unrecorded:{sent:20,replied:1,positive:0,reply_rate:0.05,reply_ci95:[0.009,0.236],exposure_days:60}},
      retired_by_reason:{no_email_published:3,publisher_mismatch:5}},
    attention:[
      {level:'action',code:'owner_decision_pending',message:'2 publisher replies are waiting for your decision (1 mentions a fee, 1 wants a link back).',fix:'Read the thread in Gmail.'},
      {level:'action',code:'gmail_send_blocked',message:'Gmail refused to send (sending limit reached), so sending stopped for the rest of this cycle.',fix:'Sending resumes by itself.'},
      {level:'warn',code:'vault_size',message:'The sealed vault is 16.4 MiB.',fix:'Outreach keeps running either way.'},
      {level:'warn',code:'replies_waiting',message:'2 publisher replies are waiting for an answer; reply drafting was skipped.',fix:'Answer in the same Gmail thread.'},
      {level:'info',code:'holds',message:'<img src=x onerror=alert(1)> 26 queued inboxes are held.',fix:'<script>alert(2)</script>'}],
    ...over};
}
const pane=(html,k)=>{const i=html.indexOf(`data-ap-pane="${k}"`);assert.ok(i>0,`pane ${k} rendered`);const j=html.indexOf('data-ap-pane=',i+20);return html.slice(i,j<0?undefined:j)};

test('needsYou: decisions plus the other unanswered replies, never double counted',()=>{
  assert.deepEqual(view.needsYou({needs_owner:2,awaiting_reply:4}),{owner:2,waiting:4,other:2,total:4});
  assert.deepEqual(view.needsYou({needs_owner:1,awaiting_reply:1}),{owner:1,waiting:1,other:0,total:1});
  assert.deepEqual(view.needsYou({needs_owner:2,awaiting_reply:0}),{owner:2,waiting:0,other:0,total:2},'a decision whose reply was answered elsewhere still counts once');
  assert.deepEqual(view.needsYou(undefined),{owner:0,waiting:0,other:0,total:0},'older summaries without the fields');
  assert.deepEqual(view.needsYou({needs_owner:'x',awaiting_reply:-3}),{owner:0,waiting:0,other:0,total:0});
});

test('the Needs-you strip: hidden at zero; otherwise counts, the Gmail inbox and the Prospects shortcut',()=>{
  assert.equal(view.needsYouStrip(summary({funnel:{needs_owner:0,awaiting_reply:0}}),h),'');
  assert.equal(view.needsYouStrip(summary({funnel:{}}),h),'');
  const html=view.needsYouStrip(summary(),h);
  assert.match(html,/<b>2<\/b><div><strong>publishers said yes with a condition<\/strong><small>2 publisher replies are waiting for your decision \(1 mentions a fee, 1 wants a link back\)/);
  assert.match(html,/<b>2<\/b><div><strong>other replies wait for an answer<\/strong><small>2 publisher replies are waiting for an answer; reply drafting was skipped/);
  assert.ok(html.includes('href="https://mail.google.com/mail/u/0/#inbox"'),'direct link to Gmail');
  assert.ok(html.includes('data-ap="needs-you"'),'opens the Prospects tab filtered to replies waiting for the owner');
  // Without the watchdog's messages (older summary), the reply mode explains what happens to the replies.
  const one=view.needsYouStrip(summary({attention:[],funnel:{needs_owner:0,awaiting_reply:1},sender:{reply_mode:'off'}}),h);
  assert.match(one,/<strong>reply waits for an answer<\/strong>/);assert.match(one,/Automatic drafts are off/);
  assert.ok(!/said yes with a condition/.test(one));
  assert.match(view.needsYouStrip(summary({attention:[],funnel:{needs_owner:1,awaiting_reply:1}}),h),/A fee, a link back or a guest post: your call/);
});

test('engine health: every level labelled, the strip codes not repeated, text escaped, fixes linked',()=>{
  const html=view.healthPanel(summary(),h);
  assert.deepEqual([...html.matchAll(/<span class="tag (\w+)">([^<]+)<\/span>/g)].map(m=>m[1]+':'+m[2]),['red:Do this','amber:Watch','blue:Note']);
  assert.ok(!html.includes('waiting for your decision')&&!html.includes('reply drafting was skipped'),'the strip shows the reply alerts');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;')&&html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'));
  assert.ok(!/<img|<script/.test(html),'no markup from the summary gets through');
  assert.match(html,/Gmail refused to send[\s\S]*?data-ap="open-connect"/,'the Gmail block points to Connect');
  assert.match(html,/<b>1<\/b> to do · <b>1<\/b> to watch · 1 note/);
  assert.match(html,/Last cycle 30 min ago · 3 stages ran · 1 skipped/);
  assert.match(html,/Sealed vault: <b>16\.4 MiB<\/b>/);
  // With nothing waiting (no strip), the reply alerts are listed here instead, so they never disappear.
  const noStrip=view.healthPanel(summary({funnel:{needs_owner:0,awaiting_reply:0}}),h);
  assert.ok(noStrip.includes('waiting for your decision')&&noStrip.includes('href="https://mail.google.com/mail/u/0/#inbox"'));
  // Only notes: the engine says it is healthy.
  const calm=view.healthPanel(summary({funnel:{},attention:[{level:'info',code:'queue_low',message:'Fewer than 20 queued.',fix:'No action needed.'}]}),h);
  assert.match(calm,/Engine healthy\./);assert.ok(!calm.includes('ap-fix'),'notes carry no fix button');
  assert.match(view.healthPanel(summary({attention:undefined,stages:undefined}),h),/Engine healthy/,'older summaries');
});

test('the Sending card: sends against the cap, credits, credits per email, the queue split and 14 days of ledger',()=>{
  const html=view.sendingPanel(summary(),h);
  assert.match(html,/<span>Sent today<\/span><strong>5 \/ 12<\/strong>/);
  assert.match(html,/<span>Verification credits today<\/span><strong>24 \/ 25<\/strong>/);assert.match(html,/Hunter 2 \/ 10/);
  assert.match(html,/<span>Credits per email \(7 days\)<\/span><strong>3\.4<\/strong>/);
  assert.match(html,/<strong>14<\/strong><span>Sendable now<\/span>[\s\S]*<strong>13<\/strong><span>Retry later<\/span>[\s\S]*<strong>13<\/strong><span>Held for good<\/span>/);
  assert.match(html,/Gmail refused to send this cycle \(sending limit reached\)/);
  const body=html.slice(html.indexOf('<tbody>'),html.indexOf('</tbody>')),rows=body.match(/<tr>/g)||[];
  assert.equal(rows.length,14,'the last 14 days');
  const first=body.match(/<tr><td>([^<]+)<\/td>/)[1],newest=new Date(day(0)+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
  assert.equal(first,newest,'newest day first');
  for(const head of ['Valid','Invalid','Catch-all','Unknown','Screen only','Sent'])assert.ok(html.includes(`<th>${head}</th>`),head);
  assert.match(html,/<tfoot><tr><td>14 days<\/td><td>336<\/td><td>98<\/td><td>70<\/td><td>98<\/td><td>70<\/td><td>6<\/td><td>84<\/td><\/tr><\/tfoot>/,'14-day totals');
  assert.match(html,/data-w="42"/,'sent-today bar');assert.match(html,/data-w="96"/,'credits bar');
  // An older summary: no ledger, no split; drafts mode.
  const old=view.sendingPanel(summary({capabilities:{outreach_mode:'draft',verifier:{ready:true,daily_limit:25,used_today:3}},outreach:{ready:9,verified_ready:2},stages:{}}),h);
  assert.match(old,/<strong>Drafts only<\/strong>/);assert.match(old,/Measured from the next cycle on/);assert.match(old,/The verification ledger appears after the next cycle/);
  assert.match(old,/2 of 9 ready inboxes are verified/);assert.ok(!old.includes('ap-split-item'));
  const off=view.sendingPanel(summary({capabilities:{outreach_mode:'send',verifier:{ready:false,key:false,ledger:[],credits_per_email:null}},outreach:{}}),h);
  assert.match(off,/No verifier connected, so nothing can be sent/);assert.match(off,/No mailbox checks in the last 14 days/);assert.match(off,/No email sent in the last 7 days/);
  assert.equal(view.sendingPanel(summary({capabilities:{rebuild_required:true,verifier:{}},outreach:{},stages:{}}),h).includes('held until the mailbox has been read back'),true);
});

test('what\'s working: per writer and per message with the Wilson range drawn as a range; retired reasons counted',()=>{
  const html=view.workingPanel(summary(),h);
  assert.match(html,/<strong>Claude<\/strong><small>sending for 13 days<\/small><\/td><td>21<\/td><td>4<\/td><td>2<\/td><td class="ap-rate"><strong>19%<\/strong><small>range 7\.7%–40%<\/small>/);
  assert.match(html,/<strong>Template<\/strong>[\s\S]*?<strong>11%<\/strong><small>range 3\.7%–27%<\/small>/);
  assert.match(html,/<strong>AI · list inclusion<\/strong>/);assert.match(html,/<strong>Before tracking began<\/strong>/);
  // Range bars on one scale (the widest upper bound), all positions within 0-100.
  for(const [,l,w] of html.matchAll(/<i data-l="([\d.]+)" data-w="([\d.]+)">/g))assert.ok(+l>=0&&+l+ +w<=100.01,`range ${l}+${w}`);
  assert.match(html,/<i data-l="19\.3" data-w="80\.7"><\/i><b data-l="47\.5"><\/b>/,'Claude: 7.7%–40% on a 40% scale, rate at 19%');
  assert.match(html,/address of another domain <b>5<\/b><\/span><span>no email published <b>3<\/b>/,'retired, most frequent first');
  assert.match(view.workingPanel(summary({outreach:{}}),h),/No sends to compare yet/,'older summaries');
  assert.match(view.workingPanel(summary({outreach:{by_writer:{},retired_by_reason:{mailbox_invalid:2}}}),h),/No sends to compare yet[\s\S]*inbox does not exist <b>2<\/b>/);
  assert.equal(view.pctText(0.029),'2.9%');assert.equal(view.pctText(0.4),'40%');assert.equal(view.pctText(0),'0%');
  assert.equal(view.variantLabel('template:followup_nudge'),'Template · followup nudge');assert.equal(view.writerLabel('cloudflare'),'Cloudflare AI (free)');
  assert.ok(!view.workingPanel(summary({outreach:{by_writer:{'<b>x</b>':{sent:1,replied:0,positive:0,reply_rate:0,reply_ci95:[0,0.8]}}}}),h).includes('<b>x</b>'),'keys escaped');
});

test('the vault line: size against the 25 MiB limit, the format, and the same thresholds as the watchdog',()=>{
  assert.equal(view.vaultLine({},h),'');assert.equal(view.vaultLine(null,h),'');
  const small=view.vaultLine({vault_bytes:300000,vault_format:'v2-gzip'},h);
  assert.match(small,/<b>293 KiB<\/b> of Cloudflare's 25 MiB file limit · compressed \(v2\)/);assert.match(small,/class="ap-vault-line "/);
  assert.match(view.vaultLine({vault_bytes:16*1048576,vault_format:'v1'},h),/class="ap-vault-line amber"[\s\S]*16\.0 MiB[\s\S]*uncompressed \(v1\)[\s\S]*data-w="64"/);
  assert.match(view.vaultLine({vault_bytes:23*1048576,vault_format:'v2-gzip',rebuild_required:true},h),/class="ap-vault-line red"[\s\S]*mailbox read-back pending/);
});

test('prospect table: decisions first, then unanswered replies; the badge names the condition in plain words',()=>{
  const ps=[{id:'a',status:'ready',score:99},{id:'b',status:'replied',awaiting_us:true,score:10},{id:'c',status:'positive',needs_owner:true,condition:'paid',score:5},
    {id:'d',status:'positive',needs_owner:true,owner_decided_at:'2026-11-26T10:00:00Z',score:80},{id:'e',status:'declined'},{id:'f',status:'sent',score:50}];
  assert.deepEqual(view.prospectView(ps,'active').map(p=>p.id),['c','b','d','f','a'],'a decided owner question no longer jumps the queue; declined is not active');
  assert.deepEqual(view.prospectView(ps,'needs_you').map(p=>p.id),['c','b']);
  assert.deepEqual(view.prospectView(ps,'declined').map(p=>p.id),['e']);assert.equal(view.prospectView(ps,'all').length,6);
  const words=c=>view.replyBadge({needs_owner:true,condition:c},h).match(/Condition: <b>([^<]+)<\/b>/)[1];
  assert.equal(words('paid'),'fee');assert.equal(words('reciprocal'),'link back');assert.equal(words('guest_post'),'guest post');assert.equal(words('other'),'another condition');
  const fee=view.replyBadge({needs_owner:true,condition:'paid'},h);
  assert.match(fee,/<span class="tag red ap-need-tag">Needs your answer<\/span>/);assert.match(fee,/a fee needs your explicit approval/);
  assert.match(view.replyBadge({needs_owner:true,condition:'reciprocal',last_reply_at:'2026-11-25T10:00:00Z',reply_draft:{at:'2026-11-25T11:00:00Z',mode:'draft'}},h),/A draft answer is in Gmail Drafts/);
  assert.match(view.replyBadge({awaiting_us:true,last_reply_at:'2026-11-25T10:00:00Z',reply_draft:{at:'2026-11-25T11:00:00Z',mode:'draft'}},h),/Reply waiting[\s\S]*An answer is drafted in Gmail Drafts/);
  assert.match(view.replyBadge({awaiting_us:true,last_reply_at:'2026-11-26T10:00:00Z',reply_draft:{at:'2026-11-25T11:00:00Z',mode:'draft'}},h),/Answer in the same Gmail thread/,'a draft older than the latest reply does not count');
  assert.match(view.replyBadge({awaiting_us:true,reply_draft:{at:'2026-11-25T11:00:00Z',mode:'none',reason:'<no_page>'}},h),/Not drafted \(&lt;no page&gt;\)/);
  assert.equal(view.replyBadge({status:'positive',needs_owner:true,owner_decided_at:'2026-11-26T10:00:00Z'},h),'');
  assert.equal(view.replyBadge({status:'sent'},h),'');
});

test('Connect form: dropdowns show the saved value, then the engine\'s live value, then the safe default; textareas keep their text',()=>{
  const F=Object.fromEntries(view.FIELDS.map(f=>[f.name,f]));
  // Nothing saved in this browser and no summary: the safe options.
  assert.equal(view.settingValue(F.REPLY_MODE,{},null),'draft');
  assert.equal(view.settingValue(F.OUTREACH_DACH,{},null),'NO');
  assert.equal(view.settingValue(F.OUTREACH_MODE,{},null),'draft','never hands-free sending by default');
  // Another device: the engine's live settings, so saving from here never flips them.
  const live={capabilities:{outreach_mode:'send'},sender:{reply_mode:'off',allow_dach:true}};
  assert.equal(view.settingValue(F.OUTREACH_MODE,{},live),'send');assert.equal(view.settingValue(F.REPLY_MODE,{},live),'off');assert.equal(view.settingValue(F.OUTREACH_DACH,{},live),'YES');
  assert.equal(view.settingValue(F.OUTREACH_DACH,{},{sender:{reply_mode:'draft'}}),'NO','a missing flag is not a yes');
  assert.equal(view.settingValue(F.REPLY_MODE,{REPLY_MODE:'send'},live),'send','what this browser saved wins');
  assert.equal(view.settingValue(F.REPLY_MODE,{REPLY_MODE:'bogus'},null),'draft','an unknown value falls back to the safe default');
  assert.equal(view.settingValue(F.GMAIL_APP_PASSWORD,{GMAIL_APP_PASSWORD:'x'},null),'','secrets never show a value');
  const select=html=>html.match(/<option value="([^"]+)" selected>/)[1];
  assert.equal(select(view.settingsField(F.REPLY_MODE,{},h)),'draft');assert.equal(select(view.settingsField(F.OUTREACH_DACH,{},h)),'NO');
  const ta=view.settingsField(F.SENDER_NAMES,{saved:{SENDER_NAMES:'a.example = Alex <A>\nb.example = Alex B'},done:true},h);
  assert.match(ta,/<textarea name="SENDER_NAMES"[^>]*>a\.example = Alex &lt;A&gt;\nb\.example = Alex B<\/textarea>/,'the saved lines, escaped');
  const gsc=view.settingsField(F.GSC_SERVICE_ACCOUNT_JSON,{},h);
  assert.match(gsc,/placeholder="\{ &quot;type&quot;: &quot;service_account&quot;, \.\.\. \}"/,'the JSON hint no longer breaks out of its attribute');
  // Sender details follow what the engine reports, not just "a settings secret exists".
  const label=html=>(html.match(/<b class="ap-(?:ok|need)">([^<]+)<\/b>/)||[])[1]||'';
  const sum=sender=>({capabilities:{outreach_mode:'send'},sender});
  assert.equal(label(view.settingsField(F.SENDER_POSTAL_ADDRESS,{s:sum({postal_address:false}),done:true},h)),'missing while sending');
  assert.equal(label(view.settingsField(F.SENDER_POSTAL_ADDRESS,{s:sum({postal_address:true}),done:true},h)),'✓ saved');
  assert.equal(label(view.settingsField(F.SENDER_POSTAL_ADDRESS,{saved:{SENDER_POSTAL_ADDRESS:'PO Box 1'},s:sum({postal_address:false}),done:true},h)),'✓ saved','just saved here, before the next run');
  assert.equal(label(view.settingsField(F.SENDER_NAMES,{s:sum({per_site_names:3}),done:true},h)),'✓ saved');
  const name=view.settingsField(F.SENDER_NAME,{s:sum({sender_name:false}),done:true},h);
  assert.equal(label(name),'needed');assert.match(name,/ required>/,'the engine has no sender name, so the form asks for one');
  assert.equal(label(view.settingsField(F.GMAIL_APP_PASSWORD,{done:true,bad:true},h)),'✗ rejected: re-enter');
});

test('the whole Autopilot page: strip, pointer, health, sending and what\'s working on Overview; the vault table sorts decisions first',async()=>{
  const KEY='dashboard-test-vault-key-123';
  const state={prospects:{
    r1:{id:'r1',site:'mysite.example',domain:'ready.example',status:'ready',score:90,email:'ed@ready.example',page_url:'https://ready.example/p',asset_url:'https://mysite.example/a',history:[]},
    r2:{id:'r2',site:'mysite.example',domain:'fee.example',status:'positive',score:20,needs_owner:true,condition:'paid',awaiting_us:true,email:'ed@fee.example',page_url:'https://fee.example/p',asset_url:'https://mysite.example/a',history:[]}}};
  const box=await sealJson(JSON.stringify(state),KEY);
  const files={'/data/autopilot.json':summary(),'/data/vault.json':box};
  globalThis.fetch=async url=>{
    const json=(b,status=200)=>new Response(JSON.stringify(b),{status,headers:{'content-type':'application/json'}});
    if(files[url])return json(files[url]);
    if(String(url).startsWith('https://api.github.com/')){const u=new URL(url);
      return u.pathname.endsWith('/runs')?json({workflow_runs:[]}):u.pathname.endsWith('/autopilot.yml')?json({state:'active'}):json({message:'Not Found'},404)}
    throw Error('unexpected fetch '+url);
  };
  localStorage.setItem('linkforge-autopilot-key',KEY);
  const html=await view.renderAutopilot(h);
  const overview=pane(html,'overview');
  assert.match(overview,/class="ap-needs"/);assert.match(overview,/Engine health/);assert.match(overview,/<h2>Sending<\/h2>/);assert.match(overview,/<h2>What&#39;s working<\/h2>/);
  assert.ok(!EMAIL.test(overview),'the overview is built from public counts only');
  assert.match(html,/class="ap-pointer" data-ap="goto-overview"[\s\S]*?<b>Needs you:<\/b> 2 decisions · 2 replies to answer · 1 alert/);
  assert.match(html,/data-ap-tab="overview" aria-selected="true">Overview<span class="warn">4<\/span>/);
  const prospects=pane(html,'prospects');
  assert.ok(prospects.indexOf('fee.example')<prospects.indexOf('ready.example'),'the decision sorts first');
  assert.match(prospects,/Needs your answer<\/span><small class="ap-why">Condition: <b>fee<\/b>/);
  assert.match(prospects,/<option value="needs_you" >Needs you \(1\)<\/option>/);
  assert.match(prospects,/Sealed vault: <b>16\.4 MiB<\/b>/);
  // A quiet day and an older summary without any of the new fields both render, without the strip or the pointer.
  files['/data/autopilot.json']=summary({funnel:{ready:3},attention:[],sender:undefined,outreach:{mode:'send',ready:3,verified_ready:1,sent_today:0,cap_today:5},
    capabilities:{ai_writer:null,outreach_mode:'send',connections:{},verifier:{ready:true,key:true,daily_limit:24,used_today:24}}});
  localStorage.removeItem('linkforge-autopilot-key');
  const quiet=await view.renderAutopilot(h);
  assert.ok(!quiet.includes('class="ap-needs"')&&!quiet.includes('ap-pointer'));
  assert.match(pane(quiet,'overview'),/Engine healthy/);assert.match(quiet,/data-ap-tab="overview" aria-selected="true">Overview<\/button>/);
});
