import test from 'node:test';
import assert from 'node:assert/strict';
import {answerReplies,answerProblem,tidyAnswer,answerSubject,answerKind,decodeWords,templateAnswer} from '../../scripts/autopilot/replies.mjs';
import {PitchWriter} from '../../scripts/autopilot/pitch.mjs';
import {hunterVerdict} from '../../scripts/autopilot/recipient-policy.mjs';

const iso=()=>new Date().toISOString(),older=new Date(Date.now()-8*86400000).toISOString();
const decode=raw=>{const i=raw.indexOf('\r\n\r\n'),head=raw.slice(0,i);return {head,body:Buffer.from(raw.slice(i+4).replace(/\r\n/g,''),'base64').toString('utf8').replace(/\r\n/g,'\n'),h:k=>(head.match(new RegExp('^'+k+': (.*)$','im'))||[])[1]||''}};
function proof(p,email=p.email){const t=Date.now();return {ok:true,email,evidence:{source:'https://'+p.domain+'/contact/',email,rank:95,observed_at:new Date(t).toISOString()},
  verification:hunterVerdict({data:{email,status:'valid',regexp:true,gibberish:false,disposable:false,mx_records:true,smtp_server:true,smtp_check:true,accept_all:false,block:false}},email,t)}}
const ASSET={url:'https://owned.example/tool/',title:'Mouse Proofing Planner | Owned',description:'A free planner that shows which gaps to seal first, room by room, with a printable checklist.'};
const conv=(reply={},extra={})=>({id:'a',site:'owned.example',domain:'pub.example',page_url:'https://pub.example/r/',email:'ed@pub.example',author:'Jane Doe',status:'positive',asset_url:ASSET.url,asset_title:'Mouse Proofing Planner',awaiting_us:true,last_subject:'Resource for your page',
  history:[{type:'initial',mode:'send',to:'ed@pub.example',at:older,message_id:'<lf-1@owned.example>',sender_name:'Alex'},
    {type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',question:false,message_id:'<their-1@pub.example>',in_reply_to:'<lf-1@owned.example>',subject:'Re: Resource for your page',excerpt:'Sure, happy to add it.',...reply}],...extra});
const stateOf=(...ps)=>({prospects:Object.fromEntries(ps.map((p,i)=>[p.id+i,p])),suppression:{},contacted:{},reply_health:{status:'ok',checked_at:iso()},sent_reconciled_at:iso()});
const transport=(authorize=p=>proof(p))=>{const m={drafts:[],sent:[],checks:0};m.draft=async raw=>{m.drafts.push(raw)};m.send=async x=>{m.sent.push(x)};m.authorizeRecipient=async p=>{m.checks++;return authorize(p)};return m};
const CONFIG={replyMode:'draft',mode:'send',fromAddress:'me@owned.example',senderName:'Sam',senderNames:{'owned.example':'Alex Site'},postalAddress:'PO Box 1, Town'};
const go=(state,mailer,config={},writer=null)=>answerReplies({state,mailer,writer,assets:[ASSET],config:{...CONFIG,...config}});

test('a positive reply gets an in-thread draft with the exact URL, a natural anchor and the first email\'s sender name',async()=>{
  const p=conv(),state=stateOf(p),m=transport();
  const r=await go(state,m);
  assert.equal(r.drafted,1);assert.equal(m.sent.length,0);assert.equal(m.checks,0,'drafts spend no verification credit');
  const {h,body}=decode(m.drafts[0]);
  assert.equal(h('In-Reply-To'),'<their-1@pub.example>');assert.equal(h('References'),'<lf-1@owned.example> <their-1@pub.example>');
  assert.equal(h('Subject'),'Re: Resource for your page');assert.equal(h('To'),'<ed@pub.example>');assert.match(h('From'),/"Alex" <me@owned\.example>/);
  assert.match(h('Message-ID'),/^<lf-/);
  assert.match(body,/^Hi Jane,/);assert.ok(body.includes(ASSET.url));assert.ok(body.includes('"Mouse Proofing Planner"'),'anchor is the page title without the site suffix');
  assert.match(body,/Best,\nAlex\nowned\.example\n\nPO Box 1, Town$/);
  assert.doesNotMatch(body,/hope you|great article|happy to help/i);
  assert.deepEqual({for:p.reply_draft.for,mode:p.reply_draft.mode},{for:'<their-1@pub.example>',mode:'draft'});
  assert.equal(p.awaiting_us,true,'a draft is not an answer until the owner sends it');
  assert.equal(p.history.at(-1).type,'answer');assert.equal(p.history.at(-1).via,'draft');assert.equal(p.history.at(-1).mode,undefined,'answer drafts never count against the pitch draft budget');
  // Without a recorded name the site's own sender name is used.
  const q=conv();delete q.history[0].sender_name;const m2=transport();await go(stateOf(q),m2);assert.match(decode(m2.drafts[0]).h('From'),/"Alex Site"/);
});

test('the same reply is never answered twice; a new reply gets its own answer',async()=>{
  const p=conv(),state=stateOf(p),m=transport();
  await go(state,m);await go(state,m);
  assert.equal(m.drafts.length,1);
  p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'neutral',question:false,message_id:'<their-2@pub.example>',subject:'Re: Resource for your page',excerpt:'Thanks, will look.'});
  await go(state,m);assert.equal(m.drafts.length,2);assert.equal(p.reply_draft.for,'<their-2@pub.example>');
  // A reply stored without a Message-ID (older records) still gets exactly one answer, threaded by subject only.
  const q=conv({message_id:null}),s2=stateOf(q),m3=transport();await go(s2,m3);await go(s2,m3);
  assert.equal(m3.drafts.length,1);assert.equal(decode(m3.drafts[0]).h('In-Reply-To'),'');
});

test('paid placement gets no draft, only the owner flag, also for a later plainer message',async()=>{
  const p=conv({condition:'paid',excerpt:'We can add it for $50.'},{needs_owner:true,condition:'paid'}),state=stateOf(p),m=transport();
  const r=await go(state,m,{replyMode:'send'});
  assert.equal(r.owner_needed,1);assert.equal(r.drafted+r.sent,0);assert.equal(m.drafts.length+m.sent.length,0);
  assert.equal(p.reply_draft.mode,'none');assert.equal(p.reply_draft.reason,'paid_placement');assert.equal(p.awaiting_us,true,'still waits for the owner');
  p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'neutral',question:true,message_id:'<their-2@pub.example>',subject:'Re: x',excerpt:'Any news?'});
  await go(state,m);assert.equal(m.drafts.length,0,'an undecided fee still blocks answers');
});

