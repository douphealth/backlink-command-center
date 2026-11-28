/**
 * Contact-form queue (stage "forms"). Publishers whose only published route is a contact form get a ready-to-paste
 * message that the owner submits by hand. Nothing is ever submitted automatically and nothing here sends email.
 *  - Up to config.daily NEW messages per UTC day (cfg.forms.daily), best prospects first (link likelihood, then fit).
 *  - The email rules apply where they can: suppressed publishers, publishers contacted in the last 90 days, publishers
 *    that also have a queued email route, DE/AT/CH (unless OUTREACH_DACH=YES) and forms on pages that ask not to be
 *    pitched or that only take sales or support requests are skipped. The form page is fetched at most once per prospect
 *    per cycle, and only when its last check is missing, stale or for another URL.
 *  - New messages wait for a complete, current reply scan and Sent-folder check (opt-outs and earlier emails known).
 *  - Preparing a message counts as contacting the publisher: state.contacted[domain] is set, so it is never also emailed
 *    within 90 days. A 3-way exchange offer the message makes is recorded on the prospect (p.exchange, via 'form').
 *  - A prepared message without a reply after 21 days expires (form_expired) and is never prepared again.
 * Only counts are logged and returned; the message, the form URL and the offer stay in the sealed vault.
 */
import {fetchPage,hostOf,sameSite,stripTags,normUrl,DAY} from './util.mjs';
import {contactForm,QUALIFY_VERSION} from './prospect.mjs';
import {isSuppressed,jurisdictionHold,normalizeEmail} from './recipient-policy.mjs';
import {bestPitchAsset,pitchable} from './assets.mjs';
import {assetStats,linkLikelihood} from './learn.mjs';
import {assetFacts,isListPage} from './pitch.mjs';
import * as copy from './pitch.mjs';

