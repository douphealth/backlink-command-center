/** Cloudflare Pages uses this tiny offline build: no account keys or servers. */
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SITES} from '../functions/_lib/sites.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const publicDir=resolve(root,'public');
for(const asset of ['index.html','app.js','browser-store.js','styles.css','_routes.json']){
  if(!existsSync(resolve(publicDir,asset)))throw Error(`Required Cloudflare Pages asset is missing: ${asset}`);
}
const out=JSON.stringify({version:1,generated_from:'functions/_lib/sites.js',sites:SITES},null,2)+'\n';
writeFileSync(resolve(publicDir,'portfolio.json'),out);
if(readFileSync(resolve(publicDir,'app.js'),'utf8').includes('Unexpected token'))throw Error('Legacy HTML-as-JSON error string still referenced');
console.log(`LinkForge Pages build: ${SITES.length} configured portfolio sites, local-first mode ready, no secret required.`);
