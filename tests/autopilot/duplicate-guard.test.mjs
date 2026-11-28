import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Imap,parseSentHeaders} from '../../scripts/autopilot/mail.mjs';
import {reconcileSent,preverify,runOutreach} from '../../scripts/autopilot/outreach.mjs';

const fetchRaw=rows=>rows.map(([to,date],i)=>{const h=`To: ${to}\r\nDate: ${date}\r\n`;return `* ${i+1} FETCH (UID ${10+i} BODY[HEADER.FIELDS (TO DATE)] {${h.length+2}}\r\n${h}\r\n)`}).join('\r\n');

test('Sent-folder headers parse to one entry per recipient, including display names and folded lines',()=>{
  const out=parseSentHeaders(fetchRaw([['"Jess Lee" <jess@plantmom.blog>','Wed, 25 Nov 2026 19:30:05 +0000'],['a@x.com,\r\n b@y.org','Wed, 25 Nov 2026 19:31:00 +0000']]));
  assert.deepEqual(out.map(x=>x.to),['jess@plantmom.blog','a@x.com','b@y.org']);
  assert.equal(out[0].at,'2026-11-25T19:30:05.000Z');
  assert.deepEqual(parseSentHeaders(''),[]);
});

test('Imap.sentRecipients reads the \\Sent mailbox read-only',async()=>{
  const imap=new Imap({user:'me@owned.example'}),seen=[];
  imap.cmd=async line=>{seen.push(line.split(' ').slice(0,2).join(' '));
    if(line.startsWith('LIST'))return '* LIST (\\HasNoChildren \\All) "/" "[Gmail]/All Mail"\r\n* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"';
    if(line.startsWith('EXAMINE')){assert.match(line,/Sent Mail/);return '* OK'}
    if(line.startsWith('UID SEARCH'))return '* SEARCH 10 11';
    if(line.startsWith('UID FETCH'))return fetchRaw([['ed@pub.com','Wed, 25 Nov 2026 19:30:05 +0000'],['ed@pub.com','Wed, 25 Nov 2026 19:37:40 +0000']]);
    throw Error(line)};
  const r=await imap.sentRecipients(new Date('2026-11-01'));
  assert.equal(r.length,2);assert.ok(!seen.some(c=>c.startsWith('SELECT')),'never opens the mailbox for writing');
});

const iso=s=>new Date(s).toISOString();
test('a pitch that is in Sent but missing from the record is restored, and never pitched again',async()=>{
  const now=Date.now(),t1=iso(now-2*3600e3);
  const state={prospects:{
    lost:{id:'lost',status:'ready',email:'ed@lost.com',domain:'lost.com',history:[]},
    fine:{id:'fine',status:'sent',email:'ed@fine.com',domain:'fine.com',history:[{type:'initial',at:t1,to:'ed@fine.com',mode:'send',message_id:'<m1>'}]},
    dup:{id:'dup',status:'sent',email:'ed@dup.com',domain:'dup.com',history:[{type:'initial',at:t1,to:'ed@dup.com',mode:'send'}]},
    untouched:{id:'untouched',status:'ready',email:'ed@new.com',domain:'new.com',history:[]}},contacted:{}};
  const imap={sentRecipients:async()=>[{to:'ed@lost.com',at:t1},{to:'ed@fine.com',at:t1},{to:'ed@dup.com',at:t1},{to:'ed@dup.com',at:iso(now-2*3600e3+7*60e3)},{to:'friend@personal.example',at:t1}]};
  const stats=await reconcileSent({state,imap});
  assert.deepEqual(stats,{restored:1,duplicates:1}); // the owner's Sent volume is not published (PRIV-2)
  assert.equal(state.prospects.lost.status,'sent');assert.equal(state.prospects.lost.history[0].reconciled,true);assert.ok(state.contacted['lost.com']);
  assert.equal(state.prospects.fine.history.length,1,'recorded pitches are left alone');
  assert.equal(state.prospects.dup.no_followup,true);assert.match(state.prospects.dup.no_followup_reason,/duplicate/);
  assert.equal(state.prospects.untouched.status,'ready');assert.equal(state.contacted['new.com'],undefined);
  assert.equal((await reconcileSent({state,imap})).duplicates,0,'a duplicate is counted once');
  // The restored prospect is skipped by outreach even if something set it back to ready.
  state.prospects.lost.status='ready';state.prospects.lost.qv=2;state.prospects.lost.asset_url='https://s.com/only-this-one';state.prospects.lost.site='s.com';state.prospects.untouched.status='rejected';state.reply_health={status:'ok',checked_at:iso(now)};state.suppression={};
  const sent=[];
  const r=await runOutreach({state,assets:[],sites:[{domain:'s.com',topic:'t'}],writer:{write:async()=>({subject:'s',body:'b'})},mailer:{send:async m=>sent.push(m),draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'me@s.com',senderName:'A',gapMs:()=>0,sendWindow:false}});
  assert.equal(sent.filter(m=>m.to==='ed@lost.com').length,0);assert.equal(state.prospects.lost.status,'skipped_duplicate');assert.ok(r.skipped>=1);
});