test('a link-exchange offer gets a draft that only asks which site, page and anchor; a guest-post offer asks for guidelines',async()=>{
  const p=conv({condition:'reciprocal',excerpt:'Yes, if you link back to us.'},{needs_owner:true,condition:'reciprocal'}),m=transport();
  const r=await go(stateOf(p),m,{replyMode:'send'});
  assert.equal(r.drafted,1);assert.equal(r.owner_needed,1);assert.equal(m.sent.length,0,'conditional replies are never sent automatically');assert.equal(p.reply_draft.reason,'needs_owner');
  const body=decode(m.drafts[0]).body;
  assert.match(body,/which site and which page/);assert.match(body,/anchor text/);assert.doesNotMatch(body,/\b(?:agree|deal|happy to link|we will link|https?:)/i);
  const g=conv({condition:'guest_post',sentiment:'neutral',excerpt:'We accept guest posts.'},{needs_owner:true,condition:'guest_post'}),m2=transport();
  await go(stateOf(g),m2);const gb=decode(m2.drafts[0]).body;
  assert.match(gb,/contributor guidelines/);assert.doesNotMatch(gb,/\b(?:I will write|we will write|deadline|agree)/i);
});

test('send mode sends an unconditional answer once, to the verified address the reply came from, with a fresh proof',async()=>{
  const p=conv(),state=stateOf(p),m=transport();
  const r=await go(state,m,{replyMode:'send'});
  assert.equal(r.sent,1);assert.equal(m.checks,1);assert.equal(m.sent[0].to,'ed@pub.example');assert.equal(m.sent[0].recipientProof.email,'ed@pub.example');
  assert.equal(decode(m.sent[0].raw).h('In-Reply-To'),'<their-1@pub.example>');
  assert.equal(p.awaiting_us,false);assert.equal(p.reply_draft.mode,'send');assert.ok(state.contacted['pub.example']);
  assert.equal(p.history.at(-1).via,'send');
  // At most one automatic answer per conversation: the next reply becomes a draft.
  p.awaiting_us=true;p.history.push({type:'reply',at:iso(),from:'ed@pub.example',sentiment:'positive',question:false,message_id:'<their-2@pub.example>',subject:'Re: x',excerpt:'Done!'});
  await go(state,m,{replyMode:'send'});assert.equal(m.sent.length,1);assert.equal(m.drafts.length,1);assert.equal(p.reply_draft.reason,'one_automatic_answer');
});

