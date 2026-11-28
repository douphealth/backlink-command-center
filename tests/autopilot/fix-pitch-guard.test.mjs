// Review fixes for the pitch guard (pitchProblem, the last check before an AI-written pitch or follow-up goes out by itself):
// claims, extra return offers, independence and money are read in the whole body; without an offer no return favour at all;
// and the old P.S. never survives (F1, F6 of the coverage review).
import test from 'node:test';
import assert from 'node:assert/strict';
import {pitchProblem,namedSitesProblem,exchangeLine,OPT_OUT,withOptOut,PitchWriter,aiProviders,templatePitch} from '../../scripts/autopilot/pitch.mjs';
import {runOutreach} from '../../scripts/autopilot/outreach.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';

const site={domain:'gearuptofit.com',topic:'running shoes'};
const asset={url:'https://gearuptofit.com/shoe-finder/',title:'Running Shoe Finder',type:'interactive_tool',description:'Answer six questions and get matched to running shoes by gait and terrain.'};
const ex={partner_site:'plantastichaven.com',partner_page:'https://plantastichaven.com/plant-tools/',partner_title:'Best Houseplant Tools',
  their_url:'https://pub.example/resources/',their_title:'Resources for New Runners',score:9};
const p={id:'a',domain:'pub.example',page_url:'https://pub.example/resources/',title:'Resources for New Runners'};
const head=`Hi Jane,\n\nI'm writing from gearuptofit.com, a site about running shoes. Would you consider adding Running Shoe Finder to your "Choosing shoes" section in "Resources for New Runners"?`;
const tail=`\n\nhttps://gearuptofit.com/shoe-finder/\n\nAnswer six questions and get matched to running shoes by gait and terrain.\n\nThe edit would be one link, with "Running Shoe Finder" as the link text.\n\n${OPT_OUT}\n\nBest,\nAlex\ngearuptofit.com`;
const SUBJECT='Suggestion for "Resources for New Runners"';
const withOffer=extra=>({subject:SUBJECT,body:withOptOut(`${head} ${exchangeLine(p,ex)} ${extra}${tail}`)});
const noOffer=extra=>({subject:SUBJECT,body:withOptOut(`${head} ${extra}${tail}`)});
const chk=out=>pitchProblem(out,asset,{exchange:ex,site});

test('F1a: a claim that a link is already in place is refused anywhere in the body, not only next to C',()=>{
  assert.equal(chk(withOffer('')),null,'the plain offer passes');
  for(const s of ["I've already added a link to your article there.",'It already links to your article.','Our link to your article is already live.'])
    assert.equal(chk(withOffer(s)),'exchange_claims_placed',s);
  // Our own page really citing their article (p.cited_by_us, from our crawl) is the one allowed "already links" sentence.
  assert.equal(pitchProblem(withOffer('Our page gearuptofit.com/guide already links to your article.'),asset,{exchange:ex,site,cited:true}),null);
  assert.notEqual(pitchProblem(withOffer("I've already linked to your article from gearuptofit.com/guide."),asset,{exchange:ex,site,cited:true}),null,'a claim of our own is still refused');
});

test('F1b: every return favour is the one offer from C; one from the page above, our tool or a site we do not run is refused',()=>{
  for(const s of ["I'd also link to your article from the page above.",'We could also link to your article from our shoe finder tool.',
    'I could also add a link to your article from runnersworld-blog.net.',"I'd be happy to feature your article in our newsletter too.",'Happy to link back to you from our blog as well.'])
    assert.ok(['exchange_extra_offer','exchange_from_target_site'].includes(chk(withOffer(s))),`${s}: ${chk(withOffer(s))}`);
  assert.equal(chk({subject:SUBJECT,body:withOptOut(`${head} In return, once your link is up, I'd link to your page from "Best Houseplant Tools" on plantastichaven.com, a separate site I run, and from runnersworld-blog.net.${tail}`)}),'exchange_extra_offer','a second site in the offer sentence');
});

test('F1c: C is disclosed in the sentence that names it, and never called independent or a partner\'s site',()=>{
  const indie={subject:SUBJECT,body:withOptOut(`${head} In return, once your link is up, I'd link to your article "Resources for New Runners" from "Best Houseplant Tools" on plantastichaven.com, an independent partner site. We also run a small newsletter.${tail}`)};
  assert.equal(chk(indie),'exchange_not_disclosed','"we also run" elsewhere is not a disclosure of C');
  const both={subject:SUBJECT,body:withOptOut(`${head} In return, once your link is up, I'd link to your page from "Best Houseplant Tools" on plantastichaven.com, a separate site I run. It is an independent site with its own editors.${tail}`)};
  assert.equal(chk(both),'exchange_implies_independent');
  assert.equal(chk(withOffer('A friend\'s site could link too.')),'exchange_implies_independent');
});

