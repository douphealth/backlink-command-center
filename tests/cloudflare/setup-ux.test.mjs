import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {handleApi} from '../../functions/_lib/api.js';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const html=readFileSync(join(root,'public','index.html'),'utf8');
const frontend=readFileSync(join(root,'public','app.js'),'utf8');
test('Login is a single secure deployment code, without legacy D1/Access instructions',()=>{
  assert.match(html,/id="code-login"/);
  assert.match(html,/id="admin-code"/);
  assert.match(html,/WORKS IMMEDIATELY ON PAGES/);
  for(const obsolete of ['setup-step-db','setup-step-access','CF_ACCESS_TEAM_DOMAIN','CF_ACCESS_AUD','Create and bind Cloudflare D1 as DB'])assert.ok(!html.includes(obsolete),obsolete);
  assert.match(frontend,/login_method|admin_login_ready|auth_ready/);
  assert.match(frontend,/\/api\/login/);
});
test('Safe setup endpoint reveals readiness without secrets',async()=>{
  const secret='A'.repeat(40),session='S'.repeat(48);
  const env={LINKFORGE_ADMIN_KEY:secret,LINKFORGE_SESSION_SECRET:session};
  const response=await handleApi(new Request('https://linkforge.example/api/setup'),env);
  const json=await response.json();assert.equal(json.mode,'setup_required');assert.equal(json.admin_login_ready,true);
  assert.equal(json.database_bound,false);
  assert.ok(!JSON.stringify(json).includes(secret));assert.ok(!JSON.stringify(json).includes(session));
});
