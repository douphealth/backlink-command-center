// Review fixes for the 3-way exchange engine (exchange review XCH-1..6): partner pages are genuinely related, C is never a site
// the publisher already links to or already gets a link from, one exchange runs per publisher, page caps hold on every path,
// return links are found wherever they point (wordpress.com, share- paths), and a deleted publisher page ends what is owed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPartnerIndex,pickPartner,exchangeTally,trackExchanges,noteTheirLink,publisherFootprint,exchangeSummary} from '../../scripts/autopilot/exchange.mjs';
import {promoteExchangeDraft,checkLinks,runOutreach} from '../../scripts/autopilot/outreach.mjs';
import {extractFeatures} from '../../scripts/autopilot/crawl.mjs';
import {answerReplies} from '../../scripts/autopilot/replies.mjs';
import {topTerms} from '../../scripts/autopilot/util.mjs';
import {PitchWriter} from '../../scripts/autopilot/pitch.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';

const DAY=864e5,NOW=Date.parse('2026-11-28T12:00:00Z'),ago=d=>new Date(NOW-d*DAY).toISOString(),iso=(ms=Date.now())=>new Date(ms).toISOString();
const CFG={mode:'abc',perPartnerSiteMonth:6,perPartnerPage:2,fulfilDays:7};
const rec=(site,path,{title,h1=title,words=1400,h2=[],text='',links=[],hosts}={})=>({site,url:`https://${site}${path}`,final_url:`https://${site}${path}`,status:200,
  technical_status:'technically_eligible',canonical:`https://${site}${path}`,noindex:false,title,h1,words,h2,terms:topTerms(`${title} ${h1} ${h1} ${h2.join(' ')} ${text}`,60),
  external_links:links.map(u=>({url:u,anchor:'see this'})),...(hosts?{external_hosts:hosts}:{})});
const SITES=['gearuptofit.com','plantastichaven.com','gearuptogrow.com','micegoneguide.com','efficientgptprompts.com','frenchyfab.com','openclaw-skillshub.com','imagealchemy.app'].map(domain=>({domain}));
const html=body=>new Response(`<html><body><main>${body}</main></body></html>`,{status:200,headers:{'content-type':'text/html'}});
const PAGE='https://efficientgptprompts.com/anki-flashcards-with-chatgpt';
const lang=()=>[
  {site:'gearuptogrow.com',pages:[rec('gearuptogrow.com','/learning/spaced-repetition/',{title:'Spaced repetition: how to remember what you study',h2:['Why spaced repetition works','Flashcards and apps'],
    text:'spaced repetition review schedule flashcards memory retention forgetting curve language vocabulary apps anki'})]},
  {site:'efficientgptprompts.com',pages:[rec('efficientgptprompts.com','/anki-flashcards-with-chatgpt/',{title:'Make Anki flashcards with ChatGPT prompts',h2:['Spaced repetition decks','Vocabulary cards'],
    text:'anki flashcards chatgpt prompts spaced repetition vocabulary decks language learners review'}),
    rec('efficientgptprompts.com','/vocabulary-decks-with-chatgpt/',{title:'Vocabulary flashcard decks with ChatGPT for language learners',h2:['Spaced repetition','Anki import'],
      text:'vocabulary flashcards anki chatgpt decks spaced repetition language learners review cards'})]},
];
const B=(extra={})=>({id:'b2',site:'gearuptogrow.com',domain:'langblog.example',page_url:'https://langblog.example/spaced-repetition-apps/',
  title:'The best spaced repetition apps for language learners',fit_section:'Flashcard apps compared',
  fit_excerpt:'Anki and other flashcard apps schedule reviews with spaced repetition so vocabulary sticks.',
  excerpt:'Learning a language means memorising thousands of words. Spaced repetition apps like Anki show each flashcard just before you forget it.',...extra});
const xOf=(page,extra={})=>({partner_site:'efficientgptprompts.com',partner_page:page,partner_title:'x',their_url:'https://langblog.example/spaced-repetition-apps/',their_title:'a',score:20,via:'email',...extra});

