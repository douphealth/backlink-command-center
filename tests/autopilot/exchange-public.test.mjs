// 3-way link exchange in public: funnel counts, the watchdog codes and owner alerts, and a whole cycle that publishes no details.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAutopilot,funnel} from '../../scripts/autopilot/run.mjs';
import {exchangeCounts,exchangeSummary} from '../../scripts/autopilot/exchange.mjs';
import {diagnose} from '../../scripts/autopilot/health.mjs';
import {alertsOf,WARN_CODES} from '../../scripts/autopilot/notify.mjs';
import {sealJson,open} from '../../scripts/autopilot/vault.mjs';
import {QUALIFY_VERSION} from '../../scripts/autopilot/prospect.mjs';
import {SITES} from '../../functions/_lib/sites.js';

const DAY=864e5,ago=d=>new Date(Date.now()-d*DAY).toISOString();
const x=(status,extra={})=>({exchange:{partner_site:'lang.example',partner_page:'https://lang.example/p',partner_title:'P',their_url:'https://pub.example/a',their_title:'A',score:10,status,offered_at:ago(20),via:'email',...extra}});

test('the funnel counts exchanges offered, accepted, owed, overdue and fulfilled, and the summary only how many partner sites and whether offers pause',()=>{
  const state={domains:{},prospects:{
    a:x('offered'),b:x('accepted',{accepted_at:ago(3)}),c:x('their_link_live',{accepted_at:ago(9),their_link_at:ago(8),owed_by:ago(1)}),
    d:x('their_link_live',{their_link_at:ago(2),owed_by:ago(-5),partner_site:'plants.example'}),e:x('fulfilled',{accepted_at:ago(15),their_link_at:ago(12),owed_by:ago(5),fulfilled_at:ago(6)}),
    f:x('lapsed'),g:x('declined'),h:{status:'sent'}}};
  assert.deepEqual(exchangeCounts(state),{exchanges_offered:7,exchanges_accepted:4,exchanges_owed:2,exchanges_overdue:1,exchanges_fulfilled:1});
  const f=funnel(state);
  for(const [k,v] of Object.entries(exchangeCounts(state)))assert.equal(f[k],v,k);
  assert.deepEqual(exchangeSummary(state,{cfg:{mode:'abc'}}),{by_partner_site_count:2,paused:false});
  const late={prospects:Object.fromEntries([1,2,3].map(i=>[`o${i}`,x('their_link_live',{their_link_at:ago(10),owed_by:ago(3)})]))};
  assert.deepEqual(exchangeSummary(late,{cfg:{mode:'abc'}}),{by_partner_site_count:1,paused:true});
  assert.equal(exchangeSummary(late,{cfg:{mode:'off'}}).paused,false,'nothing to pause when exchanges are off');
  assert.deepEqual(exchangeCounts({}),{exchanges_offered:0,exchanges_accepted:0,exchanges_owed:0,exchanges_overdue:0,exchanges_fulfilled:0});
});

