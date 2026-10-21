import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleApi} from '../../functions/_lib/api.js';
const source=readFileSync(new URL('../../public/index.html',import.meta.url),'utf8');
const frontend=readFileSync(new URL('../../public/app.js',import.meta.url),'utf8');
test('first-run screen provides two explicit steps and the exact binding/Access variable names',()=>{
  for (const id of ['setup-step-db','setup-step-access','setup-access-variables','setup-db-status','setup-access-status','setup-retry']) {
    assert.match(source,new RegExp(`id="${id}"`));
  }
  for (const setting of ['DB','linkforge-db','CF_ACCESS_TEAM_DOMAIN','CF_ACCESS_AUD','ADMIN_EMAIL'])assert.ok(source.includes(setting),setting);
  assert.ok(!source.includes('Administrator password'));
  assert.match(frontend,/config\?\.database_bound/);
  assert.match(frontend,/config\?\.cloudflare_access_configured/);
});
test('setup response lists individual configuration flags but no secret identifiers',async()=>{
  const env={CF_ACCESS_TEAM_DOMAIN:'private.cloudflareaccess.com',CF_ACCESS_AUD:'SECRET_AUD_IDENTIFIER',ADMIN_EMAIL:'secret@private.example'};
  const res=await handleApi(new Request('https://command.example/api/setup'),env);
  assert.equal(res.status,200);
  const json=await res.json();
  assert.equal(json.database_bound,false);
  assert.equal(json.cloudflare_access_configured,true);
  assert.equal(json.access_policy_verified,false);
  assert.deepEqual(json.access_settings,{team_domain_present:true,audience_tag_present:true,admin_email_present:true});
  const serialized=JSON.stringify(json);
  for(const secret of [env.CF_ACCESS_TEAM_DOMAIN,env.CF_ACCESS_AUD,env.ADMIN_EMAIL])assert.ok(!serialized.includes(secret));
});
