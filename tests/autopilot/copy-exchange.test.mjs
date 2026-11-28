// 3-way (ABC) exchange copy: publisher B is asked to link to our site A; in return one of our OTHER sites (C, never A)
// links to B's article, and the email says C is "a separate site I run". Never money; the promise is recorded only once
// the email that makes it is delivered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OPT_OUT,EXCHANGE_MAX_WORDS,templatePitch,listInclusionPitch,brokenLinkPitch,alternativePitch,mentionPitch,followupPitch,exchangePitch,exchangeLine,
  usableOffer,pitchProblem,followupProblem,PitchWriter,aiProviders} from '../../scripts/autopilot/pitch.mjs';
import {runOutreach} from '../../scripts/autopilot/outreach.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';

const site={domain:'gearuptofit.com',topic:'running shoes'},partnerSite={domain:'plantastichaven.com',topic:'houseplant care'};
const asset={url:'https://gearuptofit.com/shoe-finder/',title:'Running Shoe Finder | GearUpToFit',type:'interactive_tool',interactive:true,words:1900,
  description:'Answer six questions and get matched to running shoes by gait and terrain.',reasons:['2 data tables']};
const offer={partner_site:'plantastichaven.com',partner_page:'https://plantastichaven.com/plant-tools/',partner_title:'Best Houseplant Tools',their_url:'https://pub.example/resources/',their_title:'Resources for New Runners',score:0.7};
const p={id:'a',domain:'pub.example',page_url:'https://pub.example/resources/',title:'Resources for New Runners',author:'Jane Doe',fit_section:'Choosing shoes'};
const o={senderName:'Alex',site,exchange:offer};
const urls=b=>b.match(/https?:\/\/\S+/g)||[];
const words=b=>b.replace(OPT_OUT,'').replace(/\n\nBest,[\s\S]*$/,'').split(/\s+/).filter(Boolean).length;
const MONEY=/\bpa(?:y|id|yment)\b|\bfees?\b|\bpric(?:e|es|ing)\b|[$€£]\s?\d|sponsor/i;
const SCHEME=/link exchange|link swap|swap|scheme|reciprocal/i;
const LINE="In return, once your link is up, I'd link to your page from \"Best Houseplant Tools\" on plantastichaven.com, a separate site I run.";

