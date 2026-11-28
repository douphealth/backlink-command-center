// Contact-form queue (forms.mjs): daily limit, skips, contacted marking, the exchange offer, expiry and count-only output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareForms,formQueue,FORM_EXPIRE_DAYS} from '../../scripts/autopilot/forms.mjs';
import {QUALIFY_VERSION} from '../../scripts/autopilot/prospect.mjs';
import {runOutreach,outreachStatus,preverify} from '../../scripts/autopilot/outreach.mjs';
import {PitchWriter} from '../../scripts/autopilot/pitch.mjs';

const DAY=864e5,T0=Date.parse('2026-11-30T15:00:00Z'),iso=ms=>new Date(ms).toISOString();
const SITES=[{domain:'gearuptofit.com',topic:'running shoes'},{domain:'gearuptogrow.com',topic:'study skills spaced repetition'}];
const ASSET={site:'gearuptofit.com',url:'https://gearuptofit.com/shoe-finder/',title:'Shoe Finder',type:'interactive_tool',interactive:true,
  description:'Answer six questions and get running shoe picks matched to your gait, weight and mileage.'};
const FROM='owner@gmail.com',CONFIG={daily:5,fromAddress:FROM,senderName:'Alex',senderNames:{},allowDach:false};
const resp=(body,{status=200}={})=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8'}});
const contactPage=(extra='',form='<input name="name"><input name="email"><textarea name="message"></textarea>')=>
  `<html><body><h1>Contact</h1>${extra}<form action="/send" method="post">${form}<button>Send</button></form></body></html>`;
/** Every page answers with a normal contact form unless `pages` says otherwise; calls are counted. */
const web=(pages={})=>{const f=async url=>{f.calls.push(String(url));const u=new URL(url),k=u.hostname+u.pathname.replace(/\/$/,'');
  if(k in pages)return pages[k]===503?resp('down',{status:503}):resp(pages[k]);return resp(contactPage())};f.calls=[];return f};
const mk=(id,domain,extra={})=>({id,site:'gearuptofit.com',domain,page_url:`https://${domain}/running-shoes/`,title:'Running shoes for beginners',status:'contact_form',
  contact_form:`https://${domain}/contact/`,qv:QUALIFY_VERSION,score:60,asset_url:ASSET.url,asset_title:ASSET.title,found_at:iso(T0-5*DAY),history:[],...extra});
const fresh=(prospects,at=T0)=>({prospects,contacted:{},suppression:{},reply_health:{status:'ok',checked_at:iso(at)},sent_reconciled_at:iso(at)});
const run=(state,{at=T0,config={},...o}={})=>{const logs=[];return prepareForms({state,config:{...CONFIG,...config},sites:SITES,assets:[ASSET],now:()=>new Date(at),log:m=>logs.push(m),...o}).then(stats=>({stats,logs}))};
/** Public output is counts only: no address, publisher domain, URL or name. */
const assertCountsOnly=(...things)=>{const s=JSON.stringify(things);
  assert.doesNotMatch(s,/@|https?:|\.com\b|\.de\b|\.example\b|Maria|Running shoes for beginners/,`counts only: ${s.slice(0,300)}`)};

