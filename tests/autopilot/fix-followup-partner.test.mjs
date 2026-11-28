// Review fix (safety F6): the follow-up restates the first email's 3-way offer only while C is still one of the owner's sites
// and not failing. A site the owner no longer runs ends the offer (lapsed, partner_gone); a failing one is just not restated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PitchWriter,aiProviders,OPT_OUT} from '../../scripts/autopilot/pitch.mjs';
import {runOutreach} from '../../scripts/autopilot/outreach.mjs';
import {noteTheirLink} from '../../scripts/autopilot/exchange.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';

const site={domain:'gearuptofit.com',topic:'running shoes'},C={domain:'plantastichaven.com',topic:'houseplants'};
const asset={url:'https://gearuptofit.com/shoe-finder/',title:'Running Shoe Finder',type:'interactive_tool'};
const iso=(ms=Date.now())=>new Date(ms).toISOString();
function proof(q){const t=Date.now();return {ok:true,email:q.email,evidence:{source:`https://${q.domain}/contact/`,email:q.email,rank:95,observed_at:iso(t)},
  verification:hunterVerdict({data:{email:q.email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},q.email,t)}}
const decode=raw=>Buffer.from(raw.slice(raw.indexOf('\r\n\r\n')+4).replace(/\r\n/g,''),'base64').toString('utf8');
const prospect=partner=>({id:'a',domain:'pub.example',site:'gearuptofit.com',page_url:'https://pub.example/resources/',title:'Resources for New Runners',asset_url:asset.url,email:'editor@pub.example',
  email_source:'https://pub.example/contact/',qv:2,status:'sent',
  exchange:{partner_site:partner,partner_page:`https://${partner}/plant-tools/`,partner_title:'Best Houseplant Tools',their_url:'https://pub.example/resources/',status:'offered',offered_at:iso(Date.now()-8*864e5),via:'email'},
  history:[{type:'initial',mode:'send',at:iso(Date.now()-8*864e5),message_id:'<lf-1@gmail.com>',subject:'Suggestion',to:'editor@pub.example',sender_name:'Alex'}]});
async function followUp(p,{sites=[site,C],writer=new PitchWriter({senderName:'Alex'}),failingSites=[]}={}){
  const sent=[],state={prospects:{a:p},reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{},first_send_at:iso(Date.now()-20*864e5)};
  const r=await runOutreach({state,assets:[asset],sites,writer,log:()=>{},mailer:{authorizeRecipient:async q=>proof(q),send:async m=>sent.push(m),draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@gmail.com',senderName:'Alex',gapMs:()=>0,sendWindow:false,exchange:{mode:'abc'},failingSites}});
  return {r,text:sent[0]?decode(sent[0].raw):''};
}

test('F6: a follow-up never promises a link from a site the owner no longer runs; the offer lapses for good',async()=>{
  const p=prospect('formerly-ours.example'),{r,text}=await followUp(p,{sites:[site]});
  assert.equal(r.followups,1);assert.doesNotMatch(text,/formerly-ours|separate site I run|in return/i);assert.ok(text.includes(OPT_OUT));
  assert.equal(p.exchange.status,'lapsed');assert.equal(p.exchange.lapse_reason,'partner_gone');assert.equal(r.exchange_partner_gone,1);
  // Their link later starts no obligation from a site that is not ours.
  assert.equal(noteTheirLink(p),false);assert.equal(p.exchange.status,'lapsed');
});

test('F6: C still ours restates the offer; C failing right now is not restated, and the offer stays open',async()=>{
  let p=prospect('plantastichaven.com'),out=await followUp(p);
  assert.match(out.text,/in return for a link to your page from plantastichaven\.com \(a separate site I run\)/);assert.equal(p.exchange.status,'offered');
  p=prospect('plantastichaven.com');out=await followUp(p,{failingSites:['plantastichaven.com']});
  assert.equal(out.r.followups,1);assert.doesNotMatch(out.text,/plantastichaven|separate site I run/);assert.equal(p.exchange.status,'offered');
});

test('F6: an AI follow-up that restates an offer the engine did not restate is replaced by the template',async()=>{
  const completion=content=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'content-type':'application/json'}});
  const ai=`Subject: x\n\nHi there, just checking whether you'd consider adding Running Shoe Finder to "Resources for New Runners", in return for a link to your page from formerly-ours.example (a separate site I run). Happy to send anything you need.\n\n${asset.url}\n\n${OPT_OUT}\n\nBest,\nAlex\ngearuptofit.com`;
  const writer=new PitchWriter({senderName:'Alex',providers:aiProviders({GROQ_API_KEY:'k'}),
    fetchImpl:async u=>String(u).endsWith('/models')?new Response(JSON.stringify({data:[{id:'fixture-chat-70b'}]}),{headers:{'content-type':'application/json'}}):completion(ai)});
  const p=prospect('formerly-ours.example'),{text}=await followUp(p,{sites:[site],writer});
  assert.doesNotMatch(text,/formerly-ours|separate site I run/);assert.equal(p.history.at(-1).writer,'template');
});
