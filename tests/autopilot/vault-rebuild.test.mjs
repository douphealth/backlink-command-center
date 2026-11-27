import test from 'node:test';
import assert from 'node:assert/strict';
import {rebuildFromMailbox,requireRebuild,rebuildHold,linkRestoredSends,REBUILD} from '../../scripts/autopilot/rebuild.mjs';
import {Imap} from '../../scripts/autopilot/mail.mjs';
import {isSuppressed} from '../../scripts/autopilot/recipient-policy.mjs';
import {runOutreach} from '../../scripts/autopilot/outreach.mjs';
import {QUALIFY_VERSION} from '../../scripts/autopilot/prospect.mjs';
import {runAutopilot} from '../../scripts/autopilot/run.mjs';

const NOW_MS=Date.parse('2026-11-27T12:00:00Z');
const at=days=>new Date(NOW_MS-days*86400e3).toISOString();
const EMAIL=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const SELF='owner@sender.example';

const SENT=[
  {to:'ed@pub.com',at:at(20),message_id:'<lf-a@sender.example>'},
  {to:'ed@pub.com',at:at(200),message_id:'<lf-old@sender.example>'},
  {to:'blogger@gmail.com',at:at(10),message_id:'<lf-b@sender.example>'},
  {to:'editor@quiet.org',at:at(5)},
  {to:SELF,at:at(1)},
];
const INBOX=[
  {uid:'1',from:'mailer-daemon@googlemail.com',subject:'Delivery Status Notification (Failure)',body:`Address not found\nYour message wasn't delivered to gone@dead.com because the address couldn't be found.\nMessage-ID: <lf-c@sender.example>\nFrom: ${SELF}`},
  {uid:'2',from:'mailer-daemon@googlemail.com',subject:'Delivery Status Notification (Delay)',body:'Delivery incomplete, will retry. Message to slow@later.com <lf-d@sender.example>'},
  {uid:'3',from:'blogger@gmail.com',subject:'Re: your guide',inReplyTo:'<lf-b@sender.example>',body:'Please remove me from your list.'},
  {uid:'4',from:'colleague@pub.com',subject:'Re: resource',body:'We are not interested, do not contact us again.'},
  {uid:'5',from:'news@random-newsletter.com',subject:'Weekly digest',body:'Great stories. Unsubscribe here.'},
  {uid:'6',from:'ed@pub.com',subject:'Re: your guide',inReplyTo:'<lf-a@sender.example>',body:'Sounds good, I will add it.'},
  {uid:'7',from:'editor@quiet.org',subject:'Automatic reply: away',autoSubmitted:'auto-replied',body:'Out of office. Unsubscribe'},
];
function fakeImap({sent=SENT,pages=[INBOX],failSent=false}={}){
  const calls={sent:[],inbox:[]};
  return {calls,
    sentRecipients:async(since,opts={})=>{calls.sent.push({since,...opts});if(failSent)throw Error('IMAP EXAMINE NO [Gmail]/Sent Mail unavailable');return Object.assign(sent.slice(),{complete:true})},
    recentHeaders:async(since,{cursor}={})=>{calls.inbox.push({since,cursor});const i=cursor?cursor.uid:0,page=pages[i]||[];
      return Object.assign(page.slice(),{complete:i>=pages.length-1,cursor:{mailbox:'[Gmail]/All Mail',uidvalidity:'9',uid:i+1}})}};
}
const fresh=()=>requireRebuild({prospects:{},domains:{},suppression:{},contacted:{}},'dashboard_reset',at(0));

