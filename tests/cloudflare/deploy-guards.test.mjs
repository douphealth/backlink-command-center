import test from 'node:test';import assert from 'node:assert/strict';
import {findDatabase,workerConfig,googleServiceAccount} from '../../scripts/cloudflare-deploy-guards.mjs';
test('existing D1 is reused, not duplicated',()=>{assert.equal(findDatabase(JSON.stringify([{name:'linkforge-db',uuid:'11111111-1111-4111-8111-111111111111'}])).id,'11111111-1111-4111-8111-111111111111');assert.equal(findDatabase('[]'),null);assert.throws(()=>findDatabase('invalid'));});
test('Worker deploy config has valid binding',()=>{const c=JSON.parse(workerConfig(JSON.stringify({d1_databases:[{binding:'DB',database_name:'linkforge-db'}]}),'11111111-1111-4111-8111-111111111111'));assert.equal(c.d1_databases[0].database_id,'11111111-1111-4111-8111-111111111111');});
test('private service-account config rejects malformed source',()=>{assert.throws(()=>googleServiceAccount('{}'));assert.equal(googleServiceAccount(''),null);});