test('with an offer, every first-pitch template makes it in one sentence right after the ask, from C, said to be a separate site I run',()=>{
  const cases=[[templatePitch(p,asset,o),'template:resource_suggestion',/\? In return, once your link is up/],
    [templatePitch({...p,title:'15 Best Running Apps'},asset,o),'template:list_inclusion',/"15 Best Running Apps"\? In return/],
    [templatePitch({...p,broken_link:{anchor:'old fit guide',host:'dead.example',reason:'not_found'}},asset,o),'template:broken_link_replacement',/to the page above instead\? In return/],
    [templatePitch({...p,kind:'linkgap',competitor_link:{host:'other.example',anchor:'shoe quiz',match:'specific'}},asset,o),'template:alternative_to_linked_resource',/as the link text\? In return/]];
  for(const [t,base,after] of cases){
    assert.equal(t.variant,'template:link_exchange');assert.equal(t.base_variant,base);assert.deepEqual(t.exchange,offer);
    assert.ok(t.body.includes(LINE),base);assert.match(t.body,after,`${base}: the offer follows the one direct ask`);
    assert.deepEqual(urls(t.body),[asset.url],'one URL, ours; C and their article are named, not linked');
    assert.doesNotMatch(t.body,MONEY);assert.doesNotMatch(t.body,SCHEME);assert.ok(t.body.includes(OPT_OUT));
    assert.equal(pitchProblem(t,asset,{exchange:offer,site}),null,base);
    const n=words(t.body);assert.ok(n>=60&&n<=100,`${base}: ${n} words`);
    // The offer sentence never names the promoted site A.
    assert.doesNotMatch(t.body.split('\n').find(l=>l.includes('In return')).split('In return')[1],/gearuptofit/);
  }
  assert.deepEqual(exchangePitch(p,asset,o),templatePitch(p,asset,o));
  // Another of their articles is named by its title; the same page is "your page".
  assert.match(exchangeLine(p,{...offer,their_url:'https://pub.example/trail-runs/',their_title:'Our favourite trail runs | Pub'}),/I'd link to your article "Our favourite trail runs" from/);
  assert.match(exchangeLine(p,{...offer,their_url:'https://www.pub.example/resources'}),/I'd link to your page from/);
  // A mention is a thank-you and never carries an offer; no offer leaves the templates as they were.
  const m=mentionPitch({...p,kind:'mention'},asset,o);assert.equal(m.variant,'template:unlinked_mention');assert.doesNotMatch(m.body,/In return|plantastichaven/);
  const plain=templatePitch(p,asset,{senderName:'Alex',site});assert.equal(plain.variant,'template:resource_suggestion');assert.equal(plain.exchange,undefined);assert.doesNotMatch(plain.body,/In return|separate site/);
  assert.equal(listInclusionPitch({...p,title:'15 Best Running Apps'},asset,{senderName:'Alex',site}).variant,'template:list_inclusion');
  assert.equal(brokenLinkPitch({...p,broken_link:{host:'dead.example',reason:'gone'}},asset,{senderName:'Alex',site}).exchange,undefined);
  assert.equal(alternativePitch({...p,competitor_link:{host:'x.example'}},asset,{senderName:'Alex',site}).variant,'template:alternative_to_linked_resource');
});

test('an offer from the promoted site A, from the editor\'s own site, or without a page title is never made',()=>{
  for(const bad of [{...offer,partner_site:'gearuptofit.com'},{...offer,partner_site:'www.GearUpToFit.com'},{...offer,partner_site:'blog.gearuptofit.com'},
    {...offer,partner_site:'https://gearuptofit.com/'},{...offer,partner_site:'pub.example'},{...offer,partner_title:' '},{...offer,partner_site:'not a domain'},null,'plantastichaven.com']){
    assert.equal(usableOffer(bad,site,asset,p),null,JSON.stringify(bad));
    const t=templatePitch(p,asset,{senderName:'Alex',site,exchange:bad});
    assert.equal(t.variant,'template:resource_suggestion');assert.equal(t.exchange,undefined);assert.doesNotMatch(t.body,/In return|separate site/);
  }
  assert.deepEqual(usableOffer(offer,site,asset,p),offer);
});

test('validation: return-link wording needs the offer and the partner\'s name; payment, a swap, site A, an undisclosed C or an overclaim are rejected',()=>{
  const t=templatePitch(p,asset,o),w=body=>({subject:t.subject,body}),chk=(body,ex=offer)=>pitchProblem(w(body),asset,{exchange:ex,site});
  assert.equal(chk(t.body),null);
  assert.equal(pitchProblem(t,asset),'offer_not_allowed','no offer given: no return link may be offered');
  assert.equal(pitchProblem(t,asset,{exchange:{...offer,partner_site:'gearuptofit.com'},site}),'offer_not_allowed','an offer from A is no offer');
  assert.equal(chk(t.body.replace(LINE,"In return, we could do a link swap with plantastichaven.com, a separate site I run.")),'offer_not_allowed');
  assert.equal(chk(t.body.replace(LINE,"In return, I'd be happy to pay for the link.")),'payment_not_allowed');
  assert.equal(chk(t.body+' We can offer a small fee for the link.'),'payment_not_allowed');
  assert.equal(pitchProblem(w(templatePitch(p,asset,{senderName:'Alex',site}).body+" We'd pay for a placement."),asset),'payment_not_allowed','money is refused without an offer too');
  assert.equal(chk(t.body.replace(LINE,"In return, I'd link to your page from a separate site I run.")),'exchange_partner_missing');
  assert.equal(chk(templatePitch(p,asset,{senderName:'Alex',site}).body),'exchange_offer_missing','the writer left the offer out');
  assert.equal(chk(t.body.replace(LINE,"In return, I'd link to your page from gearuptofit.com and from plantastichaven.com, a separate site I run.")),'exchange_from_target_site');
  assert.equal(chk(t.body.replace(LINE,"In return, I'd link to your page from this site. plantastichaven.com is a separate site I run.")),'exchange_from_target_site');
  assert.equal(chk(t.body.replace(', a separate site I run','')),'exchange_not_disclosed');
  assert.equal(chk(t.body.replace('a separate site I run','a partner site of ours')),'exchange_not_disclosed');
  assert.equal(chk(t.body.replace(LINE,"I've already linked to your page from \"Best Houseplant Tools\" on plantastichaven.com, a separate site I run.")),'exchange_claims_placed');
  assert.equal(chk(t.body.replace(LINE,"In return, I'd link to your page from plantastichaven.com, a separate site I run, with a permanent dofollow link.")),'exchange_overpromise');
  assert.equal(chk(t.body.replace(LINE,"In return, I'd link to your page from plantastichaven.com, a separate site I run with DA 50 and lots of traffic.")),'exchange_overpromise');
  assert.equal(chk(t.body.replace('Best Houseplant Tools','Houseplant Traffic Light Guide'),{...offer,partner_title:'Houseplant Traffic Light Guide'}),null,'a title is not a claim');
  assert.equal(chk(t.body.replace('Answer six questions','Answer six questions. '+'More words here. '.repeat(14))),'exchange_too_long');
  // Without an offer, a pitch naming our own citation of their article is still fine.
  const cited=templatePitch({...p,cited_by_us:{our_url:'https://gearuptofit.com/guide/'}},asset,{senderName:'Alex',site});
  assert.match(cited.body,/already links to your article/);assert.equal(pitchProblem(cited,asset,{cited:true}),null);
  // Only when that citation is on record: otherwise "already links to your article" is a claim nobody checked.
  assert.equal(pitchProblem(cited,asset),'claims_placed');
  assert.ok(EXCHANGE_MAX_WORDS>=100);
});

const completion=content=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'content-type':'application/json'}});
const writerWith=(answer,seen=[])=>new PitchWriter({senderName:'Alex',providers:aiProviders({GROQ_API_KEY:'k'}),
  fetchImpl:async(u,req)=>{if(String(u).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'fixture-chat-70b'}]}),{headers:{'content-type':'application/json'}});
    const r=JSON.parse(req.body);seen.push({system:r.messages[0].content,facts:JSON.parse(r.messages[1].content.replace(/^[^\n]*\n/,''))});return completion(answer)}});