test('XCH-3 relevance: two shared polysemous title words are not a related page; C\'s own subject must be in B\'s article',()=>{
  const crawl=[
    {site:'frenchyfab.com',pages:[rec('frenchyfab.com','/french-bulldog-training/',{title:'French Bulldog Training Schedule: Week by Week',h2:['Crate training','Potty training','Leash training','Reward schedule'],
      text:'french bulldog puppy training schedule crate potty leash treats reward commands weeks sessions'})]},
    {site:'gearuptogrow.com',pages:[rec('gearuptogrow.com','/learning/spaced-repetition/',{title:'Spaced Repetition: How to Remember What You Study',h2:['Why spaced repetition works','The forgetting curve','Building a review schedule'],
      text:'spaced repetition memory retention forgetting curve review schedule flashcards anki study students exams recall long term memory'})]},
  ];
  const idx=buildPartnerIndex(crawl,SITES);
  const ml={site:'efficientgptprompts.com',domain:'mlblog.example',page_url:'https://mlblog.example/neural-network-training-schedule/',
    title:'Neural Network Training Schedule: Learning Rate Warmup and Decay',fit_section:'Training schedules compared',
    fit_excerpt:'A training schedule changes the learning rate over each epoch: warmup for the first steps, then cosine decay.',
    excerpt:'Every training run needs a schedule. Warmup raises the learning rate slowly, decay lowers it so the model converges.'};
  assert.equal(pickPartner(ml,'efficientgptprompts.com',{index:idx,state:{},cfg:CFG,now:NOW}),null,'"training" + "schedule" alone do not make a French bulldog page related');
  const ai={site:'openclaw-skillshub.com',domain:'aiblog.example',page_url:'https://aiblog.example/agent-long-term-memory/',title:'How AI Agents Use Long-Term Memory',fit_section:'Memory retention across sessions',
    excerpt:'Large language models forget everything outside the context window. Agent frameworks add long-term memory with a vector store: past conversations are embedded, and the agent can recall relevant facts later.'};
  assert.equal(pickPartner(ai,'openclaw-skillshub.com',{index:idx,state:{},cfg:CFG,now:NOW}),null,'C\'s title words (spaced, repetition, study) are not in B');
  // A same-topic pair still matches.
  const o=pickPartner(B(),'gearuptogrow.com',{index:buildPartnerIndex(lang(),SITES),state:{},cfg:CFG,now:NOW});
  assert.equal(o?.partner_site,'efficientgptprompts.com');
});

test('XCH-2 footprint: C is never a site the publisher already links to, and never the site of its earlier exchange',()=>{
  const idx=buildPartnerIndex(lang(),SITES);
  const linked={prospects:{old:{id:'old',site:'efficientgptprompts.com',domain:'langblog.example',page_url:'https://langblog.example/chatgpt-for-language-learning/',
    status:'already_linked',existing_link:{url:'https://efficientgptprompts.com/anki-flashcards-with-chatgpt/',anchor:'Anki prompts',rel:'follow'}}}};
  assert.equal(pickPartner(B(),'gearuptogrow.com',{index:idx,state:linked,cfg:CFG,now:NOW}),null,'B -> efficientgptprompts.com exists: no C<->B loop');
  assert.ok(publisherFootprint(linked,'www.langblog.example').sites.has('efficientgptprompts.com'));
  // Exchange 1 is done (B -> gearuptogrow.com, efficientgptprompts.com -> B). B's other page, pitched for plantastichaven.com later:
  // neither gearuptogrow.com (an A<->B swap) nor efficientgptprompts.com (a second promise from the same C) is offered.
  const done={prospects:{p1:{id:'p1',site:'gearuptogrow.com',domain:'langblog.example',page_url:'https://langblog.example/spaced-repetition-apps/',status:'won',
    won:{target:'https://gearuptogrow.com/learning/spaced-repetition/'},exchange:xOf(PAGE,{status:'fulfilled',offered_at:ago(120),their_link_at:ago(100),fulfilled_at:ago(95)})}}};
  const p2=B({id:'p2',site:'plantastichaven.com',page_url:'https://langblog.example/anki-tips/'});
  const foot=publisherFootprint(done,'langblog.example',{except:p2});
  assert.deepEqual([...foot.sites].sort(),['efficientgptprompts.com','gearuptogrow.com']);assert.equal(foot.running,false);
  const o=pickPartner(p2,'plantastichaven.com',{index:idx,state:done,cfg:CFG,now:NOW});
  assert.ok(!['gearuptogrow.com','efficientgptprompts.com'].includes(o?.partner_site),JSON.stringify(o));
});

