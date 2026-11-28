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
 * The header marks mail as bulk, so outreach adds it only when the owner turns it on (LIST_UNSUBSCRIBE_HEADER=on,
 * config.listUnsubscribe); the body's closing sentence is the opt-out either way. Old emails' ids keep matching.
 */
export function unsubscribeHeader(from,messageId){
 const id=cleanHeader(messageId).replace(/^<|>$/g,'');
 return `List-Unsubscribe: <mailto:${cleanHeader(from)}?subject=unsubscribe${/^lf-[a-z0-9.@-]+$/i.test(id)?'%20'+id:''}>`;
}
/** A plain-text email. `unsubscribe: true` adds the List-Unsubscribe header (callers pass config.listUnsubscribe). */
export function buildMessage({from,fromName,to,subject,text,messageId,inReplyTo,references,unsubscribe=false}){
 const headers=[`From: ${fromName?`"${encWord(cleanHeader(fromName)).replace(/"/g,'')}" `:''}<${from}>`,`To: <${cleanHeader(to)}>`,
 `Subject: ${encWord(cleanHeader(subject))}`,`Date: ${new Date().toUTCString().replace('GMT','+0000')}`,`Message-ID: ${messageId}`,
 ...(inReplyTo?[`In-Reply-To: ${inReplyTo}`,`References: ${references||inReplyTo}`]:[]),
 ...(unsubscribe===true?[unsubscribeHeader(from,messageId)]:[]),
 'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64'];
 return headers.join(CRLF)+CRLF+CRLF+wrap76(b64(text.replace(/\r?\n/g,CRLF)))+CRLF;
}
/** RFC 2047 encoded words ("=?UTF-8?B?...?=") as plain text, so "Re:" subjects read naturally. */
export function decodeWords(s){
 return String(s||'').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(?:\s+(?==\?))?/gi,(m,cs,enc,t)=>{
  try{const buf=enc.toLowerCase()==='b'?Buffer.from(t,'base64'):Buffer.from(t.replace(/_/g,' ').replace(/=([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))),'latin1');
   return /utf-?8/i.test(cs)?buf.toString('utf8'):buf.toString('latin1')}catch{return m}});
}
/** A subject without Re:/Fwd: prefixes, lower case: how a forwarded or re-sent copy of our email is recognised. */
export const baseSubject=s=>decodeWords(s).replace(/[\r\n]+/g,' ').replace(/^\s*(?:(?:re|aw|sv|antw|fwd?|fw|wg|tr)\s*(?:\[\d+\])?\s*:\s*)+/i,'').replace(/\s+/g,' ').trim().toLowerCase();
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
// Opt-outs, in their own words (quoted text is never read). Every pitch and follow-up closes with one plain sentence on how
// to stop all email ("If it's not a fit, just say so and I won't follow up.", pitch.mjs OPT_OUT; earlier pitches had a P.S.
// saying 'reply "no"'), so "no thanks", "not interested", "not for us", "we'll pass", a reply that starts with no / nope /
// stop / unsubscribe / pass (greeting and signature aside: "No\n\nSent from my iPhone") or one that says it is not a fit is an
// opt-out.
const NEGATIVE=/\b(?:unsubscribe|remove (?:me|us|my (?:e-?mail|address)|our (?:e-?mail|address|site|blog)|this (?:e-?mail|address))|take (?:me|us|my (?:e-?mail|address)|our (?:e-?mail|address)) off|opt (?:me|us) out|opt[- ]?out (?:of|from) (?:your|these|this|further|future|all)\b|(?:please|want to|like to|wish to) opt[- ]?out|stop (?:e-?mailing|contacting|messaging|writing|sending)|(?:do not|don't|dont|never) (?:e-?mail|contact|message|write to|send (?:me|us|any|further|more|another|these|this|them|e-?mails?))|no (?:more|further) (?:e-?mails|messages)|not interested|no,? thanks\b|no,? thank you|please stop|spam|not for us|(?:we|i)(?:'ll| will) pass|pass on this)\b/i;
// A first line that is only a refusal: "No", "Nope, thanks", "Pass." Softer ones ("No need, thanks.", "Not now", "Not right
// now, thanks.") are read like "not a fit" below: an opt-out unless the same reply also says yes.
const LEAD_NO=/^(?:no|nope|nah|stop|unsubscribe|pass)\b(?:[\s,]*(?:thanks|thank you|thx)\b)?\s*(?:[.!,;:\u2013\u2014-]|$)/i;
const LEAD_SOFT_NO=/^(?:no need|not (?:right )?now|not at (?:the|this) (?:moment|time))\b(?:[\s,]*(?:thanks|thank you|thx)\b)?\s*(?:[.!,;:\u2013\u2014-]|$)/i;
// The answers that closing sentence invites, in their words: "not a fit" / "isn't a fit for us" / "doesn't fit us", "not relevant",
// "not suitable", "not a good match", "not for me", "no interest", "please don't follow up", "no need to follow up", "thanks, but
// no". They are opt-outs, unless the same reply also says yes ("not a fit for the intro, so I added it lower down"): that one is
// left to the owner (neutral, a draft at most). Our own conditional ("if it's not a fit", e.g. in a copy quoted without markers)
// and the old P.S. ("Not relevant for you?") are not their answer.
const NOT_A_FIT=/(?<!\bif\s+(?:it'?s|it\s+is|this\s+is|that'?s|this'?s)\s+)\bnot\s+(?:really\s+|quite\s+)?(?:a\s+|the\s+right\s+|the\s+best\s+|a\s+(?:good|great|right)\s+)?(?:fit|match)\b|(?<!\bif\s+(?:it|this|that)\s+)\bisn'?t\s+(?:really\s+|quite\s+)?(?:a\s+|the\s+right\s+|a\s+(?:good|great|right)\s+)?(?:fit|match)\b|\b(?:doesn'?t|does\s+not|don'?t|do\s+not)\s+(?:really\s+|quite\s+)?(?:fit|suit)\s+(?:(?:in\s+)?with\s+)?(?:us|our|my)\b/i;
const SOFT_NO=[NOT_A_FIT,
 /(?<!\bif\s+(?:it'?s|it\s+is|this\s+is|that'?s)\s+)\b(?:not|isn'?t|aren'?t)\s+(?:really\s+|very\s+|that\s+|quite\s+)?(?:relevant|suitable|right\s+for\s+(?:us|me|our))\b(?!\s+for\s+you\b)/i,
 /\bnot\s+(?:really\s+)?for\s+me\b|\bno\s+interest\b/i,
 /(?<!\b(?:if|when|so)\s+(?:you|i)\s+)\b(?:(?:please|pls)\s+)?(?:do\s+not|don'?t|dont)\s+(?:need\s+to\s+)?follow[- ]?up\b|\bno\s+need\s+(?:for\s+(?:a\s+)?|to\s+)follow[- ]?up\b|\bno\s+follow[- ]?ups?\b/i,
 // A standalone "no" in their own words: "Thanks, but no." / "but no thanks" (not "no problem", not "No?").
 /(?:^|[,;:.!\u2013\u2014-][ \t]*|\bbut[ \t]+)no\b(?:[ \t,]+(?:thanks|thank you|thx))?[ \t]*(?:[.!,;:\u2013\u2014-]|$)/im];
// A refusal of the deal itself: "No deal.", "No swap, sorry." An opt-out on its own; with a yes ("happy to add it, no swap
// needed") the yes stands and only the exchange is off (exchangeIntent).
const NO_TO_DEAL=/\bno\s+(?:deal|(?:link\s+)?(?:swaps?|exchanges?))\b/i;
// An explicit refusal to link ("we have never linked to commercial sites", "we don't add links"). Not one that names a time ("until", "yet").
const DECLINE=/\b(?:we|i)(?:'ve|'d|'m|'re| have| do| did| will| would| are| am)?\s*(?:never|don't|do not|doesn't|does not|won't|will not|wouldn't|would not|can't|cannot|can not|couldn't|could not|no longer|not able to|unable to|not)\s+(?:(?:usually|normally|generally|ever|currently|really|typically|accept|do)\s+)?(?:link|add|include|accept (?:links?|external|outside|unsolicited|guest|link|submissions|resources?|suggestions?)|feature|publish|place|take (?:links?|requests|submissions))\w*\b(?![^.!?\n]{0,40}\b(?:until|yet|right now|at the moment|this week|today|tomorrow|before|soon)\b)/i;
// Includes the words of a yes to a 3-way link exchange ("deal", "happy to swap", "works for me"); the swap itself is a condition.
const POSITIVE=/\b(?:added|i've added|i have added|updated the (?:page|post|article)|included (?:it|your)|linked|great resource|happy to (?:add|include|swap|exchange|do (?:that|this|it|the (?:swap|exchange)))|sounds (?:good|fair|great)|will add|(?:i|we)'ll (?:add|include|link)|(?:i|we)(?:'d| would) (?:add|include|link) (?:it|it in|that|this|you|your)|(?:i|we) can (?:do|add|include) (?:that|it|this)|can do that|go ahead|(?:it's|that's|it is|that is) a deal|works for (?:me|us)|let's do (?:it|this|that)|count (?:me|us) in)\b/gi;
const YES_OPENING=/^(?:(?:hi|hello|hey|dear)\b[^\n,!]{0,40}[,!]?\s*)?(?:yes|yep|yeah|sure|absolutely|of course|definitely|deal|agreed)\b(?![\s,]*not\b)/i;
// A yes that a negation in the same clause turns around: "we have never linked", "I haven't added it".
const NEGATION=/(?:\b(?:not|never|no longer|cannot|nor|neither)\b|n't\b)/i;
// Conditions a publisher attaches to a yes. They need the owner's decision, so they are flagged, never auto-handled.
// Over-flagging only costs an owner look; a missed fee or swap could be answered as if it were accepted.
const CONDITIONS=[
 ['paid',/\b(?:fees?|charges?|paid|pay|paying|payment|paypal|pric(?:e|es|ed|ing)|costs?|costing|rates?|invoice|budget|compensat\w*|contribution|donation|sponsor(?:ed|ship)?|usd|eur|gbp|dollars?|euros?)\b|[$\u20ac\u00a3]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:usd|eur|gbp|dollars?|euros?|pounds?|bucks)\b|\bper (?:year|month|post|link|article|placement|insertion)\b/i],
 ['reciprocal',/\b(?:if you (?:can )?(?:mention|link|add|feature|include) (?:to )?(?:us|our|ours|my)\b|mention us|link (?:back )?to us|link back|link to (?:our|my) (?:site|blog|page|website|article|post|resource|shop|store)|add (?:us|ours)\b|in return|in exchange|link exchanges?|exchange links|link swaps?|swap(?:s|ping)?|(?:happy|glad|open) to exchange|(?:do|doing) (?:an |the )?exchange|reciprocal|return the favou?r|a link from your)\b/i],
 ['guest_post',/\b(?:guest[- ]?post(?:s|ing)?|guest (?:articles?|blogs?|contributions?)|write for us|contribute an? (?:article|post)|submit an? (?:article|post))\b/i],
];
// Our message ids (<lf-...>) in any header or text; the List-Unsubscribe mailto may leave them URL-encoded in a subject.
// That mailto (unsubscribeHeader) carries the bare id, so "unsubscribe lf-...@domain" is read as <lf-...@domain> too.
const BARE_UNSUBSCRIBE_ID=/\bunsubscribe\s+(lf-[a-z0-9-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
export const lfIds=s=>{
 const t=String(s||'').replace(/%3C/gi,'<').replace(/%3E/gi,'>').replace(/%40/gi,'@').replace(/%20/g,' ');
 return [...(t.match(/<lf-[^<>\s]+>/g)||[]),...[...t.matchAll(BARE_UNSUBSCRIBE_ID)].map(m=>`<${m[1]}>`)];
};
/**
 * An opt-out by subject alone, whoever sends it: "unsubscribe" (optionally after Re:/Fwd: prefixes), which is what
 * a mail client's unsubscribe button sends from our List-Unsubscribe mailto ("unsubscribe <lf-...>"), or any subject
 * that carries one of our message ids (only that mailto ever puts one there).
 */
export function optOutSubject(subject){
 const s=String(subject||'').replace(/%20/g,' ');
 return /^\s*(?:(?:re|fwd?|fw|aw|wg|tr)\s*:\s*)*unsubscribe\b/i.test(s)||lfIds(s).length>0;
}
// Quoted text starts at a "> " line, an "On ... wrote:" line, an "Original Message" line, or an Outlook header block ("From: ...\nSent: ...").
export function replyText(msg){return String(msg.body||'').split(/\r?\n>|\r?\nOn .{5,160} wrote:|\r?\n-{2,}\s*Original Message|\r?\n[ \t]*From:[^\r\n]{1,200}\r?\n[ \t]*(?:Sent|Date):/i)[0].trim()}
// Where a signature starts: a "--" or "__" line, " -- " in flattened text, or a phone/app footer.
const SIGNATURE=/(?:^|\n)[ \t]*(?:--|__+)[ \t]*(?:\n|$)|\s--\s|(?:^|\s)(?:sent from my|sent from (?:mail|yahoo|outlook|gmail|samsung)|get outlook for)\b/i;
/** Their own words without the signature, with typographic apostrophes made plain. */
export function ownText(msg){
 const t=replyText(msg).replace(/\r\n?/g,'\n').replace(/[\u2018\u2019]/g,"'"),i=t.search(SIGNATURE);
 return (i>=0?t.slice(0,i):t).trim();
}
/** The first line they wrote, after any greeting ("Hi Alex,"). */
const leadOf=own=>own.replace(/^(?:hi|hello|hey|dear)\b[^\n,!.]{0,40}[,!.]?[ \t]*\n?/i,'').trim().split('\n')[0].trim();
/** A yes that no negation in the same clause turns around. */
function affirmative(text){
 if(YES_OPENING.test(text))return true;
 for(const m of text.matchAll(POSITIVE)){const before=text.slice(Math.max(0,m.index-30),m.index).split(/[,;:.!?\n]/).pop();if(!NEGATION.test(before))return true}
 return false;
}
export function replyCondition(msg){return replyConditions(msg)[0]||null}
/** Every condition the reply raises, strongest first by list order (a fee, then a link back, then a guest post). */
export function replyConditions(msg){const t=replyText(msg).replace(/[\u2018\u2019]/g,"'");return CONDITIONS.filter(([,re])=>re.test(t)).map(([k])=>k)}
// Where the link back to them would come from, in their words. Read per sentence, so their own link ("I'll add it on our
// resources page") is never taken for ours: the link back named ("link back", "return link", "link to us", "a link from your
// shoe guide", "you link") with a place right after it ("from", "on", "via", "has to come from"), or, in a sentence about a
// link, swap or exchange, a preference ("prefer", "rather", "the same site", "from your running site", "comes from"; "instead"
// only next to the link back). Unless they name the site we offered (C), any of it is a counter: the owner decides (fail closed).
const LINK_BACK=String.raw`\b(?:link(?:s|ed|ing)?\s+back|return\s+link|back-?links?|link(?:s|ing)?\s+(?:back\s+)?to\s+(?:us|me|my|our|mine|ours)\b|link(?:s|ing)?\s+(?:back\s+)?from\s+(?:you|your)\b|you(?:'d|'ll|\s+would|\s+will|\s+can|\s+could)?\s+(?:also\s+)?link\b)`;
const NOT_OURS=String.raw`(?!(?:other|separate|second|sister|side|end|part)\b)`;
const RETURN_PLACE=new RegExp(LINK_BACK+String.raw`[^.!?\n]{0,60}?\b(?:from|on|via|placed|hosted|go(?:es)?\s+on|sits?\s+on|(?:be|is)\s+on|come\s+from)\b|\blink(?:s|ing)?\s+(?:back\s+)?from\s+your\s+`+NOT_OURS,'i');
const RETURN_PREFER=new RegExp(String.raw`\b(?:prefer\w*|rather|comes?\s+from|same\s+(?:site|website|domain|blog|page)|(?:from|on|via)\s+your\s+`+NOT_OURS+String.raw`(?:[\w'-]+\s+){0,3}?(?:site|website|blog|domain|homepage|page|guide|tool|finder|one|article|post)|only\s+(?:do\s+)?(?:swaps?|exchanges?|links?)\s+(?:with|from))\b`,'i');
const LINKISH=/\b(?:link\w*|backlinks?|swap\w*|exchange\w*|in return|reciprocal\w*)\b/i;
const sentencesIn=t=>String(t||'').split(/(?<=[.!?])\s+|\n+/);
/** Their reply says where the link back to them should come from (see above). */
export const returnWhere=text=>sentencesIn(String(text||'').replace(/[\u2018\u2019]/g,"'")).some(s=>RETURN_PLACE.test(s)||LINKISH.test(s)&&RETURN_PREFER.test(s)||new RegExp(LINK_BACK,'i').test(s)&&/\binstead\b/i.test(s));
// Words that put a condition on the link back ("but", "prefer", "only", "must", "as long as"): an automatic confirmation is
// never sent for such a reply unless it names the site we offered.
const RETURN_IF=/\b(?:but|only|must|has\s+to|have\s+to|had\s+to|as\s+long\s+as|provided|on\s+condition|prefer\w*|rather|instead|unless|not\s+the|not\s+from|not\s+on)\b/i;
// They will link but want nothing back: the exchange is off, the yes stands.
const NO_EXCHANGE=/\b(?:no (?:link )?(?:exchanges?|swaps?)|no deal|no need (?:for|to) (?:a |the |any )?(?:link back|return link|link exchange|swap|exchange|return the favou?r)|(?:don't|do not|doesn't|does not) need (?:a |the |any )?(?:link back|return link|link in return|swap|exchange)|without (?:a |the |any )?(?:link back|return link|swap|exchange)|not interested in (?:a |the |any )?(?:link )?(?:exchanges?|swaps?))\b/i;
const DIRECT=/\b(?:same (?:site|website|domain|blog|page)|direct(?:ly)?|(?:the|that) (?:page|tool|guide|article) you (?:sent|mentioned|shared|suggested)|(?:the\s+)?(?:site|page|domain|one)\s+(?:i|we)(?:'m|'re| am| are)?\s+(?:linking|link)\s+to|your\s+(?!(?:other|separate|second|sister|partner)\b)(?:[\w-]+\s+){0,2}?(?:site|website|blog|domain|homepage))\b/i;
const DOMAINS=/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|uk|de|fr|es|it|nl|eu|info|blog|site|online|app|dev|me|us|ca|au|nz|in|ch|at|be|se|no|dk|fi|pl|cz|ie|pt|gr|shop|store|tech|xyz|example)\b/gi;
const bareHost=s=>String(s||'').toLowerCase().replace(/^https?:\/\//,'').split(/[\/?#:]/)[0].replace(/^www\./,'');
const stemOf=d=>{const s=bareHost(d).split('.')[0]||'';return s.length>=5?s:''};
const under=(h,d)=>!!d&&(h===d||h.endsWith('.'+d));
// A site's name however they write it: "gearuptofit.com", "gearuptofit", "Gear Up To Fit", "GearUpToFit", "gear-up-to-fit".
const squash=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const BROAD=new Set('about best free guide page site tool tools with your from this that their them they what when where which your blog post article review list'.split(' '));
/** Does their text name this site (domain, name or name written in words), or, for C, the title of the page we offered? */
function namesSite(text,d,title=''){
 const low=String(text).toLowerCase(),stem=stemOf(d),t=String(title||'').trim().toLowerCase();
 return !!d&&(low.includes(d)||!!stem&&(new RegExp(`\\b${stem}\\b`,'i').test(low)||squash(low).includes(stem)))||t.length>=8&&low.includes(t);
}
/**
 * How a reply answers our 3-way exchange offer (`offer`: p.exchange, `site`: the site they were pitched, A; `domain`:
 * their own domain; `assetTitle`: the title of our page on A). 'owner': a fee or a guest post was raised (the owner decides).
 * 'counter': they want the link back from A itself (by domain, name or "Gear Up To Fit"), "the same site", "directly",
 * "your site", our page they were sent, or another site than the one offered; or they say where the link back should come
 * from without naming the site we offered (the owner decides; any doubt lands here, fail closed). 'decline': they want
 * nothing back ("no exchange needed"); the exchange is off, their yes stands. 'question': they ask or talk about the link
 * back without a yes (a neutral reply never accepts). 'accept': a positive reply, including the link back we already offered
 * ("sure, if you link back", "deal", "happy to swap"). null: nothing about the exchange (a plain "thanks, I'll look").
 * `sentiment`/`question` are classifyReply/isQuestion for the same message.
 */
export function exchangeIntent(msg,{offer={},site='',domain='',sentiment='neutral',question=false,assetTitle=''}={}){
 const conds=replyConditions(msg);
 if(conds.includes('paid')||conds.includes('guest_post'))return 'owner';
 const text=ownText(msg),low=text.toLowerCase();
 const A=bareHost(site),C=bareHost(offer.partner_site),B=bareHost(domain);
 // "Your other site" / "the separate site" is how our offer described C: they name what we offered.
 const partner=namesSite(text,C,offer.partner_title)||/\b(?:your|the|that)\s+(?:other|separate|second|sister)\s+(?:site|website|blog)\b/i.test(text);
 if(NO_EXCHANGE.test(text))return 'decline';
 const where=returnWhere(text),returnTalk=conds.includes('reciprocal')||where;
 // Another domain in their words that is neither theirs, nor the one we offered, nor A (A is judged on its own below).
 const others=[...new Set((low.match(DOMAINS)||[]).map(bareHost))].filter(h=>!under(h,B)&&!under(B,h)&&!under(h,C)&&!under(h,A));
 // A link to them "from A" / "on A" is a request for a link from A, even when the site we offered is named too.
 const stemA=stemOf(A),fromA=!!A&&[...text.matchAll(/\b(?:from|on|via)\s+(?:the\s+)?(?:https?:\/\/)?(?:www\.)?([^.!?\n]{0,40})/gi)].some(m=>{const w=squash(m[1]);return w.startsWith(squash(A))||!!stemA&&w.startsWith(stemA)});
 // Words of our page's title on A ("shoe", "finder") said about the link back read like A itself.
 const aWords=String(assetTitle||'').toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>=4&&!BROAD.has(w));
 const aboutA=namesSite(text,A)||DIRECT.test(text)||where&&aWords.some(w=>new RegExp(`\\b${w}`,'i').test(low));
 if(returnTalk&&(fromA||others.length||!partner&&aboutA))return 'counter';
 // Where the link back comes from, without the site we offered: a counter, unless it is only a question about it.
 if(where&&!partner)return question&&!RETURN_IF.test(text)?'question':'counter';
 if(sentiment==='positive')return 'accept';
 // A neutral reply never accepts an open offer; about a deal already agreed, mentioning the link back is just the deal.
 if(conds.includes('reciprocal')&&offer.status&&offer.status!=='offered')return 'accept';
 return returnTalk?'question':null;
}
/**
 * May a confirmation of the 3-way exchange go out automatically for this reply? Only when it names the site we offered, or
 * is a plain yes that says nothing about where the link back comes from and attaches no "but", "prefer", "only", "must",
 * "has to" or "as long as"; and never when it adds terms of its own (dofollow, a placement, a deadline, who goes first).
 * Everything else is a draft for the owner.
 */
// Terms beyond the deal we offered, even next to C's name: a link attribute, a placement, a deadline, who goes first.
const EXTRA_TERMS=/\b(?:do-?follow|no-?follow|follow(?:ed)? links?|permanent\w*|forever|home ?page|sidebar|footer|site-?wide|anchor|within|deadline|asap|urgent\w*|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|the end)|this week|next week|first)\b/i;
export function exchangeAutoOk(text,offer={}){
 const t=String(text||'').replace(/[‘’]/g,"'");
 if(EXTRA_TERMS.test(t))return false;
 if(namesSite(t,bareHost(offer.partner_site),offer.partner_title))return true;
 return !returnWhere(t)&&!RETURN_IF.test(t);
}
const QUESTION_OPENER=/(?:^|[.!?:\n]\s*)(?:(?:hi|hello|hey|dear)\b[^\n,!]{0,40}[,!]\s*)?(?:(?:could|can|would|will|do|does|did|is|are|have|has)\s+(?:you|we|i|there|your|the)\b|(?:what|which|how|where|when|why|who)(?:'s|\s+(?:is|are|was|were|do|does|did|would|should|can|could|kind|type|much|many|long|about|exactly)\b))/i;
/** The reply asks us something (a "?" in their own text, or a question opener). It never changes the sentiment. */
export function isQuestion(msg){
 const t=replyText(msg).replace(/https?:\/\/\S+/g,' ');
 return /\?/.test(t)||QUESTION_OPENER.test(t);
}
// Machine answers that carry no Auto-Submitted header: a contact form's acknowledgement mailed to the address the owner typed
// in (wordpress@, noreply@, forms@...), "Thank you for contacting us / we have received your message". Not the publisher's
// answer: they never take a contact-form match, so the editor's real reply later is still recorded.
const ROBOT_SENDER=/^(?:no-?reply|do-?not-?reply|donotreply|wordpress|wp-?forms?|forms?|form-?submissions?|notifications?|notify|mailer|automated|auto-?(?:confirm\w*|responder)|contact-?form\w*)(?:[+._-][^@]*)?@/i;
const ACK_SUBJECT=/\b(?:thank(?:s| you) for (?:contacting|reaching out|getting in touch|your (?:message|submission|enquiry|inquiry|email|request))|(?:we(?:'ve| have)?|i(?:'ve| have)?) received your (?:message|submission|enquiry|inquiry|request|email)|we got your (?:message|email)|(?:submission|message|enquiry|inquiry) (?:received|confirmation)|auto(?:matic)?[- ]?(?:response|confirmation))\b/i;
const ACK_BODY=/\b(?:thank(?:s| you) for (?:contacting|reaching out|getting in touch|your (?:message|submission|enquiry|inquiry))|(?:we(?:'ve| have)?|i(?:'ve| have)?) received your (?:message|submission|enquiry|inquiry|request))\b[\s\S]{0,240}?\b(?:get back to you|respond|reply to you|be in touch|contact you|answer)\b/i;
export function classifyReply(msg){
 if(/mailer-daemon|postmaster|mail delivery subsystem/i.test(msg.from)||/delivery status notification|undeliverable|failure notice|returned mail/i.test(msg.subject))return 'bounce';
 if(optOutSubject(msg.subject))return 'negative';
 if(/auto-replied|auto-generated/i.test(msg.autoSubmitted)||/out of (the )?office|automatic reply|auto(matic)?[- ]?reply/i.test(msg.subject))return 'auto';
 const text=replyText(msg).replace(/[\u2018\u2019]/g,"'"),lead=leadOf(ownText(msg)),optOut=NEGATIVE.test(text)||LEAD_NO.test(lead);
 const soft=SOFT_NO.some(re=>re.test(text))||LEAD_SOFT_NO.test(lead);
 // A no-reply or form-system sender is a machine, unless its text says no (a help desk relaying a person's opt-out): an
 // opt-out is honoured whoever sends it.
 if(ROBOT_SENDER.test(String(msg.from||'').trim())&&!optOut&&!soft)return 'auto';
 // "Thanks for contacting us, we have received your message and will get back to you": an acknowledgement, not an answer.
 // A person's words that say no are still read as an opt-out, a yes as a yes, and a question as a question.
 const said=optOut||soft||affirmative(text)||isQuestion(msg);
 if(!said&&(ACK_SUBJECT.test(decodeWords(msg.subject||''))||ACK_BODY.test(text)&&text.length<500))return 'auto';
 if(optOut)return 'negative';
 // A refusal is declined, never positive; one that also says yes is left to the owner (neutral: a draft at most).
 const yes=affirmative(text);
 if(soft)return yes?'neutral':'negative';
 if(NO_TO_DEAL.test(text)&&!yes)return 'negative';
 if(DECLINE.test(text))return yes?'neutral':'negative';
 return yes?'positive':'neutral';
}