test('a fresh vault restores contacted publishers and opt-outs from the mailbox, then lifts the hold',async()=>{
  const state=fresh(),imap=fakeImap(),logs=[];
  assert.ok(state.rebuild_required);assert.match(rebuildHold(state),/new vault: nothing is sent/);
  const r=await rebuildFromMailbox({state,imap,self:SELF,now:()=>NOW_MS,log:m=>logs.push(m)});
  assert.equal(r.complete,true);assert.equal(state.rebuild_required,undefined);assert.ok(state.rebuild.completed_at);assert.equal(rebuildHold(state),'');
  // ~400 days back on both mailboxes, read-only calls only.
  assert.equal(Date.parse(imap.calls.sent[0].since),NOW_MS-REBUILD.days*86400e3);assert.equal(Date.parse(imap.calls.inbox[0].since),NOW_MS-REBUILD.days*86400e3);
  // Sent: the newest email per publisher domain; free-mail and our own address never become a "domain".
  assert.equal(state.contacted['pub.com'],at(20));assert.equal(state.contacted['quiet.org'],at(5));
  assert.equal(state.contacted['gmail.com'],undefined);assert.equal(state.contacted['sender.example'],undefined);
  assert.equal(state.restored_sent['blogger@gmail.com'],at(10));assert.equal(state.restored_sent[SELF],undefined);
  // Bounce (ours by its message id, address older than the Sent pages): address suppressed, publisher kept from re-contact.
  assert.ok(isSuppressed(state,'gone@dead.com','dead.com'));assert.ok(state.contacted['dead.com']);
  assert.ok(!isSuppressed(state,'slow@later.com','later.com'),'a delay is not a failure');
  assert.ok(!isSuppressed(state,SELF,'sender.example'),'our own address is never suppressed');
  // Opt-outs: free-mail sender by address only; a colleague at a publisher we emailed suppresses the whole domain.
  assert.ok(isSuppressed(state,'blogger@gmail.com','someblog.example'));assert.ok(!isSuppressed(state,'someone@gmail.com','other.example'),'gmail.com is not suppressed as a domain');
  assert.ok(isSuppressed(state,'colleague@pub.com','pub.com'));assert.ok(isSuppressed(state,'ed@pub.com','pub.com'),'publisher domain suppressed');
  // Unrelated newsletters and auto-replies are not opt-outs.
  assert.ok(!isSuppressed(state,'news@random-newsletter.com','random-newsletter.com'));assert.ok(!isSuppressed(state,'editor@quiet.org','quiet.org'));
  assert.equal(r.bounces,1);assert.equal(r.opt_outs,2);assert.equal(r.replies,1);
  // The stage result and log are published: counts only.
  const pub=JSON.stringify(r)+logs.join('\n');assert.ok(!EMAIL.test(pub));assert.ok(!/pub\.com|gmail|dead\.com/.test(pub));
});

test('a free-mail recipient found again after the rebuild is linked to its publisher and not emailed within 90 days',async()=>{
  const state=fresh();await rebuildFromMailbox({state,imap:fakeImap(),self:SELF,now:()=>NOW_MS});
  state.prospects.p={id:'p',site:'s.com',domain:'someblog.example',email:'blogger@gmail.com',status:'ready',qv:QUALIFY_VERSION,history:[]};
  state.prospects.q={id:'q',site:'s.com',domain:'new.example',email:'ed@new.example',status:'ready',qv:QUALIFY_VERSION,history:[]};
  assert.equal(linkRestoredSends(state),2,'contacted date and the opt-out both reach the publisher');assert.equal(state.contacted['someblog.example'],at(10));assert.equal(state.contacted['new.example'],undefined);
  assert.ok(state.suppression['someblog.example'],'the free-mail blogger opted out: the whole blog is suppressed, as a matched reply would have done');
  assert.ok(!isSuppressed(state,'ed@new.example','new.example'));
  assert.equal(linkRestoredSends(state),0,'idempotent');
  // The existing 90-day rule in outreach then skips it.
  const sent=[];
  await runOutreach({state,assets:[],sites:[{domain:'s.com'}],writer:{write:async()=>({subject:'s',body:'b'})},mailer:{send:async m=>sent.push(m),draft:async()=>{}},
    config:{mode:'draft',dailyLimit:5,fromAddress:SELF,senderName:'Alex',gapMs:()=>0}});
  assert.equal(state.prospects.p.status,'skipped_duplicate');assert.equal(state.prospects.q.status,'drafted','an unrelated publisher is unaffected');assert.equal(sent.length,0);
});

test('the hold stays when the mailbox cannot be read, or not far enough back',async()=>{
  const state=fresh();
  await assert.rejects(rebuildFromMailbox({state,imap:fakeImap({failSent:true}),self:SELF,now:()=>NOW_MS}),/unavailable/);
  assert.ok(state.rebuild_required);
  await assert.rejects(rebuildFromMailbox({state,imap:{sentRecipients:async()=>null,recentHeaders:async()=>[]},now:()=>NOW_MS}),/Invalid Sent/);
  await assert.rejects(rebuildFromMailbox({state,imap:{sentRecipients:async()=>[]}}),/cannot read/);
  assert.ok(state.rebuild_required);
  // Sent folder truncated at 20 days and no way to page further back: the 90-day rule cannot be restored.
  const truncated={sentRecipients:async()=>Object.assign([{to:'ed@pub.com',at:at(20)}],{complete:false}),recentHeaders:async()=>Object.assign([],{complete:true})};
  const r=await rebuildFromMailbox({state,imap:truncated,now:()=>NOW_MS});
  assert.equal(r.complete,false);assert.match(r.why,/Sent folder/);assert.ok(state.rebuild_required);
  assert.match(rebuildHold(state,{ok:true,result:r}),/Sent folder/);
  assert.match(rebuildHold(state,{ok:false,error:'IMAP LOGIN NO'}),/could not be read: IMAP LOGIN NO/);
});

