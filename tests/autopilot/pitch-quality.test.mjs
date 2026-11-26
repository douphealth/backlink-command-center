import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pitchable,pitchableAssets,bestPitchAsset} from '../../scripts/autopilot/assets.mjs';
import {rankPortfolio} from '../../scripts/autopilot/score.mjs';
import {PitchWriter,grounded,validPitch} from '../../scripts/autopilot/pitch.mjs';
import {runOutreach} from '../../scripts/autopilot/outreach.mjs';
import {planWake} from '../../scripts/autopilot/waker.mjs';
import {SITES} from '../../functions/_lib/sites.js';

const site={domain:'gearuptofit.com',topic:'running shoes',assets:['https://gearuptofit.com/shoe-finder/']};
const a=(url,o={})=>({site:'gearuptofit.com',url,title:'T',type:'general_article',words:900,linkability:70,promotion:60,interactive:false,reasons:[],...o});

test('only pages an editor would link to are pitched (cases taken from production on 2026-11-26)',()=>{
  const ok=x=>pitchable(x,site).ok;
  assert.equal(ok(a('https://gearuptofit.com/shoe-finder/')),true,'configured flagship');
  assert.equal(ok(a('https://gearuptofit.com/running/running-pace-calculator/',{type:'interactive_tool',interactive:true})),true,'free tool');
  assert.equal(ok(a('https://gearuptofit.com/shoe-finder/methodology/',{type:'methodology',words:1400})),true);
  assert.equal(ok(a('https://gearuptofit.com/guide/interleaving-vs-blocked-practice/',{type:'comparison',title:'Interleaving vs Blocked Practice',words:2400,linkability:94})),true,'concept comparison, in depth');
  assert.equal(ok(a('https://gearuptofit.com/cities/athens',{words:969,linkability:71})),false,'thin programmatic city page');
  assert.equal(ok(a('https://gearuptofit.com/review/best-running-shoes-for-ball-of-foot-pain/',{type:'commercial',words:2475})),false,'affiliate review');
  assert.equal(ok(a('https://gearuptofit.com/watch-match/compare/apple-watch-se-2-vs-google-pixel-watch-3',{type:'comparison',words:916})),false,'product-vs-product page');
  assert.equal(ok(a('https://gearuptofit.com/blog/neuronwriter-review/',{type:'comparison',title:'NeuronWriter Review 2026',words:3000,linkability:88})),false,'review by title');
  assert.equal(ok(a('https://gearuptofit.com/revealing-birth-number-6/',{type:'practical_guide',words:1816,linkability:82,reasons:['One of 299 templated sibling pages — promote the hub first']})),false);
  assert.equal(ok(a('https://gearuptofit.com/productivity/weekly-review-checklist/',{type:'reference',words:3075,linkability:84,reasons:['One of 14 templated sibling pages — promote the hub first']})),true,'a blog category is not a template');
  assert.equal(ok(a('https://gearuptofit.com/skills/knowledge-graph/',{words:681,linkability:66,interactive:true})),false,'thin page with a widget');
  assert.match(pitchable(a('https://gearuptofit.com/cities/athens'),site).why,/thin/);
  assert.equal(ok(a('https://gearuptofit.com/productivity/weekly-review-checklist/',{type:'reference',title:'Weekly Review Checklist: A 30-Minute Template',words:3075,linkability:84})),true,'a weekly review is not a product review');
  assert.equal(ok(a('https://gearuptofit.com/blog/garmin-forerunner/',{type:'practical_guide',title:'Garmin Forerunner 265 Review: Worth It?',words:2600,linkability:85})),false);
});

test('every configured site has flagship pages, so each one always has something worth pitching',()=>{
  for(const s of SITES){
    assert.ok((s.assets||[]).length>=1,s.domain);
    const ranked=s.assets.map(u=>({site:s.domain,url:u,title:'x',type:'general_article',words:200,linkability:40,promotion:40,reasons:[]}));
    assert.equal(pitchableAssets(ranked,s).length,ranked.length,s.domain);
  }
});

test('a configured homepage that is the tool itself is ranked; other homepages stay navigation',()=>{
  const page=(url,o={})=>({url,final_url:url,status:200,title:'Can this power bank fly?',words:700,h2_count:4,technical_status:'technically_eligible',interactive:true,internal_links:[],terms:[],...o});
  const ranked=rankPortfolio([{site:'cabinvolt.shop',pages:[page('https://cabinvolt.shop/',{configured:true}),page('https://cabinvolt.shop/privacy',{title:'Privacy',interactive:false})]},
    {site:'blog.example',pages:[page('https://blog.example/',{title:'Blog home'})]}]);
  const home=ranked.find(x=>x.url==='https://cabinvolt.shop/');
  assert.ok(home,'flagship homepage kept');assert.equal(home.type,'interactive_tool');assert.ok(home.linkability>=78);
  assert.ok(!ranked.some(x=>x.site==='blog.example'),'an ordinary homepage is still not an asset');
});

