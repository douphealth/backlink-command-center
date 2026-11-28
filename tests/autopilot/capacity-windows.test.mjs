import test from 'node:test';
import assert from 'node:assert/strict';
import {sendWindowOpen,nextSendWindow,setSendPolicy,sendPolicy,SATURDAY_HOURS,outreachStatus,dailyCap} from '../../scripts/autopilot/outreach.mjs';
import {verifaliaVerdict} from '../../scripts/autopilot/recipient-policy.mjs';
import {inSendWindow} from '../../scripts/autopilot/health.mjs';
import {runAutopilot} from '../../scripts/autopilot/run.mjs';

const H=36e5;
/** UTC hours ("2026-11-28T08") during which `domain` may be emailed, scanning `hours` hours from `from`. */
const openHours=(domain,from,hours)=>{const out=[];for(let i=0;i<hours;i++){const t=new Date(Date.parse(from)+i*H);if(sendWindowOpen(domain,t))out.push(t.toISOString().slice(0,13))}return out};
const day=(d,hs)=>hs.map(h=>`${d}T${String(h).padStart(2,'0')}`);
const withPolicy=async(policy,fn)=>{try{setSendPolicy(policy);return await fn()}finally{setSendPolicy({saturday:true})}};

test('Saturday mornings send, 09:00-13:00 in the recipient\'s own time: EU 08-12, US 14-18, AU/NZ Fri 23-Sat 03, India 04-08, Asia 01-05 UTC',()=>{
  setSendPolicy({saturday:true});
  assert.deepEqual(SATURDAY_HOURS,[9,13]);
  const weekend=d=>openHours(d,'2026-11-28T00:00:00Z',48); // Saturday and Sunday, UTC
  assert.deepEqual(weekend('blog.co.uk'),day('2026-11-28',[8,9,10,11]));
  for(const d of ['blog.de','blog.fr','x.eu'])assert.deepEqual(weekend(d),day('2026-11-28',[8,9,10,11]),d);
  assert.deepEqual(weekend('blog.com'),day('2026-11-28',[14,15,16,17]),'US (default region)');
  assert.deepEqual(weekend('blog.in'),day('2026-11-28',[4,5,6,7]));
  assert.deepEqual(weekend('blog.jp'),day('2026-11-28',[1,2,3,4]));
  // AU/NZ: Saturday 09:00 Sydney is Friday 23:00 UTC; Monday 07:00 there is Sunday 21:00 UTC (the usual weekday window).
  assert.deepEqual(openHours('blog.com.au','2026-11-27T22:00:00Z',50),[...day('2026-11-27',[23]),...day('2026-11-28',[0,1,2]),...day('2026-11-29',[21,22,23])]);
  // Minute edges: the window starts and ends on the local hour.
  assert.equal(sendWindowOpen('blog.co.uk',new Date('2026-11-28T07:59:59Z')),false);assert.equal(sendWindowOpen('blog.co.uk',new Date('2026-11-28T08:00:00Z')),true);
  assert.equal(sendWindowOpen('blog.co.uk',new Date('2026-11-28T11:59:59Z')),true);assert.equal(sendWindowOpen('blog.co.uk',new Date('2026-11-28T12:00:00Z')),false);
  assert.equal(sendWindowOpen('blog.com',new Date('2026-11-28T13:59:00Z')),false);assert.equal(sendWindowOpen('blog.com',new Date('2026-11-28T18:00:00Z')),false);
});

test('Sunday never sends in any region, and weekday windows are unchanged with or without Saturdays',async()=>{
  const regions=['blog.co.uk','blog.com','blog.com.au','blog.in','blog.jp'];
  // Each recipient's own Sunday (local), whichever UTC hours it covers: closed.
  const sunday={'blog.co.uk':['2026-11-28T23:00:00Z',24],'blog.com':['2026-11-29T05:00:00Z',24],'blog.com.au':['2026-11-28T14:00:00Z',24],'blog.in':['2026-11-28T19:00:00Z',24],'blog.jp':['2026-11-28T16:00:00Z',24]};
  for(const d of regions)assert.deepEqual(openHours(d,...sunday[d]),[],d);
  const weekday={'blog.co.uk':[7,8,9,10,11,12,13,14,15],'blog.com':[13,14,15,16,17,18,19,20],'blog.com.au':[0,1,2,3,4,5,21,22,23],'blog.in':[3,4,5,6,7,8,9,10,11],'blog.jp':[0,1,2,3,4,5,6,7,8]};
  for(const policy of [{saturday:true},{saturday:false}])await withPolicy(policy,()=>{
    for(const d of regions)assert.deepEqual(openHours(d,'2026-11-25T00:00:00Z',24),day('2026-11-25',weekday[d]),`${d} Wednesday, Saturday ${policy.saturday}`);
    // Friday is a full weekday everywhere (the AU/NZ evening hours are already their Saturday).
    assert.deepEqual(openHours('blog.com','2026-11-27T00:00:00Z',24),day('2026-11-27',weekday['blog.com']));
  });
});

