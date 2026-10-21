/**
 * Pure production deployment guards. Cloudflare D1 IDs are account-scoped:
 * re-use the existing database and never create one because a query failed.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function findDatabase(raw,name='linkforge-db'){
  let data;try{data=JSON.parse(raw);}catch{throw Error('Cloudflare D1 list returned an invalid JSON response; refusing to provision a duplicate');}
  const entries=Array.isArray(data)?data:Array.isArray(data.databases)?data.databases:Array.isArray(data.result)?data.result:null;
  if(!entries)throw Error('Cloudflare D1 list returned an unexpected shape; refusing to provision a duplicate');
  const matches=entries.filter(x=>x.name===name);
  if(matches.length>1)throw Error('Multiple matching D1 databases; refusing to choose one');
  if(!matches.length)return null;
  const id=matches[0].uuid||matches[0].id||matches[0].database_id;
  if(!UUID.test(String(id||'')))throw Error('Existing D1 database has no usable UUID');
  return {name,id};
}
export function workerConfig(template,databaseId){
  if(!UUID.test(String(databaseId||'')))throw Error('Invalid Cloudflare D1 database ID');
  let config;try{config=JSON.parse(template);}catch{throw Error('Invalid Worker configuration template');}
  if(config.d1_databases?.length!==1||config.d1_databases[0].binding!=='DB'||config.d1_databases[0].database_name!=='linkforge-db')throw Error('Unexpected D1 binding; refusing to deploy');
  config.d1_databases[0].database_id=databaseId;
  return JSON.stringify(config,null,2)+'\n';
}
export function workerUrl(output){
  const matches=String(output).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/ig)||[];
  return matches.at(-1)||null;
}
export function googleServiceAccount(raw){
  if(!raw)return null;
  let obj;try{obj=JSON.parse(raw);}catch{throw Error('Existing GSC service-account credential is malformed JSON');}
  if(obj.type!=='service_account'||!obj.client_email?.endsWith('.gserviceaccount.com')||!obj.private_key?.includes('BEGIN PRIVATE KEY'))throw Error('Invalid GSC service-account JSON: refusing to upload');
  return raw;
}
