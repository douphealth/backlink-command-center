import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {seal,open} from '../../scripts/autopilot/vault.mjs';
import {extractEmails,rankEmail,decodeCfEmail,normUrl,keyPhrase} from '../../scripts/autopilot/util.mjs';
import {discoverSite,extractFeatures,crawlable} from '../../scripts/autopilot/crawl.mjs';
import {rankPortfolio,internalLinkPlan,linkability} from '../../scripts/autopilot/score.mjs';
import {qualifyPage,queriesFor,BLOCKED} from '../../scripts/autopilot/prospect.mjs';
import {DataForSEO} from '../../scripts/autopilot/dataforseo.mjs';
import {smtpSend,Imap,parseFetch,classifyReply,buildMessage} from '../../scripts/autopilot/mail.mjs';
import {runOutreach,processReplies,checkLinks,dailyCap} from '../../scripts/autopilot/outreach.mjs';
import {templatePitch,validPitch} from '../../scripts/autopilot/pitch.mjs';
import {runAutopilot,chooseAssets} from '../../scripts/autopilot/run.mjs';

const html=(body,{title='T',extra=''}={})=>`<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${extra}">${''}</head><body>${body}</body></html>`;
const resp=(body,{status=200,type='text/html; charset=utf-8',headers={}}={})=>new Response(body,{status,headers:{'content-type':type,...headers}});
const words=n=>Array.from({length:n},(_,i)=>['mice','home','seal','gaps','traps','garage','safe','plan'][i%8]).join(' ');

test('vault round-trips and rejects the wrong key',async()=>{
  const box=await seal({a:1,emails:['x@y.com']},'k'.repeat(24));
  assert.equal(box.alg,'AES-256-GCM');assert.ok(!JSON.stringify(box).includes('x@y.com'));
  assert.deepEqual(await open(box,'k'.repeat(24)),{a:1,emails:['x@y.com']});
  await assert.rejects(open(box,'z'.repeat(24)),/wrong LINKFORGE_DATA_KEY/);
  await assert.rejects(seal({},'short'),/at least 16/);
});

test('email extraction decodes Cloudflare protection and obfuscation, drops junk',()=>{
  const key=0x42,enc=s=>key.toString(16)+[...s].map(c=>(c.charCodeAt(0)^key).toString(16).padStart(2,'0')).join('');
  assert.equal(decodeCfEmail(enc('editor@site.com')),'editor@site.com');
  const found=extractEmails(`<a class="__cf_email__" data-cfemail="${enc('editor@site.com')}">[email]</a> jane [at] site [dot] com <a href="mailto:noreply@site.com">x</a> logo@2x.png privacy@site.com`);
  assert.ok(found.includes('editor@site.com'));assert.ok(found.includes('jane@site.com'));
  assert.ok(!found.some(e=>/noreply|privacy|png/.test(e)));
  assert.ok(rankEmail('editor@site.com','site.com')>rankEmail('support@site.com','site.com'));
  assert.equal(rankEmail('someone@other-company.com','site.com'),-1);
});

test('sitemap discovery follows robots + indexes, keeps original URLs for fetching',async()=>{
  const map={
    'https://ex.com/robots.txt':resp('Sitemap: https://ex.com/idx.xml',{type:'text/plain'}),
    'https://ex.com/idx.xml':resp('<sitemapindex><sitemap><loc>https://ex.com/post-sitemap.xml</loc></sitemap><sitemap><loc>https://ex.com/category-sitemap.xml</loc></sitemap></sitemapindex>',{type:'application/xml'}),
    'https://ex.com/post-sitemap.xml':resp('<urlset><url><loc>https://ex.com/guide/</loc><lastmod>2026-09-01</lastmod></url><url><loc>https://ex.com/tag/x/</loc></url><url><loc>https://ex.com/privacy-policy/</loc></url></urlset>',{type:'application/xml'}),
  };
  const seen=[];
  const f=async url=>{seen.push(url);return map[url]?.clone()??resp('nope',{status:404})};
  const r=await discoverSite({domain:'ex.com',assets:[]},{fetchImpl:f});
  assert.deepEqual(r.urls.map(x=>x.url),['https://ex.com/guide']);
  assert.equal(r.urls[0].fetch,'https://ex.com/guide/');
  assert.ok(!seen.includes('https://ex.com/category-sitemap.xml'),'taxonomy sitemaps skipped');
  assert.ok(crawlable('https://ex.com/about-running-shoes/','ex.com'),'only exact about pages are skipped');
  assert.ok(!crawlable('https://ex.com/about-us/','ex.com'));
});

