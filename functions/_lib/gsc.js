import {SITES} from './sites.js';
import {first,run,query,NOW,log} from './db.js';
const api='https://searchconsole.googleapis.com/webmasters/v3';
const b64=s=>btoa(String.fromCharCode(...(s instanceof Uint8Array?s:new TextEncoder().encode(s)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
export function rankUrls(site,rows){
 const candidates=[];
 for(const r of rows){
  const url=r.keys?.[0];let u;
  try{u=new URL(url)}catch{continue}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hostname.replace(/^www\./,'')!==site||u.pathname==='/'||/(?:^|\/)(?:privacy|terms|contact|author|tag|category|feed)(?:\/|$)/.test(u.pathname))continue;
  const impressions=Number(r.impressions||0),clicks=Number(r.clicks||0),position=Number(r.position||100);
  if(impressions<15||!Number.isFinite(position))continue;
  const type=/calculator|methodology|finder|tool|guide|framework|security|comparison|study/i.test(url)?'linkable_resource':'editorial_review';
  const gap=Math.max(0,impressions*(position<=10?.04:.015)-clicks);
  const score=Math.round((Math.log1p(impressions)*8+Math.sqrt(gap)*6)*(type==='linkable_resource'?1.35:.8)*(position<=20?1.2:.7));
  candidates.push({site,url,impressions,clicks,position,score,type});
 }
 return candidates.sort((a,b)=>b.score-a.score).slice(0,20);
}
export async function getToken(env){
 if(!env.GSC_SERVICE_ACCOUNT_JSON)throw Error('GSC service account not configured');
 const account=JSON.parse(env.GSC_SERVICE_ACCOUNT_JSON);
 if(account.type!=='service_account'||!account.private_key||!account.client_email)throw Error('Invalid service account');
 const raw=account.private_key.replace(/-----[^-]+-----|\s/g,'');
 const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(raw),x=>x.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const now=Math.floor(Date.now()/1000),header=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
 const claim=b64(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/webmasters.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3000}));
 const data=header+'.'+claim,signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(data));
 const reply=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:data+'.'+b64(new Uint8Array(signature))})});
 if(!reply.ok)throw Error('GSC OAuth HTTP '+reply.status);
 const result=await reply.json();if(!result.access_token)throw Error('Missing access token');
 return result.access_token;
}
async function google(url,token,body){
 const reply=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 if(!reply.ok)throw Error('GSC API HTTP '+reply.status);
 return reply.json();
}
export async function collectSite(db,env,site){
 if(!SITES.some(s=>s.domain===site))return {blocked:'Unknown site'};
 if(!env.GSC_SERVICE_ACCOUNT_JSON)return {blocked:'GSC credential missing'};
 try{
  const token=await getToken(env),sites=await google(api+'/sites',token);
  const property=['sc-domain:'+site,'https://'+site+'/'].find(x=>sites.siteEntry?.some(y=>y.siteUrl===x));
  if(!property)throw Error('Service account lacks GSC property permission');
  const end=new Date(Date.now()-3*86400000),start=new Date(end.getTime()-89*86400000);
  const body={startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10),dimensions:['page'],rowLimit:5000,type:'web',dataState:'final'};
  const all=[];
  for(let offset=0;offset<25000;offset+=5000){
    const data=await google(api+'/sites/'+encodeURIComponent(property)+'/searchAnalytics/query',token,{...body,startRow:offset});
    const rows=Array.isArray(data.rows)?data.rows:[];
    all.push(...rows);
    if(rows.length<5000)break;
  }
  const items=rankUrls(site,all);
  for(const x of items){
   await run(db,'INSERT INTO url_opportunities(site,url,score,impressions,clicks,position,kind,state,measured_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(site,url) DO UPDATE SET score=excluded.score,impressions=excluded.impressions,clicks=excluded.clicks,position=excluded.position,kind=excluded.kind,measured_at=excluded.measured_at',
    site,x.url,x.score,x.impressions,x.clicks,x.position,x.type,'needs_validation',NOW());
  }
  await log(db,'gsc_site_collected',{site,count:items.length,partial:(all.length===25000)});
  return {site,items:items.length,source:'Official Search Console API',partial:(data.rows||[]).length===5000};
 }catch(e){await log(db,'gsc_site_error',{site,error:String(e.message).slice(0,100)});return {blocked:String(e.message).slice(0,120),site};}
}
