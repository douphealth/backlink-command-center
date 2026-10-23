/**
 * Minimal Gmail transport over TLS with an App Password (no OAuth client needed):
 *  - SMTP (smtp.gmail.com:465) to send
 *  - IMAP (imap.gmail.com:993) to save drafts and detect replies/bounces
 * `connect` is injectable so the protocol logic is unit-testable.
 */
import tls from 'node:tls';
import {randomId} from './util.mjs';

const CRLF='\r\n';
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const encWord=s=>/^[\x20-\x7e]*$/.test(s)?s:`=?UTF-8?B?${b64(s)}?=`;
const wrap76=s=>s.replace(/.{1,76}/g,'$&\r\n').trimEnd();
const cleanHeader=s=>String(s||'').replace(/[\r\n]+/g,' ').trim();

export function buildMessage({from,fromName,to,subject,text,messageId,inReplyTo,references,unsubscribe}){
  const headers=[
    `From: ${fromName?`"${encWord(cleanHeader(fromName)).replace(/"/g,'')}" `:''}<${from}>`,`To: <${cleanHeader(to)}>`,
    `Subject: ${encWord(cleanHeader(subject))}`,`Date: ${new Date().toUTCString().replace('GMT','+0000')}`,`Message-ID: ${messageId}`,
    ...(inReplyTo?[`In-Reply-To: ${inReplyTo}`,`References: ${references||inReplyTo}`]:[]),
    ...(unsubscribe?[`List-Unsubscribe: <mailto:${from}?subject=unsubscribe>`]:[]),
    'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64'];
  return headers.join(CRLF)+CRLF+CRLF+wrap76(b64(text.replace(/\r?\n/g,CRLF)))+CRLF;
}
export const newMessageId=domain=>`<lf-${Date.now().toString(36)}-${randomId(8)}@${domain}>`;

function defaultConnect(host,port){return tls.connect({host,port,servername:host,timeout:30000})}

/** Line reader over a socket with a promise per expected response. */
class Wire{
  constructor(socket){this.s=socket;this.buf='';this.waiters=[];this.closed=false;
    socket.setEncoding?.('utf8');
    socket.on('data',d=>{this.buf+=d;this.pump()});
    socket.on('error',e=>{this.err=e;this.pump()});
    socket.on('close',()=>{this.closed=true;this.pump()});
    socket.on('timeout',()=>{this.err=Error('mail socket timeout');socket.destroy?.();this.pump()});
  }
  pump(){while(this.waiters.length){const w=this.waiters[0];const r=w.test(this.buf);
    if(r!=null){this.buf=this.buf.slice(r.consumed);this.waiters.shift();w.resolve(r.value);continue}
    if(this.err||this.closed){this.waiters.shift();w.reject(this.err||Error('mail connection closed'));continue}break}}
  wait(test){return new Promise((resolve,reject)=>{this.waiters.push({test,resolve,reject});this.pump()})}
  write(s){this.s.write(s)}
  end(){try{this.s.end()}catch{}}
}

/* ------------------------------- SMTP ------------------------------- */
function smtpReply(buf){
  const lines=buf.split(CRLF);let consumed=0;
  for(let i=0;i<lines.length-1;i++){consumed+=lines[i].length+2;const m=lines[i].match(/^(\d{3})([ -])/);if(m&&m[2]===' ')return {consumed,value:{code:Number(m[1]),text:lines.slice(0,i+1).join('\n')}}}
  return null;
}
export async function smtpSend({user,pass,from,to,raw,connect=defaultConnect,host='smtp.gmail.com',port=465}){
  const w=new Wire(connect(host,port));
  const cmd=async(line,ok)=>{if(line!=null)w.write(line+CRLF);const r=await w.wait(smtpReply);if(!ok.includes(r.code))throw Error(`SMTP ${r.code}: ${r.text.slice(0,160)}`);return r};
  try{
    await cmd(null,[220]);await cmd('EHLO linkforge.autopilot',[250]);
    await cmd('AUTH PLAIN '+b64(`\0${user}\0${pass}`),[235]);
    await cmd(`MAIL FROM:<${from}>`,[250]);await cmd(`RCPT TO:<${to}>`,[250,251]);
    await cmd('DATA',[354]);
    const r=await cmd(raw.replace(/\r?\n/g,CRLF).split(CRLF).map(l=>l.startsWith('.')?'.'+l:l).join(CRLF)+CRLF+'.',[250]);
    await cmd('QUIT',[221]).catch(()=>{});
    return {accepted:true,response:r.text.slice(0,120)};
  }finally{w.end()}
}

