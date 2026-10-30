import test from 'node:test';
import assert from 'node:assert/strict';
import {runOutreach,processReplies,gmailTransport,sentToday} from '../../scripts/autopilot/outreach.mjs';
import {classifyReply,decodeReplyBody,Imap} from '../../scripts/autopilot/mail.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';
const iso=()=>new Date().toISOString();
const older=()=>new Date(Date.now()-8*86400000).toISOString();
const p=(id='one')=>({id,domain:id+'.example',site:'owned.example',page_url:'https://'+id+'.example/resources/',asset_url:'https://owned.example/tool',email:'editor@'+id+'.example',qv:2,status:'ready',history:[]});
function proof(p){const time=Date.now();return {ok:true,email:p.email,evidence:{source:'https://'+p.domain+'/contact/',email:p.email,rank:95,observed_at:new Date(time).toISOString()},verification:hunterVerdict({data:{email:p.email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},p.email,time)}}
function fixture(prospects={a:p()}){
 const sent=[],state={prospects,reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}};
 return {sent,state,args:{state,assets:[{url:'https://owned.example/tool',title:'Tool'}],sites:[{domain:'owned.example',topic:'tools'}],
  mailer:{authorizeRecipient:async p=>proof(p),send:async m=>sent.push(m),draft:async()=>{}},writer:{write:async()=>({subject:'Resource suggestion',body:'A useful resource'})},
  config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'owner@owned.example',senderName:'Owner',gapMs:()=>0}}};
}
test('built-in Gmail SMTP boundary rejects a missing or mismatched verification proof without connecting',async()=>{
 const mailer=gmailTransport({GMAIL_ADDRESS:'owner@owned.example',GMAIL_APP_PASSWORD:'not-a-real-password'});
 await assert.rejects(mailer.send({to:'x@journal.example',raw:'x'}),/verified recipient evidence required/);
 const wrong=proof(p());wrong.publisher_domain='other.example';await assert.rejects(mailer.send({to:p().email,raw:'x',recipientProof:wrong}),/verified recipient evidence required/);
});
test('complete current reply scan is required by the production preflight route',async()=>{
 for(const health of [undefined,{status:'failed',checked_at:iso()},{status:'backlog',checked_at:iso()},{status:'ok',checked_at:older()}]){
  const f=fixture();f.state.reply_health=health;const r=await runOutreach(f.args);assert.equal(r.blocked_reason,'reply_scan_not_current_and_complete');assert.equal(f.sent.length,0);
 }
});
test('failed verifier and catch-all results prevent initial sending',async()=>{
 for(const verdict of [{ok:false,reason:'no_verified_mailbox'},{...proof(p()),verification:{status:'accept_all'}}]){
  const f=fixture();f.args.mailer.authorizeRecipient=async()=>verdict;const r=await runOutreach(f.args);assert.equal(f.sent.length,0);assert.equal(r.verification_held,1);
 }
});
test('successful proof is bound to the final SMTP recipient and kept privately',async()=>{
 const f=fixture();const r=await runOutreach(f.args);assert.equal(r.sent,1);assert.equal(f.sent[0].recipientProof.email,f.sent[0].to);assert.equal(f.state.prospects.a.contact_quality.status,'verified');
});
test('recipient proof errors fail closed without an exception reaching SMTP',async()=>{
 const f=fixture();f.args.mailer.authorizeRecipient=async()=>{throw Error('timeout')};await runOutreach(f.args);assert.equal(f.sent.length,0);
});
test('suppression is rechecked after asynchronous verification',async()=>{
 const f=fixture();f.args.mailer.authorizeRecipient=async p=>{f.state.suppression[p.email]={};return proof(p)};await runOutreach(f.args);assert.equal(f.sent.length,0);
});
test('follow-up shares the same cap as initial sends',async()=>{
 const a=p('old'),b=p('new');a.status='sent';a.history=[{type:'initial',mode:'send',at:older(),message_id:'<lf-old@owned.example>'}];
 const f=fixture({a,b});f.state.first_send_at=older();f.args.config.dailyLimit=1;
 const r=await runOutreach(f.args);assert.equal(r.followups,1);assert.equal(r.sent,0);assert.equal(f.sent.length,1);assert.equal(sentToday(f.state),1);
});
test('failed follow-up verification cannot silently switch the recipient',async()=>{
 const a=p('old');a.status='sent';a.history=[{type:'initial',mode:'send',at:older(),message_id:'<lf-old@owned.example>'}];const f=fixture({a});
 f.args.mailer.authorizeRecipient=async()=>proof({...a,email:'new@old.example'});await runOutreach(f.args);assert.equal(f.sent.length,0);assert.equal(a.email,'editor@old.example');
});
test('uncertain SMTP delivery does not automatically retry next cycle',async()=>{
 const f=fixture();let calls=0;f.args.mailer.send=async()=>{calls++;throw Error('connection lost after DATA')};
 await runOutreach(f.args);await runOutreach(f.args);assert.equal(calls,1);assert.equal(f.state.prospects.a.status,'delivery_uncertain');
});
test('a later opt-out with the same subject remains actionable even after a won placement',async()=>{
 const a=p();a.status='won';a.history=[{type:'initial',mode:'send',to:a.email,at:older(),message_id:'<lf-old@owned.example>'}];const state={prospects:{a}};
 const msgs=[{from:a.email,subject:'Re: resource',body:'Thank you',messageId:'<r1@one.example>'},{from:a.email,subject:'Re: resource',body:'No.',messageId:'<r2@one.example>'}];
 const r=await processReplies({state,imap:{recentHeaders:async()=>msgs}});assert.equal(r.negative,1);assert.ok(state.suppression[a.domain]);assert.equal(a.status,'declined');
});
test('hard bounce suppresses the actual failed inbox and never switches to an alternate',async()=>{
 const a=p();a.status='sent';a.alternates=['second@one.example'];a.history=[{type:'initial',mode:'send',to:a.email,at:older()}];const state={prospects:{a},contacted:{[a.domain]:older()}};
 await processReplies({state,imap:{recentHeaders:async()=>[{from:'mailer-daemon@googlemail.com',subject:'Failure',body:'Address not found '+a.email}]}});
 assert.equal(a.status,'bounced');assert.equal(a.email,'editor@one.example');assert.ok(state.suppression[a.email]);assert.ok(state.contacted[a.domain]);
});
test('historic bounce records quarantine queued alternate addresses',async()=>{
 const a=p();a.email='second@one.example';a.history=[{type:'initial',at:older(),to:'first@one.example'},{type:'bounce',at:older(),to:'first@one.example'}];const state={prospects:{a}};
 await processReplies({state,imap:{recentHeaders:async()=>[]}});assert.equal(a.status,'bounced');assert.ok(state.suppression['first@one.example']);assert.ok(a.no_followup);
});
test('delivery delays are not misreported as nonexistent mailboxes',async()=>{
 const a=p();a.status='sent';a.history=[{type:'initial',at:older(),to:a.email}];const state={prospects:{a}};
 const r=await processReplies({state,imap:{recentHeaders:async()=>[{from:'mailer-daemon@googlemail.com',subject:'Delivery Status Notification (Delay)',body:'Delivery incomplete to '+a.email+'. Gmail will retry.'}]}});
 assert.equal(r.delays,1);assert.equal(r.bounces,0);assert.equal(a.status,'delivery_delayed');assert.ok(a.no_followup);
});
test('failed or incomplete mailbox scan prevents later sending',async()=>{
 const f=fixture();await assert.rejects(processReplies({state:f.state,imap:{recentHeaders:async()=>{throw Error('IMAP timeout')}}}));assert.equal(f.state.reply_health.status,'failed');
 const arr=[];arr.complete=false;arr.cursor={mailbox:'INBOX',uidvalidity:'1',uid:400};await processReplies({state:f.state,imap:{recentHeaders:async()=>arr}});
 assert.equal(f.state.reply_health.status,'backlog');assert.equal((await runOutreach(f.args)).sent,0);
});
test('plain no, base64 and quoted-printable opt-outs are recognized',()=>{
 for(const text of ['no','No.','nope','STOP'])assert.equal(classifyReply({body:text}),'negative');
 assert.equal(classifyReply({body:decodeReplyBody(Buffer.from('Please remove me').toString('base64'),'base64')}),'negative');
 assert.equal(classifyReply({body:decodeReplyBody('Please=20remove=20me','quoted-printable')}),'negative');
 assert.equal(classifyReply({body:'Thank you\nOn Friday someone wrote:\n> Please stop'}),'neutral');
});
test('multipart DSN body retains failed recipient information',()=>{
 const b='--part\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from('Address not found: editor@journal.example').toString('base64')+'\r\n--part--\r\n';
 assert.match(decodeReplyBody(b,'','multipart/report; boundary="part"'),/editor@journal.example/);
});
test('mailbox scanning paginates oldest-first and scopes cursor to UIDVALIDITY',async()=>{
 const imap=new Imap({});const calls=[];
 imap.cmd=async line=>{calls.push(line);if(line.startsWith('LIST'))return '* LIST (\\All) "/" "[Gmail]/All Mail"\r\n';if(line.startsWith('SELECT'))return '* OK [UIDVALIDITY 100] valid\r\n';
  if(line.startsWith('UID SEARCH'))return '* SEARCH 10 11 12\r\n';if(line.startsWith('UID FETCH'))return [10,11].map((u,i)=>`* ${i+1} FETCH (UID ${u} BODY[HEADER.FIELDS (FROM)] {10}\r\nFrom: editor@journal.example\r\n\r\n BODY[TEXT]<0> {2}\r\nno\r\n)\r\n`).join('');throw Error(line)};
 const batch=await imap.recentHeaders(new Date(),{max:2,cursor:{mailbox:'[Gmail]/All Mail',uidvalidity:'99',uid:900}});
 assert.equal(batch.complete,false);assert.equal(batch.cursor.uid,11);assert.ok(calls.some(x=>x.startsWith('UID SEARCH SINCE')));assert.ok(calls.some(x=>x.startsWith('UID FETCH 10,11')));
});
