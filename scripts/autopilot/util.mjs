/** Shared helpers for the LinkForge Autopilot engine (Node 22+, no dependencies). */
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const NOW=()=>new Date().toISOString();
export const DAY=86400e3;
export const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export const ageDays=t=>t?(Date.now()-Date.parse(t))/DAY:Infinity;
export const rootDomain=host=>String(host||'').toLowerCase().replace(/^www\./,'');
export const hostOf=url=>{try{return rootDomain(new URL(url).hostname)}catch{return ''}};
export const sameSite=(host,domain)=>{const h=rootDomain(host);return h===domain||h.endsWith('.'+domain)};

export function normUrl(url,base){
  try{const u=new URL(url,base);if(!/^https?:$/.test(u.protocol))return '';u.hash='';
    for(const k of [...u.searchParams.keys()])if(/^(utm_|fbclid|gclid|ref$)/i.test(k))u.searchParams.delete(k);
    u.hostname=u.hostname.toLowerCase();return u.href.replace(/\/$/,'');}catch{return ''}
}
export function safePublicUrl(url){
  try{const u=new URL(url);if(!/^https?:$/.test(u.protocol)||u.username||u.password)return false;
    const h=u.hostname.toLowerCase();
    if(/^(localhost|.*\.local|.*\.internal|.*\.invalid|.*\.test)$/.test(h)||/^\d+\.\d+\.\d+\.\d+$/.test(h)||h.includes(':'))return false;
    return /\.[a-z]{2,}$/.test(h);}catch{return false}
}

/** Bounded concurrency map that preserves input order. */
export async function pool(items,limit,fn){
  const out=new Array(items.length);let i=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(i<items.length){const n=i++;try{out[n]=await fn(items[n],n)}catch(e){out[n]={error:String(e?.message||e)}}}}));
  return out;
}

const UA='Mozilla/5.0 (compatible; LinkForgeAutopilot/7.0; +https://backlink-command-center.pages.dev)';
/** GET with timeout, byte cap, redirect following (bounded) and conditional-request support. */
export async function fetchPage(url,{timeout=12000,maxBytes=400000,etag,lastModified,accept='text/html,application/xhtml+xml',fetchImpl=fetch,redirects=4}={}){
  let current=url;
  for(let hop=0;hop<=redirects;hop++){
    if(!safePublicUrl(current))return {url:current,status:0,error:'unsafe_url'};
    const headers={'User-Agent':UA,Accept:accept,'Accept-Language':'en'};
    if(hop===0&&etag)headers['If-None-Match']=etag;
    if(hop===0&&lastModified)headers['If-Modified-Since']=lastModified;
    let res;
    try{res=await fetchImpl(current,{redirect:'manual',headers,signal:AbortSignal.timeout(timeout)})}
    catch(e){return {url:current,status:0,error:e?.name==='TimeoutError'?'timeout':'network'}}
    if(res.status>=300&&res.status<400&&res.status!==304){
      const loc=res.headers.get('location');try{await res.body?.cancel()}catch{}
      if(!loc)return {url:current,status:res.status,error:'redirect_without_location'};
      current=new URL(loc,current).href;continue;
    }
    const type=res.headers.get('content-type')||'';
    let body='';
    if(res.status===200&&/html|xml|text\/plain/i.test(type)){
      if(res.body?.getReader){const reader=res.body.getReader(),dec=new TextDecoder();
        try{while(body.length<maxBytes){const n=await reader.read();if(n.done)break;body+=dec.decode(n.value,{stream:true})}}
        finally{await reader.cancel().catch(()=>{})}
      }else body=(await res.text()).slice(0,maxBytes);
    }else{try{await res.body?.cancel()}catch{}}
    return {url:current,requested:url,redirected:normUrl(current)!==normUrl(url),status:res.status,type,body,headers:res.headers,
      etag:res.headers.get('etag')||'',lastModified:res.headers.get('last-modified')||''};
  }
  return {url:current,status:0,error:'too_many_redirects'};
}