test('setSendPolicy: Saturday mornings are on by default, only an explicit false turns them off, and every window user follows',async()=>{
  assert.deepEqual(setSendPolicy(),{saturday:true});assert.deepEqual(setSendPolicy({saturday:undefined}),{saturday:true});
  await withPolicy({saturday:false},()=>{
    assert.deepEqual(sendPolicy(),{saturday:false});
    for(const d of ['blog.co.uk','blog.com','blog.com.au','blog.in','blog.jp'])assert.deepEqual(openHours(d,'2026-11-27T21:00:00Z',51),d==='blog.com.au'?day('2026-11-29',[21,22,23]):[],d);
    assert.equal(nextSendWindow('blog.com',new Date('2026-11-27T21:00:00Z')).toISOString(),'2026-11-30T13:00:00.000Z','weekdays only: Monday');
    assert.equal(inSendWindow({prospects:{a:{status:'ready',email:'e@a.co.uk',domain:'a.co.uk'}}},new Date('2026-11-28T10:00:00Z')),false);
  });
  assert.deepEqual(sendPolicy(),{saturday:true},'reset');
  assert.equal(inSendWindow({prospects:{a:{status:'ready',email:'e@a.co.uk',domain:'a.co.uk'}}},new Date('2026-11-28T10:00:00Z')),true,'the watchdog\'s in-window test follows');
});

test('nextSendWindow finds Saturday mornings, then Monday once they have closed',()=>{
  setSendPolicy({saturday:true});
  const next=(d,t)=>nextSendWindow(d,new Date(t)).toISOString();
  assert.equal(next('blog.co.uk','2026-11-27T21:00:00Z'),'2026-11-28T08:00:00.000Z');
  assert.equal(next('blog.com','2026-11-27T21:00:00Z'),'2026-11-28T14:00:00.000Z');
  assert.equal(next('blog.com.au','2026-11-27T21:00:00Z'),'2026-11-27T23:00:00.000Z');
  assert.equal(next('blog.co.uk','2026-11-28T09:30:00Z'),'2026-11-28T09:30:00.000Z','already open');
  assert.equal(next('blog.co.uk','2026-11-28T12:00:00Z'),'2026-11-30T07:00:00.000Z');
  assert.equal(next('blog.com','2026-11-28T18:00:00Z'),'2026-11-30T13:00:00.000Z');
  assert.equal(next('blog.com','2026-11-29T10:00:00Z'),'2026-11-30T13:00:00.000Z','Sunday: Monday');
});

const proof=email=>{const v=verifaliaVerdict({inputData:email,emailAddress:email,classification:'Deliverable',status:'Success',isDisposableEmailAddress:false},email,Date.now());return {verification:v}};
test('outreach status: next_send_at and sending_now follow Saturday windows; the daily cap is the same on Saturdays',async()=>{
  const state=()=>({reply_health:{status:'ok'},prospects:{uk:{status:'ready',email:'e@uk.co.uk',domain:'uk.co.uk',qv:2,recipient_proof:proof('e@uk.co.uk')},
    us:{status:'ready',email:'e@us.com',domain:'us.com',qv:2}}});
  const at=(t,s=state())=>outreachStatus(s,{limit:12,mode:'send',qualifyVersion:2,now:new Date(t)});
  assert.equal(at('2026-11-27T20:00:00Z').next_send_at,'2026-11-27T20:00:00.000Z','Friday: the US window is still open');
  assert.equal(at('2026-11-27T21:30:00Z').next_send_at,'2026-11-28T08:00:00.000Z','Friday night: Saturday morning in the UK');
  const sat=at('2026-11-28T09:00:00Z');assert.equal(sat.sending_now,true);assert.equal(sat.next_send_at,'2026-11-28T09:00:00.000Z');
  assert.equal(sat.cap_today,dailyCap({},12),'same warm-up cap as a weekday');
  const noon=at('2026-11-28T12:30:00Z');assert.equal(noon.sending_now,false,'the verified UK inbox is closed now');assert.equal(noon.next_send_at,'2026-11-28T14:00:00.000Z','US Saturday morning');
  assert.equal(at('2026-11-28T18:30:00Z').next_send_at,'2026-11-30T07:00:00.000Z');
  assert.equal(at('2026-11-29T12:00:00Z').sending_now,false,'Sunday');
  await withPolicy({saturday:false},()=>{
    assert.equal(at('2026-11-27T21:30:00Z').next_send_at,'2026-11-30T07:00:00.000Z');assert.equal(at('2026-11-28T09:00:00Z').sending_now,false);
  });
  assert.ok(!JSON.stringify(at('2026-11-28T09:00:00Z')).match(/uk\.co\.uk|us\.com/),'counts only');
});

test('a cycle applies the owner\'s Saturday setting before any stage (SATURDAY_SENDS=NO turns Saturday windows off)',async()=>{
  const f=async()=>new Response('',{status:404});
  try{
    const off=await runAutopilot({env:{SATURDAY_SENDS:'NO'},argv:[],fetchImpl:f,write:false,useCache:false});
    assert.equal(off.summary.sender.saturday,false);assert.deepEqual(sendPolicy(),{saturday:false});
    assert.equal(sendWindowOpen('blog.co.uk',new Date('2026-11-28T09:00:00Z')),false);
    const on=await runAutopilot({env:{},argv:[],fetchImpl:f,write:false,useCache:false});
    assert.equal(on.summary.sender.saturday,true);assert.deepEqual(sendPolicy(),{saturday:true});
    assert.equal(sendWindowOpen('blog.co.uk',new Date('2026-11-28T09:00:00Z')),true);
  }finally{setSendPolicy({saturday:true})}
});
