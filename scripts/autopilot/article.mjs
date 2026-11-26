/**
 * Article understanding for qualified prospect pages, built on three widely used open-source libraries:
 *   - @mozilla/readability (github.com/mozilla/readability): the reader-mode extractor used in Firefox;
 *     gives the article's own text and byline without menus, sidebars and footers.
 *   - jsdom (github.com/jsdom/jsdom): the DOM that Readability runs on. Scripts are never executed and no
 *     sub-resources are loaded.
 *   - franc (github.com/wooorm/franc): language detection from the text itself.
 *
 * Used only on pages that already passed qualification (a few dozen per cycle), so the cost is small.
 * What it buys: the pitch writer sees what the article actually says (not the navigation), the editor is
 * greeted by the byline name when there is one, and pages in another language are dropped before any
 * contact lookup or verification credit is spent.
 */
import {JSDOM,VirtualConsole} from 'jsdom';
import {Readability} from '@mozilla/readability';
import {francAll} from 'franc';
import {stripTags} from './util.mjs';

const NOT_A_NAME=/\b(?:admin|administrator|staff|team|editor|editors|editorial|guest|contributor|author|writer|by|posted|updated|published|min read|minutes?|comments?)\b/i;
/** "By Jess Lee | Nov 3" -> "Jess Lee"; anything that is not clearly a person's name -> null. */
export function cleanByline(byline){
  let s=String(byline||'').replace(/\s+/g,' ').trim();if(!s)return null;
  s=s.replace(/^(?:written |posted |published )?by[: ]+/i,'').split(/\s[|•·–—-]\s|,| on | and | & /)[0].trim();
  if(!/^\p{Lu}[\p{L}.'-]{1,20}(?: \p{Lu}[\p{L}.'-]{1,20}){1,2}$/u.test(s)||NOT_A_NAME.test(s))return null;
  return s;
}
/**
 * ISO 639-3 code of the text's language, or 'und' when it is too short or too close to call.
 * `expected` (default English) wins whenever it is among the near-best candidates, so an English page
 * full of names or product terms is never mistaken for another language.
 */
export function detectLanguage(text,{expected='eng'}={}){
  const t=String(text||'').replace(/\s+/g,' ').slice(0,5000);
  if(t.length<400)return 'und';
  const ranked=francAll(t,{minLength:200}).slice(0,4);
  if(!ranked.length||ranked[0][0]==='und')return 'und';
  if(ranked.some(([code,score])=>code===expected&&score>=ranked[0][1]-0.08))return expected;
  return ranked[0][0];
}
/** {title, byline, text, lang} for an HTML page, or null when no article can be extracted. Never throws. */
export function readArticle(html,url){
  let dom;
  try{
    dom=new JSDOM(String(html||'').slice(0,700000),{url,virtualConsole:new VirtualConsole()});
    const art=new Readability(dom.window.document,{charThreshold:250}).parse();
    // From the extracted HTML, so headings and paragraphs do not run together ("Watering scheduleMost houseplants").
    const text=stripTags(String(art?.content||'')).replace(/\s+/g,' ').trim();
    if(text.length<200)return null; // no real article on this page
    return {title:String(art.title||'').slice(0,180),byline:cleanByline(art.byline),text,lang:detectLanguage(text)};
  }catch{return null}
  finally{try{dom?.window.close()}catch{}}
}