/* ---------- HTML parsing (regex-based; robust enough for audit signals) ---------- */
export function attr(tag,name){
  const m=tag.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i'));
  return m?decodeEntities(m[1]??m[2]??m[3]??''):'';
}
export function decodeEntities(s){
  return String(s||'').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp|hellip|ndash|mdash|rsquo|lsquo|rdquo|ldquo);/gi,(m,e)=>{
    const k=e.toLowerCase(),map={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',hellip:'…',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“'};
    if(k[0]==='#'){const n=k[1]==='x'?parseInt(k.slice(2),16):parseInt(k.slice(1),10);return n>=32&&n<=0x10ffff?String.fromCodePoint(n):m}
    return map[k]??m;});
}
export const stripTags=s=>decodeEntities(String(s||'').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
export function tagText(html,tag){return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,'gi'))].map(m=>stripTags(m[1])).filter(Boolean)}
export function metaContent(html,key){
  for(const m of html.matchAll(/<meta\b[^>]*>/gi)){const t=m[0];if((attr(t,'name')||attr(t,'property')).toLowerCase()===key)return attr(t,'content')}
  return '';
}
/** Visible main text: drops scripts, styles, nav, header, footer, forms, asides. */
export function mainText(html){
  let h=html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi,' ');
  const main=h.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);if(main&&main[2].length>800)h=main[2];
  h=h.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi,' ');
  return stripTags(h);
}
export function links(html,base){
  const out=[];
  for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    const href=attr(m[1],'href');if(!href||/^(#|javascript:|mailto:|tel:)/i.test(href))continue;
    const url=normUrl(href,base);if(!url)continue;
    out.push({url,rel:attr(m[1],'rel').toLowerCase(),anchor:stripTags(m[2]).slice(0,140)});
  }
  return out;
}
export function jsonLd(html){
  const out=[];
  for(const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{const v=JSON.parse(m[1].trim());const walk=x=>{if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object'){out.push(x);if(x['@graph'])walk(x['@graph'])}};walk(v)}catch{}
  }
  return out;
}

/* ---------- Email discovery ---------- */
const EMAIL=/[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}/gi;
const JUNK_EMAIL=/^(?:no-?reply|donotreply|mailer-daemon|postmaster|abuse|privacy|gdpr|dpo|legal|dmca|copyright|security|billing|invoice|accounts?|payments?|orders?|returns|jobs|careers|hr|recruit\w*|unsubscribe|bounce\w*|test|example|user|name|email|your(?:name|email)?|wordpress|admin@wordpress)\b/i;
export function decodeCfEmail(hex){
  try{const key=parseInt(hex.slice(0,2),16);let s='';for(let i=2;i<hex.length;i+=2)s+=String.fromCharCode(parseInt(hex.slice(i,i+2),16)^key);return s}catch{return ''}
}
export function extractEmails(html){
  const found=new Set();
  for(const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi))found.add(decodeCfEmail(m[1]));
  for(const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi))found.add(decodeCfEmail(m[1]));
  for(const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)){try{found.add(decodeURIComponent(m[1]))}catch{found.add(m[1])}}
  const text=decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi,' '))
    .replace(/\s*(?:\[|\()\s*at\s*(?:\]|\))\s*/gi,'@').replace(/\s*(?:\[|\()\s*dot\s*(?:\]|\))\s*/gi,'.');
  for(const m of text.matchAll(EMAIL))found.add(m[0]);
  return [...found].map(e=>e.trim().toLowerCase().replace(/^\.+|\.+$/g,'')).filter(e=>/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)&&!/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(e)&&!JUNK_EMAIL.test(e.split('@')[0])&&!/(sentry|wixpress|example\.|domain\.com|email\.com|yourdomain|godaddy|cloudflare)/.test(e));
}
/** Rank an email for editorial outreach on a given publisher domain (higher is better, <0 = reject). */
export function rankEmail(email,domain){
  const [local,host]=email.split('@');if(!host)return -1;
  const onDomain=sameSite(host,domain)||sameSite(domain,rootDomain(host));
  const freemail=/^(gmail|outlook|hotmail|yahoo|icloud|proton(mail)?|aol|gmx|zoho)\./.test(rootDomain(host));
  if(!onDomain&&!freemail)return -1;
  let s=onDomain?50:20;
  if(/^(editor|editorial|editors|content|press|media|pr|hello|hi|contact|info|team|write|writers|contribute|submissions?|partnerships?|outreach|marketing|blog|news|tips)\b/.test(local))s+=25;
  if(/^[a-z]+(\.[a-z]+)?$/.test(local)&&local.length<=20&&!/^(info|contact|hello|team|support|sales|admin|office|mail|webmaster)$/.test(local))s+=18; // a named person
  if(/^(support|help|sales|admin|office|webmaster|mail)$/.test(local))s-=12;
  return s;
}

/* ---------- Text features ---------- */
const STOP=new Set('a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who why will with you your our we can do does not no yes all any more most best top new free vs via into out up about than then them they their there these those just also get got make made use using used one two three four five six seven eight nine ten 2020 2021 2022 2023 2024 2025 2026 2027 guide complete ultimate definitive tips ways things review reviews'.split(' '));
export function tokens(text){return String(text||'').toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/[\s-]+/).filter(w=>w.length>2&&!STOP.has(w)&&!/^\d+$/.test(w))}
export function topTerms(text,n=60){
  const tf=new Map(),t=tokens(text);
  for(let i=0;i<t.length;i++){tf.set(t[i],(tf.get(t[i])||0)+1);if(i+1<t.length){const b=t[i]+' '+t[i+1];tf.set(b,(tf.get(b)||0)+1.5)}}
  return [...tf].sort((a,b)=>b[1]-a[1]).slice(0,n).map(x=>x[0]);
}
/** Core phrase from a page title: drops brand suffixes, years and filler. */
export function keyPhrase(title,max=5){
  const core=String(title||'').split(/\s[|–—-]\s|:\s/)[0];
  return tokens(core).slice(0,max).join(' ');
}
export function hashId(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(36)}
export function randomId(n=10){return [...crypto.getRandomValues(new Uint8Array(n))].map(b=>(b%36).toString(36)).join('')}