test('feature extraction ignores newsletter forms and counts real tools',()=>{
  const page=html(`<main><h1>Calc</h1><form><input type="email" name="e"><input type="text" name="name"><button>Subscribe</button></form>${'<p>'+words(500)+'</p>'}</main>`);
  assert.equal(extractFeatures('https://ex.com/a',page,'ex.com').interactive,false);
  const tool=html(`<main><h1>Calc</h1><input type="number"><input type="number"><select></select><p>${words(400)}</p></main>`);
  assert.equal(extractFeatures('https://ex.com/a',tool,'ex.com').interactive,true);
});

test('ranking demotes templated siblings and thin pages; plans internal links',()=>{
  const base=(url,o={})=>({site:'ex.com',url,final_url:url,status:200,technical_status:'technically_eligible',title:'How to get rid of mice in garage',h1:'How to get rid of mice in garage',words:1500,h2_count:6,tables:1,lists:3,images:4,internal_links:[],terms:['mice','garage','rid','rid mice','get rid'],...o});
  const pages=[base('https://ex.com/hub',{title:'Rid mice hub guide'}),base('https://ex.com/thin',{words:120,title:'Thin page'}),
    ...Array.from({length:8},(_,i)=>base(`https://ex.com/compare/a-vs-${i}`,{title:`A vs ${i} comparison`}))];
  const ranked=rankPortfolio([{site:'ex.com',pages}]);
  const siblings=ranked.filter(a=>a.url.includes('/compare/'));
  assert.equal(siblings.filter(a=>a.reasons.some(r=>r.includes('templated'))).length,6);
  assert.ok(linkability(base('x',{words:120})).score<linkability(base('x')).score-15);
  const plan=internalLinkPlan([{site:'ex.com',pages}],ranked);
  assert.ok(plan.length>0&&plan.every(s=>s.from!==s.to));
});

test('prospect qualification detects existing links, stores and topical fit',()=>{
  const site={domain:'mice.com',topic:'mouse proofing home'},asset={title:'How to Get Rid of Mice: Safe Home Plan',url:'https://mice.com/plan'};
  const outs=Array.from({length:8},(_,i)=>`<a href="https://ref${i}.org/x">r${i}</a>`).join('');
  const good=qualifyPage('https://blog.org/pest-resources',html(`<h1>Mouse proofing resources</h1><h2>Keep mice out of your home</h2><p>${words(600)} mouse proofing home rid</p>${outs}`,{title:'Pest control resources for your home'}),{asset,site,ourDomains:['mice.com']});
  assert.equal(good.qualified,true);assert.equal(good.resource_page,true);
  const linked=qualifyPage('https://blog.org/p',html(`<p>${words(400)}</p><a href="https://www.mice.com/plan">plan</a>${outs}`),{asset,site,ourDomains:['mice.com']});
  assert.ok(linked.linksToUs);
  const shop=qualifyPage('https://shop.org/p',html(`<p>${words(600)}</p><button>Add to cart</button>${outs}`),{asset,site,ourDomains:['mice.com']});
  assert.equal(shop.qualified,false);
  assert.ok(BLOCKED.test('reddit.com')&&BLOCKED.test('m.facebook.com')&&!BLOCKED.test('runnersblog.com'));
  assert.ok(queriesFor({...asset,type:'practical_guide'},site).length>=4);
});

test('DataForSEO client enforces caps, records cost and parks forbidden endpoints',async()=>{
  const state={};let calls=0;
  const f=async(url)=>{calls++;if(url.includes('relevant_pages'))return resp(JSON.stringify({status_code:20000,cost:0,tasks:[{status_code:40204,status_message:'Access denied'}]}),{type:'application/json'});
    return resp(JSON.stringify({status_code:20000,cost:0.004,tasks:[{status_code:20000,result:[{items:[{type:'organic',url:'https://a.com/x',domain:'a.com',title:'A'}]}]}]}),{type:'application/json'})};
  const dfs=new DataForSEO({login:'l',password:'p',state,dailyUsd:0.01,monthlyUsd:1,fetchImpl:f});
  assert.equal((await dfs.serp('q')).length,1);
  await dfs.serp('q2');
  assert.equal(await dfs.serp('q3').then(r=>r.length),0,'daily cap reached');
  assert.equal(calls,2);assert.ok(Math.abs(dfs.spend('day')-0.008)<1e-9);
  assert.equal(await dfs.relevantPages('a.com').then(()=>dfs.canSpend('relevant_pages')),false,'forbidden endpoint parked');
});

