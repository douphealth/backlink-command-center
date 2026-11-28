/**
 * Personalised pitch writer. Uses Claude when ANTHROPIC_API_KEY is configured
 * (grounded strictly in the fetched prospect page + our asset facts), otherwise a free
 * OpenAI-compatible writer when its key is set (Groq, Gemini, or a custom endpoint), otherwise a
 * specific, non-spammy template. Every output is validated before use.
 */
import Anthropic from '@anthropic-ai/sdk';
import {hashId} from './util.mjs';

const short=(s,n=60)=>{s=String(s||'').split(/\s[|–—-]\s/)[0].trim();return s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,'')+'…':s};
const firstName=a=>a?String(a).split(/\s+/)[0]:'';
const KIND={interactive_tool:'free interactive tool',methodology:'transparent methodology',research_candidate:'data-driven resource',reference:'reference guide',comparison:'side-by-side comparison',practical_guide:'practical guide'};

/** Verifiable facts about our asset, from the crawl (never invented). */
export function assetFacts(asset){
  const f=[];
  // Only a page that IS a tool is called one: guides with an embedded widget and software reviews are described as what they are.
  if(asset.interactive&&(asset.type==='interactive_tool'||!asset.type))f.push('it is a free interactive tool (no sign-up needed)');
  else if(asset.words>=1500)f.push(`it is an in-depth ${Math.round(asset.words/100)*100}-word guide`);
  const tables=(asset.reasons||[]).map(r=>String(r).match(/^(\d+) data tables?$/)).find(Boolean);
  if(tables)f.push(`it includes ${tables[1]} data table${tables[1]==='1'?'':'s'}`);
  const cites=(asset.reasons||[]).map(r=>String(r).match(/^Cites (\d+) authoritative sources$/)).find(Boolean);
  if(cites)f.push(`it cites ${cites[1]} authoritative sources`);
  if((asset.reasons||[]).includes('Recently updated'))f.push('it was updated recently');
  return f.slice(0,2);
}
// Ranking notes meant for the dashboard, never for an editor.
const INTERNAL_NOTE=/under-linked|flagship|templated|thin content|ymyl|striking distance|est\. monthly visits|expert publishers/i;
const sentence=s=>s?s[0].toUpperCase()+s.slice(1)+'.':'';
/**
 * Which of the supplied facts an email states. It over-counts on purpose: a fact counted as stated is never
 * offered as news in a follow-up, so a follow-up cannot present something the first email already said.
 */
const FACT_KINDS=[
  ['tool',/interactive tool|no sign-?up/i,/\bfree\b|sign[- ]?up|interactive|\btools?\b/i],
  ['depth',/-word guide|in-depth/i,/\bwords?\b|in[- ]depth|detailed|comprehensive/i],
  ['tables',/data tables?/i,/\btables?\b/i],
  ['sources',/authoritative sources|^cites\b/i,/\bcit(?:es|ed|ing|ations?)\b|\bsources?\b|\breferences?\b|\bstudies\b|\bresearch\b/i],
  ['updated',/updated|\brecent/i,/\bupdated?\b|up[- ]to[- ]date|\brecent(?:ly)?\b|\bcurrent\b/i],
];
const factKind=f=>FACT_KINDS.find(([,re])=>re.test(String(f)))||null;
export function factsIn(text,facts=[]){
  const t=String(text||''),low=t.toLowerCase();
  return [...new Set(facts.filter(f=>typeof f==='string'&&f))].filter(f=>{const k=factKind(f);if(k)return k[2].test(t);
    return (f.match(/\d+/g)||[]).some(n=>t.includes(n))||f.toLowerCase().split(/[^a-z]+/).some(w=>w.length>=5&&low.includes(w))});
}
/**
 * A fact about our page that the first email did not contain, or null. When the first email's facts were not
 * recorded (sent before this was tracked), every fact counts as already stated.
 */
export function unusedFact(p,asset){
  const used=p?.facts_used;if(!Array.isArray(used))return null;
  const kinds=new Set(used.map(f=>factKind(f)?.[0]).filter(Boolean));
  return assetFacts(asset).find(f=>!used.includes(f)&&!kinds.has(factKind(f)?.[0]))||null;
}
/** Our page's own description plus ONE checkable proof point (the owner's rule: one proof point, nothing invented). */
const valueOf=(asset,site)=>{
  const d=(asset.description||'').trim().replace(/\s+/g,' '),all=assetFacts(asset),fact=all[0];
  const desc=d&&d.length>=40?(/[.!?]$/.test(d)?d:d+'.'):`It covers ${short(site?.topic||'the topic',60)}.`;
  return {text:[desc,fact?sentence(fact):''].filter(Boolean).join(' '),facts:[...new Set([...(fact?[fact]:[]),...factsIn(desc,all)])]};
};
/** A list or roundup page ("best X tools", "top 10 X apps", "X resources list"): the ask is to be added to it. */
const LIST_NOUN='(?:tools?|resources?|apps?|calculators?|websites?|sites?|blogs?|guides?|courses?|podcasts?|books?|newsletters?|channels?|software|extensions?|plugins?|templates?|generators?|trackers?|planners?|checkers?|platforms?|services?|links)';
const ROUNDUP=new RegExp(`\\b(?:best|top\\s+\\d+|\\d+\\s+(?:best|top|great|useful|essential|free|must-have))\\b(?:[\\s-]+[\\w'&-]+){0,5}?[\\s-]+${LIST_NOUN}\\b|\\b${LIST_NOUN}\\s+(?:list|roundup|directory)\\b|\\b(?:list|round-?up) of\\b(?:[\\s-]+[\\w'&-]+){0,5}?[\\s-]+${LIST_NOUN}\\b`,'i');
export function isListPage(p){
  if(!p||p.kind==='mention')return false;
  return !!p.list_page||ROUNDUP.test(String(p.title||''));
}
const listName=p=>p.list_page?.title||p.title||'';
/** A list's own section for additions ("Other notable tools", "Honourable mentions"), read from the page; '' when none. */
const addSection=p=>typeof p.list_page?.other_section==='string'?p.list_page.other_section:'';
/** The section a list-inclusion ask names: the list's section for additions when it has one (skill step 2), else the matched section. */
const listSection=p=>addSection(p)||p.fit_section||null;
/** Where on their page the link would go: the matched section when one is known. */
const placeOf=(p,list=false)=>{const sec=list?listSection(p):p.fit_section;
  return sec?`your "${short(sec,70)}" section in "${short(list?listName(p):p.title,70)}"`:list?`your list "${short(listName(p),90)}"`:`"${short(p.title,90)}"`};
const intro=site=>`I'm writing from ${site.domain}, a site about ${short(site.topic,50)}.`;
const signOff=(senderName,site)=>['Best,',senderName,site?.domain].filter(Boolean);
/** Said only when one of our pages really links to their article (set from our own crawl); never otherwise. */
const citedLine=(p,asset)=>{const u=p.cited_by_us?.our_url;if(!u)return '';
  return u===asset.url?`${short(asset.title,80)} already links to your article.`:`Our page ${String(u).replace(/^https?:\/\/(?:www\.)?/,'').replace(/\/+$/,'')} already links to your article.`};
export const reSubject=s=>{s=String(s||'').replace(/[\r\n]+/g,' ').trim();return /^re:/i.test(s)?s:`Re: ${s}`};
/**
 * The opt-out every first pitch and follow-up closes with, on its own line right before the sign-off (the owner's
 * wording since Nov 2026; it replaced the 'P.S. ... reply "no"' line). One answer stops all further email: replies.mjs
 * reads "no thanks", "not interested", "not for us" and the like as an opt-out and suppresses the publisher.
 */
