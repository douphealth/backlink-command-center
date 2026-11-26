import test from 'node:test';
import assert from 'node:assert/strict';
import {extractEmails} from '../../scripts/autopilot/util.mjs';
import {findContact,recontact,CONTACT_VERSION} from '../../scripts/autopilot/prospect.mjs';

const resp=(body,{status=200,type='text/html; charset=utf-8'}={})=>new Response(body,{status,headers:{'content-type':type}});
const article=extra=>`<html><head><title>Best trail shoes</title></head><body><article><h1>Best trail shoes</h1><p>${'Trail running advice. '.repeat(80)}</p>${extra||''}</article></body></html>`;
const site=pages=>async url=>{const u=new URL(url);const body=pages[u.pathname.replace(/\/$/,'')||'/'];return body?resp(body):resp('not found',{status:404})};

test('an address published only as schema.org structured data is read',()=>{
  const html=`<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Trail Blog","email":"mailto:editor@trailblog.com","contactPoint":{"@type":"ContactPoint","email":"hello@trailblog.com"}}</script></head><body><p>No address in the text.</p></body></html>`;
  assert.deepEqual(extractEmails(html).sort(),['editor@trailblog.com','hello@trailblog.com']);
  assert.deepEqual(extractEmails('<script>var cfg={"email":"tracking@vendor.io"}</script><p>nothing</p>'),[],'only ld+json blocks count, not arbitrary scripts');
});

test('contact discovery follows the author page and an impressum page',async()=>{
  const byAuthor=await findContact('https://trailblog.com/best-trail-shoes',article('<p>By <a href="/author/maria-lopez/">Maria Lopez</a></p>'),{author:'Maria Lopez',fetchImpl:site({
    '/':'<html><body><h1>Trail Blog</h1><p>Stories from the trail.</p></body></html>',
    '/author/maria-lopez':'<html><body><h1>Maria Lopez</h1><p>Write to me: maria@trailblog.com</p></body></html>'})});
  assert.equal(byAuthor.email,'maria@trailblog.com');assert.match(byAuthor.email_source,/author\/maria-lopez/);
  const german=await findContact('https://laufblog.de/trailschuhe',article(),{fetchImpl:site({
    '/':'<html><body><h1>Laufblog</h1><footer><a href="/impressum/">Impressum</a></footer></body></html>',
    '/impressum':'<html><body><h1>Impressum</h1><p>E-Mail: redaktion@laufblog.de</p></body></html>'})});
  assert.equal(german.email,'redaktion@laufblog.de');
});

test('second look: a qualified page without an address is promoted when one is found, and never demoted',async()=>{
  const pages={
    'https://found.com/guide':article(),'https://found.com/':'<html><body><h1>Found</h1><a href="/about/">About</a></body></html>','https://found.com/about':'<html><body><p>Say hello: hello@found.com</p></body></html>',
    'https://formonly.com/guide':article(),'https://formonly.com/':'<html><body><a href="/contact/">Contact</a></body></html>','https://formonly.com/contact':'<html><body><form><input name="n"><textarea></textarea></form></body></html>',
  };
  const fetchImpl=async url=>{const k=String(url).replace(/\/$/,'');const body=pages[k]??pages[k+'/'];return body?resp(body):/gone\.com/.test(url)?resp('down',{status:503}):resp('nf',{status:404})};
  const mk=(id,domain,status,extra={})=>({id,site:'gearuptofit.com',domain,page_url:`https://${domain}/guide`,status,score:50,...extra});
  const state={prospects:{a:mk('a','found.com','no_contact'),b:mk('b','formonly.com','no_contact'),c:mk('c','gone.com','contact_form',{contact_form:'https://gone.com/contact'}),
    d:mk('d','sent.com','sent',{email:'x@sent.com'}),e:mk('e','recent.com','no_contact',{contact_v:CONTACT_VERSION,contact_checked_at:new Date().toISOString()})}};
  const logs=[];
  const stats=await recontact({state,fetchImpl,log:m=>logs.push(m)});
  assert.deepEqual(stats,{checked:3,found:1,unreachable:1,waiting:0});
  const {a,b,c,d,e}=state.prospects;
  assert.equal(a.status,'ready');assert.equal(a.email,'hello@found.com');assert.ok(a.recontacted_at);assert.equal(a.contact_v,CONTACT_VERSION);
  assert.equal(b.status,'contact_form','a contact form found on the second look is recorded');assert.equal(b.email,undefined);
  assert.equal(c.status,'contact_form','an unreachable page changes nothing');assert.equal(c.contact_form,'https://gone.com/contact');
  assert.equal(d.status,'sent');assert.equal(e.contact_checked_at.slice(0,10),new Date().toISOString().slice(0,10));
  assert.match(logs[0],/second look: 3 qualified pages without an address re-checked, 1 now have one/);
  // Nothing is due straight afterwards.
  assert.equal((await recontact({state,fetchImpl})).checked,0);
  // The per-cycle limit leaves the rest for later cycles, best score first.
  const many={prospects:Object.fromEntries(Array.from({length:5},(_,i)=>[`p${i}`,mk(`p${i}`,'found.com','no_contact',{score:i})]))};
  const part=await recontact({state:many,fetchImpl,max:2});
  assert.equal(part.checked,2);assert.equal(part.waiting,3);assert.equal(many.prospects.p4.status,'ready');assert.equal(many.prospects.p0.status,'no_contact');
});
