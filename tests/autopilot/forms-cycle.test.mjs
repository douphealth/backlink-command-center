// The "forms" stage inside a whole cycle: it runs after reply_drafts, prepares a message only with outreach on and a
// current mailbox, and the public summary carries counts only. No network: fetch and Gmail are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAutopilot} from '../../scripts/autopilot/run.mjs';
import {sealJson} from '../../scripts/autopilot/vault.mjs';
import {QUALIFY_VERSION,CONTACT_VERSION} from '../../scripts/autopilot/prospect.mjs';
import {SITES} from '../../functions/_lib/sites.js';

const KEY='forms-cycle-test-key-'.repeat(2),DAY=864e5,iso=ms=>new Date(ms).toISOString(),SITE=SITES[0].domain;
const resp=(body,{status=200,type='text/html; charset=utf-8'}={})=>new Response(body,{status,headers:{'content-type':type}});
const web=async url=>{const u=new URL(url);
  if(u.hostname==='formpub.example'&&u.pathname==='/contact/')return resp('<html><body><h1>Contact</h1><form method="post"><input name="email"><textarea name="message"></textarea></form></body></html>');
  // One flagship page of ours is crawled, so the stage pairs the prospect with a page worth pitching.
  if(u.hostname===SITE&&u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${SITE}/shoe-finder/</loc></url></urlset>`,{type:'application/xml'});
  if(u.hostname===SITE&&u.pathname==='/shoe-finder/')return resp(`<!doctype html><html><head><title>Shoe Finder</title></head><body><main><h1>Shoe Finder</h1><p>${'Find running shoes that fit your gait and mileage. '.repeat(120)}</p></main></body></html>`);
  if(u.pathname==='/sitemap.xml')return resp('<urlset></urlset>',{type:'application/xml'});
  return resp('',{status:404})};
const gmail=()=>({drafts:[],check:async()=>({status:'connected'}),close:async()=>{},send:async()=>{throw Error('nothing may be sent in this test')},draft:async function(raw){this.drafts.push(raw)},
  imap:{recentHeaders:async()=>Object.assign([],{complete:true}),sentRecipients:async()=>Object.assign([],{complete:true})}});
const vaultWith=async(dir,prospects)=>{const paths={vault:join(dir,'vault.json'),summary:join(dir,'autopilot.json'),cache:join(dir,'crawl.json')};
  await writeFile(paths.vault,JSON.stringify(await sealJson(JSON.stringify({v:1,created_at:iso(Date.now()-30*DAY),prospects,domains:{},suppression:{},contacted:{},queries:{},ledger:[]}),KEY)));return paths};
const prospect=()=>({id:'f1',site:SITE,domain:'formpub.example',page_url:'https://formpub.example/guide/',title:'Running shoes for beginners',status:'contact_form',contact_form:'https://formpub.example/contact/',
  qv:QUALIFY_VERSION,contact_v:CONTACT_VERSION,contact_checked_at:iso(Date.now()),broken_checked_at:iso(Date.now()),score:70,asset_url:`https://${SITE}/shoe-finder/`,asset_title:'Shoe Finder',found_at:iso(Date.now()-2*DAY),history:[]});

test('a cycle prepares a contact-form message for the owner and publishes counts only; with outreach off it holds',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lf-forms-'));
  try{
    const env={LINKFORGE_DATA_KEY:KEY,SENDER_NAME:'Alex',GMAIL_ADDRESS:'me@owned.example',OUTREACH_MODE:'draft'};
    const paths=await vaultWith(dir,{f1:prospect()});
    const on=await runAutopilot({env,argv:[],fetchImpl:web,mailer:gmail(),write:false,useCache:false,paths});
    const st=on.summary.stages;
    assert.ok(Object.keys(st).indexOf('forms')>Object.keys(st).indexOf('reply_drafts'),'forms runs after reply_drafts');
    assert.ok(Object.keys(st).indexOf('forms')<Object.keys(st).indexOf('outreach'),'and before outreach');
    assert.equal(st.forms.ok,true);assert.equal(st.forms.result.prepared,1);
    const p=on.state.prospects.f1;
    assert.equal(p.status,'form_ready');assert.ok(on.state.contacted['formpub.example']);
    assert.match(p.form_message.body,/\nReply to: me@owned\.example$/);assert.equal(p.form_message.form_url,'https://formpub.example/contact/');
    assert.deepEqual(on.summary.outreach.form_queue,{ready:1,prepared_today:1,expired:0});
    const pub=JSON.stringify(on.summary);
    assert.doesNotMatch(pub,/formpub|me@owned|Running shoes for beginners|Reply to/,'no publisher, address or message text in the public summary');
    // Outreach off (research only): nothing new is prepared, and the stage says why.
    const off=await runAutopilot({env:{...env,OUTREACH_MODE:'off'},argv:[],fetchImpl:web,mailer:gmail(),write:false,useCache:false,paths:await vaultWith(dir,{f1:prospect()})});
    assert.equal(off.summary.stages.forms.ok,true);assert.equal(off.summary.stages.forms.result.held,'outreach_off');
    assert.equal(off.state.prospects.f1.status,'contact_form');assert.equal(off.state.contacted['formpub.example'],undefined);
    // FORM_QUEUE_DAILY=0 turns new messages off.
    const zero=await runAutopilot({env:{...env,LINKFORGE_SETTINGS:JSON.stringify({FORM_QUEUE_DAILY:'0'})},argv:[],fetchImpl:web,mailer:gmail(),write:false,useCache:false,paths:await vaultWith(dir,{f1:prospect()})});
    assert.equal(zero.summary.stages.forms.result.held,'daily_limit_0');assert.equal(zero.state.prospects.f1.status,'contact_form');
  }finally{await rm(dir,{recursive:true,force:true})}
});