test('a transport that cannot read Sent is a no-op; a broken answer throws so sending is blocked',async()=>{
  assert.deepEqual(await reconcileSent({state:{prospects:{}},imap:{}}),{restored:0,duplicates:0});
  await assert.rejects(reconcileSent({state:{prospects:{}},imap:{sentRecipients:async()=>null}}),/Invalid Sent/);
});

test('pre-verification stops when the day\'s credits are gone and leaves the rest of the queue untouched',async()=>{
  const mk=id=>({id,status:'ready',email:`e@${id}.com`,domain:`${id}.com`,qv:2,history:[]});
  const state={prospects:{a:mk('a'),b:mk('b'),c:mk('c')}};let calls=0;
  const mailer={authorizeRecipient:async()=>{calls++;return calls===1?{ok:false,reason:'no_verified_mailbox',detail:'mailbox_unknown'}:{ok:false,reason:'no_verified_mailbox',detail:'mailbox_verifalia_free_credits_used_up'}}};
  const r=await preverify({state,mailer,max:5,now:()=>new Date('2026-11-25T12:00:00Z')});
  assert.equal(calls,2);assert.equal(r.checked,1);assert.equal(r.held,1);assert.equal(r.out_of_credits,true);
  assert.equal(Object.values(state.prospects).filter(p=>p.contact_quality).length,1,'only the genuinely checked inbox is marked');
});

test('the Autopilot workflow starts from the newest state and never runs twice in a row',()=>{
  const y=readFileSync(new URL('../../.github/workflows/autopilot.yml',import.meta.url),'utf8');
  assert.match(y,/uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.ref \}\}/,'checkout must not pin the trigger commit');
  assert.match(y,/hours\*60>=10/,'started runs keep a 10-minute floor after the previous cycle');
  assert.match(y,/cancel-in-progress: false/);
});

test('link-gap pulls ask DataForSEO for in-content links on pages that link out (rows are paid for)',async()=>{
  const {DataForSEO}=await import('../../scripts/autopilot/dataforseo.mjs');
  let body;const dfs=new DataForSEO({login:'l',password:'p',state:{},fetchImpl:async(u,o)=>{body=JSON.parse(o.body)[0];return new Response(JSON.stringify({status_code:20000,cost:0.03,tasks:[{status_code:20000,result:[{total_count:0,items:[]}]}]}),{headers:{'content-type':'application/json'}})}});
  await dfs.backlinks('rival.com');
  const conds=body.filters.filter(Array.isArray);
  assert.ok(conds.length<=8,'DataForSEO allows at most 8 filters');
  assert.deepEqual(conds.find(c=>c[0]==='page_from_external_links'),['page_from_external_links','>=',3]);
  assert.deepEqual(conds.find(c=>c[0]==='semantic_location'),['semantic_location','in',['article','main','section','details']]);
  assert.equal(body.mode,'one_per_domain');
  const {resetLinkGapPaging}=await import('../../scripts/autopilot/run.mjs');
  const state={linkgap:{'a|b':{at:'x',offset:200,total:5000}}};
  assert.deepEqual(resetLinkGapPaging(state),{targets_reopened:1});assert.deepEqual(state.linkgap,{});assert.equal(resetLinkGapPaging(state),null);
});
