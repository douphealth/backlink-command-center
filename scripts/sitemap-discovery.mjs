/** Public-only bounded sitemap discovery; never reads private resources or sends outreach. */
const BLOCK=/(?:^|\/)(?:wp-admin|wp-content|tag|author|category|feed|privacy|terms|contact|cart|checkout)(?:\/|$)|\.(?:xml|json|jpg|png|webp|pdf|zip)$/i;
export function eligible(url,domain){
 try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname.replace(/^www\./,'')===domain&&!BLOCK.test(u.pathname)&&u.pathname!=='/';}catch{return false;}
}
export function sitemapLocs(xml){
 return [...xml.matchAll(/<loc\s*>([\s\S]*?)<\/loc>/gi)].map(m=>m[1].replace(/&amp;/g,'&').trim()).filter(Boolean);
}
export async function discoverSitemapUrls(site,{fetchImpl=fetch,limit=30}={}){
 const domain=site.domain,candidates=[],seen=new Set(),checked=[];
 const sources=['https://'+domain+'/sitemap_index.xml','https://'+domain+'/wp-sitemap.xml','https://'+domain+'/sitemap.xml'];
 for(const source of sources){
  try{
   const response=await fetchImpl(source,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(7000),headers:{Accept:'application/xml,text/xml'}});
   if(response.status!==200)continue;
   const contentType=response.headers.get('content-type')||'';
   if(!/xml|text\/plain|octet-stream/i.test(contentType))continue;
   const body=(await response.text()).slice(0,500000);
   let urls=sitemapLocs(body);
   const children=urls.filter(u=>{try{const x=new URL(u);return x.protocol==='https:'&&x.hostname.replace(/^www\./,'')===domain&&/\.xml(?:\?.*)?$/i.test(x.pathname)}catch{return false}}).slice(0,3);
   for(const child of children){
    try{const r=await fetchImpl(child,{redirect:'manual',signal:AbortSignal.timeout(7000)});if(r.status===200)urls.push(...sitemapLocs((await r.text()).slice(0,500000)));}catch{}
   }
   for(const url of urls){
    if(!eligible(url,domain)||seen.has(url))continue;
    seen.add(url);candidates.push(url);
    if(candidates.length>=limit)break;
   }
   checked.push(source);
   if(candidates.length>=limit)break;
  }catch{}
 }
 return {site:domain,urls:candidates,sitemap_sources:checked};
}
