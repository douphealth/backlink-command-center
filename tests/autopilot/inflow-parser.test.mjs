import test from 'node:test';
import assert from 'node:assert/strict';
import {extractEditorialCandidates,structuredEmails,decodeCloudflare,pageKind,CONTACT_PAGE,POLICY_VERSION,usableVerification,hunterVerdict,RecipientVerifier} from '../../scripts/autopilot/recipient-policy.mjs';
import {findContact,contactForm,contactStatus,contactFields} from '../../scripts/autopilot/prospect.mjs';

const now=Date.parse('2026-11-27T09:00:00Z');
const enc=(e,key=0x5a)=>key.toString(16).padStart(2,'0')+[...e].map(c=>(c.charCodeAt(0)^key).toString(16).padStart(2,'0')).join('');
const contact='https://journal.example/contact/',ctx={domain:'journal.example',source:'contact',now};
const resp=(body,{status=200}={})=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8'}});
const ld=o=>`<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const article=extra=>`<html><head><title>Best trail shoes</title>${extra||''}</head><body><article><h1>Best trail shoes</h1><p>${'Trail running advice. '.repeat(80)}</p></article></body></html>`;

test('Cloudflare-protected addresses are read in both forms, with the text a reader sees as context',()=>{
  assert.equal(decodeCloudflare(enc('editor@journal.example')),'editor@journal.example');
  for(const bad of ['','zz','5a1','5a'])assert.equal(decodeCloudflare(bad),'',bad);
  const href=`<h1>Editorial submissions</h1><p>Send article suggestions to <a href="/cdn-cgi/l/email-protection#${enc('editor@journal.example')}">[email&#160;protected]</a></p>`;
  const [a]=extractEditorialCandidates(href,contact,ctx);
  assert.equal(a.email,'editor@journal.example');assert.equal(a.method,'cloudflare_published');assert.equal(a.rank,95);
  // The editorial wording is 400+ characters of markup away: a plain-text window still sees it.
  const markup=`<div class="${'x'.repeat(420)}"><span></span></div>`;
  const attr=`<p>Editorial enquiries:</p>${markup}<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${enc('submissions@journal.example')}">[email&#160;protected]</a>`;
  const [b]=extractEditorialCandidates(attr,contact,ctx);
  assert.equal(b.email,'submissions@journal.example');assert.equal(b.role,'editorial');assert.match(b.context,/Editorial enquiries/);
  assert.deepEqual(extractEditorialCandidates(`<a href="/cdn-cgi/l/email-protection#${enc('sales@journal.example')}">x</a>`,contact,ctx),[],'wrong departments stay excluded');
});

test('a mailto link takes its context from the page text, not from the markup around it',()=>{
  const html=`<p>Article submissions and editorial questions:</p>${'<div class="wrapper-with-a-long-class-name"><span></span></div>'.repeat(8)}<a href="mailto:team@journal.example">Write to us</a>`;
  const [c]=extractEditorialCandidates(html,contact,ctx);
  assert.equal(c.email,'team@journal.example');assert.equal(c.role,'published_editorial_route');assert.equal(c.rank,70);
  // The published address is part of what the reader sees: an editor@ link is an editorial inbox even behind "mail".
  const [e]=extractEditorialCandidates('<a href="mailto:editor@journal.example">mail</a>',contact,ctx);
  assert.equal(e.role,'editorial');
  assert.deepEqual(extractEditorialCandidates('<p>No unsolicited pitches.</p><a href="mailto:editor@journal.example">mail</a>',contact,ctx),[],'do-not-pitch still wins');
});

