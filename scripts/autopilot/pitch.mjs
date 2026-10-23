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

export function templatePitch(p,asset,{senderName,site}){
  const name=firstName(p.author),kind=KIND[asset.type]||'resource',pick=parseInt(hashId(p.id),36)%3;
  const subject=[`Resource for your "${short(p.title,48)}" page`,`A ${kind} for your ${site.topic} readers`,`Quick suggestion for "${short(p.title,48)}"`][pick];
  const value=(asset.description||'').trim()||`It covers ${site.topic} in more depth than most pages we found.`;
  const body=[`Hi ${name||'there'},`,'',
    `I came across your page "${short(p.title,90)}"${p.fit_section?` — the "${short(p.fit_section,70)}" section in particular`:''} while researching ${site.topic}.`,'',
    `We recently published ${short(asset.title,100)}: ${asset.url}`,'',value,
    ...(asset.interactive?['','It is free to use, with no sign-up.']:[]),'',
    `If you think it would help your readers, it could be a useful addition to that page. Either way, thanks for putting it together.`,'',
    `Best,`,senderName,site.domain].join('\n');
  return {subject,body,writer:'template'};
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
- Subject: under 60 characters, specific, lowercase-friendly, no clickbait.`;

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
    const template=templatePitch(p,asset,{senderName:this.senderName,site});
    if(!this.client)return template;
    const facts={editor_page:{title:p.title,url:p.page_url,author:p.author||null,relevant_section:p.fit_section||null,excerpt:(p.excerpt||'').slice(0,1500)},
      our_asset:{title:asset.title,url:asset.url,kind:KIND[asset.type]||'resource',description:asset.description||'',facts:asset.reasons||[],free_tool:!!asset.interactive},
      sender:{name:this.senderName,website:site.domain},topic:site.topic};
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
