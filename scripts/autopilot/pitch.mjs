/**
 * Personalised pitch writer. Uses Claude when ANTHROPIC_API_KEY is configured
 * (grounded strictly in the fetched prospect page + our asset facts), otherwise a
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
const valueLine=(asset,site)=>{
  const d=(asset.description||'').trim().replace(/\s+/g,' ');
  const facts=assetFacts(asset);
  return [d&&d.length>=40?(/[.!?]$/.test(d)?d:d+'.'):`It covers ${site.topic} in practical detail.`,facts.length?sentence(facts.join(', and ')):''].filter(Boolean).join(' ');
};
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
export function alternativePitch(p,asset,{senderName,site}){
  const c=p.competitor_link,name=firstName(p.author),kind=KIND[asset.type]||'resource';
  // "Same topic" is claimed only when the competitor link and our page share specific subject words.
  const opener=c.match==='specific'?`so I thought you might want a second option on the same topic.`
    :`If you ever add another ${short(site.topic,40)} resource there, this one might be useful to the same readers.`;
  return {subject:`Another ${kind} for "${short(p.title,44)}"`,
    body:[`Hi ${name||'there'},`,'',
      c.match==='specific'?`In "${short(p.title,90)}" you link to ${linkLabel(c)}, ${opener}`:`In "${short(p.title,90)}" you link to ${linkLabel(c)}. ${opener}`,'',
      `${short(asset.title,100)}: ${asset.url}`,'',valueLine(asset,site),'',
      `If it's useful, it could sit next to the existing link. Either way, thanks for maintaining the page.`,'',
      `Best,`,senderName,site.domain,'',OPT_OUT].join('\n'),writer:'template'};
}
export function templatePitch(p,asset,{senderName,site}){
  if(p.broken_link)return brokenLinkPitch(p,asset,{senderName,site});
  if(p.kind==='linkgap'&&p.competitor_link?.host)return alternativePitch(p,asset,{senderName,site});
  const name=firstName(p.author),kind=KIND[asset.type]||'resource',pick=parseInt(hashId(p.id),36)%3;
  const subject=[`Resource for your "${short(p.title,48)}" page`,`A ${kind} for your ${short(site.topic,30)} readers`,`Suggestion for "${short(p.title,48)}"`][pick];
  const where=p.fit_section?`your "${short(p.fit_section,70)}" section in "${short(p.title,70)}"`:`"${short(p.title,90)}"`;
  const body=[`Hi ${name||'there'},`,'',
    `I was reading ${where} and thought one resource might be a good fit for it.`,'',
    `${short(asset.title,100)}: ${asset.url}`,'',valueLine(asset,site),'',
    `If it would help your readers, feel free to add it to the page. Either way, thanks for putting it together.`,'',
    `Best,`,senderName,site.domain,'',OPT_OUT].join('\n');
  return {subject,body,writer:'template'};
}
const DEAD={not_found:'returns a "page not found" error',gone:'returns a "page removed" error',domain_gone:'points to a domain that no longer exists'};
/** A real dead link on their page (re-checked before sending) and our page as a replacement. */
export function brokenLinkPitch(p,asset,{senderName,site}){
  const b=p.broken_link,name=firstName(p.author);
  const label=b.anchor&&b.anchor.length>=3?`"${short(b.anchor,60)}" (${b.host})`:`the ${b.host} link`;
  return {subject:`Broken link on "${short(p.title,48)}"`,
    body:[`Hi ${name||'there'},`,'',
      `I was reading "${short(p.title,90)}" and noticed that the link to ${label} ${DEAD[b.reason]||'no longer works'}.`,'',
      `If you're looking for a replacement, ${short(asset.title,100)} covers the same ground: ${asset.url}`,'',valueLine(asset,site),'',
      `Either way, it may be worth fixing or removing the old link so readers don't hit a dead end.`,'',
      `Best,`,senderName,site.domain,'',OPT_OUT].join('\n'),writer:'template'};
}
const OPT_OUT='P.S. Not relevant for you? Just reply "no" and I won\'t email again.';
/** The editor already mentions us without a link: thank them, ask for the link. */
export function mentionPitch(p,asset,{senderName,site}){
  const name=firstName(p.author),brand=asset.title||site.domain;
  return {subject:`Thanks for mentioning ${short(brand,40)}`,
    body:[`Hi ${name||'there'},`,'',
      `Thanks for mentioning ${brand} in "${short(p.title,90)}" — I really appreciate it.`,'',
      `Would you consider turning the mention into a link, so readers can find it in one click? Here's the address: ${asset.url}`,'',
      `Thanks again for including us.`,'',`Best,`,senderName,site.domain,'',OPT_OUT].join('\n'),writer:'template'};
}
/**
 * One follow-up that adds a NEW reason to reply (a re-checked dead link, or a verifiable fact about the page)
 * instead of "bumping this up", and makes answering a one-word reply.
 */