test('the Sent folder is paged back by whole days until it is complete',async()=>{
  const state=fresh(),calls=[];
  const imap={sentRecipients:async(since,{before}={})=>{calls.push(before||null);
      return before?Object.assign([{to:'old@pub.org',at:at(150)}],{complete:true}):Object.assign([{to:'ed@pub.com',at:'2026-10-01T09:30:00Z'},{to:'ed@pub.com',at:at(3)}],{complete:false})},
    recentHeaders:async()=>Object.assign([],{complete:true})};
  const r=await rebuildFromMailbox({state,imap,now:()=>NOW_MS});
  assert.equal(r.complete,true);assert.equal(calls.length,2);assert.equal(calls[1].toISOString(),'2026-10-02T00:00:00.000Z','the oldest day is read again (BEFORE is exclusive)');
  assert.ok(state.contacted['pub.org']);
});

test('an unfinished All Mail scan resumes from its own cursor next cycle',async()=>{
  const state=fresh(),pages=[[INBOX[0]],[INBOX[3]],[]];let t=NOW_MS;
  const imap=fakeImap({pages}),read=imap.recentHeaders;imap.recentHeaders=async(...a)=>{t+=10;return read(...a)}; // each page takes time
  // Cycle 1: time runs out after the first page.
  const r1=await rebuildFromMailbox({state,imap,self:SELF,now:()=>t,deadline:NOW_MS+5});
  assert.equal(r1.complete,false);assert.ok(state.rebuild_required);assert.equal(state.rebuild.cursor.uid,1);assert.match(rebuildHold(state,{ok:true,result:r1}),/continues next cycle/);
  assert.ok(isSuppressed(state,'gone@dead.com','dead.com'),'what was read is kept');
  // Cycle 2: continues where it stopped and completes.
  t=NOW_MS;const r2=await rebuildFromMailbox({state,imap,self:SELF,now:()=>t});
  assert.equal(r2.complete,true);assert.equal(state.rebuild_required,undefined);assert.equal(state.rebuild.cursor,undefined);
  assert.deepEqual(imap.calls.inbox.map(c=>c.cursor?.uid??null),[null,1,2]);
  assert.ok(isSuppressed(state,'colleague@pub.com','pub.com'));
});

test('Imap.sentRecipients pages with BEFORE, reads Message-IDs and says whether it returned everything',async()=>{
  const imap=new Imap({user:SELF}),seen=[];
  const raw=(rows)=>rows.map(([to,date,mid],i)=>{const h=`To: ${to}\r\nDate: ${date}\r\nMessage-ID: ${mid}\r\n`;return `* ${i+1} FETCH (UID ${10+i} BODY[HEADER.FIELDS (TO DATE MESSAGE-ID)] {${h.length+2}}\r\n${h}\r\n)`}).join('\r\n');
  imap.cmd=async line=>{seen.push(line);
    if(line.startsWith('LIST'))return '* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"';
    if(line.startsWith('EXAMINE'))return '* OK';
    if(line.startsWith('UID SEARCH'))return '* SEARCH 10 11 12';
    if(line.startsWith('UID FETCH'))return raw([['ed@pub.com','Wed, 25 Nov 2026 19:30:05 +0000','<lf-x@sender.example>'],['b@pub.org','Wed, 25 Nov 2026 19:31:00 +0000','<lf-y@sender.example>']]);
    throw Error(line)};
  const r=await imap.sentRecipients(new Date('2025-10-23T00:00:00Z'),{max:2,before:new Date('2026-10-02T00:00:00Z')});
  assert.ok(seen.includes('UID SEARCH SINCE 23-Oct-2025 BEFORE 02-Oct-2026'));
  assert.ok(seen.some(l=>l.startsWith('UID FETCH 11,12 ')&&l.includes('MESSAGE-ID')),'newest `max` messages');
  assert.equal(r.complete,false);assert.equal(r[0].message_id,'<lf-x@sender.example>');
  assert.equal((await imap.sentRecipients(new Date('2025-10-23T00:00:00Z'),{max:5})).complete,true);
  assert.ok(seen.includes('UID SEARCH SINCE 23-Oct-2025'),'no BEFORE unless asked');
});