const AI=offerLine=>`Subject: A shoe finder for your new-runner page\n\nI'm Alex from gearuptofit.com, a site about running shoes. Would you consider adding Running Shoe Finder to your "Choosing shoes" section in Resources for New Runners? ${offerLine}\n\n${asset.url}\n\nIt is a free interactive tool with no sign-up. The edit would be one link with "Running Shoe Finder" as the link text.\n\n${OPT_OUT}\n\nBest,\nAlex\ngearuptofit.com`;

test('the AI writer is given the offer as facts and must make it; otherwise the template makes it',async()=>{
  const seen=[];const w=writerWith(AI("In return, I'd gladly link to your page from my Best Houseplant Tools page on plantastichaven.com, a separate site I run."),seen);
  const out=await w.write(p,asset,site,{senderName:'Alex',exchange:offer});
  assert.equal(out.writer,'groq');assert.equal(out.variant,'ai:link_exchange');assert.equal(out.base_variant,'ai:resource_suggestion');assert.deepEqual(out.exchange,offer);
  assert.deepEqual(seen[0].facts.exchange,{partner_site:'plantastichaven.com',partner_title:'Best Houseplant Tools',their_title:'Resources for New Runners',their_url:offer.their_url,same_page:true,relationship:'a separate site I run'});
  assert.equal(seen[0].facts.situation,'resource_suggestion');
  assert.match(seen[0].system,/If exchange is given/);assert.match(seen[0].system,/"a separate site I run"/);assert.match(seen[0].system,/never offer or accept money/);assert.match(seen[0].system,/Never offer a link from sender\.website/);
  assert.match(seen[0].system,/Without exchange: never offer anything in return/);
  // The model left the offer out, offered a link from A, or offered money: the template (which makes the offer) is used.
  for(const [line,why] of [['',"exchange_offer_missing"],["In return, I'd link to your page from gearuptofit.com and plantastichaven.com, a separate site I run.",'exchange_from_target_site'],
    ["In return, I'd be happy to pay for the link from plantastichaven.com, a separate site I run.",'payment_not_allowed']]){
    const x=writerWith(AI(line)),t=await x.write(p,asset,site,{senderName:'Alex',exchange:offer});
    assert.equal(t.writer,'template');assert.equal(t.variant,'template:link_exchange');assert.deepEqual(t.exchange,offer);assert.deepEqual(x.reasons,{[why]:1});
  }
  // No offer: nothing about it in the facts, and a model that offers a return link anyway is refused.
  const none=[];const plain=await writerWith(AI("In return, I'd link to your page from plantastichaven.com, a separate site I run."),none).write(p,asset,site,{senderName:'Alex'});
  assert.equal(none[0].facts.exchange,undefined);assert.equal(plain.writer,'template');assert.equal(plain.variant,'template:resource_suggestion');assert.equal(plain.exchange,undefined);
  // An offer from A is dropped before the model sees it; a mention never carries one.
  const fromA=[];await writerWith(AI(''),fromA).write(p,asset,site,{exchange:{...offer,partner_site:'gearuptofit.com'}});assert.equal(fromA[0].facts.exchange,undefined);
  const men=[];const m=await writerWith(AI(''),men).write({...p,kind:'mention'},asset,site,{exchange:offer});assert.equal(men[0].facts.exchange,undefined);assert.equal(m.exchange,undefined);
  // Without any AI writer the template makes the offer.
  const t=await new PitchWriter({senderName:'Alex'}).write(p,asset,site,{exchange:offer});assert.equal(t.variant,'template:link_exchange');assert.ok(t.body.includes(LINE));
});

