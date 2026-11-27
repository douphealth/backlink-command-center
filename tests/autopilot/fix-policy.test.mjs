import test from 'node:test';
import assert from 'node:assert/strict';
import {RecipientVerifier,extractEditorialCandidates,mxClassStats} from '../../scripts/autopilot/recipient-policy.mjs';
import {preverify} from '../../scripts/autopilot/outreach.mjs';
import {linkLikelihood} from '../../scripts/autopilot/learn.mjs';
import {listInclusionPitch,isListPage} from '../../scripts/autopilot/pitch.mjs';

const page=ctx=>`<html><body><main><p>${ctx}</p><p>Editorial submissions: <a href="mailto:editor@pub.example">editor@pub.example</a></p></main></body></html>`;
const found=(html,url='https://pub.example/contact/')=>extractEditorialCandidates(html,url,{domain:'pub.example',source:'contact'}).map(c=>c.email);

test('F7: contracted and polite "do not pitch" notices hold the address; ordinary wording does not',()=>{
  for(const c of ['Please do not pitch us.','We are not accepting pitches.',"We don't accept unsolicited pitches.","Please don't pitch us or send link requests.",
    "Unsolicited pitches will be ignored, please don't send them.",'No link requests, please.','We don’t accept unsolicited guest posts.'])assert.deepEqual(found(page(c)),[],c);
  for(const c of ['We do not accept responsibility for third-party content.',"Please don't send attachments.",'Send article ideas to the editors.'])assert.deepEqual(found(page(c)),['editor@pub.example'],c);
});

test('F7: a notice anywhere on a contact or write-for-us page holds every address on it, not only the 180 characters around one',()=>{
  const far=`<html><body><main><h2>Write for us</h2><p>We do not accept unsolicited guest posts.</p>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. </p>'.repeat(30)}
    <p>Editorial submissions: <a href="mailto:editor@pub.example">editor@pub.example</a></p></main></body></html>`;
  assert.deepEqual(found(far,'https://pub.example/write-for-us/'),[]);
  // An ordinary article page is judged by the text around the address, as before.
  assert.equal(extractEditorialCandidates(far.replace('We do not accept unsolicited guest posts.','Our policies are listed below.'),'https://pub.example/write-for-us/',{domain:'pub.example',source:'contact'}).length,1);
});

const VENV={EMAIL_VERIFICATION_ENABLED:'YES',EMAIL_VERIFY_DAILY_LIMIT:'20',VERIFALIA_USERNAME:'u',VERIFALIA_PASSWORD:'p',VERIFALIA_ALLOW_PAID:'YES'};
function verifier({free=0}={}){
  const calls=[],state={};
  const fetchImpl=async(u,o={})=>{calls.push({u,method:o.method||'GET'});
    if(u.endsWith('/credits/balance'))return {status:200,json:async()=>({creditPacks:500,freeCredits:free,freeCreditsResetIn:'08:00:00'})};
    if(o.method==='POST'){const e=JSON.parse(o.body).entries[0].inputData;return {status:200,json:async()=>({overview:{id:'j',status:'Completed'},entries:{data:[{inputData:e,emailAddress:e,classification:'Deliverable',status:'Success',isDisposableEmailAddress:false}]}})}}
    return {status:200,json:async()=>({})};};
  const v=new RecipientVerifier({state,env:VENV,fetchImpl,now:()=>Date.parse('2026-11-28T01:00:00Z'),
    fetchPage:async u=>({status:200,url:u,body:page('Resource suggestions welcome.')}),resolveMx:async()=>[{priority:10,exchange:'mx.pub.example'}]});
  return {v,calls,state,posts:()=>calls.filter(c=>c.method==='POST').length};
}

test('F8: weekend screening never buys paid credits, even with VERIFALIA_ALLOW_PAID=YES; send checks may',async()=>{
  const f=verifier({free:0}),p={domain:'pub.example',page_url:'https://pub.example/r/',email_source:'https://pub.example/contact/',email:'editor@pub.example',history:[]};
  assert.equal(await f.v.creditsLeft({screen:true}),0,'no free credits: nothing to screen with');
  assert.ok(await f.v.creditsLeft({screen:false})>0,'paid credits allowed for send checks');
  const r=await f.v.verify(p,{prescreen:true});
  assert.equal(r.ok,false);assert.equal(f.posts(),0,'no validation job submitted');
  // Through preverify on a Saturday night: screens stop at once.
  const state={prospects:{a:{id:'a',status:'ready',email:'editor@pub.example',domain:'pub.example',page_url:'https://pub.example/r/',qv:2,score:60,history:[]}}};
  const g=verifier({free:0});
  const s=await preverify({state,mailer:{authorizeRecipient:async()=>({ok:false}),verifierCredits:async o=>g.v.creditsLeft(o),prescreenRecipient:async q=>g.v.verify(q,{prescreen:true})},
    max:5,now:()=>new Date('2026-11-28T01:00:00Z')});
  assert.equal(g.posts(),0);assert.equal(s.out_of_credits,true);
  // With free credits that would expire, the screen runs and uses them.
  const h=verifier({free:5});await h.v.verify(p,{prescreen:true});assert.equal(h.posts(),1);assert.equal(h.state.verifier_balance.free_credits,4);
});

test('COV-F6: verification outcomes by mail-host class are published as counts only',()=>{
  const out=mxClassStats({verify_stats:{google:{n:12.5,valid:3.25,catch_all:2},other:{n:4,valid:1},'<b>':{n:1,valid:1}}});
  assert.deepEqual(out,{google:{n:12.5,valid:3.3,catch_all:2},other:{n:4,valid:1,catch_all:0}});
});

test('COV-F7: lists with outside entries rank higher, more with an "other notable" section, and the ask names that section',()=>{
  const base={score:70,email:'editor@pub.example',email_rank:95,etv:5000,domain:'pub.example',title:'10 Best Garden Planner Apps'};
  const plain=linkLikelihood(base),list=linkLikelihood({...base,list_page:{items:6,title:'10 Best Garden Planner Apps'}}),
    other=linkLikelihood({...base,list_page:{items:6,title:'10 Best Garden Planner Apps',other_section:'Other notable apps'}});
  assert.ok(list>plain&&other>list,`${plain} < ${list} < ${other}`);
  assert.equal(linkLikelihood({...base,list_page:{items:2,title:'x'}}),plain,'a list with one or two outside entries gets no bonus');
  const p={...base,page_url:'https://pub.example/best/',fit_section:'Planning tools',list_page:{items:6,title:'10 Best Garden Planner Apps',other_section:'Other notable apps'},author:'Jane Doe'};
  assert.ok(isListPage(p));
  const pitch=listInclusionPitch(p,{url:'https://owned.example/planner/',title:'Garden Planner',description:''},{senderName:'Alex',site:{domain:'owned.example',topic:'gardening'}});
  assert.match(pitch.body,/your "Other notable apps" section in "10 Best Garden Planner Apps"/);
  const q={...p,list_page:{items:6,title:'10 Best Garden Planner Apps'}};
  assert.match(listInclusionPitch(q,{url:'https://owned.example/planner/',title:'Garden Planner',description:''},{senderName:'Alex',site:{domain:'owned.example',topic:'gardening'}}).body,/your "Planning tools" section/);
});
