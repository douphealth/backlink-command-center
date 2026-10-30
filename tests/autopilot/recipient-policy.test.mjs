import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEmail,samePublisher,extractEditorialCandidates,isSuppressed,usableVerification,hunterVerdict,checkMx,RecipientVerifier} from '../../scripts/autopilot/recipient-policy.mjs';
const now=Date.parse('2026-10-30T09:00:00Z');
const email='editor@journal.example';
const url='https://journal.example/contact/';
const ctx={domain:'journal.example',source:'contact',now};
const html='<h1>Editorial inquiries and resource suggestions</h1><a href="mailto:editor@journal.example">Contact our editor</a>';
const data=(e=email,extra={})=>({data:{email:e,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false,...extra}});
const env={EMAIL_VERIFICATION_ENABLED:'YES',HUNTER_API_KEY:'unit-test-not-real',EMAIL_VERIFY_DAILY_LIMIT:'3'};
const prospect={domain:'journal.example',page_url:'https://journal.example/resources/',email_source:url,email,history:[]};
function fixture(options={}){
 const state=options.state||{},calls=[],pages=[];
 const v=new RecipientVerifier({state,env:{...env,...options.env},now:()=>now,
  fetchPage:async(u)=>{pages.push(u);return {status:200,url:u,body:html}},
  resolveMx:async()=>[{priority:10,exchange:'mx.journal.example'}],
  fetchImpl:async(u,o)=>{calls.push({u,o});return {status:200,json:async()=>data(new URL(u).searchParams.get('email'))}},...options});
 return {v,state,calls,pages};
}
test('strict address normalization prevents header injection and malformed inboxes',()=>{
 assert.equal(normalizeEmail('Jane.Smith@Journal.Example'),'jane.smith@journal.example');
 for(const e of ['a@b',' a@b.com','a@b.com ','a..b@b.com','.ab@b.com','ab.@b.com','x@-host.com','x@host..com','x@b.com\r\nBcc:x@y.com','a@b.com,c@d.com'])assert.equal(normalizeEmail(e),'',e);
});
test('source identity cannot be another domain, misleading suffix or embedded credentials',()=>{
 assert.equal(samePublisher('https://www.journal.example/contact','journal.example'),true);
 for(const u of ['https://journal.example.evil.example/contact','https://evil.example/contact','https://u:p@journal.example/','file:///journal.example'])assert.equal(samePublisher(u,'journal.example'),false,u);
});
test('literal published editorial address has provenance and role',()=>{
 const [c]=extractEditorialCandidates(html,url,ctx);assert.equal(c.email,email);assert.equal(c.role,'editorial');assert.equal(c.source,url);assert.equal(c.rank,95);assert.equal(c.observed_at,new Date(now).toISOString());
});
test('generic address on an article is not promoted without an editorial remit',()=>{
 assert.deepEqual(extractEditorialCandidates('<p>Call our business info@journal.example</p>',url,{...ctx,source:'page'}),[]);
 assert.deepEqual(extractEditorialCandidates('<p>General enquiries info@journal.example</p>',url,ctx),[]);
});
test('explicit editorial contact beats a generic inbox',()=>{
 const list=extractEditorialCandidates(html+'<p>Editorial enquiries: hello@journal.example</p>',url,ctx);
 assert.equal(list[0].email,email);assert.equal(list[1].email,'hello@journal.example');
});
test('never generate email permutations from an author name',()=>{
 assert.deepEqual(extractEditorialCandidates('<h1>Editorial team: Jane Smith</h1>',url,{...ctx,author:'Jane Smith'}),[]);
});
test('a directly published named author can be prioritized',()=>{
 const list=extractEditorialCandidates('<p>Editor Jane Smith jane.smith@journal.example</p>'+html,url,{...ctx,author:'Jane Smith'});
 assert.equal(list[0].email,'jane.smith@journal.example');assert.equal(list[0].role,'named_author');
});
test('scripts, comments, forms, hidden nodes and reader comments are not contacts',()=>{
 const bad=['<!-- Editorial: editor@journal.example -->','<script>editor="editor@journal.example"</script>',
  '<form>Editorial editor@journal.example</form>','<div hidden>Editorial editor@journal.example</div>',
  '<div class="comment">Editorial editor@journal.example</div>','<div style="display:none">Editorial editor@journal.example</div>',
  '<div data-email="editor@journal.example">Editorial</div>'];
 for(const s of bad)assert.deepEqual(extractEditorialCandidates(s,url,ctx),[],s);
});
test('wrong departments and placeholders are excluded',()=>{
 for(const local of ['sales','support','feedback','privacy','noreply','press','test'])assert.deepEqual(extractEditorialCandidates('<p>Editorial contact '+local+'@journal.example</p>',url,ctx),[]);
 assert.deepEqual(extractEditorialCandidates('<p>Editorial editor@example.com</p>','https://example.com/contact/',{domain:'example.com',source:'contact'}),[]);
});
test('publisher do-not-pitch instructions are respected',()=>{
 assert.deepEqual(extractEditorialCandidates('<p>No unsolicited pitches. Editorial editor@journal.example</p>',url,ctx),[]);
});
test('third-party source email evidence is rejected',()=>{
 assert.deepEqual(extractEditorialCandidates(html,'https://directory.example/contact/',ctx),[]);
});
test('suppression matches case-insensitive exact inbox and publisher subdomains',()=>{
 assert.equal(isSuppressed({suppression:{'EDITOR@JOURNAL.EXAMPLE':{}}},email,'journal.example'),true);
 assert.equal(isSuppressed({suppression:{'journal.example':{}}},'a@journal.example','www.journal.example'),true);
 assert.equal(isSuppressed({suppression:{'other.example':{}}},email,'journal.example'),false);
});
test('MX presence is not an email-verification pass',async()=>{
 assert.deepEqual(await checkMx('journal.example',async()=>[{exchange:'mx.journal.example'}]),{ok:true,reason:'mx_present_not_mailbox_proof'});
 assert.equal(usableVerification({status:'valid'},email,now),false);
});
test('null MX, no explicit MX and DNS errors all hold rather than send',async()=>{
 assert.equal((await checkMx('journal.example',async()=>[{exchange:'.',priority:0}])).reason,'null_mx');
 assert.equal((await checkMx('journal.example',async()=>[])).reason,'no_explicit_mx');
 assert.equal((await checkMx('journal.example',async()=>{throw Error('SERVFAIL')})).reason,'dns_unverified');
});
test('only full positive mailbox evidence passes',()=>{
 assert.equal(usableVerification(hunterVerdict(data(),email,now),email,now),true);
 for(const extra of [{status:'accept_all'},{status:'unknown'},{status:'webmail'},{accept_all:true},{block:true},{disposable:true},{smtp_check:false},{smtp_check:'true'},{mx_records:false},{gibberish:true},{email:'other@journal.example'}])assert.equal(usableVerification(hunterVerdict(data(email,extra),email,now),email,now),false,JSON.stringify(extra));
});
test('missing provider fields, stale dates, future dates, changed recipients fail closed',()=>{
 assert.equal(usableVerification(hunterVerdict({data:{status:'valid',email}},email,now),email,now),false);
 const v=hunterVerdict(data(),email,now);
 assert.equal(usableVerification(v,email,now+86400001),false);assert.equal(usableVerification(v,email,now-1),false);
 assert.equal(usableVerification(v,'other@journal.example',now),false);
});
test('missing verifier, disabled spending and dummy provider key make no calls',async()=>{
 for(const change of [{HUNTER_API_KEY:''},{HUNTER_API_KEY:'test-api-key'},{EMAIL_VERIFICATION_ENABLED:'NO'},{EMAIL_VERIFY_DAILY_LIMIT:'0'}]){
  const f=fixture({env:{...env,...change}});assert.equal((await f.v.verify(prospect)).reason,'verifier_not_configured');assert.equal(f.calls.length,0);assert.equal(f.pages.length,0);
 }
});
test('successful preflight combines first-party source, MX and exact mailbox verification',async()=>{
 const f=fixture(),r=await f.v.verify(prospect);assert.equal(r.ok,true);assert.equal(r.email,email);assert.equal(r.evidence.source,url);assert.equal(f.calls.length,1);
 assert.ok(f.calls[0].o.headers['X-API-KEY']);assert.ok(!f.calls[0].u.includes(env.HUNTER_API_KEY));
});
test('positive verifier alone cannot invent source evidence',async()=>{
 const f=fixture({fetchPage:async u=>({status:200,url:u,body:'<p>No published address</p>'})});
 assert.equal((await f.v.verify(prospect)).reason,'no_published_editorial_contact');assert.equal(f.calls.length,0);
});
test('source redirect to another publisher is rejected',async()=>{
 const f=fixture({fetchPage:async()=>({status:200,url:'https://other.example/',body:html})});assert.equal((await f.v.verify(prospect)).ok,false);
});
test('verification cache is email-specific and avoids duplicate billed checks',async()=>{
 const f=fixture();await f.v.mailbox(email);await f.v.mailbox(email);assert.equal(f.calls.length,1);
 await f.v.mailbox('other@journal.example');assert.equal(f.calls.length,2);
});
test('daily provider cap is persistent and uncertain calls are counted',async()=>{
 let count=0;const state={};const f=fixture({state,env:{...env,EMAIL_VERIFY_DAILY_LIMIT:'1'},fetchImpl:async()=>{count++;throw Error('timeout')}});
 assert.equal((await f.v.mailbox(email)).status,'unknown');assert.equal((await f.v.mailbox(email)).reason,'verification_budget_exhausted');assert.equal(count,1);
 assert.equal((await fixture({state,env:{...env,EMAIL_VERIFY_DAILY_LIMIT:'1'}}).v.mailbox(email)).reason,'verification_budget_exhausted');
});
test('rate limits and pending responses never become valid',async()=>{
 for(const status of [202,222,401,429,451,500]){
  const f=fixture({fetchImpl:async()=>({status,json:async()=>data()})});assert.equal((await f.v.mailbox(email)).status,'unknown');
 }
});
test('invalid mailbox becomes suppressed and receives no more checks',async()=>{
 const f=fixture({fetchImpl:async()=>({status:200,json:async()=>data(email,{status:'invalid'})})});
 await f.v.mailbox(email);assert.ok(f.state.suppression[email]);assert.equal((await f.v.verify(prospect)).reason,'suppressed');
});
test('follow-up cannot switch to another mailbox even if it is published',async()=>{
 const f=fixture({fetchPage:async u=>({status:200,url:u,body:html.replaceAll(email,'neweditor@journal.example')})});
 assert.equal((await f.v.verify(prospect,{followup:true})).ok,false);
 assert.equal((await f.v.verify({...prospect,history:[{type:'initial',mode:'send'}]})).ok,false);
});
test('expired deadline causes no provider calls',async()=>{
 const f=fixture();assert.equal((await f.v.verify(prospect,{deadline:now-1})).ok,false);assert.equal(f.calls.length,0);
});