test('schema.org email: Organization, Person and ContactPoint on the publisher\'s own domain only',()=>{
  const org=ld({'@context':'https://schema.org','@type':'Organization',name:'Trail Blog',email:'mailto:editor@trailblog.com',contactPoint:{'@type':'ContactPoint',email:'hello@trailblog.com'}});
  // Second-look fixture 1 (rejected by the old gate, which stripped scripts first): now first-party and accepted.
  const home=extractEditorialCandidates(`<html><head>${org}</head><body><p>No address in the text.</p></body></html>`,'https://trailblog.com/',{domain:'trailblog.com',source:'page',now});
  assert.deepEqual(home.map(c=>[c.email,c.rank,c.method]),[['editor@trailblog.com',85,'structured_data']],'a general inbox needs the contact page');
  const onContact=extractEditorialCandidates(`<html><head>${org}</head><body></body></html>`,'https://trailblog.com/contact/',{domain:'trailblog.com',source:'contact',now});
  assert.deepEqual(onContact.map(c=>[c.email,c.rank]),[['editor@trailblog.com',95],['hello@trailblog.com',60]]);
  const person=ld({'@type':'Article',author:{'@type':'Person',name:'Jane Smith',email:'jane.smith@journal.example'}});
  const [a]=extractEditorialCandidates(person,'https://journal.example/post/',{domain:'journal.example',source:'page',author:'Jane Smith',now});
  assert.equal(a.role,'named_author');assert.equal(a.rank,100);
  for(const bad of [
    ld({'@type':'Organization',url:'https://other.example/',email:'editor@journal.example'}), // a node about another organisation
    ld({'@type':'Organization',email:'editor@other.example'}),ld({'@type':'Person',name:'Jane Smith',email:'jane.smith@gmail.com'}), // not the publisher's domain
    ld({'@type':'Product',email:'editor@journal.example'}),`<!-- ${ld({'@type':'Organization',email:'editor@journal.example'})} -->`,
    `<p>We do not accept guest posts or pitches.</p>${ld({'@type':'Organization',email:'editor@journal.example'})}`])
    assert.deepEqual(extractEditorialCandidates(bad,contact,{...ctx,author:'Jane Smith'}),[],bad);
  assert.equal(structuredEmails('<script type="application/ld+json">{broken</script>','journal.example').length,0);
});

test('one page-kind rule for the send gate and contact discovery, with the extra contact page names',()=>{
  for(const p of ['/contact.html','/contactus','/contact_us/','/about-us.html','/aboutus','/our-team/','/meet-the-team','/masthead/','/editorial-team/','/contact','/about-me/'])
    assert.equal(pageKind('https://x.com'+p),'contact',p);
  for(const p of ['/author/jane-doe/','/authors/jane','/writers/sam/','/contributors/lee'])assert.equal(pageKind('https://x.com'+p),'author',p);
  for(const p of ['/blog/post','/author/','/contact-lens-guide/','/about-aloe-vera','/teamwork','/impressum','/kontakt'])assert.equal(pageKind('https://x.com'+p),'page',p);
  assert.equal(pageKind('not a url'),'page');
  assert.ok(CONTACT_PAGE.test('/meet-the-team/'));
});

test('second-look fixtures: the structured-data address now reaches ready; first-name and impressum addresses stay held',async()=>{
  const org=ld({'@type':'Organization',name:'Trail Blog',email:'editor@trailblog.com'});
  const fetched=[];
  const c=await findContact('https://trailblog.com/best-trail-shoes',article(org),{fetchImpl:async u=>{fetched.push(u);return resp('<html><body><h1>Trail Blog</h1></body></html>')}});
  assert.equal(c.email,'editor@trailblog.com');assert.equal(c.email_rank,85);assert.equal(contactStatus(c),'ready');
  assert.equal(fetched.length,1,'an editorial address on the article itself ends the search after the homepage');
  // First name only (owner decision pending) and a German role address on an impressum page: not relaxed by this change.
  assert.deepEqual(extractEditorialCandidates('<h1>Maria Lopez</h1><p>Write to me: maria@trailblog.com</p>','https://trailblog.com/author/maria-lopez/',{domain:'trailblog.com',source:'author',author:'Maria Lopez'}),[]);
  assert.deepEqual(extractEditorialCandidates('<h1>Impressum</h1><p>E-Mail: redaktion@laufblog.de</p>','https://laufblog.de/impressum/',{domain:'laufblog.de',source:pageKind('https://laufblog.de/impressum/')}),[]);
});

test('the parser is country-agnostic: a .de editorial inbox passes exactly like a .com one (the DACH hold is the verifier\'s)',()=>{
  const html='<p>Editorial submissions: editor@laufblog.de</p>';
  const de=extractEditorialCandidates(html,'https://laufblog.de/contact/',{domain:'laufblog.de',source:'contact',now});
  const com=extractEditorialCandidates(html.replace('.de','.com'),'https://laufblog.com/contact/',{domain:'laufblog.com',source:'contact',now});
  assert.deepEqual(de.map(c=>[c.rank,c.role]),com.map(c=>[c.rank,c.role]));assert.equal(de[0].rank,95);
  const imp='<h1>Impressum</h1><p>E-Mail: redaktion@laufblog.com</p>';
  assert.deepEqual(extractEditorialCandidates(imp,'https://laufblog.com/impressum/',{domain:'laufblog.com',source:'page'}),[],'language-based, not TLD-based');
});

