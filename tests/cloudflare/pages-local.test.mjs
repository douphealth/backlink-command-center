import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BrowserStore,csvRows} from '../../public/browser-store.js';
import {onRequest} from '../../functions/api/[[path]].js';
import {SITES} from '../../functions/_lib/sites.js';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const ctx=(path,env={})=>({request:new Request('https://linkforge.pages.dev'+path),env,waitUntil:()=>{}});
const memory=()=>new BrowserStore({idb:null,sites:SITES});

test('Pages deploy ships real /api/* Functions, while browser-only setup remains safe',async()=>{
  const response=await onRequest(ctx('/api/setup'));
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/json/);
  const data=await response.json();assert.equal(data.mode,'browser_workspace');assert.equal(data.no_admin_password,true);
  assert.equal(data.browser_workspace_available,true);assert.equal(data.cloud_automation_available,false);
  assert.equal(data.database_bound,false);
  const api=await onRequest(ctx('/api/overview'));
  assert.equal(api.status,503);assert.match(api.headers.get('content-type'),/application\/json/);
  const err=await api.json();assert.match(err.detail,/on-device workspace/i);
  assert.equal(existsSync(join(root,'functions','api','[[path]].js')),true);
  assert.equal(existsSync(join(root,'wrangler.jsonc')),false,'Worker config must not hijack Cloudflare Pages build');
  const routes=JSON.parse(readFileSync(join(root,'public','_routes.json'),'utf8'));
  assert.deepEqual(routes.include,['/api/*']);
});

test('Public site HTTP verification has a strictly fixed domain allowlist',async()=>{
  const denied=await onRequest(ctx('/api/asset-check?domain=localhost'));assert.equal(denied.status,404);
  const probe=await onRequest(ctx('/api/asset-check?domain=169.254.169.254'));assert.equal(probe.status,404);
  assert.equal((await onRequest(ctx('/api/asset-check?domain=attacker.site'))).status,404);
});

test('Browser workspace provides 10 real portfolio sites and zero invented KPIs',async()=>{
  const s=memory();const overview=await s.api('overview');const sites=await s.api('sites');
  assert.equal(overview.counts.prospects,0);assert.equal(overview.counts.links,0);
  assert.equal(overview.spend.month_usd,0);assert.equal(overview.worker_status,'Browser workspace — no scheduled Worker');
  assert.equal(sites.items.length,10);assert.equal(sites.items[0].domain,'gearuptofit.com');
  assert.equal(s.persistent,false);
});

test('Manual publisher pipeline saves and suppresses records, never self-verifies them',async()=>{
  const s=memory();const site='gearuptofit.com';
  const create=async(url='https://editor.example/resources')=>s.api('prospects',{method:'POST',body:JSON.stringify({site,publisher_domain:'editor.example',source_url:url})});
  const c=await create();assert.ok(c.id>0);
  await assert.rejects(create(),/already/);
  await assert.rejects(s.api('prospects/'+c.id,{method:'PATCH',body:JSON.stringify({status:'verified_ready'})}),/verification/i);
  await s.api('prospects/'+c.id,{method:'PATCH',body:JSON.stringify({status:'hold',note:'Awaiting source inspection'})});
  const d=await s.api('prospects?status=hold');assert.equal(d.total,1);assert.equal(d.items[0].status,'hold');
  await s.api('suppression',{method:'POST',body:JSON.stringify({identity:'editor.example',reason:'Publisher declined contact'})});
  assert.equal((await s.api('suppression')).total,1);
  assert.equal((await s.api('overview')).counts.qualified,0);
});

test('Local operations store plans without running paid research or sending email',async()=>{
  const s=memory();const a=await s.api('operations/commands',{method:'POST',body:'{"action":"research"}'});
  assert.equal(a.status,'planned');assert.equal(a.local_only,true);
  assert.equal((await s.api('operations/commands',{method:'POST',body:'{"action":"research"}'})).created,false);
  await assert.rejects(s.api('operations/control',{method:'POST',body:'{"key":"dataforseo_paused","paused":false}'}),/private Cloudflare/i);
  const o=await s.api('operations');assert.equal(o.controls.dataforseo_paused,true);assert.equal(o.controls.outreach_paused,true);
  assert.equal(o.commands[0].status,'planned');assert.equal((await s.api('overview')).spend.requests_observed,0);
});

test('Spreadsheet import treats externally supplied prospect qualifications as unverified',async()=>{
  const s=memory();
  const csv='site,publisher_domain,source_url,status,score\ngearuptofit.com,editor.example,https://editor.example/resources,verified_ready,99\n';
  const file={size:csv.length,name:'publisher-prospects.csv',text:async()=>csv};
  const outcome=await s.importFile(file);assert.equal(outcome.count,1);
  const item=(await s.api('prospects')).items[0];assert.equal(item.status,'research');assert.equal(item.score,null);
  assert.equal((await s.api('overview')).counts.qualified,0);
  const exported=await s.exportCsv('prospects');assert.ok(exported.includes('editor.example'));
  assert.equal((await s.exportBackup()).schema,'linkforge-browser-backup');
});

test('CSV parser supports escaped quotes/newlines and rejects unsafe or oversized imports',async()=>{
  const rows=csvRows('name,reason\n"a,b","said ""no"""\n');
  assert.deepEqual(rows,[{name:'a,b',reason:'said "no"'}]);
  assert.throws(()=>csvRows('name\n"bad'),/unclosed quote/);
  assert.throws(()=>csvRows('a'.repeat(5_000_001)),/5 MB/);
});

test('Site checks record HTTP observation, never false backlink or opportunity verification',async()=>{
  const s=memory();
  await s.recordSiteChecks('gearuptofit.com',[{url:SITES[0].assets[0],status:200}]);
  const a=await s.api('sites');assert.equal(a.items[0].verified_assets,1);
  const overview=await s.api('overview');assert.equal(overview.counts.links,0);assert.equal(overview.counts.qualified,0);
});