test('F1d: money in any wording is refused; a money word our own page uses is not an offer',()=>{
  for(const s of ["I'm happy to pay a small fee for your time.",'I can offer a small payment too.','We are willing to compensate you.','There is $20 in it for you.'])
    assert.equal(chk(withOffer(s)),'payment_not_allowed',s);
  for(const s of ['We can also cover any fee.','Is there a fee?'])assert.equal(pitchProblem(noOffer(s),asset,{site}),'payment_not_allowed',`no offer: ${s}`);
  // Our page compares transfer fees: its description says so, and the pitch may too (it offers nothing).
  const fees={...asset,description:'Compare the transfer fees of six providers before you book.'};
  assert.equal(pitchProblem({subject:SUBJECT,body:withOptOut(`${head}\n\nhttps://gearuptofit.com/shoe-finder/\n\nIt compares the transfer fees of six providers before you book.\n\n${OPT_OUT}\n\nBest,\nAlex\ngearuptofit.com`)},fees,{site}),null);
  assert.equal(pitchProblem({subject:SUBJECT,body:withOptOut(`${head} I'd pay the fee myself.\n\nhttps://gearuptofit.com/shoe-finder/\n\nIt compares the transfer fees of six providers before you book.\n\n${OPT_OUT}\n\nBest,\nAlex\ngearuptofit.com`)},fees,{site}),'payment_not_allowed','an offer of money is never allowed');
});

test('F1e: without an exchange (LINK_EXCHANGE=off, or no partner page) no return favour and no other site of ours is mentioned',()=>{
  for(const s of ["I'd be glad to feature your article on plantastichaven.com, a separate site I run.",'Happy to link back to you from my other site too.',
    'I can also add your article to our resources page.',"I'll gladly link to your guide from plantastichaven.com.","In return, I'd link to your page from plantastichaven.com, a separate site I run."])
    assert.equal(pitchProblem(noOffer(s),asset,{site}),'offer_not_allowed',s);
  assert.equal(pitchProblem(noOffer(''),asset,{site}),null,'the plain ask passes');
  // A title that says "Share your ..." is a quoted title, not an offer.
  assert.equal(pitchProblem({subject:SUBJECT,body:withOptOut(`Hi Jane,\n\nI'm writing from gearuptofit.com, a site about running shoes. Would you consider adding Running Shoe Finder to "Share Your Running Routes"?${tail}`)},asset,{site,titles:['Share Your Running Routes']}),null);
});

const completion=content=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'content-type':'application/json'}});
const writerWith=answer=>new PitchWriter({senderName:'Alex',providers:aiProviders({GROQ_API_KEY:'k'}),
  fetchImpl:async u=>String(u).endsWith('/models')?new Response(JSON.stringify({data:[{id:'fixture-chat-70b'}]}),{headers:{'content-type':'application/json'}}):completion(answer)});