function proof(q){const t=Date.now();return {ok:true,email:q.email,evidence:{source:`https://${q.domain}/contact/`,email:q.email,rank:95,observed_at:iso(t)},
  verification:hunterVerdict({data:{email:q.email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},q.email,t)}}

test('XCH-2 one exchange per publisher domain: while one runs, pickPartner and the outreach stage make no second offer',async()=>{
  const idx=buildPartnerIndex(lang(),SITES);
  const state={prospects:{p1:{id:'p1',site:'plantastichaven.com',domain:'langblog.example',page_url:'https://langblog.example/x/',status:'replied',exchange:xOf(PAGE,{status:'accepted',offered_at:ago(20),accepted_at:ago(10)})}}};
  assert.equal(pickPartner(B(),'gearuptogrow.com',{index:idx,state,cfg:CFG,now:NOW}),null);
  assert.equal(publisherFootprint(state,'langblog.example').running,true);
  // The outreach stage refuses an offer for that publisher even when a partner function returns one.
  const asset={url:'https://gearuptogrow.com/learning/spaced-repetition/',title:'Spaced repetition guide',type:'guide'};
  const p2={...B(),id:'p2',email:'ed@langblog.example',email_source:'https://langblog.example/contact/',qv:2,status:'ready',asset_url:asset.url,history:[]};
  const s={prospects:{...state.prospects,p2},reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}},sent=[];
  const r=await runOutreach({state:s,assets:[asset],sites:SITES,writer:new PitchWriter({senderName:'Alex'}),log:()=>{},
    mailer:{authorizeRecipient:async q=>proof(q),send:async m=>sent.push(m),draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@gmail.com',senderName:'Alex',gapMs:()=>0,sendWindow:false,exchange:{mode:'abc'},
      exchangePartner:()=>({partner_site:'micegoneguide.com',partner_page:'https://micegoneguide.com/x/',partner_title:'Some page',their_url:p2.page_url,their_title:'t',score:9})}});
  assert.equal(r.sent,1);assert.equal(r.exchange_publisher_busy,1);assert.equal(p2.exchange,undefined);assert.notEqual(p2.history[0].variant,'template:link_exchange');
});

test('XCH-4 double counting: two obligations to one publisher on one page need a link to each article',async()=>{
  const p1x=xOf(PAGE,{status:'their_link_live',offered_at:ago(95),their_link_at:ago(2),owed_by:new Date(NOW+5*DAY).toISOString()});
  const p2x=xOf(PAGE,{their_url:'https://langblog.example/vocab-flashcards/',status:'their_link_live',offered_at:ago(5),their_link_at:ago(1),owed_by:new Date(NOW+6*DAY).toISOString()});
  const state={prospects:{p1:{id:'p1',site:'gearuptogrow.com',domain:'langblog.example',status:'won',exchange:p1x},p2:{id:'p2',site:'plantastichaven.com',domain:'langblog.example',status:'won',exchange:p2x}}};
  // The crawl shows a link to langblog.example on the page: not enough for two obligations, so the page is fetched.
  const crawl=lang();crawl[1].pages[0].external_links=[{url:'https://langblog.example/spaced-repetition-apps/',anchor:'this comparison'}];
  const fetchImpl=async()=>html(`<p>${'Spaced repetition and Anki. '.repeat(60)}</p><p>See <a href="https://langblog.example/spaced-repetition-apps/">this comparison</a>.</p>`);
  const s=await trackExchanges({state,index:buildPartnerIndex(crawl,SITES),cfg:CFG,fetchImpl,now:NOW});
  assert.equal(s.fulfilled,1);assert.equal(p1x.status,'fulfilled');assert.equal(p1x.verified_by,'fetch');assert.equal(p2x.status,'their_link_live','the second article still needs its own link');
});