test('send mode never sends without a fresh complete proof',async()=>{
  for(const authorize of [()=>({ok:false,reason:'no_verified_mailbox',detail:'mailbox_unknown'}),p=>({...proof(p),verification:{...proof(p).verification,accept_all:true}}),
    p=>({...proof(p),evidence:{...proof(p).evidence,observed_at:new Date(Date.now()-25*3600e3).toISOString()}}),()=>{throw Error('timeout')}]){
    const p=conv(),m=transport(authorize);
    await go(stateOf(p),m,{replyMode:'send'});
    assert.equal(m.sent.length,0);assert.equal(m.drafts.length,1);assert.equal(p.reply_draft.reason,'recipient_not_verified');assert.equal(p.awaiting_us,true);
  }
});

test('send mode never sends to an address other than the verified one the conversation started with',async()=>{
  const p=conv({from:'colleague@pub.example'}),m=transport();
  await go(stateOf(p),m,{replyMode:'send'});
  assert.equal(m.sent.length,0);assert.equal(m.checks,0);assert.equal(p.reply_draft.reason,'different_address');
  assert.equal(decode(m.drafts[0]).h('To'),'<colleague@pub.example>','the draft answers whoever wrote');
  assert.match(decode(m.drafts[0]).body,/^Hi there,/,'the author name is not assumed for another person');
});

test('send mode falls back to drafts for questions, a pending mailbox rebuild, outreach hold, a stale scan and missing thread ids',async()=>{
  const cases=[
    [conv({sentiment:'neutral',question:true,excerpt:'Is it free?'}),s=>s,{},'question'],
    [conv(),s=>{s.rebuild_required=iso();return s},{},'mailbox_rebuild_required'],
    [conv(),s=>s,{mode:'off'},'outreach_not_sending'],
    [conv(),s=>{s.reply_health.checked_at=new Date(Date.now()-3600e3).toISOString();return s},{},'reply_scan_not_current'],
    [conv(),s=>{s.reply_health.status='backlog';return s},{},'reply_scan_not_current'],
    [conv(),s=>{delete s.sent_reconciled_at;return s},{},'sent_check_not_current'],
    [conv({message_id:null}),s=>s,{},'no_thread_id'],
    [conv({},{duplicate_sent:true}),s=>s,{},'duplicate_guard']];
  for(const [p,prep,cfg,reason] of cases){
    const m=transport();await go(prep(stateOf(p)),m,{replyMode:'send',...cfg});
    assert.equal(m.sent.length,0,reason);assert.equal(m.drafts.length,1,reason);assert.equal(p.reply_draft.reason,reason);
  }
});

test('suppressed, declined and opted-out conversations are never answered',async()=>{
  const a=conv(),s=stateOf(a);s.suppression['pub.example']={reason:'Opt-out'};
  const b=conv({},{status:'declined'}),c=conv({sentiment:'negative'});
  for(const [p,state] of [[a,s],[b,stateOf(b)],[c,stateOf(c)]]){const m=transport();await go(state,m,{replyMode:'send'});
    assert.equal(m.sent.length+m.drafts.length,0);assert.equal(p.awaiting_us,false)}
});

test('mode off does nothing; a failed automatic send is not retried and is not followed by a draft',async()=>{
  const p=conv(),m=transport();assert.deepEqual(await go(stateOf(p),m,{replyMode:'off'}),{drafted:0,sent:0,skipped:0,owner_needed:0});assert.equal(m.drafts.length,0);
  const q=conv(),state=stateOf(q),f=transport();let calls=0;f.send=async()=>{calls++;throw Error('connection lost after DATA')};
  const r=await go(state,f,{replyMode:'send'});await go(state,f,{replyMode:'send'});
  assert.equal(calls,1);assert.equal(r.uncertain,1);assert.equal(f.drafts.length,0);assert.equal(q.reply_draft.reason,'delivery_uncertain');assert.equal(q.awaiting_us,true);
});

