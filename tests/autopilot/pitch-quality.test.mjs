import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pitchable,pitchableAssets,bestPitchAsset} from '../../scripts/autopilot/assets.mjs';
import {rankPortfolio} from '../../scripts/autopilot/score.mjs';
import {PitchWriter,grounded,validPitch,aiProviders,pickModels,AI_PROVIDERS} from '../../scripts/autopilot/pitch.mjs';
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

const modelList=ids=>new Response(JSON.stringify({object:'list',data:ids.map(id=>({id}))}),{headers:{'content-type':'application/json'}});
const GROQ_LIST=['whisper-large-v3','llama-3.3-70b-versatile','openai/gpt-oss-120b','meta-llama/llama-guard-4-12b'];
/** A provider API: the model list on GET /models, `answer` for chat completions. */
const api=(answer,ids=GROQ_LIST)=>async(u,o)=>String(u).endsWith('/models')?modelList(ids):answer(u,o);
const groq=(extra={})=>aiProviders({GROQ_API_KEY:' gsk_x ',...extra});
const email=JSON.stringify({subject:'A shoe finder for your new-runner resources',body:goodBody});

test('free AI writer: a grounded, valid email is used; everything else falls back to the template',async()=>{
  const calls=[];
  const w=new PitchWriter({senderName:'Alex',providers:groq(),fetchImpl:api(async(u,o)=>{calls.push([u,JSON.parse(o.body).model,o.headers.Authorization]);return completion(email)})});
  assert.equal(w.ai,'groq');
  const out=await w.write(prospect,asset,site);
  assert.equal(out.writer,'groq');assert.equal(w.usedAi,1);assert.equal(w.aiProvider,'groq');
  assert.equal(w.aiModel,'openai/gpt-oss-120b','chosen from the provider\'s own model list; speech and guard models are ignored');
  assert.equal(calls[0][0],'https://api.groq.com/openai/v1/chat/completions');assert.equal(calls[0][2],'Bearer gsk_x','the pasted key is trimmed');
  assert.ok(validPitch(out,asset));
  // Invented number -> template.
  const liar=new PitchWriter({senderName:'Alex',providers:groq(),fetchImpl:api(async()=>completion(JSON.stringify({subject:'A shoe finder for your new-runner resources',body:goodBody.replace('free and without sign-up','trusted by 25,000 runners')})))});
  assert.equal((await liar.write(prospect,asset,site)).writer,'template');assert.equal(liar.fallbacks,1);
  // Extra URL -> template.
  const spam=new PitchWriter({senderName:'Alex',providers:groq(),fetchImpl:api(async()=>completion(JSON.stringify({subject:'A shoe finder for your new-runner resources',body:goodBody+' See also https://evil.example/x'})))});
  assert.equal((await spam.write(prospect,asset,site)).writer,'template');
  // Every model over its quota -> template, and no further calls this cycle.
  let n=0;const limited=new PitchWriter({senderName:'Alex',providers:groq(),fetchImpl:api(async()=>{n++;return completion('',429)})});
  assert.equal((await limited.write(prospect,asset,site)).writer,'template');const after=n;await limited.write(prospect,asset,site);
  assert.equal(after,3,'each candidate model is tried once');assert.equal(n,after);assert.equal(limited.ai,null);assert.deepEqual(limited.reasons,{quota_used_up:2});
  // Rejected key -> template with a clear log line.
  const logs=[];const denied=new PitchWriter({senderName:'Alex',providers:groq(),log:m=>logs.push(m),fetchImpl:api(async()=>completion('',403))});
  assert.equal((await denied.write(prospect,asset,site)).writer,'template');assert.match(logs[0],/Groq: the API key was rejected \(HTTP 403/);
  // No key at all -> template, no network.
  const none=new PitchWriter({senderName:'Alex',fetchImpl:async()=>{throw Error('no call expected')}});
  assert.equal((await none.write(prospect,asset,site)).writer,'template');assert.equal(none.ai,null);
});

test('quotas are per model: a limited model is skipped, a short per-minute limit is waited out',async()=>{
  const tried=[];
  const w=new PitchWriter({senderName:'Alex',providers:groq(),fetchImpl:api(async(u,o)=>{const m=JSON.parse(o.body).model;tried.push(m);return m==='openai/gpt-oss-120b'?completion('',429):completion(email)})});
  assert.equal((await w.write(prospect,asset,site)).writer,'groq');assert.equal(w.aiModel,'llama-3.3-70b-versatile');
  await w.write(prospect,asset,site);
  assert.deepEqual(tried,['openai/gpt-oss-120b','llama-3.3-70b-versatile','llama-3.3-70b-versatile'],'the limited model is not asked again; the working one is remembered');
  let n=0;const slept=[];
  const brief=new PitchWriter({senderName:'Alex',providers:groq(),sleep:async ms=>{slept.push(ms)},fetchImpl:api(async()=>++n===1?new Response('',{status:429,headers:{'retry-after':'2'}}):completion(email))});
  assert.equal((await brief.write(prospect,asset,site)).writer,'groq');assert.deepEqual(slept,[2500]);assert.equal(brief.aiModel,'openai/gpt-oss-120b');
});

test('a model that no longer exists is skipped; a second provider takes over when the first one is rejected',async()=>{
  const tried=[];
  const w=new PitchWriter({senderName:'Alex',providers:groq({LINKFORGE_GROQ_MODEL:'retired-model'}),fetchImpl:api(async(u,o)=>{const m=JSON.parse(o.body).model;tried.push(m);return m==='retired-model'?completion('{"error":"unknown model"}',404):completion(email)})});
  assert.equal((await w.write(prospect,asset,site)).writer,'groq');assert.deepEqual(tried,['retired-model','openai/gpt-oss-120b']);
  const urls=[];
  const both=new PitchWriter({senderName:'Alex',providers:aiProviders({GROQ_API_KEY:'bad',GEMINI_API_KEY:'g'}),fetchImpl:async(u,o)=>{
    if(String(u).includes('groq'))return completion('',401);
    if(String(u).endsWith('/models'))return modelList(['models/gemini-embedding-001','models/gemini-2.5-flash-image','models/gemini-3.8-flash-lite-preview','models/gemini-2.5-flash','models/gemini-2.5-flash-lite']);
    urls.push(String(u));return completion(email)}});
  const out=await both.write(prospect,asset,site);
  assert.equal(out.writer,'gemini');assert.equal(both.aiModel,'gemini-2.5-flash-lite','the stable model is preferred over a preview');
  assert.deepEqual(urls,['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions']);assert.equal(both.ai,'gemini');
});

test('Gemini: a rejected key arrives as HTTP 400 and is reported as such; the native model list is the second source',async()=>{
  const logs=[];let n=0;
  const bad=new PitchWriter({senderName:'Alex',providers:aiProviders({GEMINI_API_KEY:'wrong'}),log:m=>logs.push(m),fetchImpl:async u=>{n++;
    return String(u).includes('/models')?new Response('{"error":{"code":404}}',{status:404}):new Response('[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]',{status:400,headers:{'content-type':'application/json'}})}});
  assert.equal((await bad.write(prospect,asset,site)).writer,'template');await bad.write(prospect,asset,site);
  assert.deepEqual(bad.reasons,{not_permitted:2});assert.equal(n,3,'two model lists and one chat call, then the provider is off');assert.match(logs[0],/Gemini: the API key was rejected \(HTTP 400: .*API key not valid/);
  const seen=[];
  const w=new PitchWriter({senderName:'Alex',providers:aiProviders({GEMINI_API_KEY:'g'}),fetchImpl:async(u,o)=>{
    if(String(u).endsWith('/openai/models'))return new Response('{"error":{"code":404}}',{status:404});
    if(String(u).startsWith('https://generativelanguage.googleapis.com/v1beta/models?')){assert.equal(o.headers['x-goog-api-key'],'g');return new Response(JSON.stringify({models:[{name:'models/gemini-4.1-flash-lite'},{name:'models/gemini-4.1-flash-live'},{name:'models/text-embedding-005'}]}),{headers:{'content-type':'application/json'}})}
    seen.push(JSON.parse(o.body).model);return completion(email)}});
  assert.equal((await w.write(prospect,asset,site)).writer,'gemini');assert.deepEqual(seen,['gemini-4.1-flash-lite']);
});

test('model choice and provider configuration',()=>{
  assert.deepEqual(pickModels(['models/gemini-2.5-flash-lite','models/gemini-2.5-flash','models/gemini-2.5-flash-preview-tts','models/gemini-3.8-flash-lite','models/gemini-2.5-pro'],AI_PROVIDERS.gemini.prefer),['gemini-3.8-flash-lite','gemini-2.5-flash-lite']);
  assert.deepEqual(pickModels(['whisper-large-v3','llama-3.1-8b-instant'],AI_PROVIDERS.groq.prefer),['llama-3.1-8b-instant']);
  assert.deepEqual(pickModels([],AI_PROVIDERS.groq.prefer),[]);
  assert.deepEqual(aiProviders({}),[]);
  assert.deepEqual(aiProviders({GROQ_API_KEY:'k',LINKFORGE_AI_WRITER:'off'}),[],'the off switch still works');
  assert.deepEqual(aiProviders({GROQ_API_KEY:'k',GEMINI_API_KEY:'g'}).map(p=>p.name),['groq','gemini']);
  const custom=aiProviders({LINKFORGE_AI_BASE_URL:'https://openrouter.ai/api/v1/chat/completions/',LINKFORGE_AI_KEY:'k',LINKFORGE_AI_MODEL:'some/model'});
  assert.equal(custom[0].base,'https://openrouter.ai/api/v1');assert.equal(custom[0].label,'openrouter.ai');assert.equal(custom[0].model,'some/model');
  assert.deepEqual(aiProviders({LINKFORGE_AI_BASE_URL:'http://insecure.example/v1',LINKFORGE_AI_KEY:'k',LINKFORGE_AI_MODEL:'m'}),[],'plain http is refused');
  assert.deepEqual(aiProviders({LINKFORGE_AI_BASE_URL:'https://x.example/v1',LINKFORGE_AI_KEY:'k'}),[],'a custom endpoint needs its model name');
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

test('the Autopilot workflow passes the free AI writer keys and no longer asks for the retired GitHub Models permission',()=>{
  const y=readFileSync(new URL('../../.github/workflows/autopilot.yml',import.meta.url),'utf8');
  assert.match(y,/permissions:\n\s+contents: write\n\s+id-token: write/);assert.doesNotMatch(y,/models: read|GITHUB_MODELS/);
  assert.match(y,/LINKFORGE_AI_ENDPOINT: \$\{\{ inputs\.ai_endpoint \|\| vars\.LINKFORGE_AI_ENDPOINT \|\| 'https:\/\/backlink-command-center\.pages\.dev\/api\/ai\/v1' \}\}/);
  assert.match(y,/GROQ_API_KEY: \$\{\{ secrets\.GROQ_API_KEY \}\}/);assert.match(y,/GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
});

test('a model answer in the plain "Subject:" format, with markdown and a missing trailing slash, is tidied and used',async()=>{
  const {parseAnswer,tidyPitch,pitchProblem}=await import('../../scripts/autopilot/pitch.mjs');
  const raw=`Subject: A shoe finder for your new-runner resources\n\nYour "Choosing shoes" section in Resources for New Runners points readers to fitting advice. Our **Running Shoe Finder** asks six questions and matches runners to shoes by gait and terrain, free and without sign-up: [Running Shoe Finder](https://gearuptofit.com/shoe-finder).\n\nIf it fits, it could sit in that section.\n\nBest,\nAlex\ngearuptofit.com\n\nP.S. Not relevant for you? Just reply "no" and I won't email again.`;
  const w=new PitchWriter({senderName:'Alex',providers:groq(),fetchImpl:api(async()=>completion(raw))});
  const out=await w.write(prospect,asset,site);
  assert.equal(out.writer,'groq');assert.deepEqual(out.body.match(/https?:\/\/\S+/g),['https://gearuptofit.com/shoe-finder/.']);
  assert.doesNotMatch(out.body,/\*\*|\]\(/);assert.equal(out.subject,'A shoe finder for your new-runner resources');
  assert.deepEqual(parseAnswer('```json\n{"subject":"Hello there editor","body":"line one\nline two"}\n```'),{subject:'Hello there editor',body:'line one\nline two'},'JSON with a raw line break is still read');
  assert.equal(parseAnswer('Sure! Here is an email you could send.'),null);
  assert.equal(pitchProblem(tidyPitch({subject:'Subject: "A shoe finder for you"',body:'x'.repeat(250)+' https://gearuptofit.com/shoe-finder'},asset),asset),null);
  assert.equal(pitchProblem({subject:'A shoe finder for you',body:'x'.repeat(250)},asset),'our_url_missing');
  assert.equal(pitchProblem({subject:'A shoe finder for you',body:'x'.repeat(250)+' https://gearuptofit.com/shoe-finder/ https://other.example/'},asset),'extra_url');
});

test('every template fallback records why, so a failing writer explains itself',async()=>{
  const logs=[];
  const mk=(answer,ids)=>new PitchWriter({senderName:'Alex',providers:groq(),log:m=>logs.push(m),fetchImpl:api(answer,ids)});
  const server=mk(async()=>completion('{"error":"upstream"}',500));
  assert.equal((await server.write(prospect,asset,site)).writer,'template');await server.write(prospect,asset,site);
  assert.deepEqual(server.reasons,{http_500:2});assert.equal(logs.filter(l=>/http_500/.test(l)).length,1,'logged once per reason');assert.equal(server.ai,'groq','a server error does not switch the writer off');
  const chatty=mk(async()=>completion('Sure! Here is an email you could send to the editor.'));
  await chatty.write(prospect,asset,site);assert.deepEqual(chatty.reasons,{answer_not_in_format:1});
  const empty=mk(async()=>new Response(JSON.stringify({choices:[]}),{headers:{'content-type':'application/json'}}));
  await empty.write(prospect,asset,site);assert.deepEqual(empty.reasons,{empty_answer:1});
  const thinker=mk(async()=>completion(`<think>The editor lists tools.</think>\nSubject: A shoe finder for your new-runner resources\n\n${goodBody}`));
  assert.equal((await thinker.write(prospect,asset,site)).writer,'groq','a reasoning block before the answer is dropped');
  const liar=mk(async()=>completion(`Subject: A shoe finder for your new-runner resources\n\n${goodBody.replace('free and without sign-up','trusted by 25,000 runners')}`));
  await liar.write(prospect,asset,site);assert.deepEqual(liar.reasons,{number_not_in_facts:1});
  const gone=mk(async()=>completion('{"error":{"code":"unknown_model"}}',404),[]);
  await gone.write(prospect,asset,site);await gone.write(prospect,asset,site);
  assert.deepEqual(gone.reasons,{no_usable_model:2});assert.match(logs.join('\n'),/Groq: no usable model found \(HTTP 404 for llama-3\.1-8b-instant/);
});

test('a "success" with no completion in it is reported with provider, model, status, content type and body',async()=>{
  const logs=[];
  const mk=fetchImpl=>new PitchWriter({senderName:'Alex',providers:groq(),log:m=>logs.push(m),fetchImpl});
  // What the retired GitHub Models host answered on 2026-11-26: "200 OK" as plain text, to every request.
  const okText=mk(async()=>new Response('OK',{status:200,headers:{'content-type':'text/plain'}}));
  await okText.write(prospect,asset,site);
  assert.deepEqual(okText.reasons,{answer_not_json:1});assert.match(logs.at(-1),/answer_not_json: Groq openai\/gpt-oss-120b: HTTP 200 text\/plain: OK/);
  const moved=mk(async(u,o)=>{assert.equal(o.redirect,'manual');return new Response('',{status:302,headers:{location:'https://example.com/login'}})});
  await moved.write(prospect,asset,site);
  assert.deepEqual(moved.reasons,{redirected:1});assert.match(logs.at(-1),/redirected: Groq: HTTP 302 to https:\/\/example\.com\/login/);
  const parts=mk(api(async()=>new Response(JSON.stringify({choices:[{message:{content:[{type:'text',text:`Subject: A shoe finder for your new-runner resources\n\n${goodBody}`}]}}]}),{headers:{'content-type':'application/json'}})));
  assert.equal((await parts.write(prospect,asset,site)).writer,'groq','content given as parts is read');
});
