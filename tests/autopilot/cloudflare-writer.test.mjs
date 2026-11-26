import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {verifyActionsToken,_resetKeyCache} from '../../functions/_lib/actions-oidc.js';
import {chatCompletion,listModels,answerText,MODELS,AUDIENCE} from '../../functions/_lib/ai-writer.js';
import {PitchWriter,aiProviders,actionsIdentity} from '../../scripts/autopilot/pitch.mjs';

// A stand-in for GitHub's token service: our own RSA key, published the way GitHub publishes its keys.
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
const b64=o=>Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64url');
const REPO='douphealth/backlink-command-center';
const claims=(over={})=>({iss:'https://token.actions.githubusercontent.com',aud:AUDIENCE,repository:REPO,job_workflow_ref:`${REPO}/.github/workflows/autopilot.yml@refs/heads/main`,
  iat:Math.floor(Date.now()/1000)-5,nbf:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+300,...over});
function sign(payload,{kid='test-key',key=privateKey,alg='RS256'}={}){
  const head=b64({alg,kid,typ:'JWT'}),body=b64(payload);
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url')}`;
}
const keysFetch=async url=>{assert.equal(String(url),'https://token.actions.githubusercontent.com/.well-known/jwks');return new Response(JSON.stringify({keys:[jwk]}),{headers:{'content-type':'application/json'}})};
const opts={audience:AUDIENCE,repository:REPO,workflow:'autopilot.yml',fetchImpl:keysFetch};
const code=async p=>{try{await p;return 'accepted'}catch(e){return e.code}};

test('identity token: accepted only when GitHub signed it for this repository, this workflow and this service',async()=>{
  _resetKeyCache();
  assert.equal((await verifyActionsToken(sign(claims()),opts)).repository,REPO);
  assert.equal(await code(verifyActionsToken(sign(claims({repository:'someone/else'})),opts)),'repository');
  assert.equal(await code(verifyActionsToken(sign(claims({job_workflow_ref:`${REPO}/.github/workflows/other.yml@refs/heads/main`})),opts)),'workflow');
  assert.equal(await code(verifyActionsToken(sign(claims({aud:'https://github.com/douphealth'})),opts)),'audience');
  assert.equal(await code(verifyActionsToken(sign(claims({exp:Math.floor(Date.now()/1000)-10})),opts)),'expired');
  assert.equal(await code(verifyActionsToken(sign(claims({iss:'https://evil.example'})),opts)),'issuer');
  const other=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  assert.equal(await code(verifyActionsToken(sign(claims(),{key:other}),opts)),'signature','signed by someone else under the same key id');
  assert.equal(await code(verifyActionsToken(sign(claims(),{kid:'unknown'}),opts)),'unknown_key');
  const forged=sign(claims()).split('.');forged[1]=b64(claims({repository:REPO,exp:Math.floor(Date.now()/1000)+99999}));
  assert.equal(await code(verifyActionsToken(forged.join('.'),opts)),'signature','claims changed after signing');
  assert.equal(await code(verifyActionsToken(`${b64({alg:'none',kid:'test-key'})}.${b64(claims())}.`,opts)),'algorithm');
  assert.equal(await code(verifyActionsToken('not-a-token',opts)),'malformed');
});

