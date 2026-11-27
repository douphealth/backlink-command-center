// Whole cycles with every track wired together: vault format, reply handling and drafts, the watchdog, the rebuild hold,
// the List-Unsubscribe round trip and rejection expiry across pruning. No network: fetch and Gmail are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAutopilot,prune} from '../../scripts/autopilot/run.mjs';
import {sealJson,open,vaultFormat} from '../../scripts/autopilot/vault.mjs';
import {QUALIFY_VERSION,expireRejections} from '../../scripts/autopilot/prospect.mjs';
import {buildMessage,lfIds,optOutSubject} from '../../scripts/autopilot/mail.mjs';
import {processReplies} from '../../scripts/autopilot/outreach.mjs';
import {diagnose} from '../../scripts/autopilot/health.mjs';
import {SITES} from '../../functions/_lib/sites.js';

const KEY='integration-test-key-'.repeat(2),DAY=864e5,EMAIL=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const SITE=SITES[0].domain,ASSET=`https://${SITE}/guide/`,MID='<lf-mi0abc-k3y5z8q1@owned.example>',ED='jane@pubsite.example';
const iso=ms=>new Date(ms).toISOString();
const resp=(body,{status=200,type='text/html; charset=utf-8'}={})=>new Response(body,{status,headers:{'content-type':type}});
const words=n=>Array.from({length:n},(_,i)=>['mice','home','seal','gaps','traps','garage','safe','plan'][i%8]).join(' ');
const page=(title,body)=>`<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const web=async url=>{const u=new URL(url);
  if(u.hostname==='pubsite.example')return resp(page('Home resources',`<h1>Home resources</h1><p>${words(400)}</p>`));
  if(u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${u.hostname}/guide/</loc></url></urlset>`,{type:'application/xml'});
  if(/\.(xml|txt)$/.test(u.pathname))return resp('',{status:404});
  return resp(page('Mouse proofing guide',`<h1>Guide</h1><p>${words(900)}</p>`))};
const folder=async()=>{const dir=await mkdtemp(join(tmpdir(),'lf-autonomy-'));return {dir,paths:{vault:join(dir,'vault.json'),summary:join(dir,'autopilot.json'),cache:join(dir,'crawl.json')}}};
/** A Gmail stand-in: replies come from `inbox`, the Sent folder holds the pitch, drafts are kept, sending is refused. */
function gmail(inbox,{sentAt}){
  const drafts=[],sent=[];
  return {drafts,sent,check:async()=>({status:'connected'}),close:async()=>{},
    send:async m=>{sent.push(m);throw Error('nothing may be sent in this test')},draft:async raw=>{drafts.push(raw)},
    imap:{recentHeaders:async()=>Object.assign([...inbox],{complete:true}),sentRecipients:async()=>Object.assign([{to:ED,at:sentAt,message_id:MID}],{complete:true})}};
}
const reply=(id,body,{ago})=>({uid:id,messageId:`<${id}@pubsite.example>`,from:ED,subject:'Re: Mouse Proofing Planner for your resources page',
  date:new Date(Date.now()-ago).toUTCString(),inReplyTo:MID,references:MID,autoSubmitted:'',body});
/** A saved draft as headers plus its decoded plain-text body (buildMessage writes the body in base64). */
const readDraft=raw=>{const [head,...rest]=raw.split('\r\n\r\n');return {head,body:Buffer.from(rest.join('').replace(/\s+/g,''),'base64').toString('utf8')}};
const assertPublicClean=(summary,text)=>{
  for(const s of [JSON.stringify(summary),text].filter(Boolean)){
    assert.ok(!EMAIL.test(s),'no email address in the public summary');
    assert.ok(!/pubsite|oldpub|Jane|guest posts|happy to add/i.test(s),'no publisher domain, name or reply text in the public summary');
  }
};

