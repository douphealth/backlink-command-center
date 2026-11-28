// 3-way link exchange: which of our OTHER sites (C) offers the return link to publisher B, pitched for our site A.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPartnerIndex,pickPartner,relevance,failingSites,exchangeTally,EXCHANGE_PAUSE_AT} from '../../scripts/autopilot/exchange.mjs';
import {topTerms,sameSite} from '../../scripts/autopilot/util.mjs';

const DAY=864e5,NOW=Date.parse('2026-11-28T12:00:00Z'),ago=d=>new Date(NOW-d*DAY).toISOString();
const CFG={mode:'abc',perPartnerSiteMonth:6,perPartnerPage:2,fulfilDays:7};
/** A crawl record as crawl.mjs writes it (status, canonical, words, headings, top terms, cited links). */
const rec=(site,path,{title,h1=title,words=900,h2=[],text='',links=[],...extra}={})=>({site,url:`https://${site}${path}`,final_url:`https://${site}${path}`,status:200,
  technical_status:'technically_eligible',canonical:`https://${site}${path}`,noindex:false,title,h1,words,h2,terms:topTerms(`${title} ${h1} ${h1} ${h2.join(' ')} ${text}`,60),
  external_links:links.map(u=>({url:u,anchor:'see this'})),...extra});
const flashcards=(site='lang.example',path='/flashcards-for-vocabulary/',extra={})=>rec(site,path,{title:'How to make flashcards for vocabulary',h2:['Choosing words','Spaced review','Apps vs paper'],
  text:'flashcards vocabulary language learners spaced repetition review apps anki memory words',...extra});
const crawl=()=>[
  {site:'study.example',pages:[rec('study.example','/spaced-repetition/',{title:'Spaced repetition: how to remember what you study',h2:['Why spaced repetition works','Flashcards and apps'],
    text:'spaced repetition review schedule flashcards memory retention forgetting curve language vocabulary apps anki'})]},
  {site:'lang.example',pages:[flashcards(),rec('lang.example','/grammar-drills/',{title:'Grammar drills that work',h2:['Verb tables'],text:'grammar verbs conjugation drills language practice'})]},
  {site:'plants.example',pages:[rec('plants.example','/watering-schedule/',{title:'A watering schedule for houseplants',h2:['How often to water','Signs of overwatering'],
    text:'watering houseplants soil drainage pots schedule overwatering roots'})]},
  {site:'stains.example',pages:[rec('stains.example','/grass-stains-shoes/',{title:'How to remove grass stains from shoes',h2:['Canvas shoes','Leather shoes'],
    text:'grass stains shoes canvas leather detergent scrub running trainers'})]},
];
const SITES=[{domain:'study.example'},{domain:'lang.example'},{domain:'plants.example'},{domain:'stains.example'}];
/** Publisher B: an article about spaced-repetition apps, pitched for our study site (A). */
const B=(extra={})=>({id:'b1',site:'study.example',domain:'langblog.example',page_url:'https://langblog.example/spaced-repetition-apps/',
  title:'The best spaced repetition apps for language learners',fit_section:'Flashcard apps compared',
  fit_excerpt:'Anki and other flashcard apps schedule reviews with spaced repetition so vocabulary sticks.',
  excerpt:'Learning a language means memorising thousands of words. Spaced repetition apps like Anki show each flashcard just before you forget it.',...extra});
const ex=(page,status,extra={})=>({exchange:{partner_site:new URL(page).hostname,partner_page:page,partner_title:'x',their_url:'https://pub.example/a',their_title:'a',score:9,status,offered_at:ago(5),via:'email',...extra}});