const iso=()=>new Date().toISOString();
function proof(q){const t=Date.now();return {ok:true,email:q.email,evidence:{source:`https://${q.domain}/contact/`,email:q.email,rank:95,observed_at:new Date(t).toISOString()},
  verification:hunterVerdict({data:{email:q.email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},q.email,t)}}
const decode=raw=>Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString('utf8');

test('F1 end to end: an AI pitch with an unsafe extra sentence is replaced by the template before it is sent',async()=>{
  for(const extra of ["I've already added a link to your article there.","I'd also link to your article from the page above.","I'm happy to pay a small fee for your time."]){
    const body=`${head.replace('Hi Jane,\n\n','')} ${exchangeLine(p,ex)} ${extra}\n\n${asset.url}\n\nThe edit would be one link, with "Running Shoe Finder" as the link text.\n\nBest,\nAlex\ngearuptofit.com`;
    const pr={...p,site:'gearuptofit.com',asset_url:asset.url,email:'editor@pub.example',email_source:'https://pub.example/contact/',qv:2,status:'ready',history:[]};
    const sent=[],state={prospects:{a:pr},reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}};
    const r=await runOutreach({state,assets:[asset],sites:[site,{domain:'plantastichaven.com'}],writer:writerWith(`Subject: A shoe finder for your page\n\n${body}`),
      mailer:{authorizeRecipient:async q=>proof(q),send:async m=>sent.push(m),draft:async()=>{}},
      config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@gmail.com',senderName:'Alex',gapMs:()=>0,sendWindow:false,exchange:{mode:'abc'},exchangePartner:()=>ex}});
    assert.equal(r.sent,1);const text=decode(sent[0].raw);
    assert.equal(pr.history[0].writer,'template',extra);assert.equal(pr.history[0].variant,'template:link_exchange');
    assert.ok(!text.includes(extra),extra);assert.match(text,/a separate site I run/);assert.equal(pr.exchange.status,'offered');
  }
});

test('coverage F6: the old P.S. never goes out: withOptOut drops it, and pitchProblem refuses one that is left',()=>{
  const body=`Hi Sam,\n\nI run gearuptofit.com, a running site. Would you consider adding Running Shoe Finder to your "Choosing shoes" section? It asks six questions and matches runners to shoes by gait and terrain: ${asset.url}\n\nIf it fits, it could sit in that section with "Running Shoe Finder" as the link text.\n\nBest,\nAlex\ngearuptofit.com\n\nP.S. Not relevant for you? Just reply "no" and I won't email again.`;
  const b=withOptOut(body);
  assert.doesNotMatch(b,/P\.S\.|reply "no"|Not relevant for you/);assert.match(b,/\n\nIf it's not a fit, just say so and I won't follow up\.\n\nBest,\nAlex\ngearuptofit\.com$/);
  assert.equal(pitchProblem({subject:'A shoe finder for your section',body:b},asset),null);
  assert.equal(pitchProblem({subject:'A shoe finder for your section',body:`${b}\n\nPS: one more thing about the page above.`},asset),'ps_not_allowed');
  // A P.S. in the middle (before the sign-off) goes too.
  assert.doesNotMatch(withOptOut(`Hi,\n\nBody text here.\n\nP.S. Reply "no" to stop.\n\nBest,\nAlex`),/P\.S\./);
  // Templates never had one.
  assert.doesNotMatch(templatePitch(p,asset,{senderName:'Alex',site}).body,/P\.S\./);
});

test('F1: a model-written email names no site nobody checked; ours, theirs, C and the sites in its facts are fine',()=>{
  const chk=(extra,o={})=>namedSitesProblem(withOffer(extra),asset,{exchange:ex,site,publisher:'pub.example',...o});
  assert.equal(chk(''),null,'A, the asset host and C');
  assert.equal(chk('Your readers on pub.example may like it.'),null,'the publisher\'s own site');
  for(const s of ['Your article could also appear on runnersworld-blog.net.','It is used by readers of bigrunning.co.uk.','We also run trailtips.io.'])assert.equal(chk(s),'unknown_site',s);
  assert.equal(chk('The dead link pointed to oldshoes.example.',{hosts:['oldshoes.example']}),null,'a host given in the facts (a dead link, a competitor link)');
  assert.equal(chk('Built with Node.js, it runs in any browser.'),null,'not a site');
  assert.equal(namedSitesProblem(noOffer('A link from plantastichaven.com is possible.'),asset,{site,publisher:'pub.example'}),'unknown_site','C without an offer is not a site this email may name');
  // Addresses and our URL are not names of other sites.
  assert.equal(chk('Reply to alex@gmail.com any time.'),null);
});

test('F1: without an offer a pitch still never claims a link is in place; "we\'ve published a guide" is no such claim',()=>{
  for(const s of ["I've already added a link to your article.","We've added your guide to our resources page.",'Our page already links to your article.'])
    assert.equal(pitchProblem(noOffer(s),asset,{site}),'claims_placed',s);
  assert.equal(pitchProblem(noOffer('Our page already links to your article.'),asset,{site,cited:true}),null,'our citation of their article, on record');
  for(const s of ["We've published a free step-by-step guide for it.","I've put together six questions that match runners to shoes."])assert.equal(pitchProblem(noOffer(s),asset,{site}),null,s);
  // With an offer the sentence that makes it is still read strictly.
  assert.equal(chk(withOffer('')),null);
});

test('F1 end to end: an AI pitch naming a site nobody checked is replaced by the template',async()=>{
  const body=`${head.replace('Hi Jane,\n\n','')} ${exchangeLine(p,ex)} Your article could also appear on runnersworld-blog.net.\n\n${asset.url}\n\nThe edit would be one link, with "Running Shoe Finder" as the link text.\n\nBest,\nAlex\ngearuptofit.com`;
  const pr={...p,site:'gearuptofit.com',asset_url:asset.url,email:'editor@pub.example',email_source:'https://pub.example/contact/',qv:2,status:'ready',history:[]};
  const sent=[],state={prospects:{a:pr},reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}};
  const writer=writerWith(`Subject: A shoe finder for your page\n\n${body}`);
  const r=await runOutreach({state,assets:[asset],sites:[site,{domain:'plantastichaven.com'}],writer,
    mailer:{authorizeRecipient:async q=>proof(q),send:async m=>sent.push(m),draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@gmail.com',senderName:'Alex',gapMs:()=>0,sendWindow:false,exchange:{mode:'abc'},exchangePartner:()=>ex}});
  assert.equal(r.sent,1);assert.equal(pr.history[0].writer,'template');assert.doesNotMatch(decode(sent[0].raw),/runnersworld/);assert.equal(writer.reasons.unknown_site,1);
});
