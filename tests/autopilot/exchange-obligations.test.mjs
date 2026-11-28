// 3-way link exchange obligations: B's link to A starts what we owe, our return link on C fulfils it, silence lapses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkLinks} from '../../scripts/autopilot/outreach.mjs';
import {buildPartnerIndex,trackExchanges,noteTheirLink,noteTheirLinkLost,LAPSE_DAYS,STALE_DAYS} from '../../scripts/autopilot/exchange.mjs';

const DAY=864e5,ago=d=>new Date(Date.now()-d*DAY).toISOString();
const resp=(body,{status=200}={})=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8'}});
const page=main=>`<!doctype html><html><head><title>t</title></head><body><nav><a href="https://nav.example/">menu</a></nav><main>${main}</main><footer>${'<p>footer</p>'}</footer></body></html>`;
const OURS=['study.example','lang.example','plants.example'],PARTNER='https://lang.example/flashcards-for-vocabulary';
/** Prospect B pitched for A=study.example with partner page C on lang.example. */
const prospect=(id,{status='sent',exchange={},...extra}={})=>({id,site:'study.example',domain:`${id}.example`,email:`ed@${id}.example`,page_url:`https://${id}.example/article/`,title:'Spaced repetition apps',
  status,history:[{type:'initial',at:ago(10),to:`ed@${id}.example`,mode:'send'}],
  exchange:{partner_site:'lang.example',partner_page:PARTNER,partner_title:'Flashcards',their_url:`https://${id}.example/article/`,their_title:'Spaced repetition apps',score:20,status:'offered',offered_at:ago(10),via:'email',...exchange},...extra});
const crawlWith=(links=[])=>[{site:'lang.example',pages:[{site:'lang.example',url:PARTNER,final_url:PARTNER,status:200,technical_status:'technically_eligible',canonical:PARTNER,
  title:'How to make flashcards',h1:'How to make flashcards',words:900,terms:['flashcard','vocabulary'],external_links:links.map(url=>({url,anchor:'a'}))}]}];

test('a link from B to A found by the link check starts the obligation in the same cycle; a link to another of our sites does not',async()=>{
  const state={prospects:{b1:prospect('b1'),b2:prospect('b2'),b3:prospect('b3',{exchange:{status:'accepted',accepted_at:ago(2)}})}};
  const f=async u=>{const h=new URL(u).hostname;
    if(h==='b1.example'||h==='b3.example')return resp(page('<p>Read <a href="https://www.study.example/spaced-repetition/">this guide</a>.</p>'));
    return resp(page('<p>See <a href="https://lang.example/flashcards-for-vocabulary">flashcards</a>.</p>'))};
  const before=Date.now(),r=await checkLinks({state,ourDomains:OURS,fetchImpl:f,fulfilDays:7});
  assert.equal(r.won,3);assert.equal(r.exchange_links,2);
  const {b1,b2,b3}=state.prospects;
  for(const p of [b1,b3]){assert.equal(p.status,'won');assert.equal(p.exchange.status,'their_link_live');
    const owed=Date.parse(p.exchange.owed_by)-Date.parse(p.exchange.their_link_at);assert.equal(owed,7*DAY,'owed within fulfilDays of their link');
    assert.ok(Date.parse(p.exchange.their_link_at)>=before-1000)}
  assert.equal(b2.status,'won','a link to C is still a won link');assert.equal(b2.exchange.status,'offered','but it is not the agreed link to A (that would be a direct swap)');
});

test('B removing its link before our return link is up cancels what we owe; after it, the loss is only noted',async()=>{
  const live=prospect('b1',{status:'won',won:{target:'https://study.example/',checked_at:ago(20),found_at:ago(30)},exchange:{status:'their_link_live',their_link_at:ago(30),owed_by:ago(23)}});
  const done=prospect('b2',{status:'won',won:{target:'https://study.example/',checked_at:ago(20),found_at:ago(30)},exchange:{status:'fulfilled',their_link_at:ago(30),owed_by:ago(23),fulfilled_at:ago(25)}});
  const state={prospects:{b1:live,b2:done}};
  await checkLinks({state,ourDomains:OURS,fetchImpl:async()=>resp(page('<p>No links here any more.</p>'))});
  assert.equal(live.status,'lost');assert.equal(live.exchange.status,'accepted');assert.equal(live.exchange.owed_by,undefined);assert.ok(live.exchange.their_link_lost_at);
  assert.equal(done.exchange.status,'fulfilled','a return link already given stays recorded');assert.ok(done.exchange.their_link_lost_at);
  // Linked again later: owed again, from the new date.
  assert.equal(noteTheirLink(live,{fulfilDays:7,now:Date.now()}),true);assert.equal(live.exchange.status,'their_link_live');assert.equal(live.exchange.their_link_lost_at,undefined);
  assert.equal(noteTheirLink(live,{fulfilDays:7}),false,'an obligation already running keeps its date');
  assert.equal(noteTheirLinkLost({exchange:{status:'offered'}}),false);
  assert.equal(noteTheirLink(done),false);assert.equal(done.exchange.their_link_lost_at,undefined,'their link is back: the note is cleared');assert.equal(done.exchange.status,'fulfilled');
});