test('at most the daily number of NEW messages per UTC day, best prospects first, each publisher marked contacted',async()=>{
  const ps=Object.fromEntries(Array.from({length:7},(_,i)=>[`p${i}`,mk(`p${i}`,`pub${i}.com`,{score:90-i*10})]));
  const state=fresh(ps),fetchImpl=web();
  const {stats,logs}=await run(state,{fetchImpl});
  assert.equal(stats.prepared,5);assert.equal(fetchImpl.calls.length,5,'one form-page read per prepared prospect');
  for(const i of [0,1,2,3,4]){const p=state.prospects[`p${i}`];
    assert.equal(p.status,'form_ready');assert.equal(state.contacted[p.domain],iso(T0));
    assert.deepEqual(Object.keys(p.form_message).sort(),['at','body','form_url','subject','variant','writer']);
    assert.equal(p.form_message.form_url,`https://pub${i}.com/contact/`);assert.equal(p.form_message.at,iso(T0));
    assert.equal(p.form_message.variant,'template:form');assert.equal(p.form_message.writer,'template');
    assert.equal(p.history.at(-1).type,'form_prepared');assert.equal(p.exchange,undefined,'no exchange partner, no offer');}
  for(const i of [5,6])assert.equal(state.prospects[`p${i}`].status,'contact_form','the lowest-ranked wait for the next day');
  assert.deepEqual(formQueue(state,new Date(T0)),{ready:5,prepared_today:5,expired:0});
  // Later the same UTC day: nothing new, and no page is read.
  state.reply_health.checked_at=state.sent_reconciled_at=iso(T0+3*36e5);
  const again=await run(state,{at:T0+3*36e5,fetchImpl});
  assert.equal(again.stats.prepared,0);assert.equal(again.stats.daily_limit_reached,true);assert.equal(fetchImpl.calls.length,5);
  // The next UTC day: the rest.
  state.reply_health.checked_at=state.sent_reconciled_at=iso(T0+DAY);
  const next=await run(state,{at:T0+DAY,fetchImpl});
  assert.equal(next.stats.prepared,2);assert.equal(state.prospects.p6.status,'form_ready');
  assertCountsOnly(stats,again.stats,next.stats,logs,next.logs);
  assert.match(logs[0],/forms: 5 contact-form messages prepared for you to paste \(never submitted automatically\)/);
});

test('suppressed, recently contacted, email-route, DE/AT/CH and no-solicitation publishers are skipped; old contacts are fine again',async()=>{
  const state=fresh({
    sup:mk('sup','suppressed.com'),recent:mk('recent','recent.com'),old:mk('old','oldcontact.com',{score:10}),
    dach:mk('dach','laufblog.de'),imprint:mk('imprint','imprintpub.com',{contact_form:'https://imprintpub.com/impressum/'}),
    nosolicit:mk('nosolicit','nopitch.com'),sales:mk('sales','salesform.com'),adv:mk('adv','advpage.com',{contact_form:'https://advpage.com/advertise/'}),
    support:mk('support','supportonly.com'),down:mk('down','down.com'),
    form:mk('form','both.com'),email:{...mk('email','both.com',{site:'gearuptogrow.com'}),status:'ready',email:'editor@both.com'},
    vendor:mk('vendor','vendor.com',{site_kind:'software_vendor'}),offsite:mk('offsite','offsite.com',{contact_form:'https://forms.example.org/f/1'}),
    oldqv:mk('oldqv','oldqv.com',{qv:QUALIFY_VERSION-1})});
  state.suppression['suppressed.com']={reason:'Opt-out',at:iso(T0-DAY)};
  state.contacted['recent.com']=iso(T0-10*DAY);state.contacted['oldcontact.com']=iso(T0-100*DAY);
  const fetchImpl=web({'nopitch.com/contact':contactPage('<p>Please, no solicitations or SEO pitches.</p>'),
    'salesform.com/contact':contactPage('','<input name="name"><select name="budget"><option>$1k</option></select><textarea name="msg"></textarea>'),
    'supportonly.com/contact':contactPage('<p>This form is for customer support requests only.</p>'),'down.com/contact':503});
  const {stats,logs}=await run(state,{fetchImpl,config:{daily:20}});
  const st=id=>state.prospects[id].status;
  assert.equal(st('old'),'form_ready','a publisher last contacted 100 days ago can be approached again');
  for(const id of ['sup','recent','dach','imprint','nosolicit','sales','adv','support','down','form','vendor','offsite','oldqv'])assert.equal(st(id),'contact_form',id);
  assert.equal(st('email'),'ready');
  assert.equal(stats.prepared,1);
  assert.deepEqual(stats.skipped_by,{suppressed:1,contacted_recently:1,jurisdiction_consent_required:2,no_solicitation_notice:1,sales_form:2,not_editorial_form:1,
    form_page_unreachable:1,email_route_queued:1,not_a_publisher:1,form_not_first_party:1});
  assert.equal(state.contacted['suppressed.com'],undefined);assert.equal(state.contacted['laufblog.de'],undefined);assert.equal(state.contacted['nopitch.com'],undefined);
  assert.deepEqual(state.prospects.nosolicit.form_check,{v:1,url:'https://nopitch.com/contact/',at:iso(T0),ok:false,why:'no_solicitation_notice'});
  assert.equal(state.prospects.down.form_check.why,'unreachable');assert.equal(state.prospects.down.form_check.tries,1);
  // Each page was read once; a verdict is remembered, and an unreachable page waits 3 days before its next try.
  const read=fetchImpl.calls.length;assert.equal(read,6,'old, nopitch, salesform, advpage, supportonly, down');
  state.reply_health.checked_at=state.sent_reconciled_at=iso(T0+DAY);
  const second=await run(state,{at:T0+DAY,fetchImpl,config:{daily:20}});
  assert.equal(fetchImpl.calls.length,read,'nothing is fetched again the next day');assert.equal(second.stats.prepared,0);
  state.reply_health.checked_at=state.sent_reconciled_at=iso(T0+4*DAY);
  await run(state,{at:T0+4*DAY,fetchImpl,config:{daily:20}});
  assert.equal(fetchImpl.calls.length,read+1,'only the unreachable page is tried again');assert.equal(state.prospects.down.form_check.tries,2);
  // With the owner's DE/AT/CH opt-in those two are prepared too.
  const dachState=fresh({dach:mk('dach','laufblog.de'),imprint:mk('imprint','imprintpub.com',{contact_form:'https://imprintpub.com/impressum/'})});
  assert.equal((await run(dachState,{fetchImpl:web(),config:{allowDach:true}})).stats.prepared,2);
  assertCountsOnly(stats,logs,second.stats,second.logs);
});