test('follow-ups restate an open offer in one clause, only while it is open',async()=>{
  const open={...p,exchange:{...offer,status:'offered',offered_at:'2026-11-20T10:00:00Z',via:'email'},facts_used:[]};
  const f=followupPitch(open,asset,{senderName:'Alex',site,subject:'Re: x'});
  assert.match(f.body,/"Resources for New Runners", in return for a link to your page from plantastichaven\.com \(a separate site I run\)\. /);
  assert.deepEqual(urls(f.body),[asset.url]);assert.equal(followupProblem(f),null);assert.equal(pitchProblem(f,asset,{ownSubject:true,exchange:open.exchange,site}),null);
  assert.equal(f.variant,'template:followup_fact','the follow-up kind is unchanged');
  for(const status of ['declined','lapsed','accepted','fulfilled'])assert.doesNotMatch(followupPitch({...open,exchange:{...open.exchange,status}},asset,{senderName:'Alex',site}).body,/in return|plantastichaven/,status);
  assert.doesNotMatch(followupPitch({...open,kind:'mention'},asset,{senderName:'Alex',site}).body,/in return/);
  // The AI follow-up is told the offer, and one that drops it is replaced by the template.
  const seen=[];const fu=`Subject: x\n\nHi Jane, just checking whether you'd consider adding Running Shoe Finder to Resources for New Runners. It is a free interactive tool. Happy to send anything you need.\n\n${asset.url}\n\n${OPT_OUT}\n\nBest,\nAlex\ngearuptofit.com`;
  const w=writerWith(fu,seen),out=await w.write(open,asset,site,{situation:'followup',subject:'Re: x'});
  assert.equal(seen[0].facts.exchange.partner_site,'plantastichaven.com');assert.match(seen[0].system,/If exchange is given, restate our offer in one short clause/);
  assert.equal(out.writer,'template');assert.deepEqual(w.reasons,{exchange_offer_missing:1});assert.match(out.body,/in return for a link to your page from plantastichaven\.com/);
  const good=fu.replace('Resources for New Runners.','Resources for New Runners, in return for a link from plantastichaven.com, a separate site I run.');
  const ok=await writerWith(good).write(open,asset,site,{situation:'followup',subject:'Re: x'});assert.equal(ok.writer,'groq');assert.equal(ok.variant,'ai:followup');
});

