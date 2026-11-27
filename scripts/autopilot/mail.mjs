/** Gmail TLS transport. Reply scans are incremental and report incomplete backlog. */
import tls from 'node:tls';
import {randomId} from './util.mjs';
const CRLF='\r\n';
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const encWord=s=>/^[\x20-\x7e]*$/.test(s)?s:`=?UTF-8?B?${b64(s)}?=`;
const wrap76=s=>s.replace(/.{1,76}/g,'$&\r\n').trimEnd();
const cleanHeader=s=>String(s||'').replace(/[\r\n]+/g,' ').trim();
/**
 * The opt-out address carries this message's own lf- id in its subject ("unsubscribe lf-..."), so an unsubscribe
 * sent by a mail client's button, even from a forwarding address, still matches the email it answers.
 * mailto only: no one-click POST endpoint exists, so List-Unsubscribe-Post is deliberately not sent.
 */
export function unsubscribeHeader(from,messageId){
 const id=cleanHeader(messageId).replace(/^<|>$/g,'');
 return `List-Unsubscribe: <mailto:${cleanHeader(from)}?subject=unsubscribe${/^lf-[a-z0-9.@-]+$/i.test(id)?'%20'+id:''}>`;
}
export function buildMessage({from,fromName,to,subject,text,messageId,inReplyTo,references,unsubscribe}){
 const headers=[`From: ${fromName?`"${encWord(cleanHeader(fromName)).replace(/"/g,'')}" `:''}<${from}>`,`To: <${cleanHeader(to)}>`,
 `Subject: ${encWord(cleanHeader(subject))}`,`Date: ${new Date().toUTCString().replace('GMT','+0000')}`,`Message-ID: ${messageId}`,
 ...(inReplyTo?[`In-Reply-To: ${inReplyTo}`,`References: ${references||inReplyTo}`]:[]),
 ...(unsubscribe?[unsubscribeHeader(from,messageId)]:[]),
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
/**
 * Every failure carries err.stage ('connect' | 'auth' | 'mail_from' | 'rcpt' | 'data' | 'after_data') and err.code
 * (the SMTP reply code, or the socket error code). Before 'data' nothing can have been delivered; the caller
 * treats only 'data' and 'after_data' failures as "delivery uncertain".
 */