test('watchdog: overdue return links are an action, links coming due a warning, paused offers and the form queue a note',()=>{
  const at=o=>diagnose({capabilities:{verifier:{ready:true}},funnel:{ready:30},sender:{link_exchange:'abc'},...o});
  const owed=at({funnel:{ready:30,exchanges_owed:3,exchanges_overdue:2}});
  const a=owed.find(z=>z.code==='exchange_owed');
  assert.equal(a.level,'action');
  assert.equal(a.message,'2 return links you promised are overdue; the publishers already linked to you. 1 more is due within 7 days of their link. Open Prospects > Exchanges to see exactly where to add each one.');
  assert.match(a.fix,/vault/);assert.equal(owed.filter(z=>/^exchange_(?:owed|due)$/.test(z.code)).length,1,'one alert while any is owed');
  assert.equal(at({funnel:{ready:30,exchanges_owed:4,exchanges_overdue:2}}).find(z=>z.code==='exchange_owed').message,
    '2 return links you promised are overdue; the publishers already linked to you. 2 more are due within 7 days of their link. Open Prospects > Exchanges to see exactly where to add each one.','both numbers in one alert');
  assert.match(at({funnel:{ready:30,exchanges_owed:1,exchanges_overdue:1}}).find(z=>z.code==='exchange_owed').message,/^1 return link you promised is overdue; the publisher already linked/);
  // Coming due: the same code at warning level (it escalates in the same issue once one is overdue).
  const due=at({funnel:{ready:30,exchanges_owed:2,exchanges_overdue:0}}).find(z=>z.code==='exchange_owed');
  assert.equal(due.level,'warn');assert.match(due.message,/^2 publishers have linked to you in a link exchange; the return link you promised is due within 7 days/);
  assert.ok(!at({funnel:{ready:30}}).some(z=>/^exchange/.test(z.code)),'nothing without obligations');
  const paused=at({funnel:{ready:30,exchanges_owed:4,exchanges_overdue:3}});
  assert.equal(paused.find(z=>z.code==='exchanges_paused').level,'info');assert.match(paused.find(z=>z.code==='exchanges_paused').message,/paused while 3 promised return links are overdue/);
  assert.ok(!at({funnel:{ready:30,exchanges_overdue:2}}).some(z=>z.code==='exchanges_paused'));
  assert.ok(!at({funnel:{ready:30,exchanges_overdue:3},sender:{link_exchange:'off'}}).some(z=>z.code==='exchanges_paused'),'no offers to pause when exchanges are off');
  assert.ok(at({funnel:{ready:30,exchanges_overdue:3},sender:{link_exchange:'off'}}).some(z=>z.code==='exchange_owed'),'what is owed is still owed');
  const forms=at({outreach:{form_queue:{ready:3,prepared_today:1}}}).find(z=>z.code==='forms_ready');
  assert.equal(forms.level,'info');assert.match(forms.message,/^3 contact-form messages are prepared for you to paste/);assert.match(forms.fix,/never submits a form/);
  for(const z of [...owed,...paused])assert.doesNotMatch(`${z.message} ${z.fix}`,/lang\.example|pub\.example|https?:/,'counts only');
});

test('owner alerts: an overdue return link opens an issue (action) and so does one coming due (warning code)',()=>{
  assert.ok(WARN_CODES.has('exchange_owed'));assert.ok(!WARN_CODES.has('exchange_due'),'one code: due escalates to overdue in the same issue');
  const attention=diagnose({capabilities:{verifier:{ready:true}},funnel:{ready:30,exchanges_owed:4,exchanges_overdue:3},sender:{link_exchange:'abc'}});
  const m=alertsOf({attention});
  assert.ok(m.has('exchange_owed'));assert.equal(m.get('exchange_owed').level,'action');
  assert.ok(!m.has('exchanges_paused'),'a note is not an issue');
  const m2=alertsOf({attention:diagnose({capabilities:{verifier:{ready:true}},funnel:{ready:30,exchanges_owed:1,exchanges_overdue:0}})});
  assert.ok(m2.has('exchange_owed'));assert.equal(m2.get('exchange_owed').level,'warn');
});