test('no new message without a current reply scan and Sent check, or while a hold applies; expiry still runs',async()=>{
  const old={...mk('old','expired.com'),status:'form_ready',form_message:{subject:'s',body:'b',form_url:'https://expired.com/contact/',at:iso(T0-30*DAY),variant:'template:form',writer:'template'}};
  for(const [patch,why] of [[{reply_health:{status:'backlog',checked_at:iso(T0)}},'reply_scan_not_current'],[{reply_health:{status:'ok',checked_at:iso(T0-2*36e5)}},'reply_scan_not_current'],
    [{sent_reconciled_at:undefined},'sent_check_not_current'],[{},'outreach_off']]){
    const state={...fresh({a:mk('a','pub.com'),old:structuredClone(old)}),...patch},fetchImpl=web();
    const {stats}=await run(state,{fetchImpl,config:why==='outreach_off'?{hold:'outreach_off'}:{}});
    assert.equal(stats.held,why);assert.equal(stats.prepared,0);assert.equal(fetchImpl.calls.length,0);assert.equal(state.prospects.a.status,'contact_form');
    assert.equal(state.prospects.old.status,'form_expired','expiry does not wait for the mailbox');
  }
  for(const [config,why] of [[{daily:0},'daily_limit_0'],[{fromAddress:''},'no_reply_address'],[{senderName:''},'no_sender_name']])
    assert.equal((await run(fresh({a:mk('a','pub.com')}),{fetchImpl:web(),config})).stats.held,why);
  // Per-site sender names sign the message; without one, SENDER_NAME does.
  const named=fresh({a:mk('a','pub.com')});await run(named,{fetchImpl:web(),config:{senderNames:{'gearuptofit.com':'Sam Rivera'}}});
  assert.match(named.prospects.a.form_message.body,/\nBest,\nSam Rivera\ngearuptofit\.com\nReply to: owner@gmail\.com$/);
});

