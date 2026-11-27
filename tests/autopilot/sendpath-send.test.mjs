import test from 'node:test';
import assert from 'node:assert/strict';
import {runOutreach,emailFooter} from '../../scripts/autopilot/outreach.mjs';
import {templatePitch,PitchWriter} from '../../scripts/autopilot/pitch.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';

const iso=()=>new Date().toISOString();
const older=(d=8)=>new Date(Date.now()-d*864e5).toISOString();
const site={domain:'gearuptofit.com',topic:'running shoes'};
const finder={url:'https://gearuptofit.com/shoe-finder/',title:'Running Shoe Finder',type:'interactive_tool',interactive:true,description:'Answer six questions and get matched to running shoes by gait and terrain.',reasons:['2 data tables']};
const pace={url:'https://gearuptofit.com/pace/',title:'Pace Calculator',type:'interactive_tool',interactive:true,description:'Work out your pace, splits and finish time for any race distance.',reasons:[]};
const mk=(id,o={})=>({id,domain:id+'.example',site:'gearuptofit.com',page_url:`https://${id}.example/resources/`,title:'Resources for New Runners',asset_url:finder.url,
  email:`editor@${id}.example`,email_source:`https://www.${id}.example/contact/`,qv:2,status:'ready',history:[],...o});
function proof(p){const t=Date.now();return {ok:true,email:p.email,evidence:{source:`https://${p.domain}/contact/`,email:p.email,rank:95,observed_at:new Date(t).toISOString()},
  verification:hunterVerdict({data:{email:p.email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},p.email,t)}}
const decode=raw=>{const [head,body]=raw.split('\r\n\r\n');return {head,text:Buffer.from(body.replace(/\r\n/g,''),'base64').toString('utf8').replace(/\r\n/g,'\n')}};
function fixture(prospects,cfg={}){
  const sent=[],written=[],state={prospects,reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}};
  const writer={write:async(p,a,s,o={})=>{written.push({id:p.id,asset:a.url,broken:!!p.broken_link,...o});return o.situation==='followup'?{subject:'ignored',body:'Hi, just checking. '+a.url,writer:'template',variant:'template:followup_nudge',facts_used:[]}:templatePitch(p,a,{senderName:o.senderName,site:s})}};
  return {sent,written,state,args:{state,assets:[finder,pace],sites:[site],writer,
    mailer:{authorizeRecipient:async p=>proof(p),send:async m=>sent.push(m),draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@gmail.com',senderName:'Owner Name',gapMs:()=>0,sendWindow:false,...cfg}}};
}

test('each site signs with its own sender name; the follow-up reuses the name the first email was signed with',async()=>{
  const f=fixture({a:mk('a')},{senderNames:{'gearuptofit.com':'Sam Runner'}});
  const r=await runOutreach(f.args);assert.equal(r.sent,1);
  const {head,text}=decode(f.sent[0].raw);
  assert.match(head,/^From: "Sam Runner" <owner@gmail\.com>/m);assert.match(text,/Best,\nSam Runner\ngearuptofit\.com/);
  assert.equal(f.written[0].senderName,'Sam Runner');
  const h=f.state.prospects.a.history[0];assert.equal(h.sender_name,'Sam Runner');
  // Later the owner renames the site's sender: the follow-up still comes from the name the editor saw.
  h.at=older();f.args.config.senderNames={'gearuptofit.com':'Somebody Else'};f.state.first_send_at=older(20);f.sent.length=0;
  await runOutreach(f.args);const fu=f.written.find(w=>w.situation==='followup');
  assert.equal(fu.senderName,'Sam Runner');assert.match(decode(f.sent[0].raw).head,/^From: "Sam Runner"/m);
  // A record from before names were stored was signed with SENDER_NAME.
  const g=fixture({b:mk('b',{status:'sent',history:[{type:'initial',mode:'send',at:older(),message_id:'<lf-b@gmail.com>',subject:'Old pitch'}]})},{senderNames:{'gearuptofit.com':'Sam Runner'}});
  g.state.first_send_at=older(20);await runOutreach(g.args);assert.equal(g.written[0].senderName,'Owner Name');
  const other=fixture({c:mk('c',{site:'other.example'})},{senderNames:{'gearuptofit.com':'Sam Runner'}});other.args.sites.push({domain:'other.example',topic:'x'});
  await runOutreach(other.args);assert.match(decode(other.sent[0].raw).head,/^From: "Owner Name"/m,'no per-site name: SENDER_NAME');
});

test('the postal footer names the site where the address was published; nothing is added without an address',async()=>{
  assert.equal(emailFooter('',`https://pub.example/contact`),'');
  assert.equal(emailFooter('PO Box 1, Town','https://www.pub.example/about/'),"\n\nPO Box 1, Town\nYou're receiving this because this address is published on pub.example.");
  assert.equal(emailFooter('PO Box 1, Town','not a url'),'\n\nPO Box 1, Town');
  const f=fixture({a:mk('a')},{postalAddress:'PO Box 1, Town'});await runOutreach(f.args);
  const {text}=decode(f.sent[0].raw);
  assert.match(text,/reply "no" and I won't email again\.\n\nPO Box 1, Town\nYou're receiving this because this address is published on a\.example\.$/);
  assert.equal((text.match(/https?:\/\/\S+/g)||[]).length,1,'no tracking link added');
  const none=fixture({a:mk('a')});await runOutreach(none.args);assert.doesNotMatch(decode(none.sent[0].raw).text,/receiving this because/);
});

test('every sent email records variant, writer, code version, proof state, facts used and sender name',async()=>{
  const prev=process.env.GITHUB_SHA;delete process.env.GITHUB_SHA;
  try{
    const f=fixture({a:mk('a')});await runOutreach(f.args);
    const h=f.state.prospects.a.history[0];
    assert.equal(h.type,'initial');assert.equal(h.variant,'template:resource_suggestion');assert.equal(h.writer,'template');assert.equal(h.rev,'local');
    assert.equal(h.verified,true);assert.deepEqual(h.facts_used,['it is a free interactive tool (no sign-up needed)']);assert.equal(h.sender_name,'Owner Name');
    assert.deepEqual(f.state.prospects.a.facts_used,h.facts_used,'the prospect remembers what the first email said');
    process.env.GITHUB_SHA='0123456789abcdef';
    const g=fixture({b:mk('b')});g.args.mailer.authorizeRecipient=undefined;await runOutreach(g.args);
    const k=g.state.prospects.b.history[0];assert.equal(k.rev,'0123456');assert.equal(k.verified,false,'no usable proof at send');
    // The follow-up entry is attributed to the follow-up's own writer, not the first pitch's.
    k.at=older();g.state.first_send_at=older(20);g.args.writer.write=async()=>({subject:'x',body:'Hi there. '+finder.url,writer:'groq',variant:'ai:followup',facts_used:['it includes 2 data tables']});
    await runOutreach(g.args);const fu=g.state.prospects.b.history[1];
    assert.equal(fu.type,'followup');assert.equal(fu.writer,'groq');assert.equal(fu.variant,'ai:followup');assert.deepEqual(fu.facts_used,['it includes 2 data tables']);
    assert.deepEqual(g.state.prospects.b.facts_used,['it is a free interactive tool (no sign-up needed)','it includes 2 data tables']);
  }finally{if(prev===undefined)delete process.env.GITHUB_SHA;else process.env.GITHUB_SHA=prev}
});

test('follow-ups go through the writer as situation "followup", in the same thread, with the original subject',async()=>{
  const a=mk('a',{status:'sent',history:[{type:'initial',mode:'send',at:older(),message_id:'<lf-a1@gmail.com>',subject:'Resource for your page',sender_name:'Sam'}]});
  const f=fixture({a});f.state.first_send_at=older(20);
  const r=await runOutreach(f.args);assert.equal(r.followups,1);
  assert.deepEqual(f.written[0],{id:'a',asset:finder.url,broken:false,situation:'followup',senderName:'Sam',subject:'Re: Resource for your page'});
  const {head}=decode(f.sent[0].raw);
  assert.match(head,/^Subject: Re: Resource for your page$/m,'the writer\'s subject is replaced for threading');
  assert.match(head,/^In-Reply-To: <lf-a1@gmail\.com>$/m);assert.match(head,/^References: <lf-a1@gmail\.com>$/m);
  // A writer that fails falls back to the honest template nudge.
  const b=mk('b',{status:'sent',facts_used:[],history:[{type:'initial',mode:'send',at:older(),message_id:'<lf-b1@gmail.com>',subject:'Hello there'}]});
  const g=fixture({b});g.state.first_send_at=older(20);g.args.writer.write=async()=>{throw Error('down')};
  await runOutreach(g.args);const t=decode(g.sent[0].raw).text;
  assert.match(t,/^Hi there, just checking whether you'd consider adding Running Shoe Finder to "Resources for New Runners"\. It is a free interactive tool \(no sign-up needed\)\./);
  assert.equal(g.state.prospects.b.history[1].variant,'template:followup_fact');
  // A pitch restored from the Sent folder has no message id: it is not followed up outside its thread.
  const c=mk('c',{status:'sent',history:[{type:'initial',mode:'send',at:older(),to:'editor@c.example',reconciled:true}]});
  const h=fixture({c});h.state.first_send_at=older(20);const r3=await runOutreach(h.args);
  assert.equal(h.sent.length,0);assert.equal(r3.followups_unthreaded,1);assert.equal(c.no_followup,true);
});

test('real PitchWriter end to end: the follow-up never repeats a stated fact as new',async()=>{
  const writer=new PitchWriter({senderName:'Owner Name'});
  const f=fixture({a:mk('a')});f.args.writer=writer;await runOutreach(f.args);
  const first=decode(f.sent[0].raw).text;assert.match(first,/It is a free interactive tool/);
  const p=f.state.prospects.a;p.history[0].at=older();f.state.first_send_at=older(20);f.sent.length=0;
  await runOutreach(f.args);const fu=decode(f.sent[0].raw).text;
  assert.doesNotMatch(fu,/free interactive tool|didn't mention/);assert.match(fu,/It includes 2 data tables\./,'the one fact the first email did not state');
  assert.match(decode(f.sent[0].raw).head,/^Subject: Re: /m);
});

test('a dead-link pitch keeps the page the dead link was matched to, or drops the dead-link claim',async()=>{
  const dead={url:'https://dead.example/fit',anchor:'shoe fit guide',host:'dead.example',reason:'not_found'};
  const base={recheckBroken:async()=>({dead:true})};
  // Re-paired to an unrelated page: the "replacement" framing goes.
  const a=mk('a',{broken_link:{...dead}});const f=fixture({a},{...base,pickAsset:()=>({asset:pace,match:'topic'})});
  const r=await runOutreach(f.args);
  assert.equal(a.asset_url,pace.url);assert.equal(f.written[0].broken,false);assert.equal(a.broken_link,undefined);assert.match(a.broken_link_dropped_reason,/no longer the replacement/);
  assert.equal(r.broken_link_dropped,1);assert.doesNotMatch(decode(f.sent[0].raw).text,/dead\.example|page not found/);
  // Pairing already fine: the claim stays and the matched page is pinned.
  const b=mk('b',{broken_link:{...dead}});const g=fixture({b},{...base,pickAsset:()=>undefined});await runOutreach(g.args);
  assert.equal(g.written[0].broken,true);assert.equal(b.broken_link.asset_url,finder.url);assert.match(decode(g.sent[0].raw).text,/"shoe fit guide" \(dead\.example\) returns a "page not found" error/);
  // The matched page was stored and is still pitchable: it is used even though the prospect points elsewhere.
  const c=mk('c',{asset_url:pace.url,broken_link:{...dead,asset_url:finder.url}});
  const h=fixture({c},{...base,pickAsset:(p)=>p.asset_url===finder.url?undefined:{asset:pace,match:'topic'}});await runOutreach(h.args);
  assert.equal(c.asset_url,finder.url);assert.equal(h.written[0].asset,finder.url);assert.equal(h.written[0].broken,true);
  // The matched page is no longer pitchable: the re-paired page is pitched without the dead-link claim.
  const d=mk('d',{broken_link:{...dead,asset_url:'https://gearuptofit.com/retired/'}});
  const k=fixture({d},{...base,pickAsset:()=>undefined});await runOutreach(k.args);
  assert.equal(k.written[0].broken,false);assert.equal(d.broken_link,undefined);assert.equal(d.asset_url,finder.url);
});