test('two cycles: a v1 vault is re-sealed as v2, a positive then a neutral reply keep the status, drafts are saved and the owner is alerted',async()=>{
  const {dir,paths}=await folder();
  try{
    const sentAt=iso(Date.now()-3*DAY);
    const state0={v:1,created_at:iso(Date.now()-30*DAY),suppression:{},queries:{},ledger:[],contacted:{'pubsite.example':sentAt},
      domains:{[`${SITE}|pubsite.example`]:'pub1',[`${SITE}|oldpub.example`]:'old1'},
      prospects:{
        pub1:{id:'pub1',site:SITE,domain:'pubsite.example',page_url:'https://pubsite.example/resources/',title:'Home resources',email:ED,author:'Jane Doe',status:'sent',qv:QUALIFY_VERSION,score:80,
          asset_url:ASSET,asset_title:'Mouse Proofing Planner',found_at:iso(Date.now()-10*DAY),next_link_check:iso(Date.now()+5*DAY),last_subject:'Mouse Proofing Planner for your resources page',
          history:[{type:'initial',at:sentAt,to:ED,subject:'Mouse Proofing Planner for your resources page',message_id:MID,mode:'send',variant:'template:resource',writer:'template',rev:'local',verified:true,facts_used:[],sender_name:'Alex'}]},
        // Rejected 40 days ago, before rejection expiry existed: pruning must keep both its dedup key and an expiry entry.
        old1:{id:'old1',site:SITE,domain:'oldpub.example',page_url:'https://oldpub.example/p',status:'rejected',reason:'Thin page (120 words)',found_at:iso(Date.now()-40*DAY),history:[]}}};
    await writeFile(paths.vault,JSON.stringify(await sealJson(JSON.stringify(state0),KEY,{version:1})));
    assert.equal(vaultFormat(JSON.parse(await readFile(paths.vault,'utf8'))),'v1');
    const env={LINKFORGE_DATA_KEY:KEY,SENDER_NAME:'Alex',GMAIL_ADDRESS:'me@owned.example',OUTREACH_MODE:'off'};

    // ---- Cycle 1: a positive reply arrives ----
    const positive=reply('m1','Sure, happy to add it to the page this week.',{ago:DAY});
    const g1=gmail([positive],{sentAt});
    const c1=await runAutopilot({env,argv:[],fetchImpl:web,mailer:g1,useCache:false,paths});
    const box1=JSON.parse(await readFile(paths.vault,'utf8'));
    assert.equal(box1.v,2);assert.equal(box1.z,'gzip');assert.equal(vaultFormat(box1),'v2-gzip','the v1 vault was re-sealed as compressed v2');
    assert.equal(c1.summary.capabilities.vault_format,'v2-gzip');assert.ok(c1.summary.capabilities.vault_bytes>0);
    const s1=await open(box1,KEY),p1=s1.prospects.pub1;
    assert.equal(p1.status,'positive');assert.equal(p1.awaiting_us,true);assert.ok(p1.last_reply_at);
    assert.equal(c1.summary.stages.replies.result.positive,1);
    assert.deepEqual({drafted:c1.summary.stages.reply_drafts.result.drafted,sent:c1.summary.stages.reply_drafts.result.sent},{drafted:1,sent:0});
    assert.equal(g1.drafts.length,1);assert.equal(g1.sent.length,0,'nothing is sent in draft mode');
    const d1=readDraft(g1.drafts[0]);
    assert.match(d1.head,/In-Reply-To: <m1@pubsite\.example>/);assert.match(d1.head,/Subject: Re: Mouse Proofing Planner for your resources page/);assert.match(d1.head,/List-Unsubscribe: <mailto:me@owned\.example\?subject=unsubscribe%20lf-/);
    assert.ok(d1.body.includes(ASSET),'the answer gives the exact page');assert.match(d1.body,/^Hi Jane,/);assert.match(d1.body,/\nAlex\r?\n/);
    assert.equal(p1.reply_draft.mode,'draft');
    // Pruned: the old rejected record is gone, its domain stays deduplicated and now has an expiry entry.
    assert.equal(s1.prospects.old1,undefined);assert.equal(s1.domains[`${SITE}|oldpub.example`],'old1');
    assert.equal(s1.domain_rejections[`${SITE}|oldpub.example`].kind,'page');
    assertPublicClean(c1.summary,await readFile(paths.summary,'utf8'));

    // ---- Cycle 2: a neutral reply with a condition; the positive status must not fall back ----
    const neutral=reply('m2','Thanks for following up. We only add links through guest posts at the moment, would you write one for us?',{ago:3600e3});
    const g2=gmail([positive,neutral],{sentAt});
    const c2=await runAutopilot({env,argv:[],fetchImpl:web,mailer:g2,useCache:false,paths});
    const box2=JSON.parse(await readFile(paths.vault,'utf8'));assert.equal(vaultFormat(box2),'v2-gzip');
    const s2=await open(box2,KEY),p2=s2.prospects.pub1;
    assert.equal(c2.summary.stages.replies.result.replies,1,'the first reply is not processed twice');
    assert.equal(p2.status,'positive','a later neutral reply never turns a positive conversation back into "replied"');
    assert.equal(p2.condition,'guest_post');assert.equal(p2.needs_owner,true);assert.equal(p2.awaiting_us,true);
    const d2=readDraft(g2.drafts[0]||'');
    assert.equal(g2.drafts.length,1,'one draft for the new reply, none again for the old one');assert.match(d2.head,/In-Reply-To: <m2@pubsite\.example>/);
    assert.match(d2.body,/guidelines/);assert.doesNotMatch(d2.body,/\$|fee|agree/i,'no terms are agreed or priced');
    assert.equal(c2.summary.stages.reply_drafts.result.drafted,1);assert.equal(c2.summary.stages.reply_drafts.result.owner_needed,1);
    assert.equal(p2.history.filter(h=>h.type==='answer').length,2);
    assert.equal(c2.summary.funnel.needs_owner,1);
    const codes=c2.summary.attention.map(a=>a.code);
    assert.ok(codes.some(c=>['owner_decision_pending','replies_waiting'].includes(c)),codes.join(','));
    const owner=c2.summary.attention.find(a=>a.code==='owner_decision_pending');
    assert.equal(owner.level,'action');assert.match(owner.message,/1 wants a guest post/);
    assert.equal(c2.summary.history.filter(h=>h.date===new Date().toISOString().slice(0,10)).length,1,'one history entry per day');
    assert.equal(c2.summary.history.at(-1).cycles,2);
    assert.equal(g2.sent.length,0);
    assertPublicClean(c2.summary,await readFile(paths.summary,'utf8'));
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('a new vault holds outreach, pre-verification and automatic answers until the mailbox is read back, and says so',async()=>{
  const {dir,paths}=await folder();
  try{
    const mailer={check:async()=>({status:'connected'}),close:async()=>{},send:async()=>{throw Error('must not send')},draft:async()=>{},
      authorizeRecipient:async()=>{throw Error('must not verify while the rebuild is pending')},
      imap:{sentRecipients:async()=>{throw Error('IMAP EXAMINE NO unavailable')},recentHeaders:async()=>Object.assign([],{complete:true})}};
    const {summary,state}=await runAutopilot({env:{LINKFORGE_DATA_KEY:KEY,SENDER_NAME:'Alex',GMAIL_ADDRESS:'me@owned.example',OUTREACH_MODE:'send',REPLY_MODE:'send',
      VERIFALIA_USERNAME:'u',VERIFALIA_PASSWORD:'p'},argv:[],fetchImpl:web,mailer,write:false,useCache:false,paths});
    assert.ok(state.rebuild_required);assert.equal(summary.capabilities.rebuild_required,true);
    assert.equal(summary.stages.rebuild.ok,false);
    assert.equal(summary.stages.outreach.ok,null);assert.match(summary.stages.outreach.skipped,/new vault/);
    assert.equal(summary.stages.preverify.ok,null,'no credits are spent before contact history is restored');assert.match(summary.stages.preverify.skipped,/new vault/);
    assert.equal(summary.sender.reply_mode,'draft','automatic answers are held as drafts');
    const a=summary.attention.find(x=>x.code==='mailbox_rebuild_pending');
    assert.equal(a?.level,'action');assert.match(a.message,/reading the mailbox failed/);
    assert.ok(!summary.attention.some(x=>x.code==='stage_rebuild'),'one alert, not two');
    assert.ok(!EMAIL.test(JSON.stringify(summary)));
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('the List-Unsubscribe mailto subject finds the prospect even when sent from another address',async()=>{
  const raw=buildMessage({from:'me@owned.example',fromName:'Alex',to:ED,subject:'Mouse Proofing Planner',text:'Hi',messageId:MID,unsubscribe:true});
  const mailto=raw.match(/^List-Unsubscribe: <mailto:[^?]+\?subject=([^>]+)>/m)[1],subject=decodeURIComponent(mailto);
  assert.equal(subject,'unsubscribe lf-mi0abc-k3y5z8q1@owned.example');
  assert.deepEqual(lfIds(subject),[MID]);assert.deepEqual(lfIds(mailto),[MID],'also when a client leaves it URL-encoded');
  assert.ok(optOutSubject(subject));assert.deepEqual(lfIds('please unsubscribe me'),[]);
  const state={suppression:{},contacted:{},prospects:{pub1:{id:'pub1',site:SITE,domain:'pubsite.example',email:ED,status:'sent',history:[{type:'initial',at:iso(Date.now()-DAY),to:ED,message_id:MID,mode:'send'}]}}};
  const r=await processReplies({state,imap:{recentHeaders:async()=>Object.assign([{uid:'9',messageId:'<u1@forwarder.example>',from:'owner@forwarder.example',subject,body:'',inReplyTo:'',references:'',autoSubmitted:''}],{complete:true})}});
  assert.equal(r.negative,1);assert.equal(r.unsubscribe_links,1);assert.equal(r.unmatched_optouts,undefined);
  const p=state.prospects.pub1;assert.equal(p.status,'declined');assert.equal(p.awaiting_us,false);
  assert.ok(state.suppression['pubsite.example']&&state.suppression[ED]&&state.suppression['owner@forwarder.example']);
});

test('pruned rejections keep their dedup key and expire by kind; contacted publishers never reopen',()=>{
  const old=iso(Date.now()-40*DAY),k=d=>`${SITE}|${d}`;
  const state={contacted:{'mailed.example':old},suppression:{},
    domains:{[k('thin.example')]:'a',[k('vendor.example')]:'b',[k('mailed.example')]:'c',[k('fresh.example')]:'d'},
    prospects:{a:{id:'a',site:SITE,domain:'thin.example',status:'rejected',reason:'Thin page (90 words)',found_at:old},
      b:{id:'b',site:SITE,domain:'vendor.example',status:'rejected',reason:'Software vendor site',found_at:old},
      c:{id:'c',site:SITE,domain:'mailed.example',status:'rejected',reason:'Thin page',found_at:old},
      d:{id:'d',site:SITE,domain:'fresh.example',status:'rejected',reason:'Thin page',found_at:iso(Date.now()-DAY)}}};
  assert.deepEqual(prune(state),{rejected:3});
  assert.deepEqual(Object.keys(state.prospects),['d'],'a record younger than 7 days is kept');
  assert.deepEqual(Object.keys(state.domain_rejections).sort(),[k('mailed.example'),k('thin.example'),k('vendor.example')]);
  assert.equal(expireRejections(state),1);
  assert.equal(state.domains[k('thin.example')],undefined,'a 40-day-old page rejection reopens the publisher');
  assert.equal(state.domains[k('vendor.example')],'b','publisher-level rejections never expire');
  assert.equal(state.domains[k('mailed.example')],'c','a contacted publisher stays blocked');
  assert.equal(state.domains[k('fresh.example')],'d');
});

test('watchdog wording for a refused send and for a rebuild in progress',()=>{
  const at=(o)=>diagnose({capabilities:{verifier:{ready:true}},funnel:{ready:30},...o});
  const auth=at({stages:{outreach:{ok:true,result:{send_blocked:'gmail_auth'}}}}).find(a=>a.code==='gmail_send_blocked');
  assert.match(auth.message,/login refused/);assert.match(auth.fix,/app password/);
  const limit=at({stages:{outreach:{ok:true,result:{send_blocked:'gmail_limit'}}}}).find(a=>a.code==='gmail_send_blocked');
  assert.match(limit.message,/sending limit reached/);assert.match(limit.fix,/sending limit/);
  const reading={stages:{rebuild:{ok:true,result:{complete:false,why:'all_mail_continues_next_cycle'}}},capabilities:{verifier:{ready:true},rebuild_required:true}};
  assert.equal(at({...reading,signals:{rebuild_days:0}}).find(a=>a.code==='mailbox_rebuild_pending').level,'info');
  const stuck=at({...reading,signals:{rebuild_days:3}}).find(a=>a.code==='mailbox_rebuild_pending');
  assert.equal(stuck.level,'action');assert.match(stuck.message,/Pending for 3 days/);
  assert.ok(!at({capabilities:{verifier:{ready:true},rebuild_required:false}}).some(a=>a.code==='mailbox_rebuild_pending'));
});