class FakeSmtp extends EventEmitter{
  constructor(){super();this.lines=[];setImmediate(()=>this.emit('data','220 ready\r\n'))}
  setEncoding(){}
  write(s){this.lines.push(s);const r=s.startsWith('EHLO')?'250-hi\r\n250 AUTH PLAIN\r\n':s.startsWith('AUTH')?'235 ok\r\n':s.startsWith('MAIL')||s.startsWith('RCPT')?'250 ok\r\n':s.startsWith('DATA')?'354 go\r\n':s.startsWith('QUIT')?'221 bye\r\n':s.endsWith('\r\n.\r\n')?'250 queued\r\n':'';if(r)setImmediate(()=>this.emit('data',r))}
  end(){}
}
test('SMTP client authenticates, dot-stuffs and confirms delivery',async()=>{
  const sock=new FakeSmtp();
  const raw=buildMessage({from:'me@gmail.com',fromName:'Alex',to:'ed@pub.com',subject:'Résumé tool',text:'.leading dot\nline',messageId:'<lf-1@gmail.com>'});
  const r=await smtpSend({user:'me@gmail.com',pass:'pw',from:'me@gmail.com',to:'ed@pub.com',raw,connect:()=>sock});
  assert.equal(r.accepted,true);
  assert.ok(sock.lines.some(l=>l.startsWith('AUTH PLAIN '+Buffer.from('\0me@gmail.com\0pw').toString('base64'))));
  assert.ok(raw.includes('Subject: =?UTF-8?B?'),'non-ASCII subject encoded');
});

test('IMAP fetch parsing and reply classification',()=>{
  const raw='* 1 FETCH (UID 5 BODY[HEADER.FIELDS (FROM SUBJECT IN-REPLY-TO REFERENCES AUTO-SUBMITTED)] {80}\r\nFrom: Ed <ed@pub.com>\r\nSubject: Re: tool\r\nIn-Reply-To: <lf-abc@gmail.com>\r\n\r\n BODY[TEXT]<0> {20}\r\nAdded it, thanks!\r\n)\r\n';
  const [m]=parseFetch(raw);
  assert.equal(m.from,'ed@pub.com');assert.equal(m.inReplyTo,'<lf-abc@gmail.com>');
  assert.equal(classifyReply(m),'positive');
  assert.equal(classifyReply({...m,body:'Please remove me from your list'}),'negative');
  assert.equal(classifyReply({from:'mailer-daemon@googlemail.com',subject:'Delivery Status Notification',body:''}),'bounce');
  assert.equal(classifyReply({from:'a@b.com',subject:'Automatic reply: away',body:'',autoSubmitted:''}),'auto');
});

test('outreach respects warm-up, dedupes domains, honours opt-outs and follows up once',async()=>{
  const asset={url:'https://mice.com/plan',title:'Plan',type:'practical_guide',description:'A plan.'};
  const prospects={};
  for(let i=0;i<9;i++)prospects['p'+i]={id:'p'+i,site:'mice.com',domain:i===8?'dup0.org':`pub${i}.org`,email:`ed@pub${i}.org`,status:'ready',score:i===8?99:90-i,asset_url:asset.url,page_url:`https://pub${i}.org/r`,title:'Resources',history:[]};
  const state={prospects,contacted:{'dup0.org':new Date().toISOString()},suppression:{'pub1.org':{reason:'x'}}};
  const sent=[];const mailer={send:async m=>sent.push(m),draft:async()=>{}};
  const writer={write:async(p,a,s)=>templatePitch(p,a,{senderName:'Alex',site:s})};
  const config={mode:'send',fromAddress:'me@gmail.com',senderName:'Alex',dailyLimit:20,followupDays:6,gapMs:()=>0};
  const stats=await runOutreach({state,assets:[asset],sites:[{domain:'mice.com',topic:'mice'}],writer,mailer,config});
  assert.equal(dailyCap({},20),5);
  assert.equal(stats.sent,5,'warm-up cap on day one');
  assert.ok(!sent.some(m=>m.to==='ed@pub1.org'),'suppressed domain skipped');
  assert.equal(prospects.p8.status,'skipped_duplicate');
  assert.ok(sent.every(m=>m.raw.includes('List-Unsubscribe')));
  // Age the first pitch past the follow-up window and simulate a reply on another.
  prospects.p0.history[0].at=new Date(Date.now()-7*864e5).toISOString();
  prospects.p2.history[0].at=new Date(Date.now()-7*864e5).toISOString();
  const imap={recentHeaders:async()=>[{from:'ed@pub2.org',subject:'Re: x',inReplyTo:prospects.p2.history[0].message_id,references:'',body:'not interested, please stop',autoSubmitted:''}]};
  const r=await processReplies({state,imap});
  assert.equal(r.negative,1);assert.ok(state.suppression['pub2.org']);
  sent.length=0;state.first_send_at=new Date(Date.now()-864e5).toISOString();
  await runOutreach({state,assets:[asset],sites:[{domain:'mice.com',topic:'mice'}],writer,mailer,config});
  const followups=sent.filter(m=>m.raw.includes('In-Reply-To'));
  assert.equal(followups.length,1);assert.equal(followups[0].to,'ed@pub0.org');
  assert.equal(prospects.p0.status,'followed_up');
});

