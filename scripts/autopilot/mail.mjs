/** Gmail TLS transport. Reply scans are incremental and report incomplete backlog. */
import tls from 'node:tls';
import {randomId} from './util.mjs';
const CRLF='\r\n';
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const encWord=s=>/^[\x20-\x7e]*$/.test(s)?s:`=?UTF-8?B?${b64(s)}?=`;
const wrap76=s=>s.replace(/.{1,76}/g,'$&\r\n').trimEnd();
const cleanHeader=s=>String(s||'').replace(/[\r\n]+/g,' ').trim();
export function buildMessage({from,fromName,to,subject,text,messageId,inReplyTo,references,unsubscribe}){
 const headers=[`From: ${fromName?`"${encWord(cleanHeader(fromName)).replace(/"/g,'')}" `:''}<${from}>`,`To: <${cleanHeader(to)}>`,
 `Subject: ${encWord(cleanHeader(subject))}`,`Date: ${new Date().toUTCString().replace('GMT','+0000')}`,`Message-ID: ${messageId}`,
 ...(inReplyTo?[`In-Reply-To: ${inReplyTo}`,`References: ${references||inReplyTo}`]:[]),
 ...(unsubscribe?[`List-Unsubscribe: <mailto:${from}?subject=unsubscribe>`]:[]),
 'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64'];
 return headers.join(CRLF)+CRLF+CRLF+wrap76(b64(text.replace(/\r?\n/g,CRLF)))+CRLF;
}
export const newMessageId=domain=>`<lf-${Date.now().toString(36)}-${randomId(8)}@${domain}>`;
function defaultConnect(host,port){return tls.connect({host,port,servername:host,timeout:30000})}
class Wire{
 constructor(socket){this.s=socket;this.buf='';this.waiters=[];this.closed=false;socket.setEncoding?.('utf8');
  socket.on('data',d=>{this.buf+=d;this.pump()});socket.on('error',e=>{this.err=e;this.pump()});socket.on('close',()=>{this.closed=true;this.pump()});
  socket.on('timeout',()=>{this.err=Error('mail socket timeout');socket.destroy?.();this.pump()});
 }
 pump(){while(this.waiters.length){const w=this.waiters[0],r=w.test(this.buf);
  if(r!=null){this.buf=this.buf.slice(r.consumed);this.waiters.shift();w.resolve(r.value);continue}
  if(this.err||this.closed){this.waiters.shift();w.reject(this.err||Error('mail connection closed'));continue}break;
 }}
 wait(test){return new Promise((resolve,reject)=>{this.waiters.push({test,resolve,reject});this.pump()})}
 write(s){this.s.write(s)}end(){try{this.s.end()}catch{}}
}
function smtpReply(buf){
 const lines=buf.split(CRLF);let consumed=0;
 for(let i=0;i<lines.length-1;i++){consumed+=lines[i].length+2;const m=lines[i].match(/^(\d{3})([ -])/);if(m&&m[2]===' ')return {consumed,value:{code:Number(m[1]),text:lines.slice(0,i+1).join('\n')}}}return null;
}
export async function smtpSend({user,pass,from,to,raw,connect=defaultConnect,host='smtp.gmail.com',port=465}){
 const w=new Wire(connect(host,port));
 const cmd=async(line,ok)=>{if(line!=null)w.write(line+CRLF);const r=await w.wait(smtpReply);if(!ok.includes(r.code))throw Error(`SMTP ${r.code}: ${r.text.slice(0,160)}`);return r};
 try{await cmd(null,[220]);await cmd('EHLO linkforge.autopilot',[250]);await cmd('AUTH PLAIN '+b64(`\0${user}\0${pass}`),[235]);
  await cmd(`MAIL FROM:<${from}>`,[250]);await cmd(`RCPT TO:<${to}>`,[250,251]);await cmd('DATA',[354]);
  const r=await cmd(raw.replace(/\r?\n/g,CRLF).split(CRLF).map(l=>l.startsWith('.')?'.'+l:l).join(CRLF)+CRLF+'.',[250]);
  await cmd('QUIT',[221]).catch(()=>{});return {accepted:true,response:r.text.slice(0,120)};
 }finally{w.end()}
}
const quote=s=>'"'+String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
export class Imap{
 constructor({user,pass,connect=defaultConnect,host='imap.gmail.com',port=993}){Object.assign(this,{user,pass,connect,host,port});this.n=0}
 async open(){this.w=new Wire(this.connect(this.host,this.port));try{
  await this.w.wait(b=>{const i=b.indexOf(CRLF);return i>=0?{consumed:i+2,value:b.slice(0,i)}:null});await this.cmd(`LOGIN ${quote(this.user)} ${quote(this.pass)}`);
 }catch(e){this.w.end();this.w.s.destroy?.();throw e}return this}
 async cmd(line,{literal}={}){
  const tag='A'+(++this.n).toString().padStart(3,'0');this.w.write(`${tag} ${line}${CRLF}`);
  if(literal!=null){await this.w.wait(b=>{const i=b.indexOf('+'),j=b.indexOf(CRLF,i);return i>=0&&j>=0?{consumed:j+2,value:true}:null});this.w.write(literal+CRLF)}
  const done=new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)([^\\r\\n]*)\\r\\n`);
  const out=await this.w.wait(b=>{const m=b.match(done);return m?{consumed:m.index+m[0].length,value:{status:m[2],text:b.slice(0,m.index),detail:m[3]}}:null});
  if(out.status!=='OK')throw Error(`IMAP ${line.split(' ')[0]} ${out.status}${out.detail}`.slice(0,160));return out.text;
 }
 async draftsMailbox(){const list=await this.cmd('LIST "" "*"'),m=list.split(CRLF).find(l=>/\\Drafts/.test(l));return m?(m.match(/"([^"]+)"\s*$/)||m.match(/(\S+)\s*$/))[1]:'[Gmail]/Drafts'}
 async appendDraft(raw){const box=await this.draftsMailbox();await this.cmd(`APPEND ${quote(box)} (\\Draft \\Seen) {${Buffer.byteLength(raw,'utf8')}}`,{literal:raw});return box}
 async recentHeaders(sinceDate,{max=400,cursor}={}){
  const list=await this.cmd('LIST "" "*"');const all=list.split(CRLF).find(l=>/\\All\b/.test(l));
  const mailbox=all?((all.match(/"([^"]+)"\s*$/)||[])[1]||'INBOX'):'INBOX';
  const selected=await this.cmd(mailbox==='INBOX'?'SELECT INBOX':`SELECT ${quote(mailbox)}`);
  const validity=selected.match(/\[UIDVALIDITY\s+(\d+)\]/i)?.[1]||'';
  const usable=!!validity&&cursor?.mailbox===mailbox&&cursor.uidvalidity===validity&&Number.isSafeInteger(cursor.uid)&&cursor.uid>=0;
  const after=usable?cursor.uid:0,since=sinceDate.toUTCString().split(' ').slice(1,4).join('-');
  const found=await this.cmd(usable?`UID SEARCH UID ${after+1}:*`:`UID SEARCH SINCE ${since}`);
  if(!/(?:^|\r\n)\* SEARCH(?:[ \t]+\d+)*[ \t]*(?:\r\n|$)/.test(found))throw Error('IMAP search response missing');
  const allUids=(found.match(/\* SEARCH([\d ]*)/)?.[1]||'').trim().split(/\s+/).map(Number).filter(n=>Number.isSafeInteger(n)&&n>after).sort((a,b)=>a-b);
  const uids=[...new Set(allUids)].slice(0,Math.max(1,Math.min(400,max))),out=[];
  if(uids.length){const raw=await this.cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT IN-REPLY-TO REFERENCES AUTO-SUBMITTED MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.32768>)`);out.push(...parseFetch(raw))}
  const parsed=uids.every(u=>out.some(m=>Number(m.uid)===u));
  const result=out.filter(m=>m.from!==String(this.user||'').toLowerCase());
  result.complete=!!validity&&parsed&&allUids.length<=uids.length;
  if(validity&&parsed)result.cursor={mailbox,uidvalidity:validity,uid:uids.at(-1)||after};
  return result;
 }
 async close(){try{await Promise.race([this.cmd('LOGOUT'),new Promise(r=>setTimeout(r,3000).unref?.())])}catch{}this.w?.end()}
}
/** Decode bounded multipart/plain replies; attachments are not interpreted as replies. */
export function decodeReplyBody(body,encoding='',contentType='',depth=0){
 let text=String(body||'').slice(0,32768);if(depth>4)return '';
 const boundary=contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
 if(/multipart\//i.test(contentType)&&boundary){
  const parts=text.split('--'+(boundary[1]||boundary[2])).slice(1,25),decoded=[];
  for(const part of parts){const i=part.indexOf('\r\n\r\n');if(i<0)continue;const h=part.slice(0,i);
   if(/content-disposition:\s*attachment/i.test(h)||/content-type:\s*(?:image|application)\//i.test(h))continue;
   const ct=h.match(/content-type:\s*([^\r\n]+)/i)?.[1]||'text/plain',en=h.match(/content-transfer-encoding:\s*([^\r\n]+)/i)?.[1]||'';
   decoded.push(decodeReplyBody(part.slice(i+4),en,ct,depth+1));
  }
  return decoded.join('\n');
 }
 if(/base64/i.test(encoding)){const b=text.replace(/\s/g,'');text=/^[a-z0-9+/]*={0,2}$/i.test(b)?Buffer.from(b,'base64').toString('utf8'):''}
 else if(/quoted-printable/i.test(encoding))text=Buffer.from(text.replace(/=\r?\n/g,'').replace(/=([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))),'latin1').toString('utf8');
 if(/text\/html/i.test(contentType))text=text.replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi,'').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi,'').replace(/<br\b[^>]*>|<\/(?:p|div)>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&');
 return text.trim();
}
export function parseFetch(raw){
 const out=[];for(const part of raw.split(/(?=^\* \d+ FETCH )/m)){
  if(!part.startsWith('* '))continue;
  const header=(part.match(/BODY\[HEADER\.FIELDS[^\]]*\] \{\d+\}\r\n([\s\S]*?)\r\n\r\n/)||[])[1]||'';
  const body=(part.match(/BODY\[TEXT\]<0> \{\d+\}\r\n([\s\S]*?)(?:\)(?:\r\n|$)|$)/)||[])[1]||'';
  const unfolded=header.replace(/\r\n[ \t]+/g,' '),h=k=>(unfolded.match(new RegExp('^'+k+':\\s*(.*)$','im'))||[])[1]||'';
  const from=(h('From').match(/<([^>]+)>/)||[])[1]||h('From').trim();
  out.push({uid:part.match(/\bUID\s+(\d+)/)?.[1]||'',messageId:h('Message-ID'),from:from.toLowerCase(),subject:h('Subject'),inReplyTo:h('In-Reply-To'),references:h('References'),autoSubmitted:h('Auto-Submitted'),body:decodeReplyBody(body,h('Content-Transfer-Encoding'),h('Content-Type'))});
 }return out;
}
const NEGATIVE=/\b(unsubscribe|remove me|take me off|stop (emailing|contacting)|do not (email|contact)|don't (email|contact)|not interested|no thanks|no thank you|please stop|spam)\b/i;
const POSITIVE=/\b(added|i've added|i have added|updated the (page|post|article)|included (it|your)|linked|great resource|happy to (add|include)|sounds good|will add|we'll add)\b/i;
export function classifyReply(msg){
 if(/mailer-daemon|postmaster|mail delivery subsystem/i.test(msg.from)||/delivery status notification|undeliverable|failure notice|returned mail/i.test(msg.subject))return 'bounce';
 if(/auto-replied|auto-generated/i.test(msg.autoSubmitted)||/out of (the )?office|automatic reply|auto(matic)?[- ]?reply/i.test(msg.subject))return 'auto';
 const text=String(msg.body||'').split(/\r?\n>|\r?\nOn .{5,160} wrote:|\r?\n-{2,}\s*Original Message/i)[0].trim();
 if(NEGATIVE.test(text)||/^(?:no|nope|stop)[.!\s]*$/i.test(text)||/^(?:re:\s*)?unsubscribe[.!\s]*$/i.test(msg.subject||''))return 'negative';
 if(POSITIVE.test(text))return 'positive';return 'neutral';
}