test('a 3-way offer is written and recorded (via form) only when it is honest: C is another of our sites, never A',async()=>{
  const offer={partner_site:'gearuptogrow.com',partner_page:'https://gearuptogrow.com/learning/spaced-repetition/',partner_title:'Spaced repetition guide',
    their_url:'https://pub0.com/running-shoes/',their_title:'Running shoes for beginners',score:0.8};
  const state=fresh({a:mk('a','pub0.com',{score:90}),b:mk('b','pub1.com',{score:80}),c:mk('c','pub2.com',{score:70}),d:mk('d','pub3.com',{score:60})});
  const asked=[];
  const exchangePartner=(p,site)=>{asked.push([p.id,site.domain]);
    return p.id==='a'?offer:p.id==='b'?{...offer,partner_site:'gearuptofit.com',partner_page:'https://gearuptofit.com/x/',their_url:'https://pub1.com/running-shoes/'} // C would be A
      :p.id==='c'?{...offer,partner_site:'notours.com',partner_page:'https://notours.com/p/',their_url:'https://pub2.com/running-shoes/'}:(()=>{throw Error('index not built')})()};
  const {stats,logs}=await run(state,{fetchImpl:web(),exchangePartner});
  assert.deepEqual(asked,[['a','gearuptofit.com'],['b','gearuptofit.com'],['c','gearuptofit.com'],['d','gearuptofit.com']]);
  const a=state.prospects.a;
  assert.deepEqual(a.exchange,{...offer,status:'offered',offered_at:iso(T0),via:'form'});
  assert.equal(a.form_message.variant,'template:form_link_exchange');
  assert.match(a.form_message.body,/If you add it, I'll link to your "Running shoes for beginners" from my related page "Spaced repetition guide" on gearuptogrow\.com, a separate site I run\./);
  assert.doesNotMatch(a.form_message.body,/https:\/\/gearuptogrow/,'C is named, not linked: our page is the only URL');
  for(const id of ['b','c','d']){const p=state.prospects[id];
    assert.equal(p.status,'form_ready');assert.equal(p.exchange,undefined,id);assert.equal(p.form_message.variant,'template:form');assert.doesNotMatch(p.form_message.body,/separate site|in return/i)}
  assert.equal(stats.exchange_offers,1);assert.equal(stats.offers_rejected,2);
  assertCountsOnly(stats,logs);
  // LINK_EXCHANGE=off: the partner is never asked.
  const off=fresh({a:mk('a','pub0.com')});let called=0;
  await run(off,{fetchImpl:web(),exchangePartner:()=>{called++;return offer},config:{exchangeMode:'off'}});
  assert.equal(called,0);assert.equal(off.prospects.a.exchange,undefined);
});

test('a prepared message without a reply expires after 21 days: never prepared again, the publisher stays contacted, its offer lapses',async()=>{
  const prepared=(id,domain,days,extra={})=>({...mk(id,domain),status:'form_ready',...extra,
    form_message:{subject:'s',body:'b',form_url:`https://${domain}/contact/`,at:iso(T0-days*DAY),variant:'template:form_link_exchange',writer:'template'},
    history:[{type:'form_prepared',at:iso(T0-days*DAY)}]});
  const offer={partner_site:'gearuptogrow.com',partner_page:'https://gearuptogrow.com/l/',their_url:'https://late.com/a/',status:'offered',offered_at:iso(T0-22*DAY),via:'form'};
  const state=fresh({late:prepared('late','late.com',22,{exchange:{...offer}}),young:prepared('young','young.com',20),answered:prepared('answered','answered.com',30,{replied_at:iso(T0-25*DAY)}),
    emailOffer:prepared('emailOffer','mail.com',40,{exchange:{...offer,via:'email'}})});
  for(const p of Object.values(state.prospects))state.contacted[p.domain]=p.form_message.at;
  const before=structuredClone(state.contacted);
  const {stats,logs}=await run(state,{fetchImpl:web()});
  assert.equal(stats.expired,2);assert.equal(FORM_EXPIRE_DAYS,21);
  assert.equal(state.prospects.late.status,'form_expired');assert.equal(state.prospects.late.form_expired_at,iso(T0));
  assert.equal(state.prospects.late.exchange.status,'lapsed');assert.equal(state.prospects.late.exchange.lapsed_at,iso(T0));
  assert.equal(state.prospects.young.status,'form_ready');assert.equal(state.prospects.answered.status,'form_ready','a reply stops the clock');
  assert.equal(state.prospects.emailOffer.status,'form_expired');assert.equal(state.prospects.emailOffer.exchange.status,'offered','an email offer is not the form queue\'s to lapse');
  assert.deepEqual(state.contacted,before,'expiry keeps every publisher contacted');
  assert.deepEqual(formQueue(state,new Date(T0)),{ready:2,prepared_today:0,expired:2});
  // Never prepared again, even with room in the day and long after the 90-day window.
  state.reply_health.checked_at=state.sent_reconciled_at=iso(T0+120*DAY);
  const later=await run(state,{at:T0+120*DAY,fetchImpl:web(),config:{daily:20}});
  assert.equal(later.stats.prepared,0);assert.equal(state.prospects.late.status,'form_expired');
  assert.match(logs[0],/2 expired after 21 days without a reply/);assertCountsOnly(stats,logs,later.stats,later.logs);
});

test('a publisher in the form queue is never also emailed within 90 days, and the public status carries counts only',async()=>{
  const now=Date.now();
  const state=fresh({form:mk('form','both.com',{score:90})},now);
  await run(state,{at:now,fetchImpl:web()});
  assert.equal(state.prospects.form.status,'form_ready');
  // Later, another of our sites finds an address at the same publisher.
  state.prospects.email={...mk('email','both.com',{site:'gearuptogrow.com'}),status:'ready',email:'editor@both.com',email_source:'https://both.com/contact/'};
  const drafts=[];
  const out=await runOutreach({state,assets:[ASSET],sites:SITES,writer:new PitchWriter({senderName:'Alex'}),mailer:{draft:async raw=>drafts.push(raw)},
    config:{mode:'draft',dailyLimit:5,fromAddress:FROM,senderName:'Alex',postalAddress:'',sendWindow:false,gapMs:()=>0}});
  assert.equal(drafts.length,0);assert.equal(out.drafted,0);assert.equal(state.prospects.email.status,'skipped_duplicate');
  // No verification credit is spent on it either.
  const pv={prospects:{email:{...state.prospects.email,status:'ready'}},contacted:state.contacted,suppression:{}};let checks=0;
  await preverify({state:pv,mailer:{authorizeRecipient:async()=>{checks++;return {ok:false}}},now:()=>new Date(now)});
  assert.equal(checks,0);
  const s=outreachStatus(state,{limit:12,mode:'draft',qualifyVersion:QUALIFY_VERSION,now:new Date(now)});
  assert.deepEqual(s.form_queue,{ready:1,prepared_today:1,expired:0});
  assert.doesNotMatch(JSON.stringify(s.form_queue),/both|@/);
});

test('the page is re-paired like outreach does, and a blocked or unpitchable page waits',async()=>{
  const tool={site:'gearuptofit.com',url:'https://gearuptofit.com/shoe-finder/methodology/',title:'Shoe Finder methodology',type:'methodology',words:2000,description:''};
  const state=fresh({a:mk('a','pub0.com',{asset_url:'https://gearuptofit.com/thin-city-page/',asset_title:'Thin page'}),b:mk('b','pub1.com'),c:mk('c','pub2.com')});
  const picks={a:{asset:tool,match:'specific'},b:null,c:undefined};
  const {stats}=await run(state,{fetchImpl:web(),assets:[tool,ASSET],config:{pickAsset:p=>picks[p.id],blockedAssets:new Set(['https://gearuptofit.com/shoe-finder'])}});
  const a=state.prospects.a;
  assert.equal(a.status,'form_ready');assert.equal(a.asset_url,tool.url);assert.equal(a.asset_repaired_from,'https://gearuptofit.com/thin-city-page/');
  assert.ok(a.form_message.body.includes(tool.url));
  assert.equal(state.prospects.b.status,'contact_form');assert.equal(state.prospects.c.status,'contact_form');
  assert.deepEqual(stats.skipped_by,{no_pitchable_page:1,asset_not_indexable:1});assert.equal(stats.repaired,1);
});