test('contact discovery picks the address through the send gate: ready always means the gate would accept it',async()=>{
  const sites={
    'a.example':{'/post':'<p>Questions? info@a.example</p>','/contact':'<p>Editorial: editor@a.example</p>'},
    'b.example':{'/post':'<p>Questions? info@b.example</p>'},
    'c.example':{'/post':'<p>x</p>','/contact-us':'<p>Say hello: hello@c.example</p>','/about':'<p>Founder Kim Park, kim.park@c.example</p>'},
    'd.example':{'/post':'<p>x</p>','/about':'<p>Me: sam@d.example</p>'}};
  const page=(u)=>{const x=new URL(u),body=sites[x.hostname]?.[x.pathname.replace(/\/$/,'')];return body};
  const v=new RecipientVerifier({state:{},env:{},now:()=>now,fetchPage:async u=>{const b=page(u);return b?{status:200,url:u,body:b}:{status:404,url:u,body:''}},resolveMx:async()=>[]});
  const out={};
  for(const d of Object.keys(sites)){
    const c=await findContact(`https://${d}/post`,page(`https://${d}/post`),{fetchImpl:async u=>{const b=page(u);return b?resp(b):resp('nf',{status:404})}});
    out[d]=c;
    if(c.email){const r=await v.verify({domain:d,page_url:`https://${d}/post`,email:c.email,email_source:c.email_source,history:[]},{screenOnly:true});
      assert.equal(r.ok,true,d);assert.equal(r.email,c.email,d)}
  }
  assert.equal(out['a.example'].email,'editor@a.example');
  assert.equal(out['b.example'].email,null);assert.equal(out['b.example'].held_email,'info@b.example','a general inbox on an article page is held, not queued');
  assert.equal(out['c.example'].email,'hello@c.example','a general inbox on the contact page is the last resort');
  assert.equal(out['d.example'].email,null);assert.equal(contactStatus(out['d.example']),'contact_unverifiable');
  const f=contactFields(out['d.example'],'2026-11-27T09:00:00.000Z');
  assert.equal(f.email,'sam@d.example');assert.equal(f.contact_quality.detail,'only_non_editorial_inbox_published');assert.equal(f.screen_v,POLICY_VERSION);
  assert.ok(!('held_email' in f));
});

test('the address source page failing to load is our side; a removed page is the publisher\'s',async()=>{
  const p={domain:'pub.example',page_url:'https://pub.example/guide',email:'editor@pub.example',email_source:'https://pub.example/write-for-us',history:[]};
  const mk=missing=>new RecipientVerifier({state:{},env:{},now:()=>now,resolveMx:async()=>[],
    fetchPage:async u=>u===p.email_source?missing:{status:200,url:u,body:'<p>Our guides.</p>'}});
  assert.equal((await mk({status:0,error:'timeout',url:p.email_source}).verify(p,{screenOnly:true})).detail,'email_source_unreachable');
  assert.equal((await mk({status:503,url:p.email_source}).verify(p,{screenOnly:true})).detail,'email_source_unreachable');
  assert.equal((await mk({status:404,url:p.email_source}).verify(p,{screenOnly:true})).detail,'no_email_published');
});

test('policy v2: proofs made under the previous rules are re-verified, never reused',()=>{
  assert.equal(POLICY_VERSION,2);
  const data={data:{email:'editor@journal.example',status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}};
  const v=hunterVerdict(data,'editor@journal.example',now);
  assert.equal(usableVerification(v,'editor@journal.example',now),true);
  assert.equal(usableVerification({...v,policy_version:1},'editor@journal.example',now),false);
});

test('blog comment, reply and newsletter forms are not contact forms',()=>{
  assert.equal(contactForm('<form action="/contact" method="post"><input name="name"><textarea name="message"></textarea></form>'),true);
  for(const f of ['<form action="https://x.com/wp-comments-post.php" id="commentform" class="comment-form"><textarea name="comment"></textarea></form>',
    '<form method="post"><textarea id="comment" name="comment"></textarea><input type="hidden" name="comment_post_ID" value="1"></form>',
    '<form class="newsletter"><textarea></textarea></form>','<form><input name="q"></form>','<form id="reply-form"><textarea name="reply"></textarea></form>'])
    assert.equal(contactForm(f),false,f);
  assert.equal(contactForm('<form id="commentform"><textarea name="comment"></textarea></form><form action="/contact"><textarea name="msg"></textarea></form>'),true,'a real form after a comment form still counts');
});
