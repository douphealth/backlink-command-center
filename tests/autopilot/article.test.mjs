import test from 'node:test';
import assert from 'node:assert/strict';
import {readArticle,cleanByline,detectLanguage} from '../../scripts/autopilot/article.mjs';
import {discoverProspects} from '../../scripts/autopilot/prospect.mjs';

const para='Good houseplant care starts with watering. Most houseplants prefer the top inch of soil to dry out between waterings. Check with your finger before you water, and adjust the schedule for light, season and pot size. ';
const page=({title='How Often to Water Houseplants',byline='By Jess Lee',body=para.repeat(10),lang='en'}={})=>`<html lang="${lang}"><head><title>${title} - Leafy Home</title></head><body>
<nav><a href="/">Home</a> <a href="/shop">Shop our store</a> <a href="/about">About</a></nav>
<aside>Subscribe to our newsletter for weekly deals and discount codes</aside>
<article><h1>${title}</h1><p class="byline">${byline}</p><h2>Watering schedule</h2><p>${body}</p>
<p>${Array.from({length:6},(_,i)=>`<a href="https://ref${i}.org/">reference ${i}</a>`).join(' ')}</p></article>
<footer>Copyright Leafy Home. Privacy policy. Terms.</footer></body></html>`;

test('Readability gives the article itself: no menu, sidebar or footer text, and the byline as a name',()=>{
  const a=readArticle(page(),'https://leafyhome.blog/watering');
  assert.equal(a.title,'How Often to Water Houseplants');assert.equal(a.byline,'Jess Lee');assert.equal(a.lang,'eng');
  assert.match(a.text,/top inch of soil/);assert.match(a.text,/Watering schedule Good houseplant care/,'heading and paragraph are separated');assert.doesNotMatch(a.text,/Subscribe to our newsletter|Privacy policy|Shop our store/);
  assert.equal(readArticle('','https://x.com/'),null);assert.equal(readArticle('<html><body><p>hi</p></body></html>','https://x.com/'),null);
  assert.equal(readArticle('<<<not html at all',null),null,'never throws');
});

test('bylines are used only when they are clearly a person\'s name',()=>{
  assert.equal(cleanByline('By Jess Lee'),'Jess Lee');assert.equal(cleanByline("Written by Maria-José O'Neil | Nov 3, 2026"),"Maria-José O'Neil");
  assert.equal(cleanByline('By John Smith, Senior Editor'),'John Smith');
  for(const bad of ['By Staff Writer','Editorial Team','admin','Posted on November 3','by jess','JESS LEE HOUSEPLANTS BLOG NEWS',''])assert.equal(cleanByline(bad),null,bad);
});

test('language comes from the text; English wins close calls; short text is undetermined',()=>{
  assert.equal(detectLanguage(para.repeat(6)),'eng');
  assert.equal(detectLanguage('Menggunakan alkohol untuk menghilangkan noda tinta pulpen di seragam putih dengan aman dan tidak merusak kain. Usap area di sekeliling noda terlebih dahulu dengan kapas beralkohol agar pigmen tinta tidak melebar ke bagian lain. '.repeat(4)),'ind');
  assert.equal(detectLanguage('La mayoría de las plantas de interior prefieren que la tierra se seque entre riegos. Comprueba con el dedo antes de regar y ajusta el calendario según la luz y la estación del año. '.repeat(4)),'spa');
  assert.equal(detectLanguage('Short text'),'und');
});

const site={domain:'plantastichaven.com',topic:'houseplant care',assets:[],competitors:[]};
const asset={site:site.domain,url:'https://plantastichaven.com/plant-care-plan/',title:'Houseplant Care Plan Generator',h1:'Houseplant Care Plan Generator',type:'interactive_tool',terms:['houseplant','care','watering']};
const quiet=()=>({queries:{[`${site.domain}|"plantastichaven" OR "plantastichaven.com" -site:plantastichaven.com`]:new Date().toISOString()},mentions_at:{[site.domain]:new Date().toISOString()}});
const html=b=>new Response(b,{headers:{'content-type':'text/html; charset=utf-8'}});

test('a qualified page gets the article excerpt and the author\'s name; a non-English page is dropped before contact lookup',async()=>{
  const fetched=[];
  const f=async url=>{const u=new URL(url);fetched.push(u.hostname+u.pathname);
    if(u.hostname==='leafyhome.blog'&&u.pathname.startsWith('/houseplant-watering-guide'))return html(page({title:'Houseplant Watering Guide'}));
    if(u.hostname==='leafyhome.blog'&&u.pathname==='/contact')return html('<p>Write to <a href="mailto:jess.lee@leafyhome.blog">Jess Lee</a>, author and editor.</p>');
    if(u.hostname==='tanaman.example')return html(page({title:'Houseplant care guide: watering houseplant',byline:'Oleh Admin',lang:'en',
      body:'Menggunakan air secukupnya untuk menyiram tanaman hias di dalam rumah agar akar tidak busuk dan daun tetap hijau segar sepanjang musim. Periksa tanah dengan jari sebelum menyiram dan sesuaikan jadwal dengan cahaya. houseplant care watering '.repeat(8)}));
    return html('<p>home</p>')};
  const serp=async()=>[{url:'https://leafyhome.blog/houseplant-watering-guide',domain:'leafyhome.blog',title:'Houseplant Watering Guide',rank:1},
    {url:'https://tanaman.example/houseplant-care-guide',domain:'tanaman.example',title:'Houseplant care guide',rank:2}];
  const state=quiet();
  const stats=await discoverProspects({assets:[asset],sites:[site],state,dfs:{enabled:true,canSpend:()=>true,affordable:()=>4,serp,domainTraffic:async()=>({})},fetchImpl:f,perAsset:1,linkGapCalls:0,neighborPages:0});
  const good=Object.values(state.prospects).find(p=>p.domain==='leafyhome.blog'),other=Object.values(state.prospects).find(p=>p.domain==='tanaman.example');
  assert.equal(good.status,'ready');assert.equal(good.author,'Jess Lee');assert.equal(good.email,'jess.lee@leafyhome.blog');assert.equal(stats.bylines,1);
  assert.match(good.excerpt,/^(How Often|Houseplant|By Jess|Watering|Most houseplants)/);assert.doesNotMatch(good.excerpt,/Subscribe to our newsletter|Shop our store/);
  assert.equal(other.status,'rejected');assert.match(other.reason,/not in English \(ind\)/);
  assert.ok(!fetched.some(x=>x.startsWith('tanaman.example/contact')||x==='tanaman.example/'),'no contact lookup for a page in another language');
});