test('an AI answer is used only when it passes every check; otherwise the safe template is used',async()=>{
  const fake=text=>({complete:async({system,user,check})=>{assert.match(system,/Never agree to/);assert.doesNotMatch(user,/ed@pub\.example/,'no addresses go to the writer');const why=check(text);return why?{why}:{text,writer:'groq'}}});
  const good=`Thanks for adding it. The page is ${ASSET.url.replace(/\/$/,'')} and "Mouse Proofing Planner" works well as the link text.`;
  const p=conv({excerpt:'Sure, mail me at ed@pub.example'}),m=transport();
  const r=await go(stateOf(p),m,{},fake('Hi Jane,\n\n'+good+'\n\nBest,\nAlex'));
  assert.equal(r.ai,1);const body=decode(m.drafts[0]).body;assert.ok(body.includes(ASSET.url),'URL restored exactly');assert.equal((body.match(/^Hi /gm)||[]).length,1,'model greeting trimmed');
  assert.equal(p.history.at(-1).writer,'groq');
  for(const bad of [`Happy to pay $20 for it: ${ASSET.url}`,`Sure, we can do a link exchange: ${ASSET.url}`,`Thanks [Name], see ${ASSET.url}`,`See ${ASSET.url} and https://evil.example`,'No link here.',`${ASSET.url} `+'word '.repeat(150)]){
    const q=conv(),m2=transport();const r2=await go(stateOf(q),m2,{},fake(bad));
    assert.equal(r2.ai,undefined,bad);assert.equal(q.history.at(-1).writer,'template');assert.ok(Object.keys(r2.template_reasons).length);
  }
});

test('answer checks: money, terms, promises, placeholders, filler, numbers and URLs',()=>{
  const url='https://owned.example/tool/',facts={our_page:{title:'Budget Planner',url,description:'Plan a monthly budget in 5 steps.'}};
  const ok=`Thanks. The page is ${url} and "Budget Planner" reads naturally as the link text.`;
  assert.equal(answerProblem(ok,{url,facts}),null,'words from our own page title are allowed');
  assert.equal(answerProblem(`It takes 5 steps: ${url}`,{url,facts}),null);
  assert.equal(answerProblem(`It is used by 10,000 readers: ${url}`,{url,facts}),'number_not_in_facts');
  assert.equal(answerProblem(`Our fee is fine: ${url}`,{url,facts}),'mentions_money');
  assert.equal(answerProblem(`I will mention your site in return: ${url}`,{url,facts}),'commits_to_terms');
  assert.equal(answerProblem(`We'll link to you as well: ${url}`,{url,facts}),'commits_to_terms');
  assert.equal(answerProblem(`Hope you're well! ${url}`,{url,facts}),'filler');
  assert.equal(answerProblem(`Thanks {{name}} ${url}`,{url,facts}),'placeholder_or_markup');
  assert.equal(answerProblem(`Write to me at me@owned.example, ${url}`,{url,facts}),'contains_email');
  assert.equal(answerProblem('Thanks!',{url,facts}),'our_url_missing');
  assert.equal(tidyAnswer(`Hello Jane,\nSee https://OWNED.example/tool.\n\nKind regards,\nAlex`,url),`See ${url}.`);
});

test('kinds, subjects and encoded words',()=>{
  assert.equal(answerKind({},{sentiment:'positive'}),'positive');
  assert.equal(answerKind({},{sentiment:'neutral',question:true}),'question');
  assert.equal(answerKind({needs_owner:true,condition:'reciprocal'},{sentiment:'neutral'}),'reciprocal','an undecided condition carries over');
  assert.equal(answerKind({needs_owner:true,condition:'reciprocal',owner_decided_at:iso()},{sentiment:'neutral'}),'neutral');
  assert.equal(answerKind({},{sentiment:'positive',condition:'something_new'}),'owner');
  assert.equal(answerKind({},{sentiment:'negative'}),null);
  assert.equal(answerSubject('RE: Re: Fwd: Your list'),'Re: Your list');
  assert.equal(answerSubject('=?UTF-8?B?UmU6IETDvHNzZWxkb3Jm?='),'Re: Düsseldorf');
  assert.equal(answerSubject('','Mouse Proofing Planner'),'Re: Mouse Proofing Planner');
  assert.equal(decodeWords('=?iso-8859-1?Q?caf=E9?='),'café');
  for(const k of ['positive','neutral','question','reciprocal','guest_post'])assert.doesNotMatch(templateAnswer(k,{anchor:'A',url:'https://x.example/',description:''}),/\$|fee|pay|agree|hope you/i);
});