test('the partner index keeps only indexable, substantial article pages of our own sites, from a crawl or the crawl cache',()=>{
  const pages=[flashcards(),
    rec('lang.example','/thin-note/',{title:'Flashcard note',words:300}),
    rec('lang.example','/privacy-policy-flashcards/',{title:'Flashcards privacy policy'}),
    rec('lang.example','/hidden/',{title:'Hidden flashcards',noindex:true}),
    rec('lang.example','/moved/',{title:'Moved flashcards',final_url:'https://lang.example/elsewhere/'}),
    rec('lang.example','/dupe/',{title:'Duplicate flashcards',canonical:'https://lang.example/flashcards-for-vocabulary/',technical_status:'blocked_canonical'}),
    rec('lang.example','/nocanon/',{title:'No canonical flashcards',canonical:null}),
    rec('lang.example','/gone/',{title:'Gone flashcards',status:404}),
    rec('lang.example','/untitled/',{title:'',h1:''}),
    rec('stranger.example','/flashcards/',{title:'Someone else\'s flashcards'})];
  const idx=buildPartnerIndex([{site:'lang.example',pages}],SITES);
  assert.deepEqual(idx.sites.get('lang.example').map(c=>c.url),['https://lang.example/flashcards-for-vocabulary']);
  assert.equal(idx.sites.has('stranger.example'),false,'only our own sites can carry a return link');
  assert.ok(idx.pages.has('https://lang.example/nocanon'),'every crawled page of ours is kept for the link checks');
  const fromCache=buildPartnerIndex(Object.fromEntries(pages.map(p=>[p.url,p])),SITES);
  assert.deepEqual(fromCache.sites.get('lang.example').map(c=>c.url),['https://lang.example/flashcards-for-vocabulary'],'the crawl cache (url -> record) works the same way');
  assert.equal(idx.sites.get('lang.example')[0].title,'How to make flashcards for vocabulary');
});

test('the partner is never the pitched site A nor on the publisher B\'s own domain, and always one of our sites',()=>{
  const idx=buildPartnerIndex(crawl(),SITES);
  const o=pickPartner(B(),{domain:'study.example'},{index:idx,state:{},cfg:CFG,now:NOW});
  assert.ok(o,'a related page on another of our sites is offered');
  assert.equal(o.partner_site,'lang.example');assert.equal(o.partner_page,'https://lang.example/flashcards-for-vocabulary');
  assert.equal(o.their_url,B().page_url,'the return link points to the article B wrote');assert.equal(o.their_title,B().title);assert.ok(o.score>=8);
  assert.ok(!sameSite(o.partner_site,'study.example'),'study.example has the most relevant page of all, but it is A');
  // Pitched for lang.example instead: A is now lang.example, so the partner must come from another site.
  const forLang=pickPartner(B({site:'lang.example'}),'lang.example',{index:idx,state:{},cfg:CFG,now:NOW});
  assert.equal(forLang.partner_site,'study.example');
  // One of our sites on B's domain (a subdomain of it, or B a subdomain of ours): no exchange at all, so C can never sit on B's domain.
  const sub=buildPartnerIndex([...crawl(),{site:'blog.langblog.example',pages:[flashcards('blog.langblog.example','/cards/')]}],[...SITES,{domain:'blog.langblog.example'}]);
  assert.equal(pickPartner(B(),'study.example',{index:sub,state:{},cfg:CFG,now:NOW}),null);
  const parent=buildPartnerIndex([...crawl(),{site:'langblog.example',pages:[flashcards('langblog.example','/cards/')]}],[...SITES,{domain:'langblog.example'}]);
  assert.equal(pickPartner(B({domain:'blog.langblog.example',page_url:'https://blog.langblog.example/a/'}),'study.example',{index:parent,state:{},cfg:CFG,now:NOW}),null);
  // Every pick over many publishers and targets: C is never A and never related to B.
  const idx3=buildPartnerIndex([...crawl(),{site:'words.example',pages:[flashcards('words.example','/cards/')]}],[...SITES,{domain:'words.example'}]);
  for(const a of ['study.example','lang.example','words.example','plants.example'])for(const b of ['langblog.example','cards.words.example','study.example','x.lang.example']){
    const x=pickPartner(B({site:a,domain:b,page_url:`https://${b}/spaced-repetition-apps/`}),a,{index:idx3,state:{},cfg:CFG,now:NOW});
    if(x)assert.ok(!sameSite(x.partner_site,a)&&!sameSite(a,x.partner_site)&&!sameSite(x.partner_site,b)&&!sameSite(b,x.partner_site),`${a} / ${b} -> ${x.partner_site}`);
  }
  // A publisher that is one of our own sites never gets an exchange.
  assert.equal(pickPartner(B({domain:'plants.example',page_url:'https://plants.example/x/'}),'study.example',{index:idx,state:{},cfg:CFG,now:NOW}),null);
});