test('link checks mark wins from the live page',async()=>{
  const state={prospects:{a:{id:'a',status:'sent',page_url:'https://pub.org/r',history:[{type:'initial',at:new Date(Date.now()-10*864e5).toISOString()}]}}};
  const f=async()=>resp(html('<a href="https://www.mice.com/plan" rel="nofollow">mouse plan</a>'));
  const r=await checkLinks({state,ourDomains:['mice.com'],fetchImpl:f});
  assert.equal(r.won,1);assert.equal(state.prospects.a.status,'won');assert.equal(state.prospects.a.won.rel,'nofollow');
});

test('pitch validation rejects foreign URLs and placeholders',()=>{
  const asset={url:'https://mice.com/plan'};
  const body='Hi there, '+'x'.repeat(220)+' https://mice.com/plan thanks';
  assert.equal(validPitch({subject:'A resource for your page',body},asset),true);
  assert.equal(validPitch({subject:'A resource for your page',body:body+' https://evil.com'},asset),false);
  assert.equal(validPitch({subject:'A resource for your page',body:body.replace('Hi there','Hi [Name]')},asset),false);
  const t=templatePitch({id:'x',title:'Pest resources',fit_section:'Prevention'},{...asset,title:'Plan',type:'interactive_tool',interactive:true},{senderName:'Alex',site:{domain:'mice.com',topic:'mice'}});
  assert.equal((t.body.match(/https:\/\/mice\.com\/plan/g)||[]).length,1);
});