test('an exchange offered through a contact form is link-checked too (no email in its history)',async()=>{
  const p=prospect('f1',{status:'form_ready',history:[],exchange:{via:'form',offered_at:ago(3)}});delete p.email;
  const state={prospects:{f1:p}};let fetched=0;
  await checkLinks({state,ourDomains:OURS,fetchImpl:async()=>{fetched++;return resp(page('<a href="https://study.example/">study</a>'))}});
  assert.equal(fetched,1);assert.equal(p.status,'won');assert.equal(p.exchange.status,'their_link_live');assert.equal(p.history[0].type,'won');
  // A form prospect without an exchange is not checked (nothing was sent to it).
  const plain={id:'f2',site:'study.example',domain:'f2.example',page_url:'https://f2.example/a/',status:'form_ready',history:[]};
  fetched=0;await checkLinks({state:{prospects:{f2:plain}},ourDomains:OURS,fetchImpl:async()=>{fetched++;return resp('')}});
  assert.equal(fetched,0);
});

test('our return link is verified from the crawl record of the partner page, without a fetch',async()=>{
  const p=prospect('b1',{status:'won',exchange:{status:'their_link_live',their_link_at:ago(2),owed_by:ago(-5)}});
  const index=buildPartnerIndex(crawlWith(['https://www.b1.example/article/']),OURS.map(domain=>({domain})));
  let fetched=0;const r=await trackExchanges({state:{prospects:{b1:p}},index,cfg:{fulfilDays:7},fetchImpl:async()=>{fetched++;return resp('')}});
  assert.equal(p.exchange.status,'fulfilled');assert.equal(p.exchange.verified_by,'crawl');assert.ok(p.exchange.fulfilled_at);
  assert.equal(fetched,0);assert.equal(r.fulfilled,1);assert.equal(r.owed,0);
});

test('without it in the crawl, the partner page is fetched (at most 10 a cycle, overdue first) and only a link in its content counts',async()=>{
  const index=buildPartnerIndex(crawlWith([]),OURS.map(domain=>({domain})));
  const owed=(id,dueIn,link)=>prospect(id,{status:'won',exchange:{status:'their_link_live',their_link_at:ago(7-dueIn),owed_by:ago(-dueIn),partner_page:`https://lang.example/${id}/`},link});
  const state={prospects:{
    ok:owed('ok',-2,'main'),foot:owed('foot',-1,'footer'),...Object.fromEntries(Array.from({length:12},(_,i)=>[`n${i}`,owed(`n${i}`,1+i,'none')]))}};
  const asked=[];
  const f=async u=>{const id=new URL(u).pathname.split('/')[1];asked.push(id);
    if(id==='ok')return resp(page('<p>For language learners, <a href="https://ok.example/article/">this comparison of spaced repetition apps</a> helps.</p>'));
    if(id==='foot')return resp(`<html><body><main><p>${'text '.repeat(50)}</p></main><footer><a href="https://foot.example/article/">partner</a></footer></body></html>`);
    return resp(page('<p>Nothing yet.</p>'))};
  const r=await trackExchanges({state,index,cfg:{fulfilDays:7},fetchImpl:f,maxFetches:10});
  assert.equal(r.fetched,10);assert.equal(asked.length,10);
  assert.deepEqual(asked.slice(0,2),['ok','foot'],'overdue obligations are checked first');
  assert.equal(state.prospects.ok.exchange.status,'fulfilled');assert.equal(state.prospects.ok.exchange.verified_by,'fetch');
  assert.equal(state.prospects.foot.exchange.status,'their_link_live','a footer link is not the contextual link that was promised');
  assert.equal(r.fulfilled,1);assert.equal(r.owed,13);assert.equal(r.overdue,1);
  // The next cycle starts with the ones not checked yet.
  asked.length=0;await trackExchanges({state,index,cfg:{fulfilDays:7},fetchImpl:f,maxFetches:10});
  assert.equal(asked[0],'foot','still overdue');assert.ok(asked.includes('n10')&&asked.includes('n11'),'the least recently checked follow');
});