test('a real topical match is required: one shared word, generic words or a loose theme are not enough',()=>{
  const idx=buildPartnerIndex(crawl(),SITES);
  // Running shoes vs. grass stains on shoes: they share "shoes" and "grass", but that is not a genuinely related page.
  const shoes={site:'study.example',domain:'runblog.example',page_url:'https://runblog.example/flat-feet-shoes/',title:'Best running shoes for flat feet',fit_section:'Stability shoes',
    fit_excerpt:'Stability running shoes support flat feet on long runs.',excerpt:'Flat feet need support. We tested stability shoes on road and grass trails.'};
  assert.equal(pickPartner(shoes,'study.example',{index:idx,state:{},cfg:CFG,now:NOW}),null);
  // Only generic words in common ("guide", "tips", "best", "free", "online").
  const generic={site:'study.example',domain:'tips.example',page_url:'https://tips.example/best-free-online-guide/',title:'The best free online guide with tips',excerpt:'Our guide lists the best free online tips and resources for everyone.'};
  assert.equal(pickPartner(generic,'study.example',{index:idx,state:{},cfg:CFG,now:NOW}),null);
  // One specific word only.
  const one={site:'study.example',domain:'garden.example',page_url:'https://garden.example/roots/',title:'Tree roots under patios',excerpt:'Roots lift paving slabs.'};
  assert.equal(pickPartner(one,'study.example',{index:idx,state:{},cfg:CFG,now:NOW}),null);
  // A clear match passes: watering houseplants.
  const water={site:'study.example',domain:'garden.example',page_url:'https://garden.example/water-houseplants/',title:'How often should you water houseplants?',fit_section:'Watering by season',
    excerpt:'Overwatering kills more houseplants than underwatering. Check the soil first.'};
  assert.equal(pickPartner(water,'study.example',{index:idx,state:{},cfg:CFG,now:NOW})?.partner_page,'https://plants.example/watering-schedule');
  // The scorer itself: two shared body words with no subject-level match score 0.
  const c={head:['grammar','drill'],body:['verb','table','soil','pot'],phrases:[]};
  assert.equal(relevance(c,{head:new Set(['houseplant']),ctx:new Set(['houseplant','soil','pot']),pairs:new Set()}),0);
  assert.ok(relevance(c,{head:new Set(['grammar','drill','verb']),ctx:new Set(['grammar','drill','verb']),pairs:new Set()})>=8);
});