test('XCH-5 page cap: an unsent answer draft holds its page while it can still be sent; sent late onto a full page it is flagged',()=>{
  const idx=buildPartnerIndex(lang(),SITES);
  const draft={partner_site:'efficientgptprompts.com',partner_page:PAGE,partner_title:'Make Anki flashcards',their_url:'https://d.example/a',their_title:'a',score:20,message_id:'<lf-1@x>',at:ago(35)};
  const state={prospects:{d:{id:'d',site:'gearuptogrow.com',domain:'d.example',status:'replied',exchange_draft:draft}}};
  const got=[];
  for(const id of ['n1','n2']){const p=B({id,domain:`${id}.example`,page_url:`https://${id}.example/spaced-repetition-apps/`});
    const o=pickPartner(p,'gearuptogrow.com',{index:idx,state,cfg:CFG,now:NOW});got.push(o?.partner_page);
    if(o)state.prospects[id]={...p,exchange:{...o,status:'offered',offered_at:ago(0),via:'email'}}}
  assert.equal(got.filter(u=>u===PAGE).length,1,`the 35-day-old draft still holds one of the two slots: ${got}`);
  promoteExchangeDraft(state.prospects.d,ago(0),{state});
  assert.ok(exchangeTally(state,NOW).page.get(PAGE)<=CFG.perPartnerPage,`page carries ${exchangeTally(state,NOW).page.get(PAGE)}`);
  assert.equal(state.prospects.d.exchange.over_cap,undefined);
  // A draft too old to hold its page (sent after 120 days) onto a page that filled up meanwhile: recorded as made, flagged.
  const full={prospects:{a:{id:'a',domain:'a.example',exchange:xOf(PAGE,{status:'offered',offered_at:ago(1)})},b:{id:'b',domain:'b.example',exchange:xOf(PAGE,{status:'accepted',offered_at:ago(2)})},
    d:{id:'d',domain:'d.example',exchange_draft:{...draft,at:ago(130)}}}};
  assert.equal(exchangeTally(full,NOW).page.get(PAGE),2);
  promoteExchangeDraft(full.prospects.d,ago(0),{state:full});assert.equal(full.prospects.d.exchange.status,'offered');assert.equal(full.prospects.d.exchange.over_cap,true);
});