export const OPT_OUT="If it's not a fit, just say so and I won't follow up.";
const SIGN_OFF_LINE=/^[ \t]*(?:best(?: regards| wishes)?|kind regards|warm(?: regards)?|regards|thanks(?: again)?|thank you|many thanks|cheers|all the best|sincerely|warmly)[ \t]*[,.!]?[ \t]*$/im;
// A reworded closing sentence ("...and I won't email again."): only that sentence is replaced, never the rest of its line.
const NEAR_OPT_OUT=/[^.!?\n]*\b(?:won[\u2019']?t|will not)[ \t]+(?:follow[ -]up|e-?mail(?: you)? again|write again|contact you again)\b[^.!?\n]*[.!?]?/i;
// The old 'P.S. ... reply "no"' line (a model's habit): never sent. A P.S. line or paragraph is dropped before the closing sentence goes in.
const PS_LINE=/^[ \t]*P\.?[ \t]?S\.?(?=[\s:,.!-]|$)/im;
const dropPs=b=>{if(!PS_LINE.test(b))return b;const lines=b.split('\n'),i=lines.findIndex(l=>PS_LINE.test(l));
  let j=i+1;while(j<lines.length&&lines[j].trim()&&!SIGN_OFF_LINE.test(lines[j]))j++;
  return [...lines.slice(0,i),...lines.slice(j)].join('\n').replace(/\n{3,}/g,'\n\n').trimEnd()};
/** The body with OPT_OUT exactly once: a reworded closing line is replaced; a missing one goes before the sign-off (or last). A P.S. is removed. */
export function withOptOut(body){
  const b=dropPs(String(body||''));if(b.includes(OPT_OUT))return b;
  if(NEAR_OPT_OUT.test(b))return b.replace(NEAR_OPT_OUT,m=>m.match(/^\s*/)[0]+OPT_OUT);
  const lines=b.split('\n');let i=-1;lines.forEach((l,k)=>{if(SIGN_OFF_LINE.test(l))i=k});
  if(i>0&&lines.length-i<=4)return [...lines.slice(0,i),OPT_OUT,'',...lines.slice(i)].join('\n').replace(/\n{3,}/g,'\n\n');
  return `${b.trimEnd()}\n\n${OPT_OUT}`;
}
/** "https://www.Site.com/x" or "www.site.com" -> "site.com". */
const bareHost=d=>String(d||'').trim().toLowerCase().replace(/^[a-z]+:\/\//,'').replace(/^www\./,'').replace(/[/?#:].*$/,'');
const samePage=(a,b)=>{const n=u=>String(u||'').trim().toLowerCase().replace(/^[a-z]+:\/\/(?:www\.)?/,'').replace(/[?#].*$/,'').replace(/\/+$/,'');return !!a&&n(a)===n(b)};
/**
 * A 3-way offer the email may make, or null: it must name one of our OTHER sites (C) and its page title, and C is
 * never the promoted site A (nor the editor's own site). Callers check that C is one of SITES; this only refuses A.
 */
export function usableOffer(ex,site,asset,p){
  if(!ex||typeof ex!=='object')return null;
  const c=bareHost(ex.partner_site),near=(x,y)=>!!x&&!!y&&(x===y||x.endsWith('.'+y)||y.endsWith('.'+x));
  if(!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(c)||!String(ex.partner_title||'').trim())return null;
  return [site?.domain,asset?.url,p?.domain].some(d=>near(c,bareHost(d)))?null:ex;
}
/** The offer the first email made, restated in the follow-up while it is still open. */
const standingOffer=(p,site,asset)=>p?.kind!=='mention'&&p?.exchange?.status==='offered'?usableOffer(p.exchange,site,asset,p):null;
const theirRef=(p,ex)=>{const t=short(ex.their_title||'',70);return !ex.their_url||samePage(ex.their_url,p.page_url)||!t?'your page':`your article "${t}"`};
/** The one offer sentence: plain, peer to peer, and honest that C is ours. Their link comes first; ours follows once it is up. */
export const exchangeLine=(p,ex)=>`In return, once your link is up, I'd link to ${theirRef(p,ex)} from "${short(ex.partner_title,70)}" on ${bareHost(ex.partner_site)}, a separate site I run.`;
const variantOf=(base,ex)=>ex?{variant:'template:link_exchange',base_variant:base,exchange:ex}:{variant:base};
/** A readable label for the competitor link the editor already chose ("Doctors of Running's review" or the host). */
export function linkLabel(c){
  const a=String(c?.anchor||'').trim();
  const usable=a.length>=4&&a.length<=60&&/[a-z]{3}/i.test(a)&&!/https?:|www\.|\.(com|net|org|io)\b|\+\d|^(here|this|link|click|read more|source|website)$/i.test(a);
  return usable?`"${a}" (${c.host})`:c?.host||'another site';
}
/**
 * The editor already links to a competing resource from this page: point to that exact link and offer ours
 * as a second option for the same readers. Never claims ours is better and never criticises the other site.
 */
export function alternativePitch(p,asset,{senderName,site,exchange}={}){
  const c=p.competitor_link,name=firstName(p.author),kind=KIND[asset.type]||'resource',title=short(asset.title,80),v=valueOf(asset,site),ex=usableOffer(exchange,site,asset,p);
  // "Same topic" is claimed only when the competitor link and our page share specific subject words.
  const opener=c.match==='specific'?`so I thought you might want a second option on the same topic.`
    :`If you ever add another ${short(site.topic,40)} resource there, this one might be useful to the same readers.`;
  return {subject:`Another ${kind} for "${short(p.title,44)}"`,
    body:[`Hi ${name||'there'},`,'',
      c.match==='specific'?`In "${short(p.title,90)}" you link to ${linkLabel(c)}, ${opener}`:`In "${short(p.title,90)}" you link to ${linkLabel(c)}. ${opener}`,'',
      `${short(asset.title,100)}: ${asset.url}`,'',v.text,'',
      `Would you consider adding it next to the existing link, with "${title}" as the link text?${ex?' '+exchangeLine(p,ex):''}`,'',
      OPT_OUT,'',...signOff(senderName,site)].join('\n'),writer:'template',...variantOf('template:alternative_to_linked_resource',ex),facts_used:v.facts};
}
/**
 * The owner's list-inclusion ask: who we are, one direct ask to be added to their list (in the matched
 * section when known), at most one checkable proof point, nothing else.
 */
export function listInclusionPitch(p,asset,{senderName,site,exchange}={}){
  const name=firstName(p.author),title=short(asset.title,80),proof=assetFacts(asset)[0],cited=citedLine(p,asset),ex=usableOffer(exchange,site,asset,p);
  return {subject:`A suggestion for "${short(listName(p),46)}"`,
    body:[`Hi ${name||'there'},`,'',
      `${intro(site)} Would you consider adding ${title} to ${placeOf(p,true)}?${ex?' '+exchangeLine(p,ex):''}${proof?' '+sentence(proof):''}${cited?' '+cited:''}`,'',
      asset.url,'',
      `If it fits, the entry could simply be "${title}" with a link to the page above.${ex?'':' Happy to send anything you need.'}`,'',
      OPT_OUT,'',...signOff(senderName,site)].join('\n'),writer:'template',...variantOf('template:list_inclusion',ex),facts_used:proof?[proof]:[]};
}
export function templatePitch(p,asset,{senderName,site,exchange}={}){
  const o={senderName,site,exchange};
  if(p.broken_link)return brokenLinkPitch(p,asset,o);
  if(p.kind==='linkgap'&&p.competitor_link?.host)return alternativePitch(p,asset,o);
  if(isListPage(p))return listInclusionPitch(p,asset,o);
  if(usableOffer(exchange,site,asset,p))return exchangePitch(p,asset,o);
  const name=firstName(p.author),kind=KIND[asset.type]||'resource',pick=parseInt(hashId(p.id),36)%3,title=short(asset.title,80),v=valueOf(asset,site),cited=citedLine(p,asset);
  const subject=[`Resource for your "${short(p.title,48)}" page`,`A ${kind} for your "${short(p.fit_section||p.title,40)}" readers`,`Suggestion for "${short(p.title,48)}"`][pick];
  // Who we are, one direct ask, the page, one proof point, and the exact edit proposed. No compliments, no filler.
  const body=[`Hi ${name||'there'},`,'',
    `${intro(site)} Would you consider adding ${title} to ${placeOf(p)}?`,'',
    asset.url,'',`${v.text}${cited?' '+cited:''}`,'',
    `If it fits, the edit would be one link${p.fit_section?' in that section':' on the page'}, with "${title}" as the link text.`,'',
    OPT_OUT,'',...signOff(senderName,site)].join('\n');
  return {subject,body,writer:'template',variant:'template:resource_suggestion',facts_used:v.facts};
}
/**
 * The 3-way offer (cfg.exchange.mode 'abc'): the one direct ask, then one sentence offering a link to their article
 * from a related page on another of our sites (C, never the promoted site A), said to be a separate site we run. The
 * owner places that link; the engine records the promise only once this email is delivered. Never money, never "a swap".
 */
export function exchangePitch(p,asset,{senderName,site,exchange}={}){
  const ex=usableOffer(exchange,site,asset,p);if(!ex)return templatePitch(p,asset,{senderName,site});
  const name=firstName(p.author),kind=KIND[asset.type]||'resource',pick=parseInt(hashId(p.id),36)%3,title=short(asset.title,80),v=valueOf(asset,site);
  const subject=[`Resource for your "${short(p.title,48)}" page`,`A ${kind} for your "${short(p.fit_section||p.title,40)}" readers`,`Suggestion for "${short(p.title,48)}"`][pick];
  const body=[`Hi ${name||'there'},`,'',
    `${intro(site)} Would you consider adding ${title} to ${placeOf(p)}? ${exchangeLine(p,ex)}`,'',
    asset.url,'',v.text,'',
    `The edit would be one link${p.fit_section?' in that section':''}, with "${title}" as the link text.`,'',
    OPT_OUT,'',...signOff(senderName,site)].join('\n');
  return {subject,body,writer:'template',...variantOf('template:resource_suggestion',ex),facts_used:v.facts};
}
const DEAD={not_found:'returns a "page not found" error',gone:'returns a "page removed" error',domain_gone:'points to a domain that no longer exists'};
const deadLink=b=>b.anchor&&b.anchor.length>=3?`the link to "${short(b.anchor,60)}" (${b.host})`:`the link to ${b.host}`;
/** A real dead link on their page (re-checked before sending) and our page as a replacement. */
export function brokenLinkPitch(p,asset,{senderName,site,exchange}={}){
  const b=p.broken_link,name=firstName(p.author),title=short(asset.title,80),v=valueOf(asset,site),ex=usableOffer(exchange,site,asset,p);
  return {subject:`Broken link on "${short(p.title,48)}"`,
    body:[`Hi ${name||'there'},`,'',
      `In "${short(p.title,90)}", ${deadLink(b)} ${DEAD[b.reason]||'no longer works'}.`,'',
      `If you'd like a replacement, our ${title} might work: ${asset.url}`,'',v.text,'',
      `Would you consider pointing ${b.anchor&&b.anchor.length>=3?`"${short(b.anchor,60)}"`:'that link'} to the page above instead?${ex?' '+exchangeLine(p,ex):''}`,'',
      OPT_OUT,'',...signOff(senderName,site)].join('\n'),writer:'template',...variantOf('template:broken_link_replacement',ex),facts_used:v.facts};
}
/** The editor already mentions us without a link: thank them, ask for the link. */
export function mentionPitch(p,asset,{senderName,site}){
  const name=firstName(p.author),brand=short(asset.title||site.domain,60)||site.domain;
  return {subject:`Thanks for mentioning ${short(brand,40)}`,
    body:[`Hi ${name||'there'},`,'',
      `Thanks for mentioning ${brand} in "${short(p.title,90)}".`,'',
      `Would you consider turning the mention into a link, so readers can find it in one click? Here's the address: ${asset.url}`,'',
      OPT_OUT,'',...signOff(senderName,site)].join('\n'),writer:'template',variant:'template:unlinked_mention',facts_used:[]};
}
/**
 * The one follow-up, in the same thread: the owner's honest one-line nudge. It adds a fact only when the first
 * email did not contain it (or says a re-checked dead link is still dead), and never claims anything else is new.
 */
export function followupPitch(p,asset,{senderName,site,subject,restate=true}={}){
  const name=firstName(p.author),b=p.broken_link,fact=b?null:unusedFact(p,asset),title=short(asset.title,80),ex=restate===false?null:standingOffer(p,site,asset);
  // An offer the first email made is restated in one clause, so the follow-up alone still says what is offered and by whom.
  const ask=p.kind==='mention'?`just checking whether you'd consider turning the mention of ${short(asset.title||site?.domain||'us',60)} in "${short(p.title,80)}" into a link.`
    :`just checking whether you'd consider adding ${title} to ${placeOf(p,isListPage(p))}${ex?`, in return for a link to ${theirRef(p,ex)} from ${bareHost(ex.partner_site)} (a separate site I run)`:''}.`;
  const extra=b?sentence(`${deadLink(b)} on that page still ${DEAD[b.reason]||'does not work'}, so this could replace it`):fact?sentence(fact):'';
  return {subject:subject||reSubject(p.last_subject||short(asset.title)),
    body:[`Hi ${name||'there'}, ${ask}${extra?' '+extra:''} Happy to send anything you need.`,'',asset.url,'',OPT_OUT,'',...signOff(senderName,site)].join('\n'),
    writer:'template',variant:`template:followup_${b?'broken_link':fact?'fact':'nudge'}`,facts_used:fact?[fact]:[],...(ex?{exchange:ex}:{})};
}

/**
 * Every number (2+ digits) in the email must come from the facts we supplied: a model that invents
 * "trusted by 10,000 readers" or a year is rejected and the template is used instead.
 */
export function grounded(out,facts){
  const src=JSON.stringify(facts).replace(/[,\s]/g,'');
  const nums=`${out.subject} ${out.body}`.replace(/https?:\/\/\S+/g,' ').match(/\d[\d,.]*\d/g)||[];
  return nums.every(n=>src.includes(n.replace(/[,.]$/,'').replace(/,/g,'')));
}
/**
 * Free AI writers that speak the OpenAI chat-completions format, used when no Anthropic key is set.
 * (GitHub Models, the first free writer here, was retired by GitHub on 2026-07-30: its host answers "200 OK" to everything.)
 * The model is chosen from the provider's own live model list (`prefer`: first match per pattern), so a renamed or
 * retired model does not break the writer; the `fallback` names are tried when the list cannot be read.
 */
export const AI_PROVIDERS={
  groq:{label:'Groq',base:'https://api.groq.com/openai/v1',prefer:[/gpt-oss-120b/i,/llama-3\.3-70b/i,/70b/i,/gpt-oss-20b/i,/instant/i],fallback:['openai/gpt-oss-120b','llama-3.3-70b-versatile','llama-3.1-8b-instant']},
  // nativeList: Google's own model list, read when the OpenAI-style one is not served for this key.
  // Our own dashboard's endpoint in front of Cloudflare Workers AI (functions/_lib/ai-writer.js): no key at all.
  cloudflare:{label:'Cloudflare Workers AI',prefer:[/llama-3\.3-70b/i,/gpt-oss-120b/i,/llama-4-scout/i,/llama-3\.1-8b/i],fallback:['@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/openai/gpt-oss-120b']},
  gemini:{label:'Gemini',base:'https://generativelanguage.googleapis.com/v1beta/openai',prefer:[/flash-lite/i,/flash/i],fallback:['gemini-flash-lite-latest','gemini-flash-latest','gemini-2.5-flash-lite','gemini-2.5-flash'],
    nativeList:{url:'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',keyHeader:'x-goog-api-key'}},
};
const NOT_CHAT=/embed|whisper|tts|audio|speech|image|imagen|veo|video|guard|moderation|rerank|vision|live|aqa|robotics|computer-use|transcri|native|compound|orpheus/i;
/** Ordered model candidates from a provider's model list: per pattern the newest stable match; specialty models are ignored. */
export function pickModels(ids,prefer){
  const chat=[...new Set(ids.map(i=>String(i||'').replace(/^models\//,'')))].filter(i=>i&&!NOT_CHAT.test(i));
  const unstable=i=>/preview|exp|beta/i.test(i)?1:0,out=[];
  for(const re of prefer){
    const m=chat.filter(i=>re.test(i)&&!out.includes(i)).sort((a,b)=>unstable(a)-unstable(b)||b.localeCompare(a,undefined,{numeric:true}));
    if(m.length)out.push(m[0]);
  }
  return out;
}
/** The free writers configured in the environment, in the order they are tried. Keys never leave this object. */
export function aiProviders(env){
  if(env.LINKFORGE_AI_WRITER==='off')return [];
  const t=v=>String(v||'').trim(),out=[];
  if(t(env.GROQ_API_KEY))out.push({name:'groq',...AI_PROVIDERS.groq,key:t(env.GROQ_API_KEY),model:t(env.LINKFORGE_GROQ_MODEL)});
  if(t(env.GEMINI_API_KEY))out.push({name:'gemini',...AI_PROVIDERS.gemini,key:t(env.GEMINI_API_KEY),model:t(env.LINKFORGE_GEMINI_MODEL)});
  // Any other OpenAI-compatible service (OpenRouter, Cloudflare Workers AI, Mistral, a self-hosted model): all three values are needed.
  const base=t(env.LINKFORGE_AI_BASE_URL).replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
  if(/^https:\/\/[^\s/]+/.test(base)&&t(env.LINKFORGE_AI_KEY)&&t(env.LINKFORGE_AI_MODEL)){
    let label='custom';try{label=new URL(base).hostname}catch{}
    out.push({name:'custom',label,base,key:t(env.LINKFORGE_AI_KEY),model:t(env.LINKFORGE_AI_MODEL),prefer:[],fallback:[]});
  }
  // Keyless default inside GitHub Actions: the dashboard's Workers AI endpoint, authorised by a GitHub identity token.
  const endpoint=t(env.LINKFORGE_AI_ENDPOINT).replace(/\/+$/,'');
  if(/^https:\/\/[^\s/]+/.test(endpoint)&&env.ACTIONS_ID_TOKEN_REQUEST_URL&&env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    out.push({name:'cloudflare',...AI_PROVIDERS.cloudflare,base:endpoint,key:'',getKey:actionsIdentity(env,'linkforge-ai-writer'),model:t(env.LINKFORGE_CLOUDFLARE_MODEL)});
  return out;
}
/**
 * A short-lived GitHub Actions identity token (OIDC, valid a few minutes): it proves to our own dashboard that the
 * caller is this repository's Autopilot workflow, so no secret has to be stored anywhere. Reused for 3 minutes.
 */
export function actionsIdentity(env,audience){
  let cached={at:0,value:''};
  return async fetchImpl=>{
    if(cached.value&&Date.now()-cached.at<180000)return cached.value;
    try{
      const u=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);u.searchParams.set('audience',audience);
      const res=await fetchImpl(u.href,{headers:{Authorization:'bearer '+env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
      const value=res.ok?String((await res.json().catch(()=>({})))?.value||''):'';
      if(value)cached={at:Date.now(),value};
      return value;
    }catch{return ''}
  };
}
const SCHEMA={type:'object',properties:{subject:{type:'string'},body:{type:'string'}},required:['subject','body'],additionalProperties:false};
const SYSTEM=`You write short, honest link-suggestion emails to independent website editors.
Rules:
- Plain text, no markdown, no emojis. Body: 60 to 120 words (with exchange: 60 to 100 words; a "followup": at most 70 words).
- Name their page by its title, or by relevant_section when one is given, so it is obviously not a mass email. relevant_section_text is the part of their page where our resource would fit: use it to say where the link would go; never quote it at length.
- Never open with "I hope this finds you well", "I came across your site" or "I was reading". No compliments about their article or site, no "hope you're well", no "happy to help", no labels such as "Details:".
- Who we are in a few words (sender.website and topic), at most one proof point, one direct ask. Nothing else.
- Only state facts present in the provided details; never invent statistics, awards, traffic, benefits, or that they linked to us before.
- Include our asset URL exactly once. Include no other URLs.
- Never mention pricing, payment, money or a guest post. No pressure, no guilt.
- Without exchange: never offer anything in return for the link (no return link, no "link exchange").
- If exchange is given (we offer a return link): right after the one direct ask, add exactly one sentence offering, in return, to link to their article (by exchange.their_title, or "your page" when exchange.same_page is true) from the page exchange.partner_title on exchange.partner_site, and say plainly that exchange.partner_site is "a separate site I run". Write exchange.partner_site exactly as given and give no URL for it or for their article. Their link comes first; ours follows once theirs is up. Never offer a link from sender.website or from any other site, never offer or accept money, never say the return link is already in place, never promise traffic, authority, or a site-wide or permanent link, and never call it an exchange, a scheme or a swap. Plain and peer to peer.
- End the ask with a concrete proposed edit: one link with our asset title as the link text, placed in relevant_section when one is given.
- Greet by first name only if an author name is provided, otherwise "Hi there".
- End the email, on its own line right before the sign-off, with exactly this sentence: ${OPT_OUT}
- Sign off with the sender name and website provided.
- Subject: under 60 characters, specific, lowercase-friendly, no clickbait.
- If cited_by_us is given, you may say that our page cited_by_us.our_page already links to their article (name it exactly as given; it is not a URL to include). Never claim that otherwise.
- If situation is "unlinked_mention": the editor already mentions our brand without a link. Thank them briefly and ask them to turn the mention into a link to our URL. Do not pitch anything else.
- If situation is "alternative_to_linked_resource": the editor's page already links to competitor_link (name it by its anchor text if it reads naturally, otherwise by its site name; never give its URL). Open with that specific link, then say in one sentence what our resource adds for the same readers, using only the provided facts. Offer it as an additional option next to the existing link. If competitor_link.same_subject is false, do not claim the two cover the same subject: present ours only as another resource the same readers may find useful. Never say ours is better and never criticise the other site.
- If situation is "broken_link_replacement": open by telling the editor which link on their page is dead (use its anchor text and site name from broken_link, never its URL, and state the problem exactly as given in broken_link.problem). Then offer our page as a replacement. The helpful tip comes first; the ask is secondary.
- If situation is "list_inclusion": their page is a list or roundup (list.name). Open with who we are, then ask directly: "Would you consider adding <our asset title> to <list.section, when given> your <list.name>?" Add at most one proof point, only from our_asset.facts. Do not describe or praise their list.
- If situation is "followup": a one-time follow-up in the same thread to the email we already sent. Greet, then one sentence: "just checking whether you'd consider adding <our asset title> to <their page or list>" (for kind "unlinked_mention": whether they'd consider turning the mention into a link). If new_fact is given, add it as one short sentence; never repeat earlier facts and never write "I didn't mention", "just bumping" or "circling back". If broken_link is given, say that this link on their page still has the problem given. If exchange is given, restate our offer in one short clause in that sentence (a link to their article from exchange.partner_site, a separate site I run). Then "Happy to send anything you need.", our URL, the closing sentence and the sign-off. The subject is reply_subject exactly.`;

// Money is never offered, with or without a 3-way offer (a paid offer from a publisher goes to the owner, replies.mjs).
const PAYMENT=/\b(?:paid (?:placements?|links?|posts?|guest posts?|mentions?)|sponsored (?:posts?|links?|placements?)|(?:i|we)(?:'d| would| will|'ll| can| could)(?: be)?(?: happy| glad)?(?: to)? (?:happily |gladly )?(?:pay|compensate|sponsor)\b|pay(?:ing)? (?:you|for (?:the|a|your|this) (?:link|placement|post|mention))\b|(?:offer|make|send) (?:you )?(?:a )?(?:payment|compensation)\b|(?:payment|compensation|a fee|our fee|a small fee) (?:for|in return for) (?:the|a|your|this) (?:link|placement|post|mention)\b)/i;
// An offer of money in any wording: "I'm happy to pay a small fee", "I can offer a small payment", "we're willing to compensate you".
const PAY_OFFER=/\b(?:i|we)(?:'d|'m|'re|'ll| would| will| can| could| am| are)?(?: be)?(?: (?:happy|glad|willing|able|open))?(?: to)? (?:gladly |happily |also )?(?:pay|compensate|sponsor|offer (?:you )?(?:a |some |any )?(?:small |modest |one-time |flat )?(?:fee|payment|compensation|sponsorship|budget))\b/i;
// Money words, as replies.mjs PRICE reads them. One that our own page's title, description or topic uses ("transfer fees") is
// allowed; an offer of money (PAYMENT, PAY_OFFER) never is.
const MONEY_WORDS=/\b(?:pay|paid|paying|payments?|fees?|compensat\w*|sponsor\w*|invoices?)\b|[$€£]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:usd|eur|gbp|dollars?|euros?|pounds?|bucks)\b/gi;
// Naming it as a scheme is never allowed: the owner's offer is a plain "I'd link to your article from my other site".
const SWAP=/\b(?:link[- ]?exchanges?|exchange (?:of )?links|swap(?:ping)? links|link[- ]?swap(?:s|ping)?|(?:exchange|link) schemes?|link farms?|reciprocal links?|link partnerships?)\b/i;
// Wording that offers something in return for the link: allowed only with a 3-way offer, and only in a sentence that names C.
const RETURN_OFFER=/\b(?:in return|in exchange|return the favou?r|reciprocat\w*|(?:i|we)(?:'d| would|'ll| will| can| could)(?:\s+(?:also|gladly|happily|then|certainly|definitely|be\s+(?:happy|glad)\s+to|(?:happy|glad|love|like)\s+to))*\s+(?:(?:add|place|put|give\s+you|include)\s+(?:a\s+|one\s+|another\s+)?link|link(?:ing)?)\s+(?:back\s+)?to\s+(?:you|your|their)\b)/i;
// Other wordings of a return favour: a link to their page from somewhere, a link back, featuring or listing their article on our side.
const RETURN_FAVOUR=[RETURN_OFFER,/\blink(?:s|ed|ing)?\s+(?:back\s+)?to\s+(?:you|your|their)\b[^.!?\n]{0,80}\bfrom\b/i,/\blink(?:s|ed|ing)?\s+back\s+(?:to\s+(?:you|your|their)\b|from\b)/i,
  /\b(?:feature|mention|promote|share|spotlight|list)\s+your\b/i,/\b(?:i|we)(?:'d| would|'ll| will| can| could)(?:\s+also)?\s+(?:add|include)\s+your\s+(?:[\w-]+\s+){0,3}?(?:to|on|in)\s+(?:my|our)\b/i];
const returnFavour=s=>RETURN_FAVOUR.some(re=>re.test(s));
// Without an offer: also any mention of another site of ours, which only an offer may name.
const OTHER_SITE=/\b(?:my|our) other (?:sites?|blogs?|websites?)\b|\b(?:separate|sister|second) (?:site|blog|website)\b/i;
const CLAIMS_PLACED=/\balready (?:added|placed|linked|put|included|published|links?|live|up|in place)\b|\b(?:i|we)(?:'ve| have| had) (?:already )?(?:added|placed|put|included|published|linked)\b|\b(?:the|my|our) link (?:to your \w+ )?is (?:already |now )?(?:live|up|in place)\b|\bnow links? to your\b/i;
// The same claim read anywhere in the body: "already" with a link word, or "I've added/placed ..." about a link or their page
// ("We've published a guide" is not a claim about them).
const CLAIMS_ANY=/\balready (?:added|placed|linked|put|included|published|links?|live|up|in place)\b|\b(?:i|we)(?:'ve| have| had) (?:just |now |already )*(?:linked\b|(?:added|placed|put|included|published)\b(?=[^.!?\n]{0,60}\b(?:links?|your (?:article|page|post|guide|piece|list|resource|site)|their (?:article|page|post|guide)|it there)\b))|\b(?:the|my|our) link (?:to your \w+ )?is (?:already |now )?(?:live|up|in place)\b|\bnow links? to your\b/i;
// A site named in the text (common top-level domains, so "Node.js" is not a site).
const SITE_NAME=/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|uk|de|fr|es|it|nl|eu|info|blog|site|online|app|dev|me|us|ca|au|nz|in|ch|at|be|se|no|dk|fi|pl|cz|ie|pt|gr|shop|store|tech|xyz|ai|tv|example)\b/gi;
const EMAIL_ADDR=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const OVERPROMISE=/\b(?:guarantee\w*|permanent\w*|forever|site-?wide|homepage|footer|sidebar|do-?follow|traffic|visitors|authority|domain rating|page ?rank)\b/i,METRIC=/\b(?:DA|DR)\b/;
// C is ours, and the email has to say so, in the sentence that names C: never presented as an independent site.
const DISCLOSED=/\b(?:separate|other|second|sister) (?:site|blog|website) (?:that )?(?:i|we) (?:also )?(?:run|own|manage|publish|edit)\b|\b(?:i|we) also (?:run|own|manage|publish|edit)\b|\b(?:my|our) other (?:site|blog|website)\b/i;
const INDEPENDENT=/\b(?:independent|unaffiliated|not (?:affiliated|connected|related) (?:to|with)|a friend'?s|(?:my|our|a) (?:friend|colleague|partner|client)'?s?\b|partner (?:sites?|blogs?|websites?)|third[- ]party|someone else'?s)\b/i;
// Our own page citing their article (p.cited_by_us, from our crawl) is the one true "already links" sentence a pitch may carry.
const CITED=/\balready links? to your (?:article|page|post|guide)\b/i;
const DOMAIN=/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
export const EXCHANGE_MAX_WORDS=120;
const wordCount=s=>String(s||'').split(/\s+/).filter(Boolean).length;
const sentencesOf=t=>String(t||'').replace(/https?:\/\/\S+/g,' ').split(/(?<=[.!?])\s+|\n+/).map(x=>x.trim()).filter(Boolean);
const namesHost=(text,host)=>!!host&&new RegExp(`(?:^|[^a-z0-9.-])(?:www\\.)?${host.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![a-z0-9-])`,'i').test(text);
/** A sentence without the page titles it quotes, so a title that happens to say "traffic" or "already" is not read as a claim. */
const withoutTitles=(s,ex,more=[])=>[ex.partner_title,ex.their_title,...more].filter(t=>String(t||'').trim().length>=4).sort((a,b)=>String(b).length-String(a).length)
  .reduce((t,x)=>t.split(String(x).trim()).join(' '),s).replace(/"[^"\n]{0,160}"|“[^”\n]{0,160}”/g,' ');
/**
 * Why a written pitch cannot be sent, or null when it can. The reason is logged, so a failing writer explains itself.
 * With `exchange` (the 3-way offer this email is meant to make) and `site` (the promoted site A), the body must make
 * that offer: name the partner site C in the offer sentence and say there that C is ours; every return favour it mentions
 * names C, and none names A or any other site; nothing anywhere in it claims a link is in place, promises traffic, a
 * permanent or site-wide link, or calls C independent. Without an offer, no return favour and no other site of ours is
 * mentioned at all. Money is never offered. `cited`: the prospect has our citation of their article on record (the one
 * "already links to your article" sentence allowed).
 */
export function pitchProblem(out,asset,{ownSubject=false,exchange=null,site=null,cited=false,titles:quoted=[]}={}){
  if(!out||typeof out.subject!=='string'||typeof out.body!=='string')return 'no_subject_or_body';
  // ownSubject: a follow-up's subject is ours ("Re: <original>"), not the writer's, so its length is not the writer's fault.
  if(!ownSubject&&(out.subject.length<8||out.subject.length>90)||/[\r\n]/.test(out.subject))return 'subject_length';
  if(out.body.length<200)return 'body_too_short';
  if(out.body.length>1400)return 'body_too_long';
  const urls=out.body.match(/https?:\/\/\S+/g)||[];
  if(urls.length!==1)return urls.length?'extra_url':'our_url_missing';
  if(urls[0].replace(/[).,]+$/,'')!==asset.url)return 'wrong_url';
  if(/\[|\{\{|lorem|<\w+>/i.test(out.body))return 'placeholder_or_markup';
  // The old P.S. line is gone for good (withOptOut drops it from a model's draft first).
  if(PS_LINE.test(out.body))return 'ps_not_allowed';
  // The owner's copy rules: no stock openers or flattery, and never an offer of money or a link swap.
  if(/\b(?:I hope (?:this|you)|hope you(?:'re| are) (?:well|doing)|I came across|I was reading|I stumbled (?:up)?on|love your (?:blog|site|article|post|content)|great (?:article|post|content|blog))\b/i.test(`${out.subject}\n${out.body}`))return 'cliche';
  const ex=usableOffer(exchange,site,asset);
  // Titles are quoted from pages, never written by the model: a title that says "Fees" or "Traffic" is not a claim.
  const titles=[asset.title,short(asset.title,80),short(asset.title,100),...quoted];
  const bare=withoutTitles(`${out.subject}\n${out.body}`.replace(/https?:\/\/\S+/g,' '),ex||{},titles);
  if(PAYMENT.test(`${out.subject}\n${out.body}`)||PAY_OFFER.test(bare))return 'payment_not_allowed';
  {const ours=`${asset.title||''} ${asset.description||''} ${site?.topic||''}`.toLowerCase();
    if((bare.match(MONEY_WORDS)||[]).some(w=>!/^[a-z]+$/i.test(w)||!new RegExp(`\\b${w.toLowerCase()}\\b`).test(ours)))return 'payment_not_allowed'}
  if(SWAP.test(`${out.subject}\n${out.body}`))return 'offer_not_allowed';
  // The one true "already links to your article" sentence (our citation, from our crawl) aside, nothing claims a link is in place.
  const claims=t=>sentencesOf(withoutTitles(t,ex||{},titles)).filter(s=>!(cited&&CITED.test(s)&&!/\b(?:i|we)(?:'ve| have| had)\b/i.test(s))).join(' ');
  if(!ex){
    // Without an offer nothing is offered in return, and no other site of ours is named: a promise nobody records is never made.
    if(sentencesOf(withoutTitles(out.body,{},titles)).some(s=>returnFavour(s)||OTHER_SITE.test(s)))return 'offer_not_allowed';
    if(CLAIMS_ANY.test(claims(out.body)))return 'claims_placed';
    return null;
  }
  const c=bareHost(ex.partner_site),own=[bareHost(site?.domain),bareHost(asset.url)].filter(Boolean);
  if(!namesHost(out.body,c))return returnFavour(out.body)?'exchange_partner_missing':'exchange_offer_missing';
  let disclosed=false;
  for(const s of sentencesOf(out.body)){
    const favour=returnFavour(s),offers=favour||namesHost(s,c)||/\blink\w*\b[^.!?]*\bfrom\b/i.test(s);
    if(offers&&own.some(d=>namesHost(s,d)))return 'exchange_from_target_site';
    if(favour&&!namesHost(s,c)&&/\bfrom (?:this|our|my|the same) (?:site|blog|website)\b/i.test(s))return 'exchange_from_target_site';
    // Every return favour is the one offer, from C: never a second one from the page above, our tool or another site.
    if(favour&&!namesHost(s,c))return 'exchange_extra_offer';
    if(favour&&(withoutTitles(s,ex,titles).match(DOMAIN)||[]).map(bareHost).some(h=>h!==c&&!h.endsWith('.'+c)))return 'exchange_extra_offer';
    if(namesHost(s,c)&&DISCLOSED.test(s))disclosed=true;
    // The offer sentence itself is read strictly: no "I've added/put/published" about the return link at all.
    if((favour||namesHost(s,c))&&CLAIMS_PLACED.test(withoutTitles(s,ex,titles)))return 'exchange_claims_placed';
  }
  // Claims, promises and independence are read in the whole body (titles and the true citation of their article aside).
  const said=claims(out.body);
  if(CLAIMS_ANY.test(said))return 'exchange_claims_placed';
  if(OVERPROMISE.test(said)||METRIC.test(said))return 'exchange_overpromise';
  if(!disclosed)return 'exchange_not_disclosed';
  if(INDEPENDENT.test(said))return 'exchange_implies_independent';
  if(wordCount(out.body.replace(OPT_OUT,''))>EXCHANGE_MAX_WORDS)return 'exchange_too_long';
  return null;
}
/**
 * A model-written email names only sites someone checked: ours (A and our page's host), the publisher's own, C when the email
 * makes the 3-way offer, and those the writer was given in its facts (`hosts`: a dead link's host, a competitor link). Any other
 * site ("a link from runnersworld-blog.net", "it could also appear on ...") is a promise or a claim nobody can track.
 * Quoted page titles, URLs and addresses aside. Templates name only these by construction.
 */
export function namedSitesProblem(out,asset,{exchange=null,site=null,publisher='',hosts=[],titles=[]}={}){
  const ex=usableOffer(exchange,site,asset),allowed=[site?.domain,asset?.url,ex?.partner_site,publisher,...hosts].map(bareHost).filter(Boolean);
  const text=withoutTitles(`${out?.subject||''}\n${out?.body||''}`.replace(/https?:\/\/\S+/g,' ').replace(EMAIL_ADDR,' '),ex||{},[asset?.title,...titles]);
  return (text.match(SITE_NAME)||[]).map(bareHost).some(h=>!allowed.some(d=>h===d||h.endsWith('.'+d)))?'unknown_site':null;
}
/** A follow-up must stay a short nudge and must not claim anything is new that the first email already said. */
export function followupProblem(out){
  if(String(out?.body||'').replace(OPT_OUT,'').split(/\s+/).filter(Boolean).length>75)return 'followup_too_long';
  if(/didn'?t mention|did not mention|forgot to mention|one (?:more )?detail|bump(?:ing)? (?:this|it)|circling back|top of your inbox/i.test(String(out?.body||'')))return 'followup_claim';
  return null;
}
export const validPitch=(out,asset)=>pitchProblem(out,asset)===null;
/** {subject, body} from a model's answer: the "Subject: ..." text format, or JSON (also JSON with raw line breaks). */
export function parseAnswer(text){
  const t=String(text||'').trim().replace(/^```[a-z]*\s*/i,'').replace(/\s*```$/,'').trim();
  if(t.startsWith('{')){
    try{const j=JSON.parse(t.slice(0,t.lastIndexOf('}')+1));if(typeof j.subject==='string'&&typeof j.body==='string')return {subject:j.subject,body:j.body}}catch{}
    const un=s=>s.replace(/\\n/g,'\n').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
    const s=t.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/),b=t.match(/"body"\s*:\s*"([\s\S]*)"\s*\}?\s*$/);
    return s&&b?{subject:un(s[1]),body:un(b[1])}:null;
  }
  const m=t.match(/^\**subject\**\s*:\**\s*(.+)\r?\n+([\s\S]+)$/i);
  return m?{subject:m[1].trim(),body:m[2].trim()}:null;
}
/**
 * Harmless formatting differences are fixed instead of failing the pitch: a markdown link becomes plain text,
 * bold markers go, and our URL written without its trailing slash (or with one added) is restored exactly.
 */
export function tidyPitch(out,asset){
  const subject=String(out.subject||'').replace(/^subject\s*:\s*/i,'').replace(/^["'\u201c]+|["'\u201d]+$/g,'').trim();
  const base=String(asset.url).replace(/\/+$/,'').toLowerCase();
  const body=String(out.body||'').replace(/\r\n/g,'\n')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,(m,label,url)=>label.trim().replace(/\/+$/,'')===url.replace(/\/+$/,'')?url:`${label.trim()}: ${url}`)
    .replace(/\*\*/g,'')
    .replace(/https?:\/\/[^\s<>"')\]]+/g,u=>{const clean=u.replace(/[.,;:!?]+$/,''),tail=u.slice(clean.length);return clean.replace(/\/+$/,'').toLowerCase()===base?asset.url+tail:u})
    .replace(/\n{3,}/g,'\n\n').trim();
  return {subject,body};
}

/** The 3-way offer as the AI writer is told it: names and titles only (no URL goes into the email but ours). */
const exchangeFacts=(p,ex)=>({exchange:{partner_site:bareHost(ex.partner_site),partner_title:String(ex.partner_title),their_title:ex.their_title||null,their_url:ex.their_url||null,
  same_page:!ex.their_url||samePage(ex.their_url,p.page_url),relationship:'a separate site I run'}});
/** What the AI writer is told for a first pitch: only crawl- and page-derived facts, and the situation it is in. */
function pitchFacts(p,asset,site,{senderName,exchange=null}){
  const list=isListPage(p);
  const situation=p.kind==='mention'?'unlinked_mention':p.broken_link?'broken_link_replacement':p.kind==='linkgap'&&p.competitor_link?.host?'alternative_to_linked_resource':list?'list_inclusion':'resource_suggestion';
  const cited=p.cited_by_us?.our_url?String(p.cited_by_us.our_url).replace(/^https?:\/\/(?:www\.)?/,'').replace(/\/+$/,''):null;
  return {editor_page:{title:p.title,url:p.page_url,author:p.author||null,relevant_section:p.fit_section||null,
      relevant_section_text:p.fit_excerpt?String(p.fit_excerpt).slice(0,600):null,excerpt:(p.excerpt||'').slice(0,1500)},
    // A list-inclusion ask carries at most one proof point.
    our_asset:{title:asset.title,url:asset.url,kind:KIND[asset.type]||'resource',description:asset.description||'',
      facts:situation==='list_inclusion'?assetFacts(asset).slice(0,1):[...assetFacts(asset),...(asset.reasons||[]).filter(r=>!INTERNAL_NOTE.test(r))],
      ...(situation==='list_inclusion'?{}:{free_tool:!!asset.interactive})},
    ...(situation==='list_inclusion'?{list:{name:listName(p),section:listSection(p)}}:{}),
    ...(situation==='alternative_to_linked_resource'?{competitor_link:{site:p.competitor_link.host,anchor:p.competitor_link.anchor||null,surrounding_text:p.competitor_link.context||null,same_subject:p.competitor_link.match==='specific'}}:{}),
    ...(situation==='broken_link_replacement'?{broken_link:{anchor:p.broken_link.anchor||null,site:p.broken_link.host,problem:DEAD[p.broken_link.reason]||'no longer works'}}:{}),
    ...(cited&&situation!=='unlinked_mention'?{cited_by_us:{our_page:cited}}:{}),
    ...(exchange&&situation!=='unlinked_mention'?exchangeFacts(p,exchange):{}),
    sender:{name:senderName,website:site.domain},topic:site.topic,situation};
}
/** What the AI writer is told for the follow-up: the original subject, and at most one fact the first email did not state. */
function followupFacts(p,asset,site,{senderName,subject,exchange=null}){
  const fact=p.broken_link?null:unusedFact(p,asset),list=isListPage(p);
  return {editor_page:{title:p.title,url:p.page_url,author:p.author||null,relevant_section:p.fit_section||null},
    ...(list?{list:{name:listName(p),section:listSection(p)}}:{}),
    our_asset:{title:asset.title,url:asset.url,facts:fact?[fact]:[]},new_fact:fact,
    ...(p.broken_link?{broken_link:{anchor:p.broken_link.anchor||null,site:p.broken_link.host,problem:`still ${DEAD[p.broken_link.reason]||'does not work'}`}}:{}),
    kind:p.kind==='mention'?'unlinked_mention':'suggestion',reply_subject:subject,
    ...(exchange?exchangeFacts(p,exchange):{}),
    sender:{name:senderName,website:site?.domain||''},situation:'followup'};
}

export class PitchWriter{
  constructor({apiKey,model='claude-opus-5-5',senderName,log=()=>{},providers=[],fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
    this.client=apiKey?new Anthropic({apiKey,maxRetries:2,timeout:60000}):null;
    this.model=model;this.senderName=senderName;this.log=log;this.used=0;this.fallbacks=0;
    // Free writers (OpenAI-compatible): used when no Anthropic key is set.
    this.providers=providers.map(p=>({...p,limited:new Set()}));this.usedAi=0;this.aiProvider=null;this.aiModel=null;this.fetch=fetchImpl;this.sleep=sleep;
    this.reasons={};
  }
  /** Count a template fallback by reason and say so once per reason (the reason is what makes the writer fixable). */
  fail(why,detail=''){
    this.fallbacks++;
    if(!this.reasons[why])this.log(`pitch writer: template used (${why}${detail?': '+String(detail).replace(/\s+/g,' ').slice(0,160):''})`);
    this.reasons[why]=(this.reasons[why]||0)+1;
  }
  get ai(){return this.client?'claude':this.providers.find(p=>!p.off)?.name||null}
  /**
   * One chat completion from the first free writer that can answer. Returns {out:{subject,body},provider,model} or {why, detail} (never throws).
   * With `req` ({system,user,maxTokens}) the caller's own prompt is sent and the plain answer comes back as {text,provider,model}.
   */
  async chat(facts,req=null){
    let first=null;
    for(const p of this.providers){
      if(p.off)continue;
      const r=await this.ask(p,facts,req);
      if(r.out||r.text)return r;
      first??=r;
    }
    return first||{why:this.providers.find(p=>p.offWhy)?.offWhy||'writer_off'};
  }
  /**
   * A short plain-text completion for anything other than a pitch (answers to publisher replies): the same writers
   * as pitches (Claude when its key is set, else the free writers), the caller's own system prompt. Returns
   * {text,writer} or {why} and never throws. `check(text)` may return a reason to reject the answer; the caller
   * then uses its safe template. Pitch counters are not touched.
   */
  async complete({system,user,maxTokens=1500,check}={}){
    if(!system||!user)return {why:'no_prompt'};
    const verdict=(text,writer)=>{
      text=String(text||'').replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/^```[a-z]*\s*|\s*```$/gi,'').trim();
      if(!text)return {why:'empty_answer'};
      const why=typeof check==='function'?check(text):null;
      if(why){this.completionFailures=(this.completionFailures||0)+1;return {why}}
      this.completions=(this.completions||0)+1;return {text,writer};
    };
    if(this.client){
      try{
        const res=await this.client.beta.messages.create({
          model:this.model,max_tokens:maxTokens,betas:['server-side-fallback-2026-07-01'],fallbacks:'default',
          output_config:{effort:'low'},system,messages:[{role:'user',content:user}],
        });
        if(res.stop_reason==='refusal')return {why:'refusal'};
        if(res.stop_reason==='max_tokens')return {why:'answer_cut_off'};
        return verdict(res.content.filter(b=>b.type==='text').map(b=>b.text).join(''),'claude');
      }catch(e){
        if(e instanceof Anthropic.AuthenticationError){this.log('claude: API key rejected; using templates');this.client=null}
        return {why:e instanceof Anthropic.APIError?`claude_http_${e.status}`:'claude_unreachable'};
      }
    }
    if(!this.ai)return {why:this.providers.find(x=>x.offWhy)?.offWhy||'writer_off'};
    const r=await this.chat(null,{system,user,maxTokens});
    return r.text?verdict(r.text,r.provider):{why:r.why||'no_answer'};
  }
  /** Model ids the provider lists for this key ([] when the list cannot be read). */
  async listModels(p,headers){
    const read=async(url,h)=>{
      try{
        const res=await this.fetch(url,{headers:h,redirect:'manual',signal:AbortSignal.timeout(20000)});if(!res.ok)return [];
        const j=await res.json(),list=Array.isArray(j)?j:Array.isArray(j?.data)?j.data:Array.isArray(j?.models)?j.models:[];
        return list.map(m=>typeof m==='string'?m:m?.id||m?.name).filter(Boolean);
      }catch{return []}
    };
    const ids=await read(p.base+'/models',headers);
    return ids.length||!p.nativeList?ids:read(p.nativeList.url,{[p.nativeList.keyHeader]:p.key});
  }
  async ask(p,facts,req=null){
    const key=p.getKey?await p.getKey(this.fetch):p.key;
    if(!key){p.off=true;p.offWhy='not_permitted';this.log(`${p.label}: no identity token from GitHub Actions (the workflow needs "id-token: write"); it is not used for the rest of this cycle`);return {why:'not_permitted'}}
    const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
    // Plain "Subject:" format: small models keep to it far more reliably than to JSON with line breaks inside strings.
    const system=req?req.system:SYSTEM+'\nAnswer in exactly this format, with nothing before or after it:\nSubject: <the subject line>\n\n<the email body>';
    const user=req?req.user:'Write the email from these facts (JSON):\n'+JSON.stringify(facts);
    // max_tokens leaves room for models that reason before answering; the body length is validated afterwards.
    const body=model=>JSON.stringify({model,temperature:req?0.3:0.5,max_tokens:req?.maxTokens||2000,messages:[{role:'system',content:system},{role:'user',content:user}]});
    const off=(why,line)=>{p.off=true;p.offWhy=why;this.log(line);return {why}};
    if(!p.candidates)p.candidates=[...new Set([...(p.model?[p.model]:[]),...pickModels(await this.listModels(p,headers),p.prefer||[]),...(p.fallback||[])])].slice(0,6);
    const order=[...new Set([...(p.working?[p.working]:[]),...p.candidates])].filter(m=>!p.limited.has(m));
    let lastDetail='',limited=p.limited.size>0;
    for(const model of order){
      let res;
      for(let attempt=0;;attempt++){
        // redirect:'manual': a redirect would silently turn this POST into a GET and drop the key; report it instead.
        try{res=await this.fetch(p.base+'/chat/completions',{method:'POST',headers,redirect:'manual',signal:AbortSignal.timeout(45000),body:body(model)})}
        catch(e){return {why:'unreachable',detail:`${p.label}: ${e?.name||''}`}}
        // A per-minute limit clears in seconds: wait once. Anything longer is the daily quota.
        const wait=res.status===429?Number(res.headers?.get?.('retry-after')):NaN;
        if(attempt===0&&wait>0&&wait<=20){await this.sleep(wait*1000+500);continue}
        break;
      }
      if(res.status===401||res.status===403){const said=(await res.text().catch(()=>'')).replace(/\s+/g,' ').slice(0,120);
        return off('not_permitted',`${p.label}: the ${p.getKey?'identity token':'API key'} was rejected (HTTP ${res.status}${said?': '+said:''}); it is not used for the rest of this cycle`)}
      // Quotas are per model: this model is skipped for the rest of the cycle and the next one is tried.
      if(res.status===429){p.limited.add(model);if(p.working===model)p.working=null;limited=true;continue}
      if(res.status>=300&&res.status<400)return {why:'redirected',detail:`${p.label}: HTTP ${res.status} to ${res.headers?.get?.('location')||'(no location)'}`};
      if(res.status===404||res.status===400||res.status===422){
        const text=(await res.text().catch(()=>'')).replace(/\s+/g,' ');
        // Google answers a missing or wrong key with HTTP 400, not 401.
        if(/api[ _-]?key|authorization header|unauthenticated|credential/i.test(text))return off('not_permitted',`${p.label}: the API key was rejected (HTTP ${res.status}: ${text.slice(0,100)}); it is not used for the rest of this cycle`);
        lastDetail=`HTTP ${res.status} for ${model}: ${text.slice(0,120)}`;continue;
      }
      if(!res.ok)return {why:`http_${res.status}`,detail:`${p.label}: ${(await res.text().catch(()=>'')).slice(0,120)}`};
      // Say exactly what came back: a retired service can answer "success" with no completion in it.
      const raw=await res.text().catch(()=>'');let json=null;try{json=JSON.parse(raw)}catch{}
      const content=json?.choices?.[0]?.message?.content;
      const text=(Array.isArray(content)?content.map(part=>typeof part==='string'?part:part?.text||'').join(''):String(content||'')).replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
      if(!text)return {why:json?'empty_answer':'answer_not_json',
        detail:`${p.label} ${model}: HTTP ${res.status} ${res.headers?.get?.('content-type')||'no content-type'}: ${(raw||'(empty body)').slice(0,100)}`};
      if(req){p.working=model;return {text,provider:p.name,model}}
      const out=parseAnswer(text);
      if(!out)return {why:'answer_not_in_format',detail:`${p.label} ${model}: ${text.slice(0,80)}`};
      p.working=model;
      return {out,provider:p.name,model};
    }
    if(limited&&!lastDetail)return off('quota_used_up',`${p.label}: the free quota is used up for now; it is not used for the rest of this cycle`);
    return off('no_usable_model',`${p.label}: no usable model found (${lastDetail||'no model listed'}); it is not used for the rest of this cycle`);
  }
  /**
   * The email for one prospect: a first pitch, or with {situation:'followup', subject} the one same-thread follow-up.
   * `senderName` is the per-site name it is signed with. Every result says how it was written (variant) and
   * which of our facts it states (facts_used), so a follow-up never presents a stated fact as new.
   * `exchange` (first pitches): the 3-way offer from exchange.mjs. The result carries `exchange` only when the email
   * really makes that offer (AI or template), so the caller records the promise only then. A follow-up restates the
   * offer its first email made (p.exchange, status 'offered'). Mentions never carry an offer.
   */
  async write(p,asset,site,{senderName=this.senderName,situation,subject,exchange=null,restate=true}={}){
    const followup=situation==='followup';
    // restate:false (runOutreach): the first email's offer is not repeated (its partner site is failing or no longer ours).
    const ex=p.kind==='mention'?null:followup?(restate===false?null:standingOffer(p,site,asset)):usableOffer(exchange,site,asset,p);
    const template=followup?followupPitch(p,asset,{senderName,site,subject,restate})
      :p.kind==='mention'?mentionPitch(p,asset,{senderName,site}):templatePitch(p,asset,{senderName,site,exchange:ex});
    // Once every free writer is off for this cycle (quota, rejected key), later pitches still record why they are templates.
    if(!this.ai){const why=this.providers.find(x=>x.offWhy)?.offWhy;if(why)this.fail(why);return template}
    const facts=followup?followupFacts(p,asset,site,{senderName,subject:template.subject,exchange:ex}):pitchFacts(p,asset,site,{senderName,exchange:ex});
    const stated=facts.our_asset.facts||[];
    // A follow-up keeps "Re: <original subject>" whatever the model wrote, so it threads. The closing opt-out sentence is
    // put in when the model left it out (or reworded it), so every email still says how to stop all further email.
    const check=out=>{const o=out&&typeof out==='object'&&typeof out.body==='string'?{...out,body:withOptOut(out.body),...(followup?{subject:template.subject}:{})}:out;
      const titles=[p.title,p.fit_section,p.list_page?.title,p.list_page?.other_section];
      return {o,why:pitchProblem(o,asset,{ownSubject:followup,exchange:ex,site,cited:!!p.cited_by_us?.our_url,titles})||(followup?followupProblem(o):null)
        ||namedSitesProblem(o,asset,{exchange:ex,site,publisher:p.domain||p.page_url,hosts:JSON.stringify(facts).match(SITE_NAME)||[],titles})||(grounded(o,facts)?null:'number_not_in_facts')}};
    const done=(o,writer)=>({subject:o.subject.trim(),body:o.body.trim(),writer,facts_used:factsIn(`${o.subject}\n${o.body}`,stated),
      ...(ex&&!followup?{variant:'ai:link_exchange',base_variant:`ai:${facts.situation}`,exchange:ex}:{variant:`ai:${facts.situation}`,...(ex?{exchange:ex}:{})})});
    if(!this.client){
      const r=await this.chat(facts);
      if(!r.out){this.fail(r.why,r.detail);return template}
      const {o,why}=check(tidyPitch(r.out,asset));
      if(why){this.fail(why,`${r.provider} ${r.model}`);return template}
      this.usedAi++;this.aiProvider=r.provider;this.aiModel=r.model;return done(o,r.provider);
    }
    try{
      const res=await this.client.beta.messages.create({
        model:this.model,max_tokens:2000,betas:['server-side-fallback-2026-07-01'],fallbacks:'default',
        output_config:{effort:'low',format:{type:'json_schema',schema:SCHEMA}},
        system:SYSTEM,messages:[{role:'user',content:'Write the email from these facts (JSON):\n'+JSON.stringify(facts)}],
      });
      if(res.stop_reason==='refusal'){this.fallbacks++;return template}
      const text=res.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      const {o,why}=check(JSON.parse(text));
      if(why){this.fallbacks++;return template}
      this.used++;return done(o,'claude');
    }catch(e){
      if(e instanceof Anthropic.AuthenticationError){this.log('claude: API key rejected; using templates');this.client=null}
      else if(e instanceof Anthropic.APIError)this.log(`claude: API error ${e.status}; template used`);
      else this.log('claude: '+String(e.message).slice(0,120));
      this.fallbacks++;return template;
    }
  }
}