test('pages that already link to B, failing sites, pages Google will not index and sites with exchanges off are skipped',()=>{
  const linked=crawl();linked[1].pages[0]=flashcards('lang.example','/flashcards-for-vocabulary/',{links:['https://www.langblog.example/older-post/']});
  const idx=buildPartnerIndex(linked,SITES);
  assert.equal(pickPartner(B(),'study.example',{index:idx,state:{},cfg:CFG,now:NOW}),null,'the only related page of another site already links to B');
  const base=buildPartnerIndex(crawl(),SITES);
  assert.equal(pickPartner(B(),'study.example',{index:base,state:{},cfg:CFG,now:NOW,failing:new Set(['lang.example'])}),null,'a failing site is never the partner');
  const report={sites:[{site:'lang.example',alert:'60 of 80 URLs answered HTTP 503.',server_error:60},{site:'plants.example',alert:null,server_error:0}]};
  assert.deepEqual([...failingSites(report)],['lang.example']);
  assert.equal(pickPartner(B(),'study.example',{index:buildPartnerIndex(crawl(),SITES,{failing:failingSites(report)}),state:{},cfg:CFG,now:NOW}),null,'the set can also travel with the index');
  const noindexed={index_status:{'https://lang.example/flashcards-for-vocabulary':{class:'noindex'}}};
  assert.equal(pickPartner(B(),'study.example',{index:base,state:noindexed,cfg:CFG,now:NOW}),null,'Google reports the page as noindex');
  assert.equal(pickPartner(B(),'study.example',{index:base,state:{},cfg:{...CFG,mode:'off'},now:NOW}),null);
  assert.equal(pickPartner(B(),'study.example',{index:base,state:{},cfg:{...CFG,perPartnerSiteMonth:0},now:NOW}),null);
  assert.equal(pickPartner(B({page_url:''}),'study.example',{index:base,state:{},cfg:CFG,now:NOW}),null);
});

test('caps: a partner page carries at most 2 open or fulfilled exchanges ever, a partner site at most N in 30 days',()=>{
  const idx=buildPartnerIndex(crawl(),SITES),page='https://lang.example/flashcards-for-vocabulary';
  const state=prospects=>({prospects});
  // Two exchanges on the page (one fulfilled long ago) fill it; lapsed and declined ones free their slot.
  const full=state({x1:ex(page,'fulfilled',{offered_at:ago(300),fulfilled_at:ago(280)}),x2:ex(page,'offered'),x3:ex(page,'lapsed'),x4:ex(page,'declined')});
  assert.equal(exchangeTally(full,NOW).page.get(page),2);
  assert.equal(pickPartner(B(),'study.example',{index:idx,state:full,cfg:CFG,now:NOW}),null);
  const freed=state({x1:ex(page,'fulfilled',{offered_at:ago(300),fulfilled_at:ago(280)}),x3:ex(page,'lapsed'),x4:ex(page,'declined')});
  assert.equal(pickPartner(B(),'study.example',{index:idx,state:freed,cfg:CFG,now:NOW})?.partner_page,page);
  // A second related page on the same site takes over when the first is full.
  const two=crawl();two[1].pages.push(flashcards('lang.example','/vocabulary-flashcard-decks/',{title:'Vocabulary flashcard decks for language learners'}));
  const idx2=buildPartnerIndex(two,SITES);
  assert.equal(pickPartner(B(),'study.example',{index:idx2,state:full,cfg:CFG,now:NOW})?.partner_page,'https://lang.example/vocabulary-flashcard-decks');
  // Site cap: 6 exchanges on lang.example pages active in the last 30 days block the whole site.
  const other=i=>ex(`https://lang.example/p${i}`,i%2?'accepted':'fulfilled',{offered_at:ago(20),fulfilled_at:ago(10)});
  const busy=state(Object.fromEntries(Array.from({length:6},(_,i)=>[`s${i}`,other(i)])));
  assert.equal(exchangeTally(busy,NOW).site.get('lang.example'),6);
  assert.equal(pickPartner(B(),'study.example',{index:idx2,state:busy,cfg:CFG,now:NOW}),null);
  assert.ok(pickPartner(B(),'study.example',{index:idx2,state:busy,cfg:{...CFG,perPartnerSiteMonth:7},now:NOW}),'a higher monthly cap lets it through');
  // Older than 30 days no longer counts against the site, except a return link still owed.
  const old=state(Object.fromEntries(Array.from({length:6},(_,i)=>[`s${i}`,ex(`https://lang.example/p${i}`,'fulfilled',{offered_at:ago(70),fulfilled_at:ago(40)})])));
  assert.ok(pickPartner(B(),'study.example',{index:idx2,state:old,cfg:CFG,now:NOW}));
  const owed=state(Object.fromEntries(Array.from({length:6},(_,i)=>[`s${i}`,ex(`https://lang.example/p${i}`,'their_link_live',{offered_at:ago(70),their_link_at:ago(40),owed_by:ago(-5)})])));
  assert.equal(pickPartner(B(),'study.example',{index:idx2,state:owed,cfg:CFG,now:NOW}),null,'an obligation still owed always counts');
});