const iso=()=>new Date().toISOString();
const decode=raw=>{const [head,body]=raw.split('\r\n\r\n');return {head,text:Buffer.from(body.replace(/\r\n/g,''),'base64').toString('utf8').replace(/\r\n/g,'\n')}};
function proof(q){const t=Date.now();return {ok:true,email:q.email,evidence:{source:`https://${q.domain}/contact/`,email:q.email,rank:95,observed_at:new Date(t).toISOString()},
  verification:hunterVerdict({data:{email:q.email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},q.email,t)}}
function fixture({cfg={},partner=()=>offer,send,writer,prospect={}}={}){
  const pr={id:'a',domain:'pub.example',site:'gearuptofit.com',page_url:'https://pub.example/resources/',title:'Resources for New Runners',asset_url:asset.url,
    email:'editor@pub.example',email_source:'https://pub.example/contact/',qv:2,status:'ready',history:[],...prospect};
  const sent=[],drafts=[],calls=[],logs=[],state={prospects:{a:pr},reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}};
  return {sent,drafts,calls,logs,state,pr,args:{state,assets:[asset],sites:[site,partnerSite],writer:writer||new PitchWriter({senderName:'Alex'}),log:m=>logs.push(m),
    mailer:{authorizeRecipient:async q=>proof(q),send:send||(async m=>sent.push(m)),draft:async raw=>drafts.push(raw)},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@gmail.com',senderName:'Alex',gapMs:()=>0,sendWindow:false,
      exchange:{mode:'abc',perPartnerSiteMonth:6,perPartnerPage:2,fulfilDays:7},exchangePartner:(q,s)=>{calls.push([q.id,s.domain]);return partner(q,s)},...cfg}}};
}