test('a queued prospect paired with a weak page is re-paired with the best page for that editor',()=>{
  const finder=a('https://gearuptofit.com/shoe-finder/',{title:'Running Shoe Finder',h1:'Running Shoe Finder',terms:['shoe','finder','gait','pronation']});
  const pace=a('https://gearuptofit.com/running/running-pace-calculator/',{title:'Running Pace Calculator',h1:'Running Pace Calculator',type:'interactive_tool',interactive:true,terms:['pace','marathon','splits']});
  const list=pitchableAssets([pace,finder],site);
  assert.equal(list[0].url,finder.url,'flagship leads');
  assert.deepEqual(bestPitchAsset({title:'Marathon training: how to pace your long runs',page_url:'https://runblog.com/marathon-pace'},list,site),{asset:pace,match:'specific'});
  assert.deepEqual(bestPitchAsset({title:'Our favourite running resources',page_url:'https://runblog.com/resources'},list,site),{asset:finder,match:'topic'},'no specific overlap: the flagship');
  assert.equal(bestPitchAsset({title:'x'},[],site),null);
});

const now=()=>new Date().toISOString();
function fixture(pickAsset){
  const sent=[],written=[];
  const p={id:'p1',domain:'pub.example',site:'gearuptofit.com',page_url:'https://pub.example/resources',title:'Running resources',asset_url:'https://gearuptofit.com/review/best-shoes/',email:'ed@pub.example',qv:2,status:'ready',history:[]};
  const state={prospects:{p1:p},reply_health:{status:'ok',checked_at:now()},suppression:{},contacted:{}};
  return {sent,written,p,args:{state,assets:[a('https://gearuptofit.com/shoe-finder/',{title:'Running Shoe Finder'})],sites:[site],
    writer:{write:async(pp,asset)=>{written.push(asset.url);return {subject:'s',body:'b'}}},mailer:{send:async m=>sent.push(m),draft:async()=>{}},
    config:{mode:'send',dailyLimit:12,followupDays:6,fromAddress:'me@gearuptofit.com',senderName:'Alex',gapMs:()=>0,sendWindow:false,pickAsset}}};
}
test('outreach writes the pitch for the re-paired page, and sends nothing when a site has no pitchable page',async()=>{
  const finder=a('https://gearuptofit.com/shoe-finder/',{title:'Running Shoe Finder'});
  const f=fixture(()=>({asset:finder,match:'topic'}));
  const r=await runOutreach(f.args);
  assert.deepEqual(f.written,[finder.url]);assert.equal(r.repaired,1);assert.equal(f.p.asset_url,finder.url);assert.equal(f.p.asset_repaired_from,'https://gearuptofit.com/review/best-shoes/');
  const none=fixture(()=>null);const r2=await runOutreach(none.args);
  assert.equal(none.sent.length,0);assert.equal(r2.no_pitchable_page,1);assert.equal(none.p.status,'ready','kept for when a pitchable page exists');
  const keep=fixture(()=>undefined);await runOutreach(keep.args);assert.deepEqual(keep.written,['https://gearuptofit.com/review/best-shoes/'],'undefined = pairing already fine');
});

const asset={url:'https://gearuptofit.com/shoe-finder/',title:'Running Shoe Finder',type:'interactive_tool',interactive:true,description:'Answer six questions and get matched to running shoes by gait and terrain.',reasons:['2 data tables']};
const prospect={id:'x',title:'Resources for New Runners',page_url:'https://pub.example/resources',fit_section:'Choosing shoes',excerpt:'A list of tools for new runners.'};
const goodBody=`Your "Choosing shoes" section in Resources for New Runners points readers to fitting advice. Our Running Shoe Finder asks six questions and matches runners to shoes by gait and terrain, free and without sign-up: ${asset.url}\n\nIf it fits, it could sit in that section.\n\nBest,\nAlex\ngearuptofit.com\n\nP.S. Not relevant for you? Just reply "no" and I won't email again.`;
const completion=(content,status=200)=>new Response(JSON.stringify({choices:[{message:{content}}]}),{status,headers:{'content-type':'application/json'}});

