import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {smtpSend,buildMessage,newMessageId,unsubscribeHeader} from '../../scripts/autopilot/mail.mjs';
import {runOutreach,sendFailure,processReplies} from '../../scripts/autopilot/outreach.mjs';

/** A scripted SMTP server: `fail` replaces the normal answer for one command ('greeting', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'BODY'), or 'drop' closes the connection there. */
class Smtp extends EventEmitter{
  constructor(fail={}){super();this.fail=fail;this.lines=[];setImmediate(()=>this.answer('greeting','220 ready\r\n'))}
  setEncoding(){}
  answer(k,normal){const r=this.fail[k];if(r==='drop'){setImmediate(()=>this.emit('close'));return}setImmediate(()=>this.emit('data',r||normal))}
  write(s){this.lines.push(s);
    if(s.startsWith('EHLO'))this.answer('EHLO','250-hi\r\n250 AUTH PLAIN\r\n');else if(s.startsWith('AUTH'))this.answer('AUTH','235 ok\r\n');
    else if(s.startsWith('MAIL'))this.answer('MAIL','250 ok\r\n');else if(s.startsWith('RCPT'))this.answer('RCPT','250 ok\r\n');
    else if(s.startsWith('DATA'))this.answer('DATA','354 go\r\n');else if(s.startsWith('QUIT'))this.answer('QUIT','221 bye\r\n');
    else if(s.endsWith('\r\n.\r\n'))this.answer('BODY','250 2.0.0 OK queued\r\n');}
  end(){}
}
const send=fail=>smtpSend({user:'me@gmail.com',pass:'pw',from:'me@gmail.com',to:'ed@pub.example',raw:'Subject: x\r\n\r\nhello',connect:()=>new Smtp(fail)});

test('every SMTP failure says at which stage it happened and with which code',async()=>{
  assert.equal((await send({})).accepted,true);
  const cases=[[{greeting:'421 4.7.0 Try again later, closing connection.\r\n'},'connect',421],[{greeting:'drop'},'connect','connection'],
    [{AUTH:'535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 Learn more\r\n'},'auth',535],
    [{MAIL:'550 5.4.5 Daily user sending limit exceeded.\r\n'},'mail_from',550],[{RCPT:'553 5.1.2 The recipient address is not valid.\r\n'},'rcpt',553],
    [{DATA:'554 5.5.1 Error: no valid recipients\r\n'},'data',554],[{BODY:'451 4.3.0 Mail server temporarily rejected message.\r\n'},'after_data',451],[{BODY:'drop'},'after_data','connection']];
  for(const [fail,stage,code] of cases){
    const e=await send(fail).then(()=>null,x=>x);
    assert.ok(e instanceof Error,stage);assert.equal(e.stage,stage,JSON.stringify(fail));assert.equal(e.code,code,JSON.stringify(fail));
  }
  const thrown=await smtpSend({user:'u',pass:'p',from:'u@x',to:'t@y',raw:'x',connect:()=>{throw Object.assign(Error('getaddrinfo ENOTFOUND'),{code:'ENOTFOUND'})}}).catch(e=>e);
  assert.equal(thrown.stage,'connect');assert.equal(thrown.code,'ENOTFOUND');
});

test('send failures are classified: nothing delivered before DATA; Gmail login and quota refusals block the cycle',()=>{
  const e=(stage,code,msg='x')=>Object.assign(Error(`SMTP ${code}: ${msg}`),{stage,code});
  assert.deepEqual(sendFailure(e('auth',535,'535 5.7.8 Username and Password not accepted')),{stage:'auth',code:535,block:'gmail_auth',uncertain:false,refused:false,retry_recipient:false});
  assert.equal(sendFailure(e('auth',534,'534-5.7.9 Application-specific password required')).block,'gmail_auth');
  assert.equal(sendFailure(e('mail_from',550,'550 5.4.5 Daily user sending limit exceeded')).block,'gmail_limit');
  assert.equal(sendFailure(e('connect',421,'421 4.7.0 Try again later, closing connection')).block,'gmail_limit');
  assert.equal(sendFailure(e('auth',454,'454 4.7.0 Too many login attempts, please try again later')).block,'gmail_limit');
  const refused=sendFailure(e('rcpt',550,'550 5.1.1 No such user'));assert.equal(refused.refused,true);assert.equal(refused.uncertain,false);assert.equal(refused.block,null);
  assert.equal(sendFailure(e('rcpt',450,'450 4.2.1 Try later')).retry_recipient,true);
  assert.equal(sendFailure(e('data',554)).uncertain,true);assert.equal(sendFailure(e('after_data',451)).uncertain,true);
  const late=sendFailure(e('after_data',550,'550 5.4.5 Daily user sending limit exceeded'));assert.equal(late.uncertain,true);assert.equal(late.block,'gmail_limit');
  assert.equal(sendFailure(Error('connection lost after DATA')).uncertain,true,'an untagged failure stays uncertain, as before');
  assert.equal(sendFailure(Object.assign(Error('mail socket timeout'),{stage:'connect',code:'timeout'})).block,null);
});