export function followupPitch(p,asset,{senderName}){
  const name=firstName(p.author),b=p.broken_link,facts=assetFacts(asset);
  const reason=b?`The link to ${b.anchor&&b.anchor.length>=3?`"${short(b.anchor,60)}" (${b.host})`:`the ${b.host} link`} on that page still ${DEAD[b.reason]||'does not work'}, so this could replace it.`
    :facts.length?`One detail I didn't mention: ${facts[0]}.`:'';
  return {subject:/^re:/i.test(p.last_subject||'')?p.last_subject:`Re: ${p.last_subject||short(asset.title)}`,
    body:[`Hi ${name||'there'},`,'',`Following up on my note about "${short(p.title,80)}".${reason?' '+reason:''}`,'',`Here it is again: ${asset.url}`,'',
      `If it's not a fit, just reply "no" and I won't email again.`,'',`Best,`,senderName].join('\n'),writer:'template'};
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
const GITHUB_MODELS='https://models.github.ai';
/** Tried in order; the catalogue is consulted when none of them exists any more. */
const GITHUB_MODEL_PREFERENCE=['openai/gpt-4.1-mini','openai/gpt-4o-mini','openai/gpt-4.1','openai/gpt-4o'];
const SCHEMA={type:'object',properties:{subject:{type:'string'},body:{type:'string'}},required:['subject','body'],additionalProperties:false};
const SYSTEM=`You write short, honest link-suggestion emails to independent website editors.
Rules:
- 70 to 130 words in the body. Plain text, no markdown, no emojis.
- Refer to something specific on the editor's page (its title, a section, or a point made in the excerpt) so it is obviously not a mass email. Say where on their page our resource would fit when a relevant_section is given.
- Never open with "I hope this finds you well", "I came across your site" or "I was reading"; start with the specific observation.
- Explain in one or two sentences what our resource adds for THEIR readers. Only state facts present in the provided asset details; never invent statistics, awards, traffic, or that they linked to us before.
- Include our asset URL exactly once. Include no other URLs.
- One soft ask (consider adding it to the page). No pressure, no guilt, no flattery clichés ("I love your blog", "great content"), no offer of payment or link exchange.
- Greet by first name only if an author name is provided, otherwise "Hi there".
- Sign off with the sender name and website provided.
- Subject: under 60 characters, specific, lowercase-friendly, no clickbait.
- If situation is "unlinked_mention": the editor already mentions our brand without a link. Thank them briefly and ask them to turn the mention into a link to our URL. Do not pitch anything else.
- If situation is "alternative_to_linked_resource": the editor's page already links to competitor_link (name it by its anchor text if it reads naturally, otherwise by its site name; never give its URL). Open with that specific link, then say in one sentence what our resource adds for the same readers, using only the provided facts. Offer it as an additional option next to the existing link. If competitor_link.same_subject is false, do not claim the two cover the same subject: present ours only as another resource the same readers may find useful. Never say ours is better and never criticise the other site.
- If situation is "broken_link_replacement": open by telling the editor which link on their page is dead (use its anchor text and site name from broken_link, never its URL, and state the problem exactly as given in broken_link.problem). Then offer our page as a replacement covering the same topic. The helpful tip comes first; the ask is secondary.
- End with this exact line: P.S. Not relevant for you? Just reply "no" and I won't email again.`;

/** Why a written pitch cannot be sent, or null when it can. The reason is logged, so a failing writer explains itself. */
export function pitchProblem(out,asset){
  if(!out||typeof out.subject!=='string'||typeof out.body!=='string')return 'no_subject_or_body';
  if(out.subject.length<8||out.subject.length>90||/[\r\n]/.test(out.subject))return 'subject_length';
  if(out.body.length<200)return 'body_too_short';
  if(out.body.length>1400)return 'body_too_long';
  const urls=out.body.match(/https?:\/\/\S+/g)||[];
  if(urls.length!==1)return urls.length?'extra_url':'our_url_missing';
  if(urls[0].replace(/[).,]+$/,'')!==asset.url)return 'wrong_url';
  if(/\[|\{\{|lorem|<\w+>/i.test(out.body))return 'placeholder_or_markup';
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

export class PitchWriter{
  constructor({apiKey,model='claude-opus-5-5',senderName,log=()=>{},githubToken='',githubModel='',fetchImpl=fetch}){
    this.client=apiKey?new Anthropic({apiKey,maxRetries:2,timeout:60000}):null;
    this.model=model;this.senderName=senderName;this.log=log;this.used=0;this.fallbacks=0;
    // Free writer inside GitHub Actions (GitHub Models): used when no Anthropic key is set.
    this.ghToken=githubToken;this.ghModels=[...(githubModel?[githubModel]:[]),...GITHUB_MODEL_PREFERENCE];this.ghModel=null;this.usedGithub=0;this.fetch=fetchImpl;
    this.reasons={};
  }
  /** Count a template fallback by reason and say so once per reason (the reason is what makes the writer fixable). */
  fail(why,detail=''){
    this.fallbacks++;
    if(!this.reasons[why])this.log(`pitch writer: template used (${why}${detail?': '+String(detail).replace(/\s+/g,' ').slice(0,140):''})`);
    this.reasons[why]=(this.reasons[why]||0)+1;
  }
  get ai(){return this.client?'claude':this.ghToken&&!this.ghOff?'github_models':null}
  /** One chat completion on GitHub Models. Returns {out:{subject,body}} or {why, detail} (never throws). */
  async github(facts){
    if(!this.ghToken||this.ghOff)return {why:this.ghOffWhy||'writer_off'};
    const headers={Authorization:'Bearer '+this.ghToken,'Content-Type':'application/json',Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
    // Plain "Subject:" format: small models keep to it far more reliably than to JSON with line breaks inside strings.
    const system=SYSTEM+'\nAnswer in exactly this format, with nothing before or after it:\nSubject: <the subject line>\n\n<the email body>';
    const ask=async model=>this.fetch(GITHUB_MODELS+'/inference/chat/completions',{method:'POST',headers,signal:AbortSignal.timeout(45000),body:JSON.stringify({model,temperature:0.5,max_tokens:700,
      messages:[{role:'system',content:system},{role:'user',content:'Write the email from these facts (JSON):\n'+JSON.stringify(facts)}]})});
    const off=(why,line)=>{this.ghOff=true;this.ghOffWhy=why;this.log(line);return {why}};
    const candidates=this.ghModel?[this.ghModel]:this.ghModels;
    let lastDetail='';
    for(let i=0;i<candidates.length;i++){
      let res;try{res=await ask(candidates[i])}catch(e){return {why:'unreachable',detail:e?.name||''}}
      if(res.status===401||res.status===403)return off('not_permitted',`github models: not permitted (HTTP ${res.status}); the workflow needs "models: read". Templates are used`);
      if(res.status===429)return off('quota_used_up','github models: today\'s free quota is used up; templates are used for the rest of this cycle');
      if(res.status===404||res.status===400||res.status===422){
        lastDetail=`HTTP ${res.status} for ${candidates[i]}: ${(await res.text().catch(()=>'')).slice(0,120)}`;
        // Unknown model: after the known names, ask the catalogue once for a small text model.
        if(i===candidates.length-1&&!this.ghCatalogTried){this.ghCatalogTried=true;const found=await this.catalogModel(headers);if(found&&!candidates.includes(found))candidates.push(found)}
        continue;
      }
      if(!res.ok)return {why:`http_${res.status}`,detail:(await res.text().catch(()=>'')).slice(0,120)};
      const body=await res.json().catch(()=>null),text=String(body?.choices?.[0]?.message?.content||'');
      if(!text)return {why:'empty_answer',detail:JSON.stringify(body||{}).slice(0,120)};
      const out=parseAnswer(text);
      if(!out)return {why:'answer_not_in_format',detail:text.slice(0,80)};
      this.ghModel=candidates[i];
      return {out};
    }
    this.ghOff=true;this.ghOffWhy='no_usable_model';this.log(`github models: no usable model found (${lastDetail}); templates are used`);
    return {why:'no_usable_model'};
  }
  async catalogModel(headers){
    try{
      const res=await this.fetch(GITHUB_MODELS+'/catalog/models',{headers,signal:AbortSignal.timeout(20000)});if(!res.ok)return null;
      const list=await res.json();if(!Array.isArray(list))return null;
      const text=list.filter(m=>m?.id&&(m.supported_output_modalities||['text']).includes('text')&&!/embed/i.test(m.id));
      return (text.find(m=>/mini/i.test(m.id)&&/^openai\//.test(m.id))||text.find(m=>m.rate_limit_tier==='low')||text[0])?.id||null;
    }catch{return null}
  }
  async write(p,asset,site){
    const template=(p.kind==='mention'?mentionPitch:templatePitch)(p,asset,{senderName:this.senderName,site});
    // Once the free writer is off for this cycle (quota, permission), later pitches still record why they are templates.
    if(!this.ai){if(this.ghOffWhy)this.fail(this.ghOffWhy);return template}
    const facts={editor_page:{title:p.title,url:p.page_url,author:p.author||null,relevant_section:p.fit_section||null,excerpt:(p.excerpt||'').slice(0,1500)},
      our_asset:{title:asset.title,url:asset.url,kind:KIND[asset.type]||'resource',description:asset.description||'',facts:[...assetFacts(asset),...(asset.reasons||[]).filter(r=>!INTERNAL_NOTE.test(r))],free_tool:!!asset.interactive},
      ...(p.kind==='linkgap'&&p.competitor_link?.host&&!p.broken_link?{competitor_link:{site:p.competitor_link.host,anchor:p.competitor_link.anchor||null,surrounding_text:p.competitor_link.context||null,same_subject:p.competitor_link.match==='specific'}}:{}),
      ...(p.broken_link&&p.kind!=='mention'?{broken_link:{anchor:p.broken_link.anchor||null,site:p.broken_link.host,problem:DEAD[p.broken_link.reason]||'no longer works'}}:{}),
      sender:{name:this.senderName,website:site.domain},topic:site.topic,situation:p.kind==='mention'?'unlinked_mention':p.broken_link?'broken_link_replacement':p.kind==='linkgap'&&p.competitor_link?.host?'alternative_to_linked_resource':'resource_suggestion'};
    if(!this.client){
      const r=await this.github(facts);
      if(!r.out){this.fail(r.why,r.detail);return template}
      const out=tidyPitch(r.out,asset),why=pitchProblem(out,asset)||(grounded(out,facts)?null:'number_not_in_facts');
      if(why){this.fail(why);return template}
      this.usedGithub++;return {...out,writer:'github_models'};
    }
    try{
      const res=await this.client.beta.messages.create({
        model:this.model,max_tokens:2000,betas:['server-side-fallback-2026-07-01'],fallbacks:'default',
        output_config:{effort:'low',format:{type:'json_schema',schema:SCHEMA}},
        system:SYSTEM,messages:[{role:'user',content:'Write the email from these facts (JSON):\n'+JSON.stringify(facts)}],
      });
      if(res.stop_reason==='refusal'){this.fallbacks++;return template}
      const text=res.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      const out=JSON.parse(text);
      if(!validPitch(out,asset)||!grounded(out,facts)){this.fallbacks++;return template}
      this.used++;return {subject:out.subject.trim(),body:out.body.trim(),writer:'claude'};
    }catch(e){
      if(e instanceof Anthropic.AuthenticationError){this.log('claude: API key rejected; using templates');this.client=null}
      else if(e instanceof Anthropic.APIError)this.log(`claude: API error ${e.status}; template used`);
      else this.log('claude: '+String(e.message).slice(0,120));
      this.fallbacks++;return template;
    }
  }
}