test('free AI writer (GitHub Models): a grounded, valid email is used; everything else falls back to the template',async()=>{
  const calls=[];
  const w=new PitchWriter({senderName:'Alex',githubToken:'ghs_x',fetchImpl:async(u,o)=>{calls.push([u,JSON.parse(o.body).model,o.headers.Authorization]);return completion(JSON.stringify({subject:'A shoe finder for your new-runner resources',body:goodBody}))}});
  assert.equal(w.ai,'github_models');
  const out=await w.write(prospect,asset,site);
  assert.equal(out.writer,'github_models');assert.equal(w.usedGithub,1);assert.equal(w.ghModel,'openai/gpt-4.1-mini');
  assert.equal(calls[0][0],'https://models.github.ai/inference/chat/completions');assert.equal(calls[0][2],'Bearer ghs_x');
  assert.ok(validPitch(out,asset));
  // Invented number -> template.
  const liar=new PitchWriter({senderName:'Alex',githubToken:'t',fetchImpl:async()=>completion(JSON.stringify({subject:'A shoe finder for your new-runner resources',body:goodBody.replace('free and without sign-up','trusted by 25,000 runners')}))});
  assert.equal((await liar.write(prospect,asset,site)).writer,'template');assert.equal(liar.fallbacks,1);
  // Extra URL -> template.
  const spam=new PitchWriter({senderName:'Alex',githubToken:'t',fetchImpl:async()=>completion(JSON.stringify({subject:'A shoe finder for your new-runner resources',body:goodBody+' See also https://evil.example/x'}))});
  assert.equal((await spam.write(prospect,asset,site)).writer,'template');
  // Quota used up -> template, and no further calls this cycle.
  let n=0;const limited=new PitchWriter({senderName:'Alex',githubToken:'t',fetchImpl:async()=>{n++;return completion('',429)}});
  assert.equal((await limited.write(prospect,asset,site)).writer,'template');await limited.write(prospect,asset,site);assert.equal(n,1);assert.equal(limited.ai,null);
  // No permission -> template with a clear log line.
  const logs=[];const denied=new PitchWriter({senderName:'Alex',githubToken:'t',log:m=>logs.push(m),fetchImpl:async()=>completion('',403)});
  assert.equal((await denied.write(prospect,asset,site)).writer,'template');assert.match(logs[0],/models: read/);
  // No token at all -> template, no network.
  const none=new PitchWriter({senderName:'Alex',fetchImpl:async()=>{throw Error('no call expected')}});
  assert.equal((await none.write(prospect,asset,site)).writer,'template');assert.equal(none.ai,null);
});

test('when the preferred models no longer exist the catalogue supplies one',async()=>{
  const tried=[];
  const w=new PitchWriter({senderName:'Alex',githubToken:'t',fetchImpl:async(u,o)=>{
    if(String(u).endsWith('/catalog/models'))return new Response(JSON.stringify([{id:'openai/text-embedding-9',supported_output_modalities:['embeddings']},{id:'openai/gpt-9-mini',supported_output_modalities:['text'],rate_limit_tier:'low'}]),{headers:{'content-type':'application/json'}});
    const model=JSON.parse(o.body).model;tried.push(model);
    return model==='openai/gpt-9-mini'?completion(JSON.stringify({subject:'A shoe finder for your new-runner resources',body:goodBody})):completion('{"error":"unknown model"}',404)}});
  const out=await w.write(prospect,asset,site);
  assert.equal(out.writer,'github_models');assert.equal(w.ghModel,'openai/gpt-9-mini');assert.equal(tried.at(-1),'openai/gpt-9-mini');
  await w.write(prospect,asset,site);assert.equal(tried.at(-1),'openai/gpt-9-mini');assert.equal(tried.length,6,'the working model is remembered');
});

test('grounding: numbers must come from the supplied facts',()=>{
  const facts={our_asset:{facts:['it is an in-depth 2400-word guide','it cites 12 authoritative sources']}};
  assert.equal(grounded({subject:'s',body:'A 2,400-word guide citing 12 sources.'},facts),true);
  assert.equal(grounded({subject:'s',body:'Used by 50,000 readers since 2019.'},facts),false);
  assert.equal(grounded({subject:'s',body:'No numbers here, see https://a.com/2024/post-123'},facts),true,'digits inside the URL are not claims');
});

test('a failed reply scan is retried at the 2 h gap instead of after the 5 h keep-alive',()=>{
  const nowMs=Date.parse('2026-11-26T08:51:00Z');
  const s={generated_at:'2026-11-26T08:50:47Z',capabilities:{outreach_mode:'send'},outreach:{ready:67,next_send_at:'2026-11-26T08:50:47Z',reply_health:'failed'}};
  const p=planWake(s,nowMs);assert.equal(p.at,'2026-11-26T10:50:47.000Z');assert.match(p.reason,/reply scan failed/);
  assert.equal(planWake({...s,outreach:{...s.outreach,ready:0}},nowMs).at,'2026-11-26T13:50:47.000Z','nothing to send: keep-alive');
});

test('the Autopilot workflow grants the free AI writer its permission and token',()=>{
  const y=readFileSync(new URL('../../.github/workflows/autopilot.yml',import.meta.url),'utf8');
  assert.match(y,/permissions:\n\s+contents: write\n\s+models: read/);assert.match(y,/GITHUB_MODELS_TOKEN: \$\{\{ github\.token \}\}/);
});