// ---- Whole cycle: the hold, the stage and its reasons ----
const resp=(body,{status=200,type='text/html'}={})=>new Response(body,{status,headers:{'content-type':type}});
const site=async url=>{const u=new URL(url);if(u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${u.hostname}/guide/</loc></url></urlset>`,{type:'application/xml'});
  if(/\.(xml|txt)$/.test(u.pathname))return resp('',{status:404});return resp(`<html><head><title>Guide</title></head><body><main><h1>Guide</h1><p>${'mice home seal gaps '.repeat(200)}</p></main></body></html>`)};
const ENV={LINKFORGE_DATA_KEY:'rebuild-test-key-'.repeat(2),LINKFORGE_VAULT_RESET_AT:new Date(Date.now()+60e3).toISOString(),SENDER_NAME:'Alex',OUTREACH_MODE:'send',REPLY_MODE:'send',GMAIL_ADDRESS:SELF};
function cycleMailer(imap){
  const sent=[];
  return {sent,check:async()=>({status:'connected'}),send:async m=>{sent.push(m);throw Error('must not send while the vault is being rebuilt')},draft:async()=>{},close:async()=>{},imap};
}

test('cycle: a new vault holds outreach and automatic replies while the mailbox cannot be read',async()=>{
  const mailer=cycleMailer({sentRecipients:async()=>{throw Error('IMAP EXAMINE NO unavailable')},recentHeaders:async()=>Object.assign([],{complete:true})});
  const {summary,state}=await runAutopilot({env:ENV,argv:[],fetchImpl:site,mailer,write:false,useCache:false});
  assert.equal(summary.capabilities.vault,true);
  assert.equal(summary.stages.rebuild.ok,false);assert.match(summary.stages.rebuild.error,/unavailable/);
  assert.ok(state.rebuild_required);assert.equal(summary.capabilities.rebuild_required,true);
  assert.equal(summary.stages.outreach.ok,null);assert.match(summary.stages.outreach.skipped,/new vault: nothing is sent until contact history and opt-outs are restored.*could not be read/);
  assert.equal(summary.sender.reply_mode,'draft','automatic answers become drafts while held');
  assert.equal(mailer.sent.length,0);
  assert.ok(typeof summary.capabilities.vault_bytes==='number'||summary.capabilities.vault_bytes===null);
  assert.ok(!EMAIL.test(JSON.stringify(summary)),'no address in the public summary');
});

test('cycle: once the mailbox is read back, the hold lifts in the same cycle',async()=>{
  const mailer=cycleMailer(fakeImap());
  const {summary,state}=await runAutopilot({env:ENV,argv:[],fetchImpl:site,mailer,write:false,useCache:false});
  assert.equal(summary.stages.rebuild.ok,true);assert.equal(summary.stages.rebuild.result.complete,true);
  assert.equal(state.rebuild_required,undefined);assert.equal(summary.capabilities.rebuild_required,false);
  assert.ok(state.contacted['pub.com']);assert.ok(isSuppressed(state,'colleague@pub.com','pub.com'));
  assert.equal(summary.stages.outreach.ok,true,'outreach runs with the restored history');assert.equal(summary.sender.reply_mode,'send');
  assert.ok(!EMAIL.test(JSON.stringify(summary)));assert.ok(!/pub\.com|dead\.com/.test(JSON.stringify(summary.stages)));
});

test('cycle: without a new vault there is no hold and no rebuild stage; the vault on disk is measured',async()=>{
  const {summary,state}=await runAutopilot({env:{SENDER_NAME:'Alex'},argv:[],fetchImpl:site,write:false,useCache:false});
  assert.equal(summary.stages.rebuild,undefined);assert.equal(state.rebuild_required,undefined);assert.equal(summary.capabilities.rebuild_required,false);
  assert.ok(['v1','v2-gzip',null].includes(summary.capabilities.vault_format));
  assert.ok(summary.capabilities.vault_bytes===null||summary.capabilities.vault_bytes>0);
});
