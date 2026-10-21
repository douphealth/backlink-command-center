/**
 * LinkForge public evidence collector. Strictly static, first-party URLs.
 * No GSC credentials, emails, publisher probing, paid APIs or invented metrics.
 * GitHub Actions runs it daily; the browser can read the resulting JSON.
 */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';

const MAX_HTML=120000;
const SAFE_TIMEOUT_MS=12000;
const acceptedProtocol='https:';

function attr(tag,name){
  const match=tag.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27|([^\\s>]+))','i'));
  return match?(match[1]??match[2]??match[3]??''):'';
}
function normalize(url,base){
  try{
    const u=new URL(url,base);
    if(u.protocol!==acceptedProtocol||u.username||u.password)return '';
    u.hash='';u.search='';
    return u.href.replace(/\/$/,'').toLowerCase();
  }catch{return '';}
}
export function evaluatePublicPage(url,{status=0,contentType='',headers={},body=''}={}){
  const getHeader=k=>headers?.get?.(k)??headers[k]??headers[k.toLowerCase()]??'';
  const titleTag=body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title=titleTag?titleTag[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,150):'';
  const links=[...body.matchAll(/<link\b[^>]*>/gi)];
  const canonical=links.find(x=>/\bcanonical\b/i.test(attr(x[0],'rel')));
  const canonicalUrl=canonical?attr(canonical[0],'href'):'';
  const meta=[...body.matchAll(/<meta\b[^>]*>/gi)].filter(x=>/^(?:robots|googlebot)$/i.test(attr(x[0],'name')));
  const robots=[getHeader('x-robots-tag'),...meta.map(x=>attr(x[0],'content'))].join(' ').toLowerCase();
  const noindex=/\bnoindex\b/i.test(robots), nofollow=/\bnofollow\b/i.test(robots);
  const contentLength=body.length;
  const canonicalMatches=Boolean(canonicalUrl&&normalize(canonicalUrl,url)===normalize(url));
  const html=contentType.toLowerCase().includes('text/html');
  let statusLabel='unreachable_from_probe';
  if(status>=300&&status<400)statusLabel='redirect_requires_review';
  else if(status===200&&!html)statusLabel='unexpected_content_type';
  else if(status===200&&noindex)statusLabel='blocked_noindex';
  else if(status===200&&canonicalUrl&&!canonicalMatches)statusLabel='blocked_canonical';
  else if(status===200&&(!canonicalUrl||!title||contentLength<650))statusLabel='needs_editorial_review';
  else if(status===200)statusLabel='technically_eligible';
  return {http_status:status,technical_status:statusLabel,title,canonical:canonicalUrl||null,canonical_matches:canonicalMatches,noindex,nofollow,html_length:contentLength};
}
export function editorialSignals(url,topic=''){
  const path=new URL(url).pathname.toLowerCase(),description=(path+' '+topic).toLowerCase();
  const research=/methodology|research|study|compare|comparison|framework|security|identif|reference/.test(description);
  const tool=/calculator|finder|match|planner|generator|tool|blueprint|quiz/.test(description);
  const guide=/guide|how-to|spaced-repetition|plant|review|learn|care/.test(description);
  const commercial=/affiliate|price|deal|coupon|shopping|checkout/.test(description);
  let fit=research?85:tool?81:guide?68:52;
  if(commercial)fit-=23;
  return {category:research?'reference':tool?'interactive_tool':guide?'practical_guide':'editorial_review',editorial_fit_score:fit};
}
export async function collectPublicEvidence(portfolio,{fetchImpl=fetch,now=new Date()}={}){
  const sites=Array.isArray(portfolio?.sites)?portfolio.sites:[];
  const resources=sites.flatMap(s=>(s.assets||[]).map(url=>({site:s.domain,topic:s.topic||'',url})));
  const unique=[...new Map(resources.filter(x=>{
    try{
      const u=new URL(x.url);
      return u.protocol===acceptedProtocol&&!u.username&&!u.password&&!u.port&&(u.hostname===x.site||u.hostname.endsWith('.'+x.site));
    }catch{return false}
  }).map(x=>[x.url,x])).values()];
  let cursor=0;
  const output=new Array(unique.length);
  const runner=async()=>{
    while(cursor<unique.length){
      const n=cursor++,entry=unique[n],signals=editorialSignals(entry.url,entry.topic);
      const fallback={...entry,...signals,http_status:0,technical_status:'unreachable_from_probe',title:'',canonical:null,canonical_matches:false,noindex:false,nofollow:false,html_length:0};
      try{
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),SAFE_TIMEOUT_MS);
        let response;
        try{
          response=await fetchImpl(entry.url,{method:'GET',redirect:'manual',signal:controller.signal,headers:{'Accept':'text/html','User-Agent':'LinkForge-Resource-Audit/1.0'}});
          const contentType=response.headers.get('content-type')||'';
          let body='';
          if(response.status===200&&contentType.includes('text/html')){
            if(response.body?.getReader){
              const reader=response.body.getReader(),decoder=new TextDecoder();
              try{
                while(body.length<MAX_HTML){
                  const next=await reader.read();if(next.done)break;
                  body+=decoder.decode(next.value,{stream:true});
                }
              }finally{await reader.cancel().catch(()=>{});}
            }else body=(await response.text()).slice(0,MAX_HTML);
          }
          output[n]={...fallback,...evaluatePublicPage(entry.url,{status:response.status,contentType,headers:response.headers,body})};
        }finally{clearTimeout(timer);}
      }catch{output[n]=fallback;}
    }
  };
  await Promise.all(Array.from({length:Math.min(3,unique.length)},runner));
  return {schema_version:1,generated_at:now.toISOString(),source:'public_http_technical_checks',gsc_metrics_included:false,
    methodology:'Technical checks of configured owned resources only. Editorial fit is a deterministic heuristic, not search traffic or backlinks.',
    urls:output.sort((a,b)=>(b.technical_status==='technically_eligible'?1:0)-(a.technical_status==='technically_eligible'?1:0)||b.editorial_fit_score-a.editorial_fit_score)};
}
const main=fileURLToPath(import.meta.url)===resolve(process.argv[1]||'');
if(main){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const input=JSON.parse(await readFile(resolve(root,'public/portfolio.json'),'utf8'));
  const evidence=await collectPublicEvidence(input);
  const out=resolve(root,'public/public-intelligence.json');
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(evidence,null,2)+'\n','utf8');
  console.log('Public owned-URL checks:',evidence.urls.length,'technically eligible:',evidence.urls.filter(x=>x.technical_status==='technically_eligible').length);
}