test('runOutreach offers a partner only on first pitches in abc mode and records the promise only after a delivered email that makes it',async()=>{
  const f=fixture(),r=await runOutreach(f.args);
  assert.equal(r.sent,1);assert.equal(r.exchange_offered,1);assert.deepEqual(f.calls,[['a','gearuptofit.com']]);
  const {text}=decode(f.sent[0].raw);assert.ok(text.includes(LINE));assert.ok(text.includes(OPT_OUT));
  const {status,via,offered_at,...rest}=f.pr.exchange;
  assert.deepEqual({status,via},{status:'offered',via:'email'});assert.ok(Date.parse(offered_at)>Date.now()-60e3);assert.deepEqual(rest,offer);
  const h=f.pr.history[0];assert.equal(h.variant,'template:link_exchange');assert.equal(h.base_variant,'template:resource_suggestion');
  assert.ok(!/plantastichaven|pub\.example|gearuptofit|Best Houseplant/.test(f.logs.join('\n')),'the log carries counts only');assert.match(f.logs.at(-1),/1 with a return-link offer/);
  // The follow-up asks for no new partner and restates the open offer.
  f.pr.history[0].at=new Date(Date.now()-8*864e5).toISOString();f.state.first_send_at=new Date(Date.now()-20*864e5).toISOString();f.sent.length=0;
  await runOutreach(f.args);assert.equal(f.calls.length,1,'no partner lookup for a follow-up');
  assert.match(decode(f.sent[0].raw).text,/in return for a link to your page from plantastichaven\.com \(a separate site I run\)/);assert.equal(f.pr.exchange.status,'offered');
  // Mode off, no partner function, or no partner found: no offer at all.
  for(const g of [fixture({cfg:{exchange:{mode:'off'}}}),fixture({cfg:{exchangePartner:undefined}}),fixture({partner:()=>null}),fixture({partner:()=>{throw Error('index not built')}})]){
    const s=await runOutreach(g.args);assert.equal(s.sent,1,'the pitch still goes out');assert.equal(g.pr.exchange,undefined);
    assert.doesNotMatch(decode(g.sent[0].raw).text,/In return|separate site/);assert.equal(g.pr.history[0].variant,'template:resource_suggestion');
  }
  // A mention never asks for a partner.
  const men=fixture({prospect:{kind:'mention'}});await runOutreach(men.args);assert.deepEqual(men.calls,[]);assert.equal(men.pr.exchange,undefined);
  // An open promise to this publisher is not replaced by a new one.
  const busy=fixture({prospect:{exchange:{...offer,status:'accepted'}}});await runOutreach(busy.args);assert.deepEqual(busy.calls,[]);assert.equal(busy.pr.exchange.status,'accepted');
});

test('an offer that is not ours to make is refused before writing, and a failed or offer-less email records no promise',async()=>{
  for(const bad of [{...offer,partner_site:'gearuptofit.com',partner_page:'https://gearuptofit.com/x/'},{...offer,partner_site:'stranger.example',partner_page:'https://stranger.example/x/'},
    {...offer,partner_page:'https://elsewhere.example/plant-tools/'},{...offer,their_url:'https://other-publisher.example/a/'},{...offer,partner_title:''}]){
    const g=fixture({partner:()=>bad}),s=await runOutreach(g.args);
    assert.equal(s.sent,1);assert.equal(s.exchange_refused,1,JSON.stringify(bad));assert.equal(g.pr.exchange,undefined);assert.doesNotMatch(decode(g.sent[0].raw).text,/In return/);
  }
  // A writer that leaves the offer out (no `exchange` in its result) promised nothing.
  const stub={write:async(q,a,s,opts)=>({...templatePitch(q,a,{senderName:'Alex',site:s}),seen:opts.exchange})};
  const quiet=fixture({writer:stub}),q=await runOutreach(quiet.args);assert.equal(q.sent,1);assert.equal(quiet.pr.exchange,undefined);assert.equal(q.exchange_not_included,1);
  // Nothing was transmitted (refused before DATA), or delivery is uncertain: no promise is recorded.
  const refused=fixture({send:async()=>{throw Object.assign(Error('SMTP 421: try later'),{stage:'connect',code:421})}});
  const a=await runOutreach(refused.args);assert.equal(a.sent,0);assert.equal(refused.pr.exchange,undefined);assert.equal(refused.pr.status,'ready');
  const unsure=fixture({send:async()=>{throw Object.assign(Error('socket closed'),{stage:'data',code:'connection'})}});
  await runOutreach(unsure.args);assert.equal(unsure.pr.status,'delivery_uncertain');assert.equal(unsure.pr.exchange,undefined);
  // Draft mode: the saved draft makes the offer, so the promise is on record for when the owner sends it.
  const draft=fixture({cfg:{mode:'draft'}});await runOutreach(draft.args);
  assert.equal(draft.drafts.length,1);assert.equal(draft.pr.status,'drafted');assert.equal(draft.pr.exchange.status,'offered');assert.ok(decode(draft.drafts[0]).text.includes(LINE));
});