test('a whole cycle: a link to A starts the obligation, a fetched partner page fulfils another, and the public summary holds counts only',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lf-exchange-'));
  const paths={vault:join(dir,'vault.json'),summary:join(dir,'autopilot.json'),cache:join(dir,'crawl.json')},KEY='exchange-test-key-'.repeat(2);
  const A=SITES[0].domain,C=SITES[1].domain,resp=(body,status=200)=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8'}});
  const page=main=>`<!doctype html><html><head><title>t</title></head><body><main><p>${'words '.repeat(80)}</p>${main}</main></body></html>`;
  const web=async url=>{const u=new URL(url);
    if(u.hostname==='pub3-secret.example')return resp(page(`<p>We recommend <a href="https://${A}/shoe-finder/">this shoe finder</a>.</p>`));
    if(u.hostname==='pub1-secret.example')return resp(page('<p>No links yet.</p>'));
    if(u.hostname===C&&u.pathname==='/partner-two/')return resp(page('<p>Runners should read <a href="https://pub2-secret.example/article/">this stability shoe test</a>.</p>'));
    if(u.hostname===C&&u.pathname==='/partner-three/')return resp(page('<p>Nothing added yet.</p>'));
    return resp('',404)};
  const xc=(id,status,extra={})=>({partner_site:C,partner_page:`https://${C}/partner-${id}/`,partner_title:'Partner page',their_url:`https://pub${id==='one'?1:id==='two'?2:3}-secret.example/article/`,
    their_title:'Stability shoes',score:14,status,offered_at:ago(10),via:'email',...extra});
  const p=(n,id,status,exchange,extra={})=>({id:`pub${n}`,site:A,domain:`pub${n}-secret.example`,email:`ed@pub${n}-secret.example`,page_url:`https://pub${n}-secret.example/article/`,title:'Stability shoes',
    status,qv:QUALIFY_VERSION,found_at:ago(15),asset_url:`https://${A}/shoe-finder/`,history:[{type:'initial',at:ago(10),to:`ed@pub${n}-secret.example`,mode:'send'}],exchange:xc(id,...exchange),...extra});
  const state0={v:1,created_at:ago(60),suppression:{},queries:{},ledger:[],contacted:{},domains:{},prospects:{
    pub1:p(1,'one','sent',['offered']),
    pub2:p(2,'two','won',['their_link_live',{accepted_at:ago(6),their_link_at:ago(5),owed_by:ago(-2)}],{won:{target:`https://${A}/`,anchor:'a',rel:'follow',found_at:ago(5),checked_at:ago(1)}}),
    pub3:p(3,'three','positive',['accepted',{accepted_at:ago(2)}])}};
  await writeFile(paths.vault,JSON.stringify(await sealJson(JSON.stringify(state0),KEY)));
  const mailer={check:async()=>({status:'connected'}),close:async()=>{},send:async()=>{throw Error('nothing is sent in this test')},draft:async()=>{},
    imap:{recentHeaders:async()=>Object.assign([],{complete:true}),sentRecipients:async()=>Object.assign([],{complete:true})}};
  try{
    const {summary}=await runAutopilot({env:{LINKFORGE_DATA_KEY:KEY,SENDER_NAME:'Alex',GMAIL_ADDRESS:'me@owned.example',OUTREACH_MODE:'off'},argv:[],fetchImpl:web,mailer,useCache:false,paths});
    const s=await open(JSON.parse(await readFile(paths.vault,'utf8')),KEY);
    assert.equal(s.prospects.pub1.exchange.status,'offered');
    assert.equal(s.prospects.pub2.exchange.status,'fulfilled');assert.equal(s.prospects.pub2.exchange.verified_by,'fetch');
    assert.equal(s.prospects.pub3.status,'won');assert.equal(s.prospects.pub3.exchange.status,'their_link_live','the link check started it this cycle');assert.ok(s.prospects.pub3.exchange.owed_by);
    assert.equal(summary.stages.link_checks.result.exchange_links,undefined,'no per-cycle exchange count next to the public win list');
    assert.equal(summary.stages.exchanges.ok,true);
    assert.deepEqual({fulfilled:summary.stages.exchanges.result.fulfilled,owed:summary.stages.exchanges.result.owed,overdue:summary.stages.exchanges.result.overdue},{fulfilled:1,owed:1,overdue:0});
    assert.deepEqual(Object.fromEntries(Object.entries(summary.funnel).filter(([k])=>k.startsWith('exchanges_'))),
      {exchanges_offered:3,exchanges_accepted:2,exchanges_owed:1,exchanges_overdue:0,exchanges_fulfilled:1});
    assert.deepEqual(summary.exchanges,{by_partner_site_count:1,paused:false});
    assert.equal(summary.attention.find(a=>a.code==='exchange_owed')?.level,'warn');
    // Publishers in an exchange are not in the public list of won links (pub3 linked this cycle, pub2 earlier).
    assert.ok(!(summary.wins||[]).some(w=>/pub[23]-secret/.test(`${w.publisher} ${w.page_url}`)),JSON.stringify(summary.wins));
    // Public: no publisher still in negotiation, no partner page, no exchange record fields, no addresses.
    const text=await readFile(paths.summary,'utf8');
    for(const t of [JSON.stringify(summary),text]){
      assert.doesNotMatch(t,/pub1-secret|partner-one|partner-two|partner-three|their_url|partner_page|partner_title|owed_by/);
      assert.doesNotMatch(t,/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    }
  }finally{await rm(dir,{recursive:true,force:true})}
});