export async function smtpSend({user,pass,from,to,raw,connect=defaultConnect,host='smtp.gmail.com',port=465}){
 let stage='connect',w=null;
 const cmd=async(line,ok)=>{if(line!=null)w.write(line+CRLF);const r=await w.wait(smtpReply);
  if(!ok.includes(r.code)){const e=Error(`SMTP ${r.code}: ${r.text.slice(0,160)}`);e.code=r.code;throw e}return r};
 try{w=new Wire(connect(host,port));await cmd(null,[220]);await cmd('EHLO linkforge.autopilot',[250]);
  stage='auth';await cmd('AUTH PLAIN '+b64(`\0${user}\0${pass}`),[235]);
  stage='mail_from';await cmd(`MAIL FROM:<${from}>`,[250]);
  stage='rcpt';await cmd(`RCPT TO:<${to}>`,[250,251]);
  stage='data';await cmd('DATA',[354]);
  stage='after_data';const r=await cmd(raw.replace(/\r?\n/g,CRLF).split(CRLF).map(l=>l.startsWith('.')?'.'+l:l).join(CRLF)+CRLF+'.',[250]);
  await cmd('QUIT',[221]).catch(()=>{});return {accepted:true,response:r.text.slice(0,120)};
 }catch(e){
  const err=e instanceof Error?e:Error(String(e));
  if(typeof err.stage!=='string')err.stage=stage;
  err.code??=/timeout/i.test(err.message)?'timeout':'connection';
  throw err;
 }finally{w?.end()}
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
  if(uids.length){const raw=await this.cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE IN-REPLY-TO REFERENCES AUTO-SUBMITTED MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.32768>)`);out.push(...parseFetch(raw))}
  const parsed=uids.every(u=>out.some(m=>Number(m.uid)===u));
  const result=out.filter(m=>m.from!==String(this.user||'').toLowerCase());
  result.complete=!!validity&&parsed&&allUids.length<=uids.length;
  if(validity&&parsed)result.cursor={mailbox,uidvalidity:validity,uid:uids.at(-1)||after};
  return result;
 }
 /**
  * Who we emailed recently, read from Gmail's own Sent folder (read-only, headers only). This is the
  * ground truth for "already contacted": it survives a lost or overwritten state file.
  */
 async sentRecipients(sinceDate,{max=500,before=null}={}){
  const list=await this.cmd('LIST "" "*"');const line=list.split(CRLF).find(l=>/\\Sent\b/.test(l));
  const mailbox=line?((line.match(/"([^"]+)"\s*$/)||line.match(/(\S+)\s*$/)||[])[1]):'[Gmail]/Sent Mail';
  await this.cmd(`EXAMINE ${quote(mailbox)}`);
  const day=d=>d.toUTCString().split(' ').slice(1,4).join('-'),since=day(sinceDate);
  // `before` (exclusive, whole days) pages further back; `complete` says whether every match was returned (newest `max` otherwise).
  const found=await this.cmd(`UID SEARCH SINCE ${since}${before instanceof Date&&Number.isFinite(before.getTime())?` BEFORE ${day(before)}`:''}`);
  if(!/(?:^|\r\n)\* SEARCH(?:[ \t]+\d+)*[ \t]*(?:\r\n|$)/.test(found))throw Error('IMAP sent search response missing');
  const all=(found.match(/\* SEARCH([\d ]*)/)?.[1]||'').trim().split(/\s+/).map(Number).filter(n=>Number.isSafeInteger(n)&&n>0).sort((a,b)=>a-b),uids=all.slice(-Math.max(1,Math.min(1000,max)));
  if(!uids.length)return Object.assign([],{complete:true});
  const out=parseSentHeaders(await this.cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (TO DATE MESSAGE-ID)])`));
  out.complete=uids.length===all.length;return out;
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
/** [{to, at}] from a Sent-folder header fetch: one entry per recipient address per message. */
export function parseSentHeaders(raw){
 const out=[];for(const part of String(raw||'').split(/(?=^\* \d+ FETCH )/m)){
  if(!part.startsWith('* '))continue;
  const header=((part.match(/BODY\[HEADER\.FIELDS[^\]]*\] \{\d+\}\r\n([\s\S]*?)(?:\r\n\r\n|\)\s*$|$)/)||[])[1]||'').replace(/\r\n[ \t]+/g,' ');
  const h=k=>(header.match(new RegExp('^'+k+':\\s*(.*)$','im'))||[])[1]||'';
  const t=Date.parse(h('Date')),at=Number.isFinite(t)?new Date(t).toISOString():null,mid=(h('Message-ID').match(/<[^<>\s]+>/)||[])[0];
  for(const e of new Set((h('To').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)||[]).map(x=>x.toLowerCase())))out.push({to:e,at,...(mid?{message_id:mid}:{})});
 }
 return out;
}
export function parseFetch(raw){
 const out=[];for(const part of raw.split(/(?=^\* \d+ FETCH )/m)){
  if(!part.startsWith('* '))continue;
  const header=(part.match(/BODY\[HEADER\.FIELDS[^\]]*\] \{\d+\}\r\n([\s\S]*?)\r\n\r\n/)||[])[1]||'';
  const body=(part.match(/BODY\[TEXT\]<0> \{\d+\}\r\n([\s\S]*?)(?:\)(?:\r\n|$)|$)/)||[])[1]||'';
  const unfolded=header.replace(/\r\n[ \t]+/g,' '),h=k=>(unfolded.match(new RegExp('^'+k+':\\s*(.*)$','im'))||[])[1]||'';
  const from=(h('From').match(/<([^>]+)>/)||[])[1]||h('From').trim();
  out.push({uid:part.match(/\bUID\s+(\d+)/)?.[1]||'',messageId:h('Message-ID'),from:from.toLowerCase(),subject:h('Subject'),date:h('Date'),inReplyTo:h('In-Reply-To'),references:h('References'),autoSubmitted:h('Auto-Submitted'),body:decodeReplyBody(body,h('Content-Transfer-Encoding'),h('Content-Type'))});
 }return out;
}
const NEGATIVE=/\b(unsubscribe|remove me|take me off|stop (emailing|contacting)|do not (email|contact)|don't (email|contact)|not interested|no thanks|no thank you|please stop|spam)\b/i;
const POSITIVE=/\b(added|i've added|i have added|updated the (page|post|article)|included (it|your)|linked|great resource|happy to (add|include)|sounds good|will add|we'll add|(?:i|we) can (?:do|add|include) (?:that|it|this)|can do that|go ahead)\b/i;
const YES_OPENING=/^(?:(?:hi|hello|hey|dear)\b[^\n,!]{0,40}[,!]?\s*)?(?:yes|yep|yeah|sure|absolutely|of course|definitely)\b/i;
// Conditions a publisher attaches to a yes. They need the owner's decision, so they are flagged, never auto-handled.
const CONDITIONS=[
 ['paid',/\b(?:fees?|charges?|paid|payment|paypal|pricing|our rates?|sponsored|usd|eur|gbp|dollars|euros?)\b|[$€£]\s?\d/i],
 ['reciprocal',/\b(?:if you (?:can )?(?:mention|link|add|feature|include) us|mention us|link (?:back )?to us|link back|in return|in exchange|link exchanges?|exchange links|link swaps?|swap links|reciprocal|return the favou?r|a link from your)\b/i],
 ['guest_post',/\b(?:guest[- ]?post(?:s|ing)?|guest (?:articles?|blogs?|contributions?)|write for us|contribute an? (?:article|post)|submit an? (?:article|post))\b/i],
];
// Our message ids (<lf-...>) in any header or text; the List-Unsubscribe mailto may leave them URL-encoded in a subject.
export const lfIds=s=>String(s||'').replace(/%3C/gi,'<').replace(/%3E/gi,'>').replace(/%40/gi,'@').match(/<lf-[^<>\s]+>/g)||[];
/**
 * An opt-out by subject alone, whoever sends it: "unsubscribe" (optionally after Re:/Fwd: prefixes), which is what
 * a mail client's unsubscribe button sends from our List-Unsubscribe mailto ("unsubscribe <lf-...>"), or any subject
 * that carries one of our message ids (only that mailto ever puts one there).
 */
export function optOutSubject(subject){
 const s=String(subject||'').replace(/%20/g,' ');
 return /^\s*(?:(?:re|fwd?|fw|aw|wg|tr)\s*:\s*)*unsubscribe\b/i.test(s)||lfIds(s).length>0;
}
export function replyText(msg){return String(msg.body||'').split(/\r?\n>|\r?\nOn .{5,160} wrote:|\r?\n-{2,}\s*Original Message/i)[0].trim()}
export function replyCondition(msg){const t=replyText(msg);for(const [k,re] of CONDITIONS)if(re.test(t))return k;return null}
const QUESTION_OPENER=/(?:^|[.!?:\n]\s*)(?:(?:hi|hello|hey|dear)\b[^\n,!]{0,40}[,!]\s*)?(?:(?:could|can|would|will|do|does|did|is|are|have|has)\s+(?:you|we|i|there|your|the)\b|(?:what|which|how|where|when|why|who)(?:'s|\s+(?:is|are|was|were|do|does|did|would|should|can|could|kind|type|much|many|long|about|exactly)\b))/i;
/** The reply asks us something (a "?" in their own text, or a question opener). It never changes the sentiment. */
export function isQuestion(msg){
 const t=replyText(msg).replace(/https?:\/\/\S+/g,' ');
 return /\?/.test(t)||QUESTION_OPENER.test(t);
}
export function classifyReply(msg){
 if(/mailer-daemon|postmaster|mail delivery subsystem/i.test(msg.from)||/delivery status notification|undeliverable|failure notice|returned mail/i.test(msg.subject))return 'bounce';
 if(optOutSubject(msg.subject))return 'negative';
 if(/auto-replied|auto-generated/i.test(msg.autoSubmitted)||/out of (the )?office|automatic reply|auto(matic)?[- ]?reply/i.test(msg.subject))return 'auto';
 const text=replyText(msg);
 if(NEGATIVE.test(text)||/^(?:no|nope|stop)[.!\s]*$/i.test(text))return 'negative';
 if(POSITIVE.test(text)||YES_OPENING.test(text))return 'positive';return 'neutral';
}

