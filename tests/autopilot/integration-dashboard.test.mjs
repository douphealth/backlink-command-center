// The dashboard's unlocked-vault views for the new owner tasks: Prospects > Exchanges (which publisher, which page of ours
// links back, by when) and the contact-form messages to paste; plus the Saturday wording and the live values of the new
// settings. No network: the DOM is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
const mem=new Map();
globalThis.localStorage={getItem:k=>mem.get(k)??null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)};
globalThis.location={hash:'',pathname:'/',hostname:'backlink-command-center.pages.dev',host:'backlink-command-center.pages.dev'};
globalThis.history={replaceState(){}};
globalThis.document={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}};
const view=await import('../../public/autopilot-view.js');

const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const h={escapeHTML,n:x=>Number(x||0).toLocaleString('en-US'),external:(url,label)=>`<a href="${escapeHTML(url)}">${escapeHTML(label||url)} ↗</a>`,niceTime:t=>t?String(t).slice(0,10):'Not recorded',
  statusTag:s=>`<span class="tag">${escapeHTML(s)}</span>`,panel:(title,sub,body)=>`<section><h2>${escapeHTML(title)}</h2><p>${escapeHTML(sub)}</p>${body}</section>`,
  table:(hd,rows)=>`<table><tr>${hd.map(x=>`<th>${escapeHTML(x)}</th>`).join('')}</tr>${rows.join('')}</table>`,empty:(t='',d='')=>`<div class="empty"><strong>${escapeHTML(t)}</strong>${escapeHTML(d)}</div>`};
const DAY=864e5,ago=d=>new Date(Date.now()-d*DAY).toISOString();
const xp=(id,status,extra={})=>({id,domain:`${id}.example`,site:'gearuptofit.com',page_url:`https://${id}.example/a/`,title:'Their <b>article</b>',asset_url:'https://gearuptofit.com/shoe-finder',asset_title:'Shoe Finder',status:'won',
  exchange:{partner_site:'gearuptogrow.com',partner_page:`https://gearuptogrow.com/p-${id}`,partner_title:'Marathon recovery',their_url:`https://${id}.example/a/`,their_title:'Their <b>article</b>',status,offered_at:ago(20),via:'email',...extra}});

test('Exchanges: overdue return links first, then due, agreed and offered, fulfilled last; closed ones are left out',()=>{
  const all=[xp('fulfilled','fulfilled',{fulfilled_at:ago(1)}),xp('offered','offered'),xp('due','their_link_live',{their_link_at:ago(2),owed_by:ago(-5)}),
    xp('late','their_link_live',{their_link_at:ago(9),owed_by:ago(2)}),xp('agreed','accepted',{accepted_at:ago(3)}),xp('lapsed','lapsed'),xp('declined','declined'),{id:'plain',status:'sent'}];
  assert.deepEqual(view.exchangeView(all).map(p=>p.id),['late','due','agreed','offered','fulfilled']);
  const html=view.exchangesPanel(all,h);
  assert.match(html,/2 return links to add \(1 overdue\)/);
  for(const s of ['late.example','https://late.example/a/','https://gearuptogrow.com/p-late','on gearuptogrow.com','https://gearuptofit.com/shoe-finder','Overdue since','Due by','Agreed','Offered','Done: both links verified'])assert.ok(html.includes(s),s);
  assert.ok(!html.includes('lapsed.example')&&!html.includes('declined.example'),'closed exchanges are not listed');
  assert.ok(!html.includes('<b>article</b>')&&html.includes('&lt;b&gt;article&lt;/b&gt;'),'titles are escaped');
  assert.match(view.exchangesPanel([],h),/No link exchanges yet/);
});

test('contact-form messages: only those ready to paste, newest first, with the form link and the exact text, escaped',()=>{
  const fp=(id,at,status='form_ready')=>({id,domain:`${id}.example`,page_url:`https://${id}.example/x/`,title:'Race day',status,
    form_message:{subject:`Suggestion for "${id}"`,body:`Hi there,\n\n<script>x</script> one link.\n\nIf it's not a fit, just say so and I won't follow up.`,form_url:`https://${id}.example/contact/`,at,variant:'template:form'}});
  const all=[fp('old',ago(3)),fp('new',ago(1)),fp('gone',ago(30),'form_expired'),{id:'x',status:'contact_form'}];
  assert.deepEqual(view.formQueueView(all).map(p=>p.id),['new','old']);
  const html=view.formsPanel(all,h);
  assert.match(html,/2 ready to paste/);assert.ok(html.includes('https://new.example/contact/'));assert.ok(html.includes('Open contact form'));
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;')&&!html.includes('<script>'),'message text is escaped');
  assert.ok(html.includes('value="Suggestion for &quot;new&quot;"'),'the subject is ready to copy');
  assert.ok(!html.includes('gone.example'),'an expired message is not offered for pasting');
  // The prospect table counts form_ready as in progress.
  assert.deepEqual(view.prospectView(all,'active').map(p=>p.id).sort(),['new','old','x']);
});

test('the sending card says Saturday mornings unless they are turned off; the new settings show the engine\'s live values',()=>{
  const s=(sender)=>({capabilities:{outreach_mode:'send',daily_send_cap:12,verifier:{}},outreach:{mode:'send',sent_today:1,cap_today:12},sender});
  assert.match(view.sendingPanel(s({saturday:true}),h),/business hours \(weekdays and Saturday mornings\)/);
  assert.match(view.sendingPanel(s({saturday:false}),h),/business hours \(weekdays\)</);
  const field=k=>view.FIELDS.find(f=>f.name===k);
  const live={sender:{link_exchange:'off',saturday:false,list_unsubscribe:true}};
  assert.equal(view.settingValue(field('LINK_EXCHANGE'),{},live),'off');
  assert.equal(view.settingValue(field('SATURDAY_SENDS'),{},live),'NO');
  assert.equal(view.settingValue(field('LIST_UNSUBSCRIBE_HEADER'),{},live),'on');
  assert.equal(view.settingValue(field('LIST_UNSUBSCRIBE_HEADER'),{},{}),'off','default: off');
  assert.equal(view.settingValue(field('SATURDAY_SENDS'),{SATURDAY_SENDS:'YES'},live),'YES','this browser\'s own choice wins');
});