const iso=()=>new Date().toISOString();
const mk=id=>({id,domain:id+'.example',site:'s.com',page_url:`https://${id}.example/r`,title:'Resources',asset_url:'https://s.com/tool',email:`editor@${id}.example`,qv:2,status:'ready',history:[],score:id==='a'?90:50});
function fixture(sendImpl){
  const attempts=[],logs=[];
  const state={prospects:{a:mk('a'),b:mk('b')},reply_health:{status:'ok',checked_at:iso()},suppression:{},contacted:{}};
  return {attempts,logs,state,args:{state,assets:[{url:'https://s.com/tool',title:'Tool'}],sites:[{domain:'s.com',topic:'tools'}],log:m=>logs.push(m),
    writer:{write:async()=>({subject:'A suggestion for you',body:'Hello https://s.com/tool',writer:'template',variant:'template:resource_suggestion',facts_used:[]})},
    mailer:{send:async m=>{attempts.push(m.to);return sendImpl(m,attempts.length)},draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'me@gmail.com',senderName:'A',gapMs:()=>0,sendWindow:false}}};
}
const smtpError=(stage,code,msg)=>Object.assign(Error(`SMTP ${code}: ${msg}`),{stage,code});

test('a Gmail login or quota refusal stops sending for the cycle and never marks anyone contacted',async()=>{
  for(const [err,blocked] of [[smtpError('auth',535,'535 5.7.8 Username and Password not accepted'),'gmail_auth'],[smtpError('mail_from',550,'550 5.4.5 Daily user sending limit exceeded'),'gmail_limit']]){
    const f=fixture(()=>{throw err});const r=await runOutreach(f.args);
    assert.equal(r.send_blocked,blocked);assert.equal(f.attempts.length,1,'no further attempt this cycle');assert.equal(r.sent,0);
    for(const p of Object.values(f.state.prospects)){assert.equal(p.status,'ready');assert.ok(!p.no_followup);assert.equal(p.history.length,0)}
    assert.deepEqual(f.state.contacted,{});assert.deepEqual(f.state.suppression,{});
    assert.ok(f.logs.some(l=>/Gmail refused to send/.test(l)));assert.ok(!f.logs.join('\n').includes('@'),'no address in the public log');
  }
});

test('a failure before DATA is never "delivery uncertain"; one after DATA still is, with no retry',async()=>{
  const conn=fixture(()=>{throw Object.assign(Error('mail socket timeout'),{stage:'connect',code:'timeout'})});const r=await runOutreach(conn.args);
  assert.equal(r.not_sent,1);assert.equal(conn.attempts.length,1);assert.equal(r.send_blocked,undefined);
  assert.equal(conn.state.prospects.a.status,'ready');assert.deepEqual(conn.state.contacted,{});
  // Next cycle it is simply sent.
  conn.args.mailer.send=async m=>{conn.attempts.push(m.to)};const again=await runOutreach(conn.args);assert.equal(again.sent,2);
  const late=fixture(()=>{throw smtpError('after_data',451,'451 4.3.0 temporarily rejected')});await runOutreach(late.args);await runOutreach(late.args);
  assert.equal(late.attempts.filter(t=>t==='editor@a.example').length,1,'no automatic retry');assert.equal(late.state.prospects.a.status,'delivery_uncertain');assert.ok(late.state.contacted['a.example']);
  const quota=fixture(()=>{throw smtpError('after_data',550,'550 5.4.5 Daily user sending limit exceeded')});const q=await runOutreach(quota.args);
  assert.equal(q.send_blocked,'gmail_limit');assert.equal(quota.state.prospects.a.status,'delivery_uncertain');assert.equal(quota.attempts.length,1);
});

test('a mailbox refused at RCPT is a bounce: suppressed, no follow-up, and the next prospect still gets its turn',async()=>{
  const f=fixture((m,n)=>{if(n===1)throw smtpError('rcpt',550,'550 5.1.1 The email account that you tried to reach does not exist')});
  const r=await runOutreach(f.args);
  const a=f.state.prospects.a,b=f.state.prospects.b;
  assert.equal(r.rcpt_refused,1);assert.equal(r.sent,1);assert.equal(a.status,'bounced');assert.equal(a.no_followup,true);
  assert.ok(f.state.suppression['editor@a.example']);assert.deepEqual(a.history.map(h=>[h.type,h.stage,h.code]),[['bounce','rcpt',550]]);
  assert.ok(f.state.contacted['a.example'],'as with every delivery failure, nobody else at this publisher is tried automatically');
  assert.equal(b.status,'sent');
  // The stored bounce restores the suppression even after it is lost (the reply scan's migration).
  const st={prospects:{a:structuredClone(a)}};await processReplies({state:st,imap:{recentHeaders:async()=>[]}});assert.ok(st.suppression['editor@a.example']);
  const deferred=fixture((m,n)=>{if(n===1)throw smtpError('rcpt',450,'450 4.2.1 try later')});const d=await runOutreach(deferred.args);
  assert.equal(deferred.state.prospects.a.status,'ready');assert.equal(d.sent,1,'a deferred recipient does not stop the others');
});

test('the opt-out header carries this message\'s own id; no one-click POST header is claimed',()=>{
  const id=newMessageId('gmail.com');
  const raw=buildMessage({from:'me@gmail.com',fromName:'Sam',to:'ed@pub.example',subject:'Hi',text:'x',messageId:id,unsubscribe:true});
  const bare=id.slice(1,-1);assert.match(bare,/^lf-[a-z0-9]+-[a-z0-9]+@gmail\.com$/);
  assert.ok(raw.includes(`\r\nList-Unsubscribe: <mailto:me@gmail.com?subject=unsubscribe%20${bare}>\r\n`));
  assert.doesNotMatch(raw,/List-Unsubscribe-Post/);
  assert.equal(unsubscribeHeader('me@gmail.com','<not ours>'),'List-Unsubscribe: <mailto:me@gmail.com?subject=unsubscribe>');
  assert.doesNotMatch(buildMessage({from:'me@gmail.com',to:'a@b.c',subject:'s',text:'x',messageId:id}),/List-Unsubscribe/);
});