test('PitchWriter.complete uses the same free writers with the caller\'s prompt and returns plain text',async()=>{
  const calls=[];
  const fetchImpl=async(url,opts={})=>{calls.push({url,body:opts.body&&JSON.parse(opts.body)});
    if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'test-chat-70b'}]}),{status:200});
    return new Response(JSON.stringify({choices:[{message:{content:'<think>plan</think>Thanks, here it is: https://owned.example/tool/'}}]}),{status:200,headers:{'content-type':'application/json'}})};
  const w=new PitchWriter({providers:[{name:'groq',label:'Groq',base:'https://api.groq.test/openai/v1',key:'k',prefer:[/70b/],fallback:[]}],fetchImpl});
  const r=await w.complete({system:'SYS',user:'USER',maxTokens:700});
  assert.deepEqual(r,{text:'Thanks, here it is: https://owned.example/tool/',writer:'groq'});
  const post=calls.find(c=>c.url.endsWith('/chat/completions')).body;
  assert.deepEqual(post.messages,[{role:'system',content:'SYS'},{role:'user',content:'USER'}]);assert.equal(post.max_tokens,700);
  assert.equal(w.used+w.usedAi+w.fallbacks,0,'pitch counters are untouched');
  assert.deepEqual(await w.complete({system:'SYS',user:'USER',check:()=>'mentions_money'}),{why:'mentions_money'});
  assert.equal((await new PitchWriter({}).complete({system:'S',user:'U'})).why,'writer_off');
});

test('PitchWriter.complete uses the Anthropic path with a plain-text request when a key is set',async()=>{
  const w=new PitchWriter({});let args;
  w.client={beta:{messages:{create:async a=>{args=a;return {stop_reason:'end_turn',content:[{type:'text',text:'Plain answer.'}]}}}}};
  assert.deepEqual(await w.complete({system:'SYS',user:'USER'}),{text:'Plain answer.',writer:'claude'});
  assert.equal(args.system,'SYS');assert.deepEqual(args.messages,[{role:'user',content:'USER'}]);assert.equal(args.output_config.format,undefined);assert.equal(args.fallbacks,'default');
  w.client={beta:{messages:{create:async()=>({stop_reason:'refusal',content:[]})}}};
  assert.deepEqual(await w.complete({system:'SYS',user:'USER'}),{why:'refusal'});
  w.client={beta:{messages:{create:async()=>{throw Error('network down')}}}};
  assert.deepEqual(await w.complete({system:'SYS',user:'USER'}),{why:'claude_unreachable'});
});

test('the cycle runs the reply_drafts stage with a working vault and Gmail, and skips it when REPLY_MODE=off',async()=>{
  const {runAutopilot}=await import('../../scripts/autopilot/run.mjs');
  const f=async url=>{const u=new URL(url);if(u.pathname==='/sitemap.xml')return new Response('<urlset></urlset>',{status:200,headers:{'content-type':'application/xml'}});return new Response('',{status:404})};
  const mailer={check:async()=>({status:'connected'}),send:async()=>{throw Error('must not send')},draft:async()=>{throw Error('nothing to draft')},imap:{recentHeaders:async()=>[],sentRecipients:async()=>[]},close:async()=>{}};
  const env={LINKFORGE_DATA_KEY:'k'.repeat(24),LINKFORGE_VAULT_RESET_AT:new Date(Date.now()+1e3).toISOString(),SENDER_NAME:'Alex',GMAIL_ADDRESS:'me@owned.example'};
  const on=await runAutopilot({env,argv:[],fetchImpl:f,mailer,write:false,useCache:false});
  assert.equal(on.summary.stages.reply_drafts.ok,true);assert.deepEqual(on.summary.stages.reply_drafts.result,{drafted:0,sent:0,skipped:0,owner_needed:0});
  const off=await runAutopilot({env:{...env,REPLY_MODE:'off'},argv:[],fetchImpl:f,mailer,write:false,useCache:false});
  assert.equal(off.summary.stages.reply_drafts.ok,null);assert.match(off.summary.stages.reply_drafts.skipped,/REPLY_MODE=off/);
});