/* ------------------------------- IMAP ------------------------------- */
export class Imap{
  constructor({user,pass,connect=defaultConnect,host='imap.gmail.com',port=993}){Object.assign(this,{user,pass,connect,host,port});this.n=0}
  async open(){
    this.w=new Wire(this.connect(this.host,this.port));
    await this.w.wait(b=>{const i=b.indexOf(CRLF);return i>=0?{consumed:i+2,value:b.slice(0,i)}:null});
    await this.cmd(`LOGIN ${quote(this.user)} ${quote(this.pass)}`);
    return this;
  }
  /** Send a command; resolves with the full untagged response text once the tagged OK arrives. */
  async cmd(line,{literal}={}){
    const tag='A'+(++this.n).toString().padStart(3,'0');
    this.w.write(`${tag} ${line}${CRLF}`);
    if(literal!=null){
      await this.w.wait(b=>{const i=b.indexOf('+');const j=b.indexOf(CRLF,i);return i>=0&&j>=0?{consumed:j+2,value:true}:null});
      this.w.write(literal+CRLF);
    }
    const done=new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)([^\\r\\n]*)\\r\\n`);
    const out=await this.w.wait(b=>{const m=b.match(done);return m?{consumed:m.index+m[0].length,value:{status:m[2],text:b.slice(0,m.index),detail:m[3]}}:null});
    if(out.status!=='OK')throw Error(`IMAP ${line.split(' ')[0]} ${out.status}${out.detail}`.slice(0,160));
    return out.text;
  }
  async draftsMailbox(){
    const list=await this.cmd('LIST "" "*"');
    const m=list.split(CRLF).find(l=>/\\Drafts/.test(l));
    return m?(m.match(/"([^"]+)"\s*$/)||m.match(/(\S+)\s*$/))[1]:'[Gmail]/Drafts';
  }
  async appendDraft(raw){
    const box=await this.draftsMailbox(),bytes=Buffer.byteLength(raw,'utf8');
    await this.cmd(`APPEND ${quote(box)} (\\Draft \\Seen) {${bytes}}`,{literal:raw});
    return box;
  }
  /** Headers of INBOX messages since `sinceDate` (Date). */
  async recentHeaders(sinceDate,{max=400}={}){
    await this.cmd('SELECT INBOX');
    const since=sinceDate.toUTCString().split(' ').slice(1,4).join('-');
    const found=await this.cmd(`UID SEARCH SINCE ${since}`);
    const uids=(found.match(/\* SEARCH([\d ]*)/)?.[1]||'').trim().split(/\s+/).filter(Boolean).slice(-max);
    if(!uids.length)return [];
    const raw=await this.cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT IN-REPLY-TO REFERENCES AUTO-SUBMITTED)] BODY.PEEK[TEXT]<0.1500>)`);
    return parseFetch(raw);
  }
  async close(){try{await Promise.race([this.cmd('LOGOUT'),new Promise(r=>setTimeout(r,3000).unref?.())])}catch{}this.w?.end()}
}
const quote=s=>'"'+String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';

export function parseFetch(raw){
  const out=[];
  for(const part of raw.split(/(?=^\* \d+ FETCH )/m)){
    if(!part.startsWith('* '))continue;
    const header=(part.match(/BODY\[HEADER\.FIELDS[^\]]*\] \{\d+\}\r\n([\s\S]*?)\r\n\r\n/)||[])[1]||'';
    const body=(part.match(/BODY\[TEXT\]<0> \{\d+\}\r\n([\s\S]*?)(?:\)\r\n|$)/)||[])[1]||'';
    const unfolded=header.replace(/\r\n[ \t]+/g,' ');
    const h=k=>(unfolded.match(new RegExp('^'+k+':\\s*(.*)$','im'))||[])[1]||'';
    const from=(h('From').match(/<([^>]+)>/)||[])[1]||h('From').trim();
    out.push({from:from.toLowerCase(),subject:h('Subject'),inReplyTo:h('In-Reply-To'),references:h('References'),autoSubmitted:h('Auto-Submitted'),body});
  }
  return out;
}

const NEGATIVE=/\b(unsubscribe|remove me|take me off|stop (emailing|contacting)|do not (email|contact)|don't (email|contact)|not interested|no thanks|no thank you|please stop|spam)\b/i;
const POSITIVE=/\b(added|i've added|i have added|updated the (page|post|article)|included (it|your)|linked|great resource|happy to (add|include)|sounds good|will add|we'll add)\b/i;
const BOUNCE=/mailer-daemon|postmaster|mail delivery subsystem/i;
/** Classify a reply: bounce | negative | positive | neutral. */
export function classifyReply(msg){
  if(BOUNCE.test(msg.from)||/delivery status notification|undeliverable|failure notice|returned mail/i.test(msg.subject))return 'bounce';
  if(/auto-replied|auto-generated/i.test(msg.autoSubmitted)||/out of (the )?office|automatic reply|auto(matic)?[- ]?reply/i.test(msg.subject))return 'auto';
  const text=String(msg.body||'').split(/\r?\n>|\r?\nOn .{5,80} wrote:/)[0];
  if(NEGATIVE.test(text))return 'negative';
  if(POSITIVE.test(text))return 'positive';
  return 'neutral';
}
