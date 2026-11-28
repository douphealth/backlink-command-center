// A 3-way (ABC) link exchange through whole cycles, every track wired together: the first pitch to publisher B for our site A
// offers a link from a related page on our site C (never A), with the plain closing opt-out line and no List-Unsubscribe header;
// B answers "sure, if you link back" (accepted, no owner decision, a confirmation draft names all three pages); a later link
// check finds B's link (the return link is owed); a later crawl of C's page finds ours (fulfilled). A contact-form publisher in
// the same cycles gets a prepared message with its own offer. Public output: counts only. No network: fetch and Gmail are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAutopilot,loadConfig} from '../../scripts/autopilot/run.mjs';
import {sealJson,open} from '../../scripts/autopilot/vault.mjs';
import {QUALIFY_VERSION,CONTACT_VERSION} from '../../scripts/autopilot/prospect.mjs';
import {OPT_OUT} from '../../scripts/autopilot/pitch.mjs';
import {sendPolicy,setSendPolicy} from '../../scripts/autopilot/outreach.mjs';
import {normUrl} from '../../scripts/autopilot/util.mjs';
import {exchangeTally} from '../../scripts/autopilot/exchange.mjs';
import {SITES} from '../../functions/_lib/sites.js';

const KEY='integration-exchange-key-'.repeat(2),DAY=864e5,EMAIL=/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,iso=ms=>new Date(ms).toISOString();
const A=SITES[0].domain,C=SITES[2].domain,ASSET=normUrl(`https://${A}/shoe-finder/`);
const C_LOC=`https://${C}/learning/marathon-recovery/`,C_PAGE=normUrl(C_LOC);
const B='runnerblog.example',B_URL=`https://${B}/marathon-recovery/`,ED=`sam@${B}`,F='formpub.example',F_URL=`https://${F}/race-day-recovery/`;
const B_TITLE='Marathon recovery: sleep, stretching and foam rolling after race day';
const REPLY="Sure, happy to if you link back.";
const resp=(body,{status=200,type='text/html; charset=utf-8'}={})=>new Response(body,{status,headers:{'content-type':type}});
const filler=(s,n)=>Array.from({length:n},()=>s).join(' ');
const html=(url,title,main)=>`<!doctype html><html><head><title>${title}</title><link rel="canonical" href="${url}"></head><body><main><h1>${title}</h1>${main}</main></body></html>`;
/** The web by phase: B links to A from phase 'their_link'; C's page carries the return link from phase 'fulfilled'. */
function web(phase){
  const theirLink=['their_link','fulfilled'].includes(phase.now),ourLink=phase.now==='fulfilled';
  return async url=>{const u=new URL(url);
    if(u.hostname===B)return resp(html(B_URL,B_TITLE,`<p>${filler('Recovery after a marathon means sleep, gentle stretching and foam rolling for sore legs.',40)}</p>${theirLink?`<p>Before your next race, check <a href="https://${A}/shoe-finder/">this shoe finder</a>.</p>`:''}`));
    if(u.hostname===F&&u.pathname==='/contact/')return resp('<html><body><h1>Contact</h1><form method="post"><input name="email"><textarea name="message"></textarea></form></body></html>');
    if(u.hostname===F)return resp(html(F_URL,'Race day recovery: stretching and sleep for marathon runners',`<p>${filler('Marathon recovery tips on stretching, sleep and foam rolling.',40)}</p>`));
    if(u.hostname===A&&u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>https://${A}/shoe-finder/</loc></url></urlset>`,{type:'application/xml'});
    if(u.hostname===A&&u.pathname==='/shoe-finder/')return resp(html(`https://${A}/shoe-finder/`,'Shoe Finder',`<p>${filler('Find running shoes that fit your gait and mileage.',120)}</p>`));
    if(u.hostname===C&&u.pathname==='/sitemap.xml')return resp(`<urlset><url><loc>${C_LOC}</loc></url></urlset>`,{type:'application/xml'});
    if(u.hostname===C&&u.pathname==='/learning/marathon-recovery/')return resp(html(C_LOC,'Marathon recovery: sleep, stretching and foam rolling',
      `<h2>Sleep after the marathon</h2><p>${filler('Sleep, stretching and foam rolling help marathon recovery for runners in the days after the race.',70)}</p>${ourLink?`<p>Sam's <a href="${B_URL}">guide to marathon recovery</a> covers the first week in detail.</p>`:''}`));
    if(u.pathname==='/sitemap.xml')return resp('<urlset></urlset>',{type:'application/xml'});
    return resp('',{status:404})};
}
/** Gmail stand-in: replies come from `inbox`, the Sent folder holds what the owner sent, drafts are kept, sending is refused. */
function gmail(inbox=[],sentFolder=[]){
  const drafts=[];
  return {drafts,check:async()=>({status:'connected'}),close:async()=>{},send:async()=>{throw Error('nothing may be sent in this test')},draft:async raw=>{drafts.push(raw)},
    imap:{recentHeaders:async()=>Object.assign([...inbox],{complete:true}),sentRecipients:async()=>Object.assign([...sentFolder],{complete:true})}};
}
const readDraft=raw=>{const [head,...rest]=raw.split('\r\n\r\n');return {head,body:Buffer.from(rest.join('').replace(/\s+/g,''),'base64').toString('utf8')}};
const vaultOf=async paths=>open(JSON.parse(await readFile(paths.vault,'utf8')),KEY);
/** Time passes between cycles: the vault is opened, changed as the days would have changed it, and sealed again. */
const advance=async(paths,fn)=>{const s=await vaultOf(paths);fn(s);await writeFile(paths.vault,JSON.stringify(await sealJson(JSON.stringify(s),KEY)))};
/** Public output: no address, no publisher in negotiation, no exchange detail, no reply text. */
const assertPublic=async(summary,paths,{publisherAllowed=false}={})=>{
  const text=await readFile(paths.summary,'utf8');
  for(const s of [JSON.stringify(summary),text]){
    assert.ok(!EMAIL.test(s),'no email address in the public summary');
    assert.doesNotMatch(s,/partner_page|partner_title|their_url|their_title|owed_by|offered_at|form_message|exchange_draft/,'no exchange record fields');
    assert.doesNotMatch(s,/link back|happy to if|Reply to:|a separate site I run/i,'no reply or message text');
    assert.doesNotMatch(s,new RegExp(F.replace('.','\\.')),'no contact-form publisher');
    if(!publisherAllowed)assert.doesNotMatch(s,/runnerblog/,'no publisher still in negotiation');
  }
  // Our pages may be listed as our own pages, never next to the exchange they carry.
  const pub=JSON.parse(text);
  assert.deepEqual(Object.keys(pub.exchanges||{}).sort(),['by_partner_site_count','paused']);
  for(const w of pub.wins||[])assert.deepEqual(Object.keys(w).filter(k=>/exchange|partner/.test(k)),[],'a won link never says it is an exchange');
};
const exchangeFunnel=f=>Object.fromEntries(Object.entries(f).filter(([k])=>k.startsWith('exchanges_')));

test('settings: List-Unsubscribe off unless turned on, Saturday mornings on unless turned off, 3-way exchange and the form queue on by default',()=>{
  const c=loadConfig({},[]);
  assert.equal(c.outreach.listUnsubscribe,false);assert.equal(c.outreach.saturday,true);assert.equal(c.exchange.mode,'abc');assert.equal(c.forms.daily,5);
  const on=loadConfig({LINKFORGE_SETTINGS:JSON.stringify({LIST_UNSUBSCRIBE_HEADER:'on',SATURDAY_SENDS:'NO',LINK_EXCHANGE:'off',FORM_QUEUE_DAILY:'0'})},[]);
  assert.equal(on.outreach.listUnsubscribe,true);assert.equal(on.outreach.saturday,false);assert.equal(on.exchange.mode,'off');assert.equal(on.forms.daily,0);
});

test('an offer drafted as an answer (not sent yet) holds its partner page and site for 30 days, like a sent one',()=>{
  const draft=(d,at)=>({exchange_draft:{partner_site:C,partner_page:C_LOC,partner_title:'T',their_url:`https://${d}/a`,message_id:`<lf-${d}@x>`,at}});
  const t=exchangeTally({prospects:{a:draft('one.example',iso(Date.now()-2*DAY)),b:draft('two.example',iso(Date.now()-40*DAY))}});
  assert.equal(t.page.get(C_PAGE),1,'the recent draft counts, the 40-day-old one no longer does');assert.equal(t.site.get(C),1);
  const sent=exchangeTally({prospects:{a:{...draft('one.example',iso(Date.now()-2*DAY)),exchange:{partner_site:C,partner_page:C_PAGE,status:'offered',offered_at:iso(Date.now()-DAY)}}}});
  assert.equal(sent.page.get(C_PAGE),1,'never counted twice once the offer is on record');
});

test('a 3-way exchange from first pitch to verified return link, across four cycles, with counts only in public',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lf-exchange-flow-')),phase={now:'pitch'};
  const paths={vault:join(dir,'vault.json'),summary:join(dir,'autopilot.json'),cache:join(dir,'crawl.json')};
  try{
    const found=iso(Date.now()-3*DAY);
    const state0={v:1,created_at:iso(Date.now()-30*DAY),suppression:{},queries:{},ledger:[],contacted:{},domains:{[`${A}|${B}`]:'b1',[`${A}|${F}`]:'f1'},
      // The mailbox is current (no rebuild pending) and earlier repairs ran.
      migrations:{reply_status_v2:found,reply_class_v3:found},
      prospects:{
        b1:{id:'b1',site:A,domain:B,page_url:B_URL,title:B_TITLE,email:ED,author:'Sam Lee',status:'ready',qv:QUALIFY_VERSION,contact_v:CONTACT_VERSION,score:82,
          asset_url:ASSET,asset_title:'Shoe Finder',fit_section:'Marathon recovery',excerpt:'Recovery after a marathon means sleep, gentle stretching and foam rolling.',
          found_at:found,contact_checked_at:found,broken_checked_at:iso(Date.now()),history:[]},
        f1:{id:'f1',site:A,domain:F,page_url:F_URL,title:'Race day recovery: stretching and sleep for marathon runners',status:'contact_form',contact_form:`https://${F}/contact/`,
          qv:QUALIFY_VERSION,contact_v:CONTACT_VERSION,contact_checked_at:iso(Date.now()),broken_checked_at:iso(Date.now()),score:70,asset_url:ASSET,asset_title:'Shoe Finder',
          fit_section:'Marathon recovery',found_at:found,history:[]}}};
    await writeFile(paths.vault,JSON.stringify(await sealJson(JSON.stringify(state0),KEY)));
    // Draft mode (the owner sends from Gmail), no send-window wait in the test; the defaults decide everything else.
    const env={LINKFORGE_DATA_KEY:KEY,SENDER_NAME:'Alex',GMAIL_ADDRESS:'me@owned.example',OUTREACH_MODE:'draft',AUTOPILOT_SEND_WINDOW:'off'};
    const cycle=mailer=>runAutopilot({env,argv:[],fetchImpl:web(phase),mailer,useCache:false,paths});

    // ---- Cycle 1: the forms stage prepares the form message, then the first pitch to B offers a link from C ----
    const g1=gmail();
    const c1=await cycle(g1);
    assert.equal(sendPolicy().saturday,true,'the run applied the Saturday-morning setting');
    const st=c1.summary.stages,order=Object.keys(st);
    assert.ok(order.indexOf('reply_drafts')<order.indexOf('forms')&&order.indexOf('forms')<order.indexOf('outreach'),'forms runs after reply_drafts and before outreach');
    assert.ok(order.indexOf('link_checks')<order.indexOf('exchanges'),'the exchanges stage follows the link checks');
    assert.equal(st.outreach.ok,true);assert.equal(st.outreach.result.drafted,1);assert.equal(st.outreach.result.exchange_offered,1);
    assert.equal(st.forms.ok,true);assert.equal(st.forms.result.prepared,1);
    let s=await vaultOf(paths),b=s.prospects.b1;
    assert.equal(b.status,'drafted');
    assert.equal(b.exchange.status,'offered');assert.equal(b.exchange.via,'email');assert.ok(b.exchange.offered_at);
    assert.equal(b.exchange.partner_site,C,'C is the related page on another of our sites');assert.notEqual(b.exchange.partner_site,A,'never A itself');
    assert.ok(SITES.some(x=>x.domain===b.exchange.partner_site),'C is one of our sites');
    assert.equal(b.exchange.partner_page,C_PAGE);assert.equal(b.exchange.their_url,B_URL);
    assert.equal(g1.drafts.length,1,'one pitch saved for the owner');
    const pitch=readDraft(g1.drafts[0]);
    assert.doesNotMatch(pitch.head,/List-Unsubscribe/i,'no List-Unsubscribe header by default');
    assert.match(pitch.head,new RegExp(`To: .*${ED.replace('.','\\.')}`));
    assert.ok(pitch.body.includes(OPT_OUT),'the plain closing sentence on how to stop all email');
    assert.doesNotMatch(pitch.body,/P\.S\.|reply "no"/i,'the old P.S. is gone');
    assert.ok(pitch.body.includes(ASSET),'the page we pitch');
    assert.ok(pitch.body.includes(C),'the offer names C');assert.match(pitch.body,/a separate site I run/,'and says honestly that C is ours');
    assert.ok(!pitch.body.includes(C_PAGE),'C\'s page is named, not linked');
    assert.doesNotMatch(pitch.body,/\b(?:pay|paid|fee|\$\d|already (?:added|linked|placed))\b/i,'no money and no claim that a link is in place');
    assert.equal(b.history.find(h=>h.type==='initial').variant,'template:link_exchange');
    const f=s.prospects.f1;
    assert.equal(f.status,'form_ready');assert.ok(f.form_message.body.includes(OPT_OUT));assert.equal(f.form_message.form_url,`https://${F}/contact/`);
    assert.equal(f.exchange?.via,'form','the form message carries its own offer');assert.notEqual(f.exchange.partner_site,A);
    assert.ok(f.form_message.body.includes(f.exchange.partner_site));
    assert.deepEqual(exchangeFunnel(c1.summary.funnel),{exchanges_offered:2,exchanges_accepted:0,exchanges_owed:0,exchanges_overdue:0,exchanges_fulfilled:0});
    assert.deepEqual(c1.summary.outreach.form_queue,{ready:1,prepared_today:1,expired:0});
    assert.ok(c1.summary.attention.some(a=>a.code==='forms_ready'),'the owner is told a form message waits');
    assert.equal(c1.summary.sender.list_unsubscribe,false);assert.equal(c1.summary.sender.link_exchange,'abc');
    await assertPublic(c1.summary,paths);
    // The form prospect is link-checked like an emailed one, from the day its message was prepared.
    assert.equal(s.prospects.f1.link_check?.status,200);

    // ---- Cycle 2: the owner sent the pitch; B says yes on the condition we offered ourselves ----
    const mid=pitch.head.match(/Message-ID: (<[^>]+>)/i)[1],sentAt=iso(Date.now()-DAY);
    const yes={uid:'r1',messageId:`<r1@${B}>`,from:ED,subject:`Re: ${pitch.head.match(/Subject: (.+)/)[1].trim()}`,date:new Date(Date.now()-2*3600e3).toUTCString(),
      inReplyTo:mid,references:mid,autoSubmitted:'',body:`${REPLY}\n\nSam\n\nOn Tue, Alex wrote:\n> ${OPT_OUT}`};
    const g2=gmail([yes],[{to:ED,at:sentAt,message_id:mid}]);
    const c2=await cycle(g2);
    s=await vaultOf(paths);b=s.prospects.b1;
    assert.equal(b.exchange.status,'accepted');assert.ok(b.exchange.accepted_at);
    assert.equal(b.status,'positive');assert.ok(!b.needs_owner,'a yes to our own offer is not an owner decision');assert.equal(c2.summary.funnel.needs_owner,0);
    assert.ok(!s.suppression[ED]&&!s.suppression[B],'the quoted closing sentence is not read as an opt-out');
    assert.equal(c2.summary.stages.replies.result.exchange_accepted,1);
    assert.equal(g2.drafts.length,1,'one confirmation drafted (B is not pitched again)');
    const answer=readDraft(g2.drafts[0]);
    assert.match(answer.head,/In-Reply-To: <r1@runnerblog\.example>/);assert.doesNotMatch(answer.head,/List-Unsubscribe/i);
    for(const u of [B_URL,ASSET,C_PAGE])assert.ok(answer.body.includes(u),`the confirmation names ${u}`);
    assert.match(answer.body,/a separate site I run/);assert.match(answer.body,/as soon as yours is live/,'the return link goes live once theirs is');
    assert.equal(b.reply_draft.mode,'draft');
    assert.deepEqual(exchangeFunnel(c2.summary.funnel),{exchanges_offered:2,exchanges_accepted:1,exchanges_owed:0,exchanges_overdue:0,exchanges_fulfilled:0});
    await assertPublic(c2.summary,paths);

    // ---- Cycle 3, days later: B's page links to A; the return link is now owed ----
    phase.now='their_link';
    await advance(paths,x=>{x.prospects.b1.next_link_check=iso(Date.now()-60e3)});
    const c3=await cycle(gmail([yes],[{to:ED,at:sentAt,message_id:mid}]));
    s=await vaultOf(paths);b=s.prospects.b1;
    assert.equal(b.status,'won');assert.equal(b.exchange.status,'their_link_live');
    assert.ok(Math.abs(Date.parse(b.exchange.owed_by)-Date.parse(b.exchange.their_link_at)-7*DAY)<1000,'owed within 7 days of their link');
    assert.equal(c3.summary.stages.link_checks.result.exchange_links,1);
    assert.deepEqual(exchangeFunnel(c3.summary.funnel),{exchanges_offered:2,exchanges_accepted:1,exchanges_owed:1,exchanges_overdue:0,exchanges_fulfilled:0});
    const due=c3.summary.attention.find(a=>a.code==='exchange_due');
    assert.equal(due?.level,'warn','the owner is told a return link is due');assert.doesNotMatch(`${due.message} ${due.fix}`,/https?:|runnerblog|gearuptogrow/);
    assert.deepEqual(c3.summary.exchanges,{by_partner_site_count:1,paused:false});
    // B is a won link now (the existing public wins list), but nothing says which page of ours owes it a link.
    await assertPublic(c3.summary,paths,{publisherAllowed:true});

    // ---- Cycle 4: the owner placed the link; the crawl of C's page finds it ----
    phase.now='fulfilled';
    const c4=await cycle(gmail([yes],[{to:ED,at:sentAt,message_id:mid}]));
    s=await vaultOf(paths);b=s.prospects.b1;
    assert.equal(b.exchange.status,'fulfilled');assert.equal(b.exchange.verified_by,'crawl');assert.ok(b.exchange.fulfilled_at);
    assert.equal(c4.summary.stages.exchanges.result.fulfilled,1);
    assert.deepEqual(exchangeFunnel(c4.summary.funnel),{exchanges_offered:2,exchanges_accepted:1,exchanges_owed:0,exchanges_overdue:0,exchanges_fulfilled:1});
    assert.ok(!c4.summary.attention.some(a=>/^exchange/.test(a.code)),'nothing owed, nothing to tell');
    await assertPublic(c4.summary,paths,{publisherAllowed:true});
  }finally{setSendPolicy({saturday:true});await rm(dir,{recursive:true,force:true})}
});

test('a link-back request on an older pitch that offered nothing gets a drafted 3-way offer from the run\'s own partner picker',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lf-exchange-old-')),O='oldpitch.example',O_ED=`kim@${O}`,MID='<lf-mi0old-k3y5z8q1@owned.example>',sentAt=iso(Date.now()-4*DAY);
  const paths={vault:join(dir,'vault.json'),summary:join(dir,'autopilot.json'),cache:join(dir,'crawl.json')};
  try{
    const state0={v:1,created_at:iso(Date.now()-30*DAY),suppression:{},queries:{},ledger:[],contacted:{[O]:sentAt},domains:{[`${A}|${O}`]:'o1'},migrations:{reply_status_v2:sentAt,reply_class_v3:sentAt},
      prospects:{o1:{id:'o1',site:A,domain:O,page_url:`https://${O}/marathon-recovery-tips/`,title:'Marathon recovery tips: sleep, stretching and foam rolling',email:O_ED,author:'Kim Ray',status:'sent',qv:QUALIFY_VERSION,score:75,
        asset_url:ASSET,asset_title:'Shoe Finder',found_at:iso(Date.now()-9*DAY),next_link_check:iso(Date.now()+3*DAY),last_subject:'Shoe Finder for your recovery tips',
        history:[{type:'initial',at:sentAt,to:O_ED,subject:'Shoe Finder for your recovery tips',message_id:MID,mode:'send',variant:'template:resource_suggestion',writer:'template',verified:true,sender_name:'Alex'}]}}};
    await writeFile(paths.vault,JSON.stringify(await sealJson(JSON.stringify(state0),KEY)));
    const ask={uid:'q1',messageId:`<q1@${O}>`,from:O_ED,subject:'Re: Shoe Finder for your recovery tips',date:new Date(Date.now()-3600e3).toUTCString(),inReplyTo:MID,references:MID,autoSubmitted:'',
      body:'Happy to add it if you link back to us.'};
    const g=gmail([ask],[{to:O_ED,at:sentAt,message_id:MID}]);
    const {summary}=await runAutopilot({env:{LINKFORGE_DATA_KEY:KEY,SENDER_NAME:'Alex',GMAIL_ADDRESS:'me@owned.example',OUTREACH_MODE:'off'},argv:[],fetchImpl:web({now:'pitch'}),mailer:g,useCache:false,paths});
    const p=(await vaultOf(paths)).prospects.o1;
    assert.equal(summary.stages.reply_drafts.result.exchange_offers_drafted,1);
    assert.equal(p.exchange_draft?.partner_site,C);assert.equal(p.exchange,undefined,'not on record until the owner sends the draft');
    const d=readDraft(g.drafts[0]);
    assert.ok(d.body.includes(C)&&/a separate site I run/.test(d.body),'the draft offers C, disclosed as ours');
    assert.doesNotMatch(d.head,/List-Unsubscribe/i);
    await assertPublic(summary,paths);
  }finally{await rm(dir,{recursive:true,force:true})}
});
