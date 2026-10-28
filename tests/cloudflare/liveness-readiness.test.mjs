import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../../functions/api/[[path]].js';
const context=(route,env={})=>({request:new Request('https://backlink-command-center.pages.dev/api/'+route),env,waitUntil(){}});
test('public liveness reports dashboard available even without optional database',async()=>{
  const res=await onRequest(context('health'));
  assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.status,'ok');
  assert.equal(body.dashboard,'available');
  assert.equal(body.backend_ready,false);
  assert.equal(body.automation_ready,false);
  assert.equal(body.mode,'browser_workspace');
  assert.equal(res.headers.get('cache-control'),'no-store, private');
});
test('readiness remains unavailable while backend is not configured',async()=>{
  const res=await onRequest(context('readiness'));
  assert.equal(res.status,503);
  const body=await res.json();
  assert.equal(body.ready,false);
});
test('ordinary API endpoint still denies unconfigured backend',async()=>{
  const res=await onRequest(context('overview'));
  assert.equal(res.status,503);
  const body=await res.json();
  assert.equal(body.mode,'browser_workspace');
});