test('a won link recorded earlier starts the obligation; opt-outs and bounces close open offers',async()=>{
  const won=prospect('w1',{status:'won',won:{target:'https://study.example/x',found_at:ago(1)}});
  const toC=prospect('w2',{status:'won',won:{target:'https://lang.example/x',found_at:ago(1)}});
  const opted=prospect('d1',{status:'declined'}),suppressed=prospect('d2',{status:'replied'}),bounced=prospect('x1',{status:'bounced'});
  const owedOptOut=prospect('d3',{status:'declined',exchange:{status:'their_link_live',their_link_at:ago(1),owed_by:ago(-6)}});
  const state={suppression:{'d2.example':{reason:'Opt-out'}},prospects:{w1:won,w2:toC,d1:opted,d2:suppressed,x1:bounced,d3:owedOptOut}};
  const r=await trackExchanges({state,index:null,cfg:{fulfilDays:7},fetchImpl:async()=>resp(page('<p>none</p>'))});
  assert.equal(won.exchange.status,'their_link_live');assert.ok(won.exchange.owed_by);
  assert.equal(toC.exchange.status,'offered');
  assert.equal(opted.exchange.status,'declined');assert.equal(suppressed.exchange.status,'declined');assert.ok(opted.exchange.declined_at);
  assert.equal(bounced.exchange.status,'lapsed');assert.equal(bounced.exchange.lapse_reason,'bounced');
  assert.equal(owedOptOut.exchange.status,'their_link_live','a publisher who linked and then opted out of email is still owed the return link');
  assert.equal(r.declined,2);assert.equal(r.lapsed,1);assert.equal(r.their_link_live,1);
});

test('an offer with no reply and no link lapses after 60 days; an answered or accepted one after 120; a later link is still honoured',async()=>{
  assert.equal(LAPSE_DAYS,60);assert.equal(STALE_DAYS,120);
  const quiet=prospect('q1',{exchange:{offered_at:ago(61)}}),young=prospect('q2',{exchange:{offered_at:ago(59)}});
  const answered=prospect('q3',{replied_at:ago(50),status:'replied',exchange:{offered_at:ago(61)}});
  const accepted=prospect('q4',{status:'positive',exchange:{status:'accepted',offered_at:ago(130),accepted_at:ago(121)}});
  const acceptedRecent=prospect('q5',{status:'positive',exchange:{status:'accepted',offered_at:ago(130),accepted_at:ago(100)}});
  const repliedBefore=prospect('q6',{replied_at:ago(70),exchange:{offered_at:ago(61)}});
  const state={prospects:{q1:quiet,q2:young,q3:answered,q4:accepted,q5:acceptedRecent,q6:repliedBefore}};
  const r=await trackExchanges({state,cfg:{fulfilDays:7},fetchImpl:async()=>resp('')});
  assert.equal(quiet.exchange.status,'lapsed');assert.equal(quiet.exchange.lapse_reason,'no_reply');assert.ok(quiet.exchange.lapsed_at);
  assert.equal(young.exchange.status,'offered');assert.equal(answered.exchange.status,'offered');
  assert.equal(accepted.exchange.status,'lapsed');assert.equal(accepted.exchange.lapse_reason,'no_link');
  assert.equal(acceptedRecent.exchange.status,'accepted');
  assert.equal(repliedBefore.exchange.status,'lapsed','a reply from before the offer is not an answer to it');
  assert.equal(r.lapsed,3);
  // B links after all: the promise is kept (back to owed, lapse cleared).
  await checkLinks({state:{prospects:{q1:quiet}},ourDomains:OURS,fetchImpl:async()=>resp(page('<a href="https://study.example/">guide</a>'))});
  assert.equal(quiet.exchange.status,'their_link_live');assert.equal(quiet.exchange.lapsed_at,undefined);
});