test('new offers pause while 3 or more promised return links are overdue',()=>{
  const idx=buildPartnerIndex(crawl(),SITES);
  const overdue=n=>({prospects:Object.fromEntries(Array.from({length:n},(_,i)=>[`o${i}`,ex(`https://plants.example/p${i}`,'their_link_live',{their_link_at:ago(10),owed_by:ago(3)})]))});
  assert.equal(EXCHANGE_PAUSE_AT,3);
  assert.ok(pickPartner(B(),'study.example',{index:idx,state:overdue(2),cfg:CFG,now:NOW}),'2 overdue: offers continue');
  assert.equal(pickPartner(B(),'study.example',{index:idx,state:overdue(3),cfg:CFG,now:NOW}),null,'3 overdue: offers pause');
  // Owed but not yet overdue does not pause.
  const due={prospects:Object.fromEntries(Array.from({length:5},(_,i)=>[`d${i}`,ex(`https://plants.example/p${i}`,'their_link_live',{their_link_at:ago(2),owed_by:ago(-5)})]))};
  assert.ok(pickPartner(B(),'study.example',{index:idx,state:due,cfg:CFG,now:NOW}));
});

test('ties are broken deterministically: score, then the least used partner site and page, then the URL',()=>{
  const twins=[{site:'lang.example',pages:[flashcards('lang.example','/b-cards/')]},{site:'words.example',pages:[flashcards('words.example','/a-cards/')]}];
  const sites=[{domain:'study.example'},{domain:'lang.example'},{domain:'words.example'}];
  const idx=buildPartnerIndex(twins,sites);
  const first=pickPartner(B(),'study.example',{index:idx,state:{},cfg:CFG,now:NOW});
  assert.equal(first.partner_page,'https://lang.example/b-cards','equal score and load: alphabetical URL');
  for(let i=0;i<5;i++)assert.deepEqual(pickPartner(B(),'study.example',{index:buildPartnerIndex(twins.slice().reverse(),sites),state:{},cfg:CFG,now:NOW}),first,'input order does not matter');
  const used={prospects:{u:ex('https://lang.example/other/','accepted')}};
  assert.equal(pickPartner(B(),'study.example',{index:idx,state:used,cfg:CFG,now:NOW}).partner_site,'words.example','the site already carrying an exchange gives way');
});

test('a prospect that already holds an exchange keeps the same deal',()=>{
  const idx=buildPartnerIndex(crawl(),SITES);
  const held=B({exchange:{partner_site:'plants.example',partner_page:'https://plants.example/watering-schedule',partner_title:'A watering schedule',their_url:B().page_url,their_title:B().title,score:12,status:'accepted',offered_at:ago(3),accepted_at:ago(1),via:'email'}});
  assert.deepEqual(pickPartner(held,'study.example',{index:idx,state:{prospects:{b1:held}},cfg:CFG,now:NOW}),
    {partner_site:'plants.example',partner_page:'https://plants.example/watering-schedule',partner_title:'A watering schedule',their_url:B().page_url,their_title:B().title,score:12});
  const lapsed=B({exchange:{...held.exchange,status:'lapsed'}});
  assert.equal(pickPartner(lapsed,'study.example',{index:idx,state:{prospects:{b1:lapsed}},cfg:CFG,now:NOW}).partner_site,'lang.example','a lapsed offer is replaced by a fresh pick');
});