test('full autopilot cycle with mocked network publishes a clean summary',async()=>{
  const sites=new Map();
  const f=async url=>{
    const u=new URL(url);
    if(u.pathname==='/robots.txt')return resp('',{status:404});
    if(u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${u.hostname}/guide/</loc></url><url><loc>https://${u.hostname}/tool/</loc></url></urlset>`,{type:'application/xml'});
    if(/\.xml$/.test(u.pathname))return resp('',{status:404});
    sites.set(u.hostname,true);
    return resp(html(`<main><h1>${u.pathname} guide</h1><h2>Section</h2><p>${words(900)}</p><a href="https://${u.hostname}/guide/">g</a><a href="https://cdc.gov/x">c</a></main>`,{title:'Complete guide to mouse proofing'}));
  };
  const {summary}=await runAutopilot({env:{SENDER_NAME:'Alex'},argv:[],fetchImpl:f,write:false,useCache:false});
  assert.equal(summary.stages.crawl.ok,true);
  assert.ok(summary.totals.pages_crawled>=10);
  assert.ok(summary.best_urls.length>0);
  assert.equal(summary.stages.prospects.ok,null,'private stages skipped without a vault key');
  assert.ok(!/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(JSON.stringify(summary)),'no email in public summary');
  assert.ok(summary.setup.some(x=>x.key==='LINKFORGE_DATA_KEY'&&!x.done));
  assert.ok(chooseAssets(summary.best_urls,{}).length>0);
});

test('URL helpers',()=>{
  assert.equal(normUrl('HTTPS://Ex.com/a/?utm_source=x#h'),'https://ex.com/a');
  assert.equal(keyPhrase('How to Get Rid of Mice: Safe Home Plan | Mice Gone'),'rid mice');
});

const BS=String.fromCharCode(92);
class FakeImap extends EventEmitter{
  constructor(){super();this.got=[];this.pending=null;setImmediate(()=>this.emit('data','* OK Gimap ready\r\n'))}
  setEncoding(){}
  write(s){
    if(this.pending){this.got.push('LITERAL:'+s.length);const tag=this.pending;this.pending=null;return setImmediate(()=>this.emit('data',`${tag} OK APPEND completed\r\n`))}
    this.got.push(s);const [tag,cmd]=s.trim().split(' ');let out='';
    if(cmd==='LOGIN')out=`${tag} OK logged in\r\n`;
    else if(cmd==='LIST')out=`* LIST (${BS}HasNoChildren) "/" "INBOX"\r\n* LIST (${BS}Drafts ${BS}HasNoChildren) "/" "[Gmail]/Entw&APw-rfe"\r\n${tag} OK done\r\n`;
    else if(cmd==='APPEND'){this.pending=tag;out='+ go ahead\r\n'}
    else if(cmd==='SELECT')out=`* 3 EXISTS\r\n${tag} OK [READ-WRITE] selected\r\n`;
    else if(cmd==='UID'&&s.includes('SEARCH'))out=`* SEARCH 7 9\r\n${tag} OK done\r\n`;
    else if(cmd==='UID'&&s.includes('FETCH'))out=`* 1 FETCH (UID 7 BODY[HEADER.FIELDS (FROM SUBJECT IN-REPLY-TO REFERENCES AUTO-SUBMITTED)] {40}\r\nFrom: <ed@pub.com>\r\nSubject: Re: hi\r\n\r\n BODY[TEXT]<0> {6}\r\nthanks)\r\n${tag} OK done\r\n`;
    else if(cmd==='LOGOUT')out=`* BYE\r\n${tag} OK bye\r\n`;
    setImmediate(()=>this.emit('data',out));
  }
  end(){}
}
test('IMAP session saves drafts to the special-use Drafts box and reads replies',async()=>{
  const sock=new FakeImap();
  const imap=await new Imap({user:'me@gmail.com',pass:'p"w',connect:()=>sock}).open();
  assert.ok(sock.got[0].includes('LOGIN "me@gmail.com" "p\\"w"'),'credentials quoted');
  const box=await imap.appendDraft('From: a\r\n\r\nbody');
  assert.equal(box,'[Gmail]/Entw&APw-rfe');
  assert.ok(sock.got.some(l=>l.startsWith('LITERAL:')));
  const msgs=await imap.recentHeaders(new Date('2026-10-01T00:00:00Z'));
  assert.ok(sock.got.some(l=>l.includes('UID SEARCH SINCE 01-Oct-2026')));
  assert.equal(msgs[0].from,'ed@pub.com');
  await imap.close();
});

test('engine refuses a wrong vault key but starts fresh after a dashboard key reset',async()=>{
  const f=async url=>{const u=new URL(url);if(u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${u.hostname}/guide/</loc></url></urlset>`,{type:'application/xml'});
    if(/\.(xml|txt)$/.test(u.pathname))return resp('',{status:404});return resp(html(`<main><h1>Guide</h1><p>${words(900)}</p></main>`,{title:'Mouse proofing guide'}))};
  const sealed=await seal({prospects:{}},'old-key-'.repeat(3));
  const fs=await import('node:fs');const path='public/data/vault.json';const original=fs.existsSync(path)?fs.readFileSync(path,'utf8'):null;
  fs.writeFileSync(path,JSON.stringify(sealed));
  try{
    const wrong=await runAutopilot({env:{LINKFORGE_DATA_KEY:'new-key-'.repeat(3)},argv:[],fetchImpl:f,write:false,useCache:false});
    assert.equal(wrong.summary.capabilities.vault,false);
    const reset=await runAutopilot({env:{LINKFORGE_DATA_KEY:'new-key-'.repeat(3),LINKFORGE_VAULT_RESET_AT:new Date(Date.now()+1000).toISOString()},argv:[],fetchImpl:f,write:false,useCache:false});
    assert.equal(reset.summary.capabilities.vault,true);
  }finally{original==null?fs.unlinkSync(path):fs.writeFileSync(path,original)}
});