test('XCH-5 page cap: answerReplies re-picks an old draft offer instead of reusing a page it no longer holds',async()=>{
  const ASSET={url:'https://gearuptogrow.com/learning/spaced-repetition/',title:'Spaced repetition guide',description:'How spaced repetition works.'};
  const mk=at=>({id:'o',site:'gearuptogrow.com',domain:'old.example',page_url:'https://old.example/a/',email:'ed@old.example',status:'replied',awaiting_us:true,asset_url:ASSET.url,asset_title:ASSET.title,
    history:[{type:'initial',at:ago(200),to:'ed@old.example',message_id:'<lf-o@x>',sender_name:'Alex',subject:'S'},{type:'reply',at:iso(),from:'ed@old.example',sentiment:'neutral',message_id:'<r@old.example>',excerpt:'Happy to add it if you link back to us.',condition:'reciprocal'}],
    exchange_draft:{partner_site:'efficientgptprompts.com',partner_page:PAGE,partner_title:'Old pick',their_url:'https://old.example/a/',their_title:'a',message_id:'<lf-d@x>',at}});
  const fresh={partner_site:'efficientgptprompts.com',partner_page:'https://efficientgptprompts.com/vocabulary-decks-with-chatgpt',partner_title:'New pick',their_url:'https://old.example/a/',their_title:'a',score:12};
  for(const [age,want] of [[10,'Old pick'],[130,'New pick']]){
    const p=mk(ago(age)),state={prospects:{o:p},suppression:{},contacted:{},reply_health:{status:'ok',checked_at:iso()},sent_reconciled_at:iso()},drafts=[];let asked=0;
    await answerReplies({state,mailer:{draft:async r=>drafts.push(r)},assets:[ASSET],sites:SITES,config:{replyMode:'draft',mode:'send',fromAddress:'me@owned.example',senderName:'Alex'},
      exchangePartner:()=>{asked++;return fresh}});
    const body=Buffer.from(drafts[0].slice(drafts[0].indexOf('\r\n\r\n')+4).replace(/\r\n/g,''),'base64').toString('utf8');
    assert.match(body,new RegExp(want),`${age} days: ${body}`);assert.equal(asked,age>100?1:0);
  }
});

test('XCH-5 page cap: a lapsed offer revived onto a full page is flagged; placed on another page of C it is found there and moves',async()=>{
  const prospects={old:{id:'old',site:'gearuptogrow.com',domain:'old.example',status:'won',won:{target:'https://gearuptogrow.com/learning/spaced-repetition/'},
    exchange:xOf(PAGE,{their_url:'https://old.example/a',status:'lapsed',lapse_reason:'no_reply',offered_at:ago(70),lapsed_at:ago(10)})}};
  for(const id of ['n1','n2'])prospects[id]={id,domain:`${id}.example`,exchange:xOf(PAGE,{their_url:`https://${id}.example/a`,status:'offered',offered_at:ago(1)})};
  const state={prospects};
  assert.equal(noteTheirLink(prospects.old,{now:NOW,state,pageCap:2}),true);
  const x=prospects.old.exchange;assert.equal(x.status,'their_link_live');assert.equal(x.over_cap,true,'kept (it was promised) and flagged for the owner');
  // The owner puts it on the other related page of C; the crawl sees it there.
  const crawl=lang();crawl[1].pages[1].external_hosts=['old.example'];
  const s=await trackExchanges({state,index:buildPartnerIndex(crawl,SITES),cfg:CFG,fetchImpl:async()=>{throw Error('no fetch needed')},now:NOW});
  assert.equal(s.fulfilled,1);assert.equal(x.status,'fulfilled');assert.equal(x.partner_page,'https://efficientgptprompts.com/vocabulary-decks-with-chatgpt');
  assert.equal(x.offered_page,PAGE);assert.equal(exchangeTally(state,NOW).page.get(PAGE),2,'the first page is back at its cap, not over it');
});

