// The owner's Nov 2026 copy decisions: one natural closing sentence replaces the 'P.S. ... reply "no"' line in every first
// pitch and follow-up (it must still say how to stop all email), and the List-Unsubscribe header is off unless turned on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OPT_OUT,withOptOut,templatePitch,listInclusionPitch,brokenLinkPitch,alternativePitch,mentionPitch,followupPitch,exchangePitch,
  PitchWriter,aiProviders,followupProblem} from '../../scripts/autopilot/pitch.mjs';
import {classifyReply,buildMessage} from '../../scripts/autopilot/mail.mjs';
import {runOutreach} from '../../scripts/autopilot/outreach.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';

const site={domain:'gearuptofit.com',topic:'running shoes'};
const asset={url:'https://gearuptofit.com/shoe-finder/',title:'Running Shoe Finder | GearUpToFit',type:'interactive_tool',interactive:true,words:1900,
  description:'Answer six questions and get matched to running shoes by gait and terrain.',reasons:['2 data tables']};
const offer={partner_site:'plantastichaven.com',partner_page:'https://plantastichaven.com/plant-tools/',partner_title:'Best Houseplant Tools',their_url:'https://pub.example/resources/',their_title:'Resources for New Runners',score:0.7};
const p={id:'a',domain:'pub.example',page_url:'https://pub.example/resources/',title:'Resources for New Runners',author:'Jane Doe',fit_section:'Choosing shoes'};
const o={senderName:'Alex',site};
const CLOSE=/\n\nIf it's not a fit, just say so and I won't follow up\.\n\nBest,\nAlex\ngearuptofit\.com$/;

test('the opt-out is one natural closing sentence, right before the sign-off, in every first pitch and follow-up',()=>{
  assert.equal(OPT_OUT,"If it's not a fit, just say so and I won't follow up.");
  const all=[templatePitch(p,asset,o),listInclusionPitch({...p,title:'15 Best Running Apps'},asset,o),
    brokenLinkPitch({...p,broken_link:{anchor:'old fit guide',host:'dead.example',reason:'not_found'}},asset,o),
    alternativePitch({...p,kind:'linkgap',competitor_link:{host:'other.example',anchor:'shoe quiz',match:'specific'}},asset,o),
    mentionPitch({...p,kind:'mention'},asset,o),exchangePitch(p,asset,{...o,exchange:offer}),templatePitch({...p,title:'Top 7 Running Apps'},asset,{...o,exchange:offer}),
    followupPitch(p,asset,{...o,subject:'Re: x'}),followupPitch({...p,facts_used:[]},asset,{...o,subject:'Re: x'}),
    followupPitch({...p,broken_link:{anchor:'old fit guide',host:'dead.example',reason:'gone'}},asset,{...o,subject:'Re: x'}),
    followupPitch({...p,kind:'mention'},asset,{...o,subject:'Re: x'}),followupPitch({...p,exchange:{...offer,status:'offered'}},asset,{...o,subject:'Re: x'})];
  for(const t of all){
    assert.equal(t.body.split(OPT_OUT).length,2,`${t.variant}: exactly once`);
    assert.match(t.body,CLOSE,`${t.variant}: last line before the sign-off`);
    assert.doesNotMatch(t.body,/P\.S\.|reply "no"|Not relevant for you/,`${t.variant}: the old P.S. is gone`);
  }
  // The follow-up's 75-word limit is about the nudge itself, not the closing sentence.
  assert.equal(followupProblem({body:'word '.repeat(70)+OPT_OUT}),null);
});

test('an AI email without the closing sentence gets it before the sign-off; a reworded one is replaced; it is never doubled',()=>{
  assert.equal(withOptOut('Hi there,\n\nBody text.\n\nBest,\nSam\nsite.com'),`Hi there,\n\nBody text.\n\n${OPT_OUT}\n\nBest,\nSam\nsite.com`);
  assert.equal(withOptOut('Hi there,\n\nBody text.\n\nThanks,\nSam'),`Hi there,\n\nBody text.\n\n${OPT_OUT}\n\nThanks,\nSam`);
  assert.equal(withOptOut('Hi there, body text with no sign-off.'),`Hi there, body text with no sign-off.\n\n${OPT_OUT}`);
  assert.equal(withOptOut(`Body.\n\n${OPT_OUT}\n\nBest,\nSam`),`Body.\n\n${OPT_OUT}\n\nBest,\nSam`,'already there: unchanged');
  // Typographic apostrophes or a reworded promise: only that sentence becomes the owner's exact wording.
  assert.equal(withOptOut('Body.\n\nIf it’s not a fit, just say so and I won’t follow up.\n\nBest,\nSam'),`Body.\n\n${OPT_OUT}\n\nBest,\nSam`);
  assert.equal(withOptOut('Body. If this is not useful, tell me and I won\'t email again. See also https://x.example/\n\nBest,\nSam'),
    `Body. ${OPT_OUT} See also https://x.example/\n\nBest,\nSam`,'the rest of the line is kept, so an extra URL is still caught');
});

const completion=content=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{'content-type':'application/json'}});
const writerWith=(answer,seen=[])=>new PitchWriter({senderName:'Alex',providers:aiProviders({GROQ_API_KEY:'k'}),
  fetchImpl:async(u,req)=>{if(String(u).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'fixture-chat-70b'}]}),{headers:{'content-type':'application/json'}});
    const r=JSON.parse(req.body);seen.push({system:r.messages[0].content,facts:JSON.parse(r.messages[1].content.replace(/^[^\n]*\n/,''))});return completion(answer)}});