export const FORM_EXPIRE_DAYS=21,FORM_CHECK_VERSION=1,FORM_WORDS=[60,100];
const CONTACT_DAYS=90,RECHECK_DAYS=3,MAX_TRIES=3,SCAN_MAX_AGE=25*60e3;
/** The closing sentence that says how to stop all email. The copy track's OPT_OUT (pitch.mjs) is used once it exports one. */
export const FORM_OPT_OUT="If it's not a fit, just say so and I won't follow up.";
export const formOptOut=()=>{const s=typeof copy.OPT_OUT==='string'?copy.OPT_OUT.replace(/\s+/g,' ').trim():'';
  return s&&s.length<=160&&!/reply\s+["“]?no\b|^p\.?\s?s\.?\b/i.test(s)?s:FORM_OPT_OUT};
// Titles come from pages: bracketed tags ("[2026]", "{draft}", stray markup) are dropped so they never read as placeholders.
const short=(s,n=60)=>{s=String(s||'').replace(/\[[^\]]*\]|\{[^}]*\}|<[^>]*>/g,' ').split(/\s[|–—-]\s/)[0].replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,'')+'…':s};
const firstName=a=>{const f=String(a||'').trim().split(/\s+/)[0]||'';return /^\p{L}[\p{L}'-]{1,30}$/u.test(f)?f:''};
const sentence=s=>s?s[0].toUpperCase()+s.slice(1)+(/[.!?]$/.test(s)?'':'.'):'';
const EMAIL=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
export const wordCount=s=>String(s||'').split(/\s+/).filter(w=>/[\p{L}\p{N}]/u.test(w)).length;

/* ---------- Is this form a route for an editorial suggestion? ---------- */
// "No solicitations", "please don't pitch", "this form is not for SEO offers", "we don't accept guest posts", and the
// do-not-pitch notices the email rules already honour (recipient-policy.mjs, rule 8). Over-matching only skips a form.
const NO_SOLICIT=new RegExp([
  '\\bno (?:unsolicited |sales |marketing |seo |link |guest post |sponsored |backlink |advertising |promotional )?(?:solicitations?|soliciting|pitches|submissions)\\b',
  '\\bno (?:link|guest[- ]?post|sponsored(?: post)?|backlink|link exchange|link insertion|seo|outreach|marketing|sales|advertising|promotional)s? (?:requests|pitches|e-?mails|messages|inquiries|enquiries|offers)\\b',
  // An instruction to the reader ("please don't pitch us"), not the site's own promise ("we never spam", "we don't spam you").
  "(?<!\\b(?:we|i|we'll|we will)\\s)\\b(?:do not|don't|dont) (?:pitch|solicit|spam)\\b","\\bplease (?:do not|don't|dont|never) (?:pitch|solicit|spam)\\b",'\\bdo not contact\\b',
  "\\b(?:do not|don't|dont|please don't|please do not) use this (?:form|page) (?:to|for) (?:solicit\\w*|sell\\w*|pitch\\w*|advertis\\w*|promot\\w*|marketing|seo|link\\w*|guest|sponsor\\w*|business (?:offers|proposals)|partnerships?)\\b",
  '\\bthis (?:form|page) is not (?:for|intended for|meant for) (?:solicit\\w*|sales|marketing|seo|advertis\\w*|pitch\\w*|link\\w*|guest|business|promot\\w*|partnerships?)\\b',
  "\\b(?:do not|don't|dont|doesn't|does not|never|will not|won't|no longer) (?:accept|want|take|consider|respond to|reply to|read|answer)\\s+(?:any\\s+)?(?:unsolicited|guest|sponsored|link|outreach|marketing|seo|promotional|backlink|pitch|advertising|sales)\\b[^.!?]{0,30}?\\b(?:pitch(?:es)?|submissions|posts?|requests|e-?mails|messages|insertions|exchanges|content|outreach|solicitations|offers|inquiries)\\b",
  '\\bnot accept(?:ing)? (?:guest posts|pitches|submissions|unsolicited|solicitations|advertising|sponsored (?:posts|content)|link (?:requests|insertions|exchanges))\\b',
  '\\b(?:unsolicited (?:pitches|e-?mails|requests|submissions|messages|link requests|offers)|solicitations|sales pitches|seo (?:pitches|offers|requests))\\s+(?:will be|are|get|may be)\\s+(?:ignored|deleted|discarded|not (?:answered|read|responded to|reviewed|accepted|welcome))\\b',
].join('|'),'i');
// A form that only takes support, order or booking requests is not an editorial route either.
const NOT_EDITORIAL=/\bthis form is (?:only )?for (?:customer |technical |order |billing |product )?(?:support|orders?|billing|returns|refunds|bookings?|appointments?|reservations?)\b(?:[^.!?]{0,30}\bonly\b)?/i;
// Sales intake: a page about advertising or hiring, or a form asking for a budget, a quote or a call.
const SALES_PATH=/\/(?:advertis\w*|sponsor\w*|media-kit|partner(?:ship)?s?|hire(?:-me|-us)?|services?|quote|get-a-quote|request-a-quote|pricing)(?:[/.]|$)/i;
const SALES_FIELD=/<(?:input|select|textarea)\b[^>]*name\s*=\s*["']?[\w\[\]-]*(?:budget|start[_-]?date|timeline|deadline|company[_-]?size|project[_-]?type|services?[_-]?needed)/i;
const SALES_TEXT=/\b(?:request|get) (?:a |your )?(?:free )?(?:quote|estimate|proposal)\b|\bbook (?:a|your) (?:call|demo|consultation)\b|\bproject (?:budget|details|scope)\b|\bhire (?:me|us)\b|\byour budget\b/i;
const pathOf=u=>{try{return new URL(u).pathname}catch{return ''}};
/** {ok, why}: whether the page still has a form an editor reads, without a do-not-pitch notice anywhere on it. */
export function formPageVerdict(html,url=''){
  const raw=String(html||'').slice(0,500000),text=stripTags(raw.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi,' ')).replace(/[‘’]/g,"'");
  if(NO_SOLICIT.test(text))return {ok:false,why:'no_solicitation_notice'};
  if(NOT_EDITORIAL.test(text))return {ok:false,why:'not_editorial_form'};
  if(SALES_PATH.test(pathOf(url)))return {ok:false,why:'sales_form'};
  let sales=false;
  for(const m of raw.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)){
    if(!/<textarea\b/i.test(m[2]))continue;
    const one=m[0].slice(0,9000);
    if(SALES_FIELD.test(one)||SALES_TEXT.test(stripTags(m[2].slice(0,8000)))){sales=true;continue}
    if(contactForm(one))return {ok:true,why:null}; // discovery's own rule (no comment, search, login or newsletter forms)
  }
  return {ok:false,why:sales?'sales_form':'no_form'};
}

/* ---------- The exchange offer ---------- */
/**
 * A 3-way offer is used only when it is what the owner allows: C (partner_site) is one of our own sites and never the
 * site the publisher is asked to link to (A), the C page is on C, and their article is on the publisher's own domain.
 * Anything else is dropped (fail closed), so the message never offers what the engine cannot track.
 */
export function validOffer(o,p,sites=[]){
  if(!o||typeof o!=='object')return null;
  const own=new Set(sites.map(s=>String(s?.domain||'').toLowerCase()).filter(Boolean)),c=String(o.partner_site||'').toLowerCase();
  if(!c||!own.has(c)||c===String(p?.site||'').toLowerCase())return null;
  if(!sameSite(hostOf(o.partner_page),c)||!p?.domain||!sameSite(hostOf(o.their_url),p.domain))return null;
  return {partner_site:c,partner_page:String(o.partner_page),partner_title:String(o.partner_title||'').slice(0,180),their_url:String(o.their_url),
    their_title:String(o.their_title||'').slice(0,180),...(Number.isFinite(Number(o.score))&&o.score!==null&&o.score!==''?{score:Number(o.score)}:{})};
}

/* ---------- The message ---------- */
const PAYMENT=/\b(?:(?:we|i)(?:'d| would| will| can)? (?:happily )?pay|paid (?:link|post|placement|article)|sponsored (?:post|article|link)|for a fee|fee for|payment for)\b|[$€£]\s?\d/i;
const CLAIMS_PLACED=/\b(?:already (?:linked|added|placed|links? to (?:you|your))|(?:i|we)(?:'ve| have) (?:already )?(?:linked|added (?:a|the|your) link))\b/i;
/**
 * Why a form message cannot be used, or null. 60-100 words, a subject, our page's URL as the only URL, our Gmail address as
 * the only address and the reply address, the closing opt-out sentence, at most one question, no payment, no claim that a
 * link exists; an exchange offer names C and says it is a separate site I run, and without an offer no exchange is mentioned.
 */
export function formProblem(out,{asset,offer=null,from='',optOut=formOptOut()}={}){
  if(!out||typeof out.subject!=='string'||typeof out.body!=='string')return 'no_subject_or_body';
  const s=out.subject.trim(),b=out.body,f=String(from||'').toLowerCase();
  if(s.length<8||s.length>90||/[\r\n]/.test(s))return 'subject_length';
  const n=wordCount(b);if(n<FORM_WORDS[0])return 'too_short';if(n>FORM_WORDS[1])return 'too_long';
  const urls=b.match(/https?:\/\/\S+/g)||[];if(urls.length!==1)return urls.length?'extra_url':'our_url_missing';
  if(urls[0].replace(/[).,]+$/,'')!==asset?.url)return 'wrong_url';
  const emails=[...new Set((b.match(EMAIL)||[]).map(e=>e.toLowerCase()))];
  if(!f||emails.length!==1||emails[0]!==f||!/\breply to\b/i.test(b))return 'reply_address';
  if(/^\s*(?:hi|hello|hey|dear)\b[^\n]*@/i.test(b))return 'greeting_by_address';
  if(!b.includes(optOut))return 'opt_out_missing';
  // One ask: a question mark inside a quoted page title ("What is spaced repetition?") is not a question to them.
  if((b.replace(/https?:\/\/\S+/g,' ').replace(/"[^"\n]{0,200}"/g,'""').match(/\?/g)||[]).length>1)return 'more_than_one_ask';
  if(/\[|\{\{|\}\}|lorem|<\w+>/i.test(b))return 'placeholder_or_markup';
  if(PAYMENT.test(`${s}\n${b}`))return 'payment_mentioned';
  if(CLAIMS_PLACED.test(b))return 'claims_link_placed';
  if(offer){if(!b.toLowerCase().includes(offer.partner_site)||!/\ba separate site I run\b/i.test(b))return 'exchange_not_stated'}
  else if(/\b(?:in return|link exchange|exchange links|link swap|swap links|reciprocal|separate site I run)\b/i.test(b))return 'exchange_without_offer';
  return null;
}
/**
 * The owner's form message: who we are, one direct ask, our page, what it is, the exact edit, the 3-way offer when there
 * is one, the closing opt-out sentence, the per-site sender name and our Gmail address to reply to. Options drop optional
 * parts so a long title still fits in 100 words.
 */
export function formTemplate(p,asset,site,{senderName,from,offer=null,optOut=formOptOut(),desc=true,proof=true,edit=true,happy=true,titleLen=80}={}){
  const name=firstName(p.author),mention=p.kind==='mention',list=!mention&&isListPage(p);
  const title=short(asset.title||site.domain,titleLen),theirs=short(list?p.list_page?.title||p.title:p.title,titleLen)||'your page';
  // The proposed link text is the page's whole title, never a shortened one.
  const linkText=short(asset.title||site.domain,200),editLine=edit&&!mention&&linkText.length<=80?`The edit would be one link, with "${linkText}" as the link text.`:'';
  const d=String(asset.description||'').replace(/\s+/g,' ').trim(),fact=proof&&!mention?assetFacts(asset)[0]:null;
  const about=desc==='short'||!(d.length>=40&&d.length<=220)?`It covers ${short(site.topic||'the topic',50)}.`:sentence(d);
  const ask=mention?`Thanks for mentioning ${title} in "${theirs}". Would you consider turning the mention into a link, so readers can find it in one click?`
    :`Would you consider adding ${title} to ${list?`your list "${theirs}"`:`"${theirs}"`}?`;
  const give=offer?`If you ${mention?'link it':'add it'}, I'll link to your ${offer.their_title?`"${short(offer.their_title,60)}"`:'article'} from ${offer.partner_title?`my related page "${short(offer.partner_title,60)}"`:'a related page'} on ${offer.partner_site}, a separate site I run.`:'';
  const what=[desc?about:'',fact?sentence(fact):''].filter(Boolean).join(' ');
  const body=[`Hi ${name||'there'},`,'',`I'm ${senderName} from ${site.domain}, a site about ${short(site.topic||'the topic',50)}. ${ask}`,'',asset.url,'',
    ...(what?[what,'']:[]),...(editLine?[editLine,'']:[]),...(give?[give,'']:[]),
    `${happy?'Happy to send anything you need. ':''}${optOut}`,'','Best,',senderName,site.domain,`Reply to: ${from}`].join('\n');
  const subject=mention?`Thanks for mentioning ${short(title,40)}`:list?`A suggestion for "${short(theirs,46)}"`:`Suggestion for "${short(theirs,48)}"`;
  return {subject,body,writer:'template',variant:offer?'template:form_link_exchange':'template:form',facts_used:fact?[fact]:[]};
}
// Longest first: the first variant inside 60-100 words is used. The offer is dropped only when nothing else fits.
const TRIES=[{},{proof:false},{proof:false,happy:false},{desc:'short',proof:false,happy:false},{desc:'short',proof:false,happy:false,titleLen:45},
  {desc:false,proof:false,happy:false,titleLen:45},{desc:false,proof:false,happy:false,edit:false,titleLen:45}];
/** A writer that can write for a contact form says so (writer.channels includes 'form'); others are never asked. */
export const writesForms=w=>!!w&&typeof w.write==='function'&&(w.channels instanceof Set?w.channels.has('form'):Array.isArray(w.channels)&&w.channels.includes('form'));
export async function composeForm(p,asset,site,{writer=null,senderName,from,offer=null,optOut=formOptOut(),stats={}}={}){
  if(writesForms(writer)){
    let out=null;try{out=await writer.write(p,asset,site,{senderName,exchange:offer,channel:'form',from,optOut})}catch{}
    const why=formProblem(out,{asset,offer,from,optOut});
    if(!why)return {subject:out.subject.trim(),body:out.body.trim(),writer:out.writer||'ai',variant:out.variant||(offer?'ai:form_link_exchange':'ai:form'),offer};
    (stats.writer_rejected??={})[why]=(stats.writer_rejected[why]||0)+1;
  }
  for(const o of offer?[offer,null]:[null])for(const t of TRIES){
    const m=formTemplate(p,asset,site,{senderName,from,offer:o,optOut,...t});
    if(!formProblem(m,{asset,offer:o,from,optOut}))return {...m,offer:o};
  }
  return null;
}

/* ---------- The queue ---------- */
/** Public counts only: messages waiting for the owner to paste, prepared this UTC day, and expired without a reply. */
export function formQueue(state,now=new Date()){
  const today=new Date(now).toISOString().slice(0,10);let ready=0,prepared_today=0,expired=0;
  for(const p of Object.values(state?.prospects||{})){if(p?.status==='form_ready')ready++;else if(p?.status==='form_expired')expired++;if(String(p?.form_message?.at||'').startsWith(today))prepared_today++}
  return {ready,prepared_today,expired};
}
/** Opt-outs and earlier emails must be known before a publisher is approached: a complete, current reply scan and Sent check. */
function mailboxHold(state,ms){
  const scan=ms-Date.parse(state.reply_health?.checked_at||''),sent=ms-Date.parse(state.sent_reconciled_at||'');
  if(state.reply_health?.status!=='ok'||!(scan>=-60e3&&scan<=SCAN_MAX_AGE))return 'reply_scan_not_current';
  if(!(sent>=-60e3&&sent<=SCAN_MAX_AGE))return 'sent_check_not_current';
  return '';
}
const repliedAfter=(p,t)=>!!p.replied_at||(p.history||[]).some(h=>h.type==='reply'&&!(Date.parse(h.at)<t));
/**
 * One cycle of the queue. `config`: {daily, fromAddress, senderName, senderNames, allowDach, exchangeMode, pickAsset,
 * blockedAssets, hold, maxChecks, requireMailbox}. `hold` (a reason code) stops new messages but not expiry.
 * `exchangePartner(p,site)` returns a 3-way offer or null. Returns counts only.
 */
export async function prepareForms({state,writer=null,config={},exchangePartner=null,sites=[],assets=[],fetchImpl=fetch,log=()=>{},now=()=>new Date(),deadline=Infinity}){
  const t=now(),ms=t.getTime(),at=t.toISOString(),stats={prepared:0,expired:0,skipped:0};
  state.contacted??={};const all=Object.values(state.prospects||{});
  // 1. Expiry: 21 days without a reply. The publisher stays contacted, and an offer the message made lapses.
  for(const p of all){
    if(p?.status!=='form_ready')continue;
    const prepared=Date.parse(p.form_message?.at||(p.history||[]).findLast?.(h=>h.type==='form_prepared')?.at||'');
    if(!(ms-prepared>FORM_EXPIRE_DAYS*DAY)||repliedAfter(p,prepared))continue;
    p.status='form_expired';p.form_expired_at=at;stats.expired++;
    if(p.exchange?.status==='offered'&&p.exchange.via==='form'){p.exchange.status='lapsed';p.exchange.lapsed_at=at}
  }
  const daily=Math.max(0,Math.floor(Number(config.daily)||0)),from=normalizeEmail(String(config.fromAddress||'').trim().toLowerCase());
  const senderFor=p=>String(config.senderNames?.[String(p.site||'').toLowerCase()]||config.senderName||'').trim();
  const done=()=>{const why=Object.entries(stats.skipped_by||{}).map(([k,n])=>`${k} x${n}`).join(', ');
    log(`forms: ${stats.prepared} contact-form messages prepared for you to paste (never submitted automatically)${stats.exchange_offers?`, ${stats.exchange_offers} with a 3-way exchange offer`:''}`+
      `${stats.skipped?`; ${stats.skipped} skipped (${why})`:''}${stats.expired?`; ${stats.expired} expired after ${FORM_EXPIRE_DAYS} days without a reply`:''}${stats.held?`; new messages held (${stats.held})`:''}`);return stats};
  const held=String(config.hold||'')||(!daily?'daily_limit_0':'')||(!from?'no_reply_address':'')||(!config.senderName&&!Object.keys(config.senderNames||{}).length?'no_sender_name':'')||
    (config.requireMailbox===false?'':mailboxHold(state,ms));
  if(held){stats.held=held.replace(/[^a-z0-9_:-]/gi,'_').slice(0,60);return done()}
  let budget=Math.max(0,daily-formQueue(state,t).prepared_today);
  if(!budget){stats.daily_limit_reached=true;return done()}
  const siteBy=new Map(sites.map(s=>[s.domain,s])),assetBy=new Map(assets.map(a=>[a.url,a])),learned=assetStats(state);
  // A publisher with a queued email route is emailed (verified, automatic), not sent to the form queue.
  const emailRoute=new Set(all.filter(p=>p?.status==='ready'&&p.email).map(p=>p.domain));
  const queue=all.filter(p=>p?.status==='contact_form'&&p.contact_form&&p.domain&&(p.qv||1)>=QUALIFY_VERSION&&!p.form_message)
    .map(p=>({p,v:linkLikelihood(p,{assets:learned})})).sort((a,b)=>b.v-a.v||(b.p.score||0)-(a.p.score||0)).map(x=>x.p);
  const exchangeOn=typeof exchangePartner==='function'&&(config.exchangeMode??'abc')==='abc',optOut=formOptOut();
  const maxChecks=Math.max(1,Math.floor(Number(config.maxChecks)||Math.max(3,daily*3)));let checks=0;
  const skip=k=>{stats.skipped++;(stats.skipped_by??={})[k]=(stats.skipped_by[k]||0)+1};
  // Pair the page like outreach does: the configured picker (undefined keeps the pairing, null = nothing worth pitching),
  // else the site's best pitchable page for this editor's topic when the stored one is not pitchable.
  const pairFor=(p,site)=>{
    if(p.kind==='mention')return undefined;
    if(typeof config.pickAsset==='function')return config.pickAsset(p,site);
    if(!assets.length)return undefined;
    const list=assets.filter(a=>a.site===site.domain&&pitchable(a,site).ok);
    return list.some(a=>a.url===p.asset_url)?undefined:bestPitchAsset(p,list,site);
  };
  for(const p of queue){
    if(budget<=0)break;
    if(Date.now()>deadline){stats.deadline=true;break}
    const last=Date.parse(state.contacted[p.domain]||'');
    if(isSuppressed(state,p.email||'',p.domain)){skip('suppressed');continue}
    if(Number.isFinite(last)&&ms-last<CONTACT_DAYS*DAY){skip('contacted_recently');continue}
    if(emailRoute.has(p.domain)){skip('email_route_queued');continue}
    if(!config.allowDach&&jurisdictionHold({domain:p.domain,source:p.contact_form})){skip('jurisdiction_consent_required');continue}
    if(!sameSite(hostOf(p.contact_form),p.domain)){skip('form_not_first_party');continue}
    if(p.site_kind&&p.site_kind!=='publisher'){skip('not_a_publisher');continue}
    const site=siteBy.get(p.site);if(!site){skip('unknown_site');continue}
    const senderName=senderFor(p);if(!senderName){skip('no_sender_name');continue}
    let pick;try{pick=pairFor(p,site)}catch{pick=undefined}
    if(pick===null){skip('no_pitchable_page');continue}
    const repaired=pick?.asset?.url&&pick.asset.url!==p.asset_url?pick.asset:null;
    const asset=repaired||assetBy.get(p.asset_url)||{url:p.asset_url,title:p.asset_title||site.domain,type:p.kind==='mention'?'brand':'resource',description:''};
    if(!asset.url){skip('no_pitchable_page');continue}
    if(config.blockedAssets?.has?.(normUrl(asset.url))){skip('asset_not_indexable');continue}
    // The form page, read once: the notices and the form itself are not on the record.
    const url=p.contact_form,fc=p.form_check,same=fc?.v===FORM_CHECK_VERSION&&fc.url===url,age=ms-Date.parse(fc?.at||'');
    if(same&&fc.ok===false&&fc.why!=='unreachable'){skip(fc.why||'form_check_failed');continue}
    if(same&&fc.why==='unreachable'&&((fc.tries||0)>=MAX_TRIES||age<RECHECK_DAYS*DAY)){skip('form_page_unreachable');continue}
    if(!(same&&fc.ok===true&&age<RECHECK_DAYS*DAY)){
      if(checks>=maxChecks){stats.check_budget_used=true;break}
      checks++;stats.pages_checked=(stats.pages_checked||0)+1;
      const res=await fetchPage(url,{fetchImpl,timeout:12000,maxBytes:400000});
      if(res.status!==200||!res.body){p.form_check={v:FORM_CHECK_VERSION,url,at,ok:false,why:'unreachable',tries:(same&&fc.why==='unreachable'?fc.tries||1:0)+1};skip('form_page_unreachable');continue}
      const v=sameSite(hostOf(res.url),p.domain)?formPageVerdict(res.body,res.url):{ok:false,why:'form_not_first_party'};
      p.form_check={v:FORM_CHECK_VERSION,url,at,ok:v.ok,...(v.why?{why:v.why}:{})};
      if(!v.ok){skip(v.why);continue}
    }
    let offer=null;
    if(exchangeOn){let raw=null;try{raw=await exchangePartner(p,site)}catch{raw=null}offer=validOffer(raw,p,sites);if(raw&&!offer)stats.offers_rejected=(stats.offers_rejected||0)+1}
    const msg=await composeForm(p,asset,site,{writer,senderName,from,offer,optOut,stats});
    if(!msg){skip('copy_rejected');continue}
    if(repaired){p.asset_repaired_from=p.asset_url;p.asset_url=repaired.url;p.asset_title=repaired.title;stats.repaired=(stats.repaired||0)+1}
    p.form_message={subject:msg.subject,body:msg.body,form_url:url,at,variant:msg.variant,writer:msg.writer};
    p.status='form_ready';state.contacted[p.domain]=at;
    (p.history??=[]).push({type:'form_prepared',at,form_url:url,variant:msg.variant,writer:msg.writer,sender_name:senderName});
    if(msg.offer){p.exchange={...msg.offer,status:'offered',offered_at:at,via:'form'};stats.exchange_offers=(stats.exchange_offers||0)+1}
    stats.prepared++;budget--;
  }
  return done();
}
