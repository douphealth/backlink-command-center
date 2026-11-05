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
  if(asset.interactive)f.push('it is a free interactive tool (no sign-up needed)');
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
export function templatePitch(p,asset,{senderName,site}){
  if(p.broken_link)return brokenLinkPitch(p,asset,{senderName,site});
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
export function followupPitch(p,asset,{senderName}){
  const name=firstName(p.author);
  return {subject:/^re:/i.test(p.last_subject||'')?p.last_subject:`Re: ${p.last_subject||short(asset.title)}`,
    body:[`Hi ${name||'there'},`,'',`Just bringing this back to the top of your inbox in case it got buried: ${short(asset.title,100)} (${asset.url}) could be a good fit for "${short(p.title,80)}".`,'',`No worries if it is not a match. I will not follow up again.`,'',`Best,`,senderName].join('\n'),writer:'template'};
}

const SCHEMA={type:'object',properties:{subject:{type:'string'},body:{type:'string'}},required:['subject','body'],additionalProperties:false};
const SYSTEM=`You write short, honest link-suggestion emails to independent website editors.
Rules:
- 70 to 130 words in the body. Plain text, no markdown, no emojis.
- Refer to something specific on the editor's page (its title or a section) so it is obviously not a mass email.
- Explain in one or two sentences what our resource adds for THEIR readers. Only state facts present in the provided asset details; never invent statistics, awards, traffic, or that they linked to us before.
- Include our asset URL exactly once. Include no other URLs.
- One soft ask (consider adding it to the page). No pressure, no guilt, no flattery clichés ("I love your blog", "great content"), no offer of payment or link exchange.
- Greet by first name only if an author name is provided, otherwise "Hi there".
- Sign off with the sender name and website provided.
- Subject: under 60 characters, specific, lowercase-friendly, no clickbait.
- If situation is "unlinked_mention": the editor already mentions our brand without a link. Thank them briefly and ask them to turn the mention into a link to our URL. Do not pitch anything else.
- If situation is "broken_link_replacement": open by telling the editor which link on their page is dead (use its anchor text and site name from broken_link, never its URL, and state the problem exactly as given in broken_link.problem). Then offer our page as a replacement covering the same topic. The helpful tip comes first; the ask is secondary.
- End with this exact line: P.S. Not relevant for you? Just reply "no" and I won't email again.`;

export function validPitch(out,asset){
  if(!out||typeof out.subject!=='string'||typeof out.body!=='string')return false;
  const urls=out.body.match(/https?:\/\/\S+/g)||[];
  return out.subject.length>=8&&out.subject.length<=90&&!/[\r\n]/.test(out.subject)&&out.body.length>=200&&out.body.length<=1400&&
    urls.length===1&&urls[0].replace(/[).,]+$/,'')===asset.url&&!/\[|\{\{|lorem|<\w+>/i.test(out.body);
}

export class PitchWriter{
  constructor({apiKey,model='claude-opus-5-5',senderName,log=()=>{}}){
    this.client=apiKey?new Anthropic({apiKey,maxRetries:2,timeout:60000}):null;
    this.model=model;this.senderName=senderName;this.log=log;this.used=0;this.fallbacks=0;
  }
  async write(p,asset,site){
    const template=(p.kind==='mention'?mentionPitch:templatePitch)(p,asset,{senderName:this.senderName,site});
    if(!this.client)return template;
    const facts={editor_page:{title:p.title,url:p.page_url,author:p.author||null,relevant_section:p.fit_section||null,excerpt:(p.excerpt||'').slice(0,1500)},
      our_asset:{title:asset.title,url:asset.url,kind:KIND[asset.type]||'resource',description:asset.description||'',facts:[...assetFacts(asset),...(asset.reasons||[]).filter(r=>!INTERNAL_NOTE.test(r))],free_tool:!!asset.interactive},
      ...(p.broken_link&&p.kind!=='mention'?{broken_link:{anchor:p.broken_link.anchor||null,site:p.broken_link.host,problem:DEAD[p.broken_link.reason]||'no longer works'}}:{}),
      sender:{name:this.senderName,website:site.domain},topic:site.topic,situation:p.kind==='mention'?'unlinked_mention':p.broken_link?'broken_link_replacement':'resource_suggestion'};
    try{
      const res=await this.client.beta.messages.create({
        model:this.model,max_tokens:2000,betas:['server-side-fallback-2026-07-01'],fallbacks:'default',
        output_config:{effort:'low',format:{type:'json_schema',schema:SCHEMA}},
        system:SYSTEM,messages:[{role:'user',content:'Write the email from these facts (JSON):\n'+JSON.stringify(facts)}],
      });
      if(res.stop_reason==='refusal'){this.fallbacks++;return template}
      const text=res.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      const out=JSON.parse(text);
      if(!validPitch(out,asset)){this.fallbacks++;return template}
      this.used++;return {subject:out.subject.trim(),body:out.body.trim(),writer:'claude'};
    }catch(e){
      if(e instanceof Anthropic.AuthenticationError){this.log('claude: API key rejected; using templates');this.client=null}
      else if(e instanceof Anthropic.APIError)this.log(`claude: API error ${e.status}; template used`);
      else this.log('claude: '+String(e.message).slice(0,120));
      this.fallbacks++;return template;
    }
  }
}