test('the AI writer is told the exact sentence, and its email carries it even when the model left it out',async()=>{
  const body=`I'm Alex from gearuptofit.com, a site about running shoes. Would you consider adding Running Shoe Finder to your "Choosing shoes" section in Resources for New Runners? It is a free interactive tool with no sign-up.\n\n${asset.url}\n\nIf it fits, the edit would be one link with "Running Shoe Finder" as the link text.\n\nBest,\nAlex\ngearuptofit.com`;
  const seen=[];const out=await writerWith(`Subject: A shoe finder for your new-runner page\n\n${body}`,seen).write({...p,id:'w'},asset,site);
  assert.equal(out.writer,'groq');assert.match(out.body,CLOSE);assert.equal(out.body.split(OPT_OUT).length,2);
  assert.ok(seen[0].system.includes(`with exactly this sentence: ${OPT_OUT}`));assert.doesNotMatch(seen[0].system,/P\.S\.|reply "no"/);
  const fu=`Subject: x\n\nHi Jane, just checking whether you'd consider adding Running Shoe Finder to Resources for New Runners. Happy to send anything you need.\n\n${asset.url}\n\nBest,\nAlex\ngearuptofit.com`;
  const f=await writerWith(fu).write({...p,facts_used:[]},asset,site,{situation:'followup',subject:'Re: A shoe finder'});
  assert.equal(f.writer,'groq');assert.equal(f.subject,'Re: A shoe finder');assert.match(f.body,CLOSE);
});

test('replies that take up the closing sentence are opt-outs; our own sentence quoted back is never read',()=>{
  const quote=`\n\nOn Mon, Nov 23, 2026 at 8:39 PM Alex <a@b.com> wrote:\n> ${OPT_OUT}`;
  const r=body=>({from:'ed@pub.example',subject:'Re: Resource for your page',body:body+quote,autoSubmitted:''});
  for(const t of ['No thanks','No, thank you.','Not interested, thanks.','Not for us, sorry.',"Thanks, but we'll pass.","Please don't email me again.",'No\n\nSent from my iPhone','Nope.','Not a fit for us.','Please remove us from your list.'])
    assert.equal(classifyReply(r(t)),'negative',t);
  assert.equal(classifyReply(r('Thanks, I added it to the page!')),'positive');
  assert.equal(classifyReply(r('Thanks for the note, I will have a look next week.')),'neutral','the quoted closing sentence is not an opt-out by the reader');
});

const iso=()=>new Date().toISOString();
const decode=raw=>{const [head,body]=raw.split('\r\n\r\n');return {head,text:Buffer.from(body.replace(/\r\n/g,''),'base64').toString('utf8').replace(/\r\n/g,'\n')}};
function proof(q){const t=Date.now();return {ok:true,email:q.email,evidence:{source:`https://${q.domain}/contact/`,email:q.email,rank:95,observed_at:new Date(t).toISOString()},
  verification:hunterVerdict({data:{email:q.email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},q.email,t)}}
function fixture(cfg={}){
  const pr={id:'a',domain:'pub.example',site:'gearuptofit.com',page_url:'https://pub.example/resources/',title:'Resources for New Runners',asset_url:asset.url,
    email:'editor@pub.example',email_source:'https://pub.example/contact/',qv:2,status:'ready',history:[]};
  const sent=[],state={prospects:{a:pr},reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}};
  return {sent,state,pr,args:{state,assets:[asset],sites:[site],writer:new PitchWriter({senderName:'Alex'}),
    mailer:{authorizeRecipient:async q=>proof(q),send:async m=>sent.push(m),draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@gmail.com',senderName:'Alex',gapMs:()=>0,sendWindow:false,...cfg}}};
}

test('List-Unsubscribe is off by default and added to pitches and follow-ups only when the owner turns it on',async()=>{
  const id='<lf-abc-123@gmail.com>';
  assert.doesNotMatch(buildMessage({from:'me@gmail.com',to:'a@b.example',subject:'s',text:'x',messageId:id}),/List-Unsubscribe/);
  assert.doesNotMatch(buildMessage({from:'me@gmail.com',to:'a@b.example',subject:'s',text:'x',messageId:id,unsubscribe:'on'}),/List-Unsubscribe/,'only an explicit true');
  assert.match(buildMessage({from:'me@gmail.com',to:'a@b.example',subject:'s',text:'x',messageId:id,unsubscribe:true}),/\r\nList-Unsubscribe: <mailto:me@gmail\.com\?subject=unsubscribe%20lf-abc-123@gmail\.com>\r\n/);
  const off=fixture();assert.equal((await runOutreach(off.args)).sent,1);
  const a=decode(off.sent[0].raw);assert.doesNotMatch(a.head,/List-Unsubscribe/);assert.ok(a.text.includes(OPT_OUT),'the body still says how to stop all email');
  const on=fixture({listUnsubscribe:true});await runOutreach(on.args);
  assert.match(decode(on.sent[0].raw).head,/^List-Unsubscribe: <mailto:owner@gmail\.com\?subject=unsubscribe%20lf-/m);
  // The follow-up honours the same switch.
  for(const [f,want] of [[off,false],[on,true]]){
    f.pr.history[0].at=new Date(Date.now()-8*864e5).toISOString();f.state.first_send_at=new Date(Date.now()-20*864e5).toISOString();f.sent.length=0;
    await runOutreach(f.args);const fu=decode(f.sent[0].raw);
    assert.match(fu.head,/^In-Reply-To: <lf-/m);assert.equal(/List-Unsubscribe/.test(fu.head),want);assert.ok(fu.text.includes(OPT_OUT));
  }
});
