import test from 'node:test';
import assert from 'node:assert/strict';
import {outreachStatus,sendStats,wilson,isoWeek} from '../../scripts/autopilot/outreach.mjs';
import {POLICY_VERSION} from '../../scripts/autopilot/recipient-policy.mjs';

const ago=h=>new Date(Date.now()-h*36e5).toISOString(),ahead=h=>new Date(Date.now()+h*36e5).toISOString();
const proof=email=>({verification:{policy_version:POLICY_VERSION,email,status:'valid',smtp_check:true,accept_all:false,block:false,disposable:false,checked_at:ago(1),expires_at:ahead(23)}});
const mk=(id,extra={})=>({id,domain:`${id}.example`,email:`editor@${id}.example`,status:'ready',qv:2,history:[],...extra});
const held=(detail,checked=ago(2),extra={})=>({contact_quality:{status:'held',reason:'no_verified_mailbox',detail,checked_at:checked,...extra}});

test('the ready queue is split into sendable now, retry later and held for good (counts only)',()=>{
  const state={contacted:{'recent.example':ago(240)},suppression:{'blocked.example':{reason:'Opt-out'}},prospects:{
    verified:mk('verified',{recipient_proof:proof('editor@verified.example')}),
    fresh:mk('fresh'),
    ourSide:mk('ourside',held('mailbox_verifalia_free_credits_used_up')),          // our side: checked again next cycle
    staleHold:mk('stale',held('only_non_editorial_inbox_published',ago(5*24))),     // publisher hold older than 3 days: due again
    waitHold:mk('wait',held('only_non_editorial_inbox_published')),                 // publisher hold under 3 days
    cooling:mk('cooling',held('mailbox_recently_inconclusive',ago(2),{retry_after:ahead(48)})),
    catchAll:mk('catchall',held('catch_all_domain')),invalid:mk('invalid',held('mailbox_invalid')),nullMx:mk('nullmx',held('mx_null_mx')),
    recent:mk('recent'),blocked:mk('blocked'),
    oldVersion:mk('old',{qv:1}),notReady:mk('sent',{status:'sent'}),
    r1:mk('r1',{status:'contact_unverifiable',contact_quality:{status:'held',detail:'no_email_published'}}),
    r2:mk('r2',{status:'contact_unverifiable',contact_quality:{status:'held',detail:'no_email_published'}}),
    r3:mk('r3',{status:'contact_unverifiable',reason:'No verifiable editorial inbox (x)'})}};
  const s=outreachStatus(state,{limit:12,mode:'send',qualifyVersion:2});
  assert.equal(s.ready,11);
  assert.deepEqual({sendable_now:s.sendable_now,retry_later:s.retry_later,held_permanent:s.held_permanent,to_verify:s.to_verify},{sendable_now:4,retry_later:2,held_permanent:5,to_verify:3});
  assert.equal(s.sendable_now+s.retry_later+s.held_permanent,s.ready);
  assert.equal(s.verified_ready,1);
  assert.deepEqual(s.retired_by_reason,{no_email_published:2,unrecorded:1});
  assert.doesNotMatch(JSON.stringify(s),/@|\.example/,'counts only');
});
test('results per writer and per variant: replies credited to the message they answered, Wilson intervals, days of exposure',()=>{
  const now=Date.parse('2026-11-27T12:00:00Z');
  const state={prospects:{
    p1:{status:'positive',history:[{type:'initial',at:'2026-11-20T10:00:00Z',mode:'send',writer:'claude',variant:'ai:list_inclusion',message_id:'<lf-1>',to:'a@x.example'},
      {type:'followup',at:'2026-11-26T10:00:00Z',mode:'send',writer:'template',variant:'template:followup_nudge',message_id:'<lf-2>'},
      {type:'reply',at:'2026-11-26T12:00:00Z',sentiment:'positive',in_reply_to:'<lf-2>',message_id:'<r1>'},{type:'reply',at:'2026-11-26T13:00:00Z',sentiment:'neutral',in_reply_to:'<lf-1>'}]},
    p2:{status:'replied',replied_at:'2026-11-10T10:00:00Z',history:[{type:'initial',at:'2026-11-01T10:00:00Z',mode:'send',writer:'github_models'},{type:'followup',at:'2026-11-07T10:00:00Z',mode:'send',writer:'github_models'},
      {type:'reply',at:'2026-11-10T10:00:00Z',sentiment:'neutral'}]},
    p3:{status:'sent',history:[{type:'initial',at:'2026-11-25T10:00:00Z',mode:'send',writer:'template',variant:'template:initial'}]},
    p4:{status:'drafted',history:[{type:'initial',at:'2026-11-25T10:00:00Z',mode:'draft',writer:'claude',variant:'ai:list_inclusion'}]},
    p5:{status:'replied',replied_at:'2026-11-03T00:00:00Z',history:[{type:'initial',at:'2026-11-02T10:00:00Z',mode:'send',writer:'template'}]}}};
  const {by_writer:w,by_variant:v}=sendStats(state,now);
  assert.deepEqual(Object.fromEntries(Object.entries(w).map(([k,r])=>[k,[r.sent,r.replied,r.positive]])),{template:[4,2,1],github_models:[1,1,0],claude:[1,0,0]},
    'legacy follow-ups were the fixed template; the positive reply answered the follow-up');
  assert.deepEqual(Object.fromEntries(Object.entries(v).map(([k,r])=>[k,[r.sent,r.replied,r.positive]])),{unrecorded:[3,2,0],'ai:list_inclusion':[1,0,0],'template:followup_nudge':[1,1,1],'template:initial':[1,0,0]});
  assert.equal(w.template.reply_rate,0.5);assert.deepEqual(w.template.reply_ci95,wilson(2,4));
  assert.equal(v['ai:list_inclusion'].exposure_days,7);assert.equal(w.github_models.exposure_days,26);
  const wk=sendStats(state,now).by_week;
  assert.deepEqual(Object.keys(wk),['2026-W44','2026-W45','2026-W47','2026-W48'],'chronological ISO weeks');
  assert.deepEqual(Object.fromEntries(Object.entries(wk).map(([k,r])=>[k,[r.sent,r.replied,r.positive]])),{'2026-W44':[1,1,0],'2026-W45':[2,1,0],'2026-W47':[1,0,0],'2026-W48':[2,1,1]},
    'a reply counts in the week of the message it answered');
  assert.doesNotMatch(JSON.stringify({w,v,wk}),/@|example/);
  assert.deepEqual(outreachStatus(state,{limit:12,mode:'send',qualifyVersion:2}).by_writer.claude.sent,1);
});
test('ISO weeks follow the Thursday rule at year ends',()=>{
  assert.equal(isoWeek('2026-11-27T10:00:00Z'),'2026-W48');assert.equal(isoWeek('2027-01-01T00:00:00Z'),'2026-W53');
  assert.equal(isoWeek('2025-12-29T00:00:00Z'),'2026-W01');assert.equal(isoWeek('2021-01-03T00:00:00Z'),'2020-W53');assert.equal(isoWeek('nope'),null);
});
test('Wilson 95% intervals match the published pooled figure',()=>{
  assert.deepEqual(wilson(3,102),[0.01,0.083]);
  assert.equal(wilson(0,0),null);
  const [lo,hi]=wilson(0,10);assert.equal(lo,0);assert.ok(hi>0.25&&hi<0.3);
});
