import test from 'node:test';
import assert from 'node:assert/strict';
import {RecipientVerifier,POLICY_VERSION} from '../../scripts/autopilot/recipient-policy.mjs';
import {screenQueue,publisherHold} from '../../scripts/autopilot/outreach.mjs';

const enc=(e,key=0x33)=>key.toString(16).padStart(2,'0')+[...e].map(c=>(c.charCodeAt(0)^key).toString(16).padStart(2,'0')).join('');
/** pages: host -> body (or {status}); every other path on a known host answers with the host's '*' body. */
function rig(pages){
  const st={prospects:{},suppression:{},contacted:{},email_verifications:{},email_verifier_usage:{}},paid=[];
  const v=new RecipientVerifier({state:st,env:{},now:()=>Date.now(),resolveMx:async()=>[],fetchImpl:async(...a)=>{paid.push(a);throw Error('no paid call expected')},
    fetchPage:async u=>{const x=new URL(u),site=pages[x.hostname]||{},b=site[x.pathname.replace(/\/$/,'')||'/']??site['*'];
      return b==null?{status:404,url:u,body:''}:typeof b==='object'?{...b,url:u,body:''}:{status:200,url:u,body:b}}});
  const asked=[];
  return {st,paid,asked,mailer:{screenRecipient:(p,o)=>{asked.push(p.id);return v.verify(p,{...o,screenOnly:true})}}};
}
const ago=d=>new Date(Date.now()-d*86400e3).toISOString();

test('a timed-out address page is our side: held for nobody, re-screened next cycle',async()=>{
  const r=rig({'slow.example':{'/write-for-us':{status:0,error:'timeout'},'*':'<p>Guides.</p>'}});
  r.st.prospects.s={id:'s',domain:'slow.example',page_url:'https://slow.example/guide',email:'editor@slow.example',email_source:'https://slow.example/write-for-us',status:'ready',score:50,history:[]};
  const out=await screenQueue({state:r.st,mailer:r.mailer});
  assert.equal(out.held,0);assert.equal(out.retired,0);
  const s=r.st.prospects.s;assert.equal(s.status,'ready');assert.equal(s.screen_strike,undefined);assert.equal(s.screened_at,undefined,'not marked screened: tried again next cycle');
  assert.equal(publisherHold('email_source_unreachable'),false);
});

test('a passing re-screen clears a first strike and the hold it set',async()=>{
  const r=rig({'ok.example':{'*':'<h1>Editorial submissions</h1><a href="mailto:editor@ok.example">Editor</a>'}});
  r.st.prospects.o={id:'o',domain:'ok.example',page_url:'https://ok.example/r',email:'editor@ok.example',status:'ready',score:50,history:[],screened_at:ago(2),
    screen_strike:{detail:'no_email_published',at:ago(2)},contact_quality:{status:'held',detail:'no_email_published',checked_at:ago(2),via:'screen'}};
  const out=await screenQueue({state:r.st,mailer:r.mailer});
  assert.equal(out.kept,1);const o=r.st.prospects.o;assert.equal(o.screen_strike,undefined);assert.equal(o.contact_quality,undefined);assert.equal(o.status,'ready');
});

test('after the parser improves, retired never-emailed prospects are re-screened for free and recovered ones return to ready',async()=>{
  const cf=`<h1>Write for us</h1><p>Editorial submissions: <a href="/cdn-cgi/l/email-protection#${enc('editor@cf.example')}">[email&#160;protected]</a></p>`;
  const r=rig({'cf.example':{'*':cf},'sent.example':{'*':cf.replaceAll('cf.example','sent.example')},'contacted.example':{'*':cf},'supp.example':{'*':cf},
    'catch.example':{'*':cf},'empty.example':{'*':'<p>Use our form.</p>'},'down.example':{'*':{status:503}}});
  const mk=(id,extra={})=>({id,domain:`${id}.example`,page_url:`https://${id}.example/guide`,email:`old@${id}.example`,status:'contact_unverifiable',score:50,history:[],
    reason:'No verifiable editorial inbox (only_non_editorial_inbox_published)',contact_quality:{status:'held',detail:'only_non_editorial_inbox_published',checked_at:ago(20)},...extra});
  Object.assign(r.st.prospects,{cf:mk('cf',{score:90}),sent:mk('sent',{history:[{type:'initial',at:ago(30),mode:'send'}]}),contacted:mk('contacted'),supp:mk('supp'),
    catch:mk('catch',{contact_quality:{status:'held',detail:'catch_all_domain',checked_at:ago(20)},reason:'No verifiable editorial inbox (catch_all_domain)'}),
    empty:mk('empty',{contact_quality:undefined,reason:'No verifiable editorial inbox (no_email_published)'}),down:mk('down',{score:10})});
  r.st.contacted['contacted.example']=ago(200);r.st.suppression['supp.example']={reason:'Opt-out'};
  const out=await screenQueue({state:r.st,mailer:r.mailer});
  assert.deepEqual(r.asked.sort(),['cf','down','empty'],'only never-emailed, uncontacted, unsuppressed parser retirements are re-screened');
  assert.equal(out.rescreened,3);assert.equal(out.recovered,1);assert.equal(r.paid.length,0,'no verification credit is spent');
  const cfp=r.st.prospects.cf;
  assert.equal(cfp.status,'ready');assert.equal(cfp.email,'editor@cf.example');assert.equal(cfp.screen_v,POLICY_VERSION);assert.equal(cfp.reason,undefined);assert.equal(cfp.contact_quality,undefined);
  assert.equal(r.st.prospects.empty.status,'contact_unverifiable');assert.equal(r.st.prospects.empty.screen_v,POLICY_VERSION,'settled for this parser version');
  assert.equal(r.st.prospects.down.screen_v,undefined);assert.equal(r.st.prospects.down.rescreen_tries,1,'an unreachable publisher is tried again');
  for(const id of ['sent','contacted','supp','catch'])assert.equal(r.st.prospects[id].status,'contact_unverifiable',id);
  // Next cycles: only the unreachable one is tried again, twice more at most.
  r.asked.length=0;await screenQueue({state:r.st,mailer:r.mailer});await screenQueue({state:r.st,mailer:r.mailer});await screenQueue({state:r.st,mailer:r.mailer});
  assert.deepEqual(r.asked,['down','down']);assert.equal(r.st.prospects.down.screen_v,POLICY_VERSION);
});

test('the free re-screen is bounded per cycle, best score first',async()=>{
  const r=rig({'*':{}});
  for(let i=0;i<5;i++)r.st.prospects['p'+i]={id:'p'+i,domain:`p${i}.example`,page_url:`https://p${i}.example/g`,status:'contact_unverifiable',score:i,history:[],contact_quality:{status:'held',detail:'no_email_published'}};
  const out=await screenQueue({state:r.st,mailer:r.mailer,rescreenMax:2});
  assert.equal(out.rescreened,2);assert.deepEqual(r.asked,['p4','p3']);
});