test('XCH-1 fulfilment: a return link to a wordpress.com publisher or a share- path is found, from a fetch and from the crawl',async()=>{
  for(const [domain,their] of [['langnotes.wordpress.com','https://langnotes.wordpress.com/2026/05/srs-apps/'],['plantswap.example','https://plantswap.example/share-your-cuttings/'],
    ['x.langnotes.com','https://x.langnotes.com/srs/']]){
    const mk=()=>({prospects:{p:{id:'p',site:'gearuptogrow.com',domain,status:'won',exchange:xOf(PAGE,{their_url:their,status:'their_link_live',offered_at:ago(30),their_link_at:ago(10),owed_by:ago(3)})}}});
    const body=`<p>${'Spaced repetition and Anki decks. '.repeat(60)}</p><p>A good roundup: <a href="${their}">compared</a>.</p>`;
    let state=mk(),s=await trackExchanges({state,index:buildPartnerIndex([],SITES),cfg:CFG,fetchImpl:async()=>html(body),now:NOW});
    assert.equal(s.fulfilled,1,`${domain}: fetch`);
    // The crawl record keeps every host the content links to (external_links leaves these out), so no fetch is needed.
    const f=extractFeatures(PAGE,`<html><head><title>Make Anki flashcards</title></head><body><main>${body}</main></body></html>`,'efficientgptprompts.com');
    assert.ok(f.external_hosts.includes(domain),`${domain}: ${f.external_hosts}`);
    state=mk();s=await trackExchanges({state,index:buildPartnerIndex([{site:'efficientgptprompts.com',pages:[{...rec('efficientgptprompts.com','/anki-flashcards-with-chatgpt'),...f,status:200}]}],SITES),cfg:CFG,
      fetchImpl:async()=>{throw Error('no fetch needed')},now:NOW});
    assert.equal(s.fulfilled,1,`${domain}: crawl`);assert.equal(state.prospects.p.exchange.verified_by,'crawl');
  }
  // "C already links to B" sees those hosts too: a page already linking to the publisher is not offered.
  const crawl=lang();for(const pg of crawl[1].pages)pg.external_hosts=['langnotes.wordpress.com'];
  assert.notEqual(pickPartner(B({domain:'langnotes.wordpress.com',page_url:'https://langnotes.wordpress.com/2026/05/srs-apps/'}),'gearuptogrow.com',{index:buildPartnerIndex(crawl,SITES),state:{},cfg:CFG,now:NOW})?.partner_site,'efficientgptprompts.com');
});

test('XCH-6 obligations: a publisher page that answers 404/410 twice, 7+ days apart, is gone: nothing is owed and offers do not stay paused',async()=>{
  const prospects={};
  for(const i of [1,2,3])prospects[`g${i}`]={id:`g${i}`,site:'gearuptogrow.com',domain:`gone${i}.example`,page_url:`https://gone${i}.example/srs/`,status:'won',
    won:{target:'https://gearuptogrow.com/learning/spaced-repetition/',checked_at:iso(Date.now()-20*DAY)},history:[{type:'initial',at:iso(Date.now()-60*DAY)}],
    exchange:{partner_site:'efficientgptprompts.com',partner_page:`https://efficientgptprompts.com/p${i}`,their_url:`https://gone${i}.example/srs/`,status:'their_link_live',
      offered_at:iso(Date.now()-60*DAY),their_link_at:iso(Date.now()-30*DAY),owed_by:iso(Date.now()-23*DAY),via:'email'}};
  const state={prospects,contacted:{}},gone=async()=>new Response('Gone',{status:410,headers:{'content-type':'text/html'}});
  assert.equal(exchangeSummary(state,{cfg:CFG}).paused,true);
  let r=await checkLinks({state,ourDomains:SITES.map(s=>s.domain),fetchImpl:gone});
  assert.equal(r.unverifiable,3);assert.deepEqual(Object.values(prospects).map(p=>p.exchange.status),['their_link_live','their_link_live','their_link_live'],'one answer may be a hiccup');
  // A week later the pages still answer 410: their links are certainly gone.
  for(const p of Object.values(prospects))p.page_gone_since=iso(Date.now()-8*DAY);
  r=await checkLinks({state,ourDomains:SITES.map(s=>s.domain),fetchImpl:gone});
  assert.deepEqual(Object.values(prospects).map(p=>[p.status,p.exchange.status]),[['lost','accepted'],['lost','accepted'],['lost','accepted']]);
  assert.equal(r.lost,3);assert.equal(exchangeSummary(state,{cfg:CFG}).paused,false);
  // A page that comes back clears the clock.
  const p={id:'b',site:'gearuptogrow.com',domain:'back.example',page_url:'https://back.example/x/',status:'sent',page_gone_since:iso(Date.now()-3*DAY),history:[{type:'initial',at:iso(Date.now()-9*DAY)}]};
  await checkLinks({state:{prospects:{b:p}},ourDomains:['gearuptogrow.com'],fetchImpl:async()=>html('<p>No link yet.</p>')});assert.equal(p.page_gone_since,undefined);
});