const env=(ai)=>({LINKFORGE_REPO:REPO,...(ai?{AI:ai}:{})});
const post=(body,token)=>new Request('https://dash.example/api/ai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
const good={model:MODELS[0],max_tokens:2000,temperature:0.5,messages:[{role:'system',content:'Write an email.'},{role:'user',content:'Facts: {}'}]};

test('the endpoint refuses everyone but the Autopilot workflow, and bounds what it will run',async()=>{
  _resetKeyCache();
  const deps={fetchImpl:keysFetch},calls=[];
  const ai={run:async(model,input)=>{calls.push([model,input]);return {response:'Subject: Hello there editor\n\nBody text'}}};
  assert.equal((await chatCompletion(post(good),env(ai),deps)).status,401,'no token');
  assert.equal((await chatCompletion(post(good,sign(claims({repository:'someone/else'}))),env(ai),deps)).status,401,'another repository');
  assert.equal(calls.length,0,'nothing reaches the model without a valid token');
  const token=sign(claims());
  const ok=await chatCompletion(post(good,token),env(ai),deps);
  assert.equal(ok.status,200);assert.equal((await ok.json()).choices[0].message.content,'Subject: Hello there editor\n\nBody text');
  assert.deepEqual(calls[0],[MODELS[0],{messages:good.messages,max_tokens:2000,temperature:0.5}]);
  assert.equal((await chatCompletion(post({...good,model:'@cf/black-forest-labs/flux-1-schnell'},token),env(ai),deps)).status,404,'only the listed text models');
  assert.equal((await chatCompletion(post({...good,max_tokens:999999},token),env(ai),deps)).status,200);assert.equal(calls.at(-1)[1].max_tokens,2000,'output is capped');
  assert.equal((await chatCompletion(post({...good,messages:[{role:'user',content:'x'.repeat(30000)}]},token),env(ai),deps)).status,413);
  assert.equal((await chatCompletion(post({...good,messages:[{role:'tool',content:'x'}]},token),env(ai),deps)).status,400);
  assert.equal((await chatCompletion(post(good,token),env(null),deps)).status,503,'no AI binding');
  assert.equal((await chatCompletion(new Request('https://dash.example/api/ai/v1/chat/completions',{headers:{authorization:'Bearer '+token}}),env(ai),deps)).status,405);
  const spent=await chatCompletion(post(good,token),env({run:async()=>{throw Error('4006: you have used up your daily free allocation of 10,000 neurons')}}),deps);
  assert.equal(spent.status,429);assert.equal((await spent.json()).error.code,'quota');
  assert.equal((await chatCompletion(post(good,token),env({run:async()=>{throw Error('upstream timeout')}}),deps)).status,502);
  const list=await listModels(new Request('https://dash.example/api/ai/v1/models',{headers:{authorization:'Bearer '+token}}),env(ai),deps);
  assert.deepEqual((await list.json()).data.map(m=>m.id),MODELS);
  assert.equal((await listModels(new Request('https://dash.example/api/ai/v1/models'),env(ai),deps)).status,401);
  assert.equal(answerText({choices:[{message:{content:'a'}}]}),'a');assert.equal(answerText({output:[{content:[{text:'b'}]}]}),'b');assert.equal(answerText({}),'');
});

test('engine: inside GitHub Actions the keyless writer is configured by itself and writes through the endpoint',async()=>{
  _resetKeyCache();
  const actionsEnv={LINKFORGE_AI_ENDPOINT:'https://dash.example/api/ai/v1/',ACTIONS_ID_TOKEN_REQUEST_URL:'https://runner.example/token?api-version=2.0',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'runner-secret'};
  assert.deepEqual(aiProviders({LINKFORGE_AI_ENDPOINT:'https://dash.example/api/ai/v1'}),[],'outside Actions there is no identity, so no provider');
  assert.deepEqual(aiProviders({...actionsEnv,LINKFORGE_AI_WRITER:'off'}),[]);
  assert.deepEqual(aiProviders({...actionsEnv,GROQ_API_KEY:'k'}).map(p=>p.name),['groq','cloudflare'],'a saved key is tried first');
  const asset={url:'https://gearuptofit.com/shoe-finder/',title:'Running Shoe Finder',type:'interactive_tool',interactive:true,description:'Answer six questions and get matched to running shoes by gait and terrain.',reasons:[]};
  const prospect={id:'x',title:'Resources for New Runners',page_url:'https://pub.example/resources',fit_section:'Choosing shoes',excerpt:'A list of tools for new runners.'};
  const site={domain:'gearuptofit.com',topic:'running'};
  const bodyText=`Your "Choosing shoes" section in Resources for New Runners points readers to fitting advice. Our Running Shoe Finder asks six questions and matches runners to shoes by gait and terrain, free and without sign-up: ${asset.url}\n\nIf it fits, it could sit in that section.\n\nBest,\nAlex\ngearuptofit.com\n\nP.S. Not relevant for you? Just reply "no" and I won't email again.`;
  const ai={run:async()=>({response:`Subject: A shoe finder for your new-runner resources\n\n${bodyText}`})};
  let tokenRequests=0;const seen=[];
  // The whole chain in one process: runner token service -> engine -> dashboard endpoint (real verification) -> model.
  const fetchImpl=async(url,init={})=>{
    const u=String(url);
    if(u.startsWith('https://runner.example/token')){tokenRequests++;assert.equal(init.headers.Authorization,'bearer runner-secret');assert.match(u,/audience=linkforge-ai-writer/);return new Response(JSON.stringify({value:sign(claims())}),{headers:{'content-type':'application/json'}})}
    if(u.includes('.well-known/jwks'))return keysFetch(u);
    seen.push(u);
    const req=new Request(u,{method:init.method||'GET',headers:init.headers,body:init.body});
    return u.endsWith('/models')?listModels(req,env(ai),{fetchImpl:keysFetch}):chatCompletion(req,env(ai),{fetchImpl:keysFetch});
  };
  const w=new PitchWriter({senderName:'Alex',providers:aiProviders(actionsEnv),fetchImpl});
  assert.equal(w.ai,'cloudflare');
  const out=await w.write(prospect,asset,site);
  assert.equal(out.writer,'cloudflare');assert.equal(w.aiModel,'@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.deepEqual(seen,['https://dash.example/api/ai/v1/models','https://dash.example/api/ai/v1/chat/completions']);
  await w.write(prospect,asset,site);assert.equal(tokenRequests,1,'the identity token is reused for a few minutes');
  // No identity token (permission missing): templates, with the reason.
  const logs=[];
  const none=new PitchWriter({senderName:'Alex',providers:aiProviders(actionsEnv),log:m=>logs.push(m),fetchImpl:async()=>new Response('{}',{status:403})});
  assert.equal((await none.write(prospect,asset,site)).writer,'template');assert.match(logs[0],/no identity token from GitHub Actions/);
  assert.equal(await actionsIdentity(actionsEnv,'a')(async()=>{throw Error('offline')}),'');
});

test('the Pages configuration binds Workers AI and names the only repository allowed to call it',()=>{
  const t=readFileSync(new URL('../../wrangler.toml',import.meta.url),'utf8');
  assert.match(t,/^name = "backlink-command-center"$/m);assert.match(t,/^pages_build_output_dir = "public"$/m);
  assert.match(t,/\[ai\]\nbinding = "AI"/);assert.match(t,/LINKFORGE_REPO = "douphealth\/backlink-command-center"/);
});
