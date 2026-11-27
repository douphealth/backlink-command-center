import test from 'node:test';
import assert from 'node:assert/strict';
import {runAutopilot} from '../../scripts/autopilot/run.mjs';

const html=body=>`<!doctype html><html><head><title>Mouse proofing guide</title></head><body>${body}</body></html>`;
const resp=(body,{status=200,type='text/html; charset=utf-8'}={})=>new Response(body,{status,headers:{'content-type':type}});
const words=n=>Array.from({length:n},(_,i)=>['mice','home','seal','gaps','traps','garage','safe','plan'][i%8]).join(' ');
const site=async url=>{const u=new URL(url);
  if(u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${u.hostname}/guide/</loc></url></urlset>`,{type:'application/xml'});
  if(/\.(xml|txt)$/.test(u.pathname))return resp('',{status:404});return resp(html(`<main><h1>Guide</h1><p>${words(900)}</p></main>`))};

test('pre-verify runs without a working Gmail login, and the verifier ledger is published as counts only',async()=>{
  const asked=[];
  const mailer={check:async()=>({status:'rejected',error:'Gmail rejected the login for me@gmail.com.'}),send:async()=>{throw Error('must not send')},draft:async()=>{},
    imap:{recentHeaders:async()=>[]},authorizeRecipient:async p=>{asked.push(p.id);return {ok:false,reason:'x',detail:'mailbox_unknown'}},verifierCredits:async()=>5,close:async()=>{}};
  const {summary}=await runAutopilot({env:{LINKFORGE_DATA_KEY:'k'.repeat(24),LINKFORGE_VAULT_RESET_AT:new Date(Date.now()+1e3).toISOString(),SENDER_NAME:'Alex',OUTREACH_MODE:'send',
    VERIFALIA_USERNAME:'u',VERIFALIA_PASSWORD:'p',HUNTER_API_KEY:'real-looking-key',HUNTER_DAILY_LIMIT:'3'},argv:[],fetchImpl:site,mailer,write:false,useCache:false});
  assert.equal(summary.capabilities.connections.gmail.status,'rejected');assert.match(summary.stages.outreach.skipped,/Gmail rejected/,'sending stays blocked');
  assert.equal(summary.stages.preverify.ok,true,'verification does not need Gmail');
  const v=summary.capabilities.verifier;
  assert.equal(v.daily_limit,25);assert.equal(v.hunter_daily_limit,3);assert.equal(v.hunter_used_today,0);
  assert.ok(Array.isArray(v.ledger));assert.equal(v.credits_per_email,null);
  assert.ok(!JSON.stringify(summary).includes('me@gmail.com'),'addresses redacted from the public summary');
  // Without the verifier, pre-verify still says why it skipped.
  const off=await runAutopilot({env:{LINKFORGE_DATA_KEY:'k'.repeat(24),LINKFORGE_VAULT_RESET_AT:new Date(Date.now()+1e3).toISOString(),SENDER_NAME:'Alex'},argv:[],fetchImpl:site,mailer,write:false,useCache:false});
  assert.match(off.summary.stages.preverify.skipped,/verifier not configured/);
});
