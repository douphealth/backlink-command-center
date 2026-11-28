/**
 * Encrypted private state. The repository is public, so prospect contacts and
 * outreach history are stored only as AES-256-GCM ciphertext. The same format is
 * decrypted in the dashboard (public/autopilot-view.js) with WebCrypto.
 *
 * v1: AES-GCM over the JSON text. v2 (written since Nov 2026): the JSON is gzipped first ({z:'gzip'}), which keeps
 * the file far below Cloudflare's 25 MiB per-file limit for Pages assets (v1 grew ~0.5 MB a day). Both are read.
 */
import {gzipSync,gunzipSync,constants} from 'node:zlib';
const ITERATIONS=210000;
export const VAULT_VERSION=2;
const enc=new TextEncoder(),dec=new TextDecoder();
const b64=u8=>Buffer.from(u8).toString('base64');
const unb64=s=>new Uint8Array(Buffer.from(s,'base64'));

async function deriveKey(passphrase,salt,iterations=ITERATIONS){
  const base=await crypto.subtle.importKey('raw',enc.encode(String(passphrase)),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
/** Seal already-serialized JSON (lets the caller compare the text it sealed with the state it is about to write). */
export async function sealJson(json,passphrase,{version=VAULT_VERSION}={}){
  if(!passphrase||String(passphrase).length<16)throw Error('LINKFORGE_DATA_KEY must be at least 16 characters');
  if(version!==1&&version!==2)throw Error('Unknown vault version');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(passphrase,salt);
  const plain=version===2?gzipSync(Buffer.from(String(json),'utf8'),{level:constants.Z_BEST_COMPRESSION}):enc.encode(String(json));
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain));
  return {v:version,alg:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:b64(salt),iv:b64(iv),...(version===2?{z:'gzip'}:{}),ct:b64(ct),sealed_at:new Date().toISOString()};
}
export async function seal(value,passphrase,opts){return sealJson(JSON.stringify(value),passphrase,opts)}
/** 'v1', 'v2-gzip', or null when there is no sealed vault. Published (format only) in the summary. */
export const vaultFormat=box=>box&&box.ct?(box.v===2?`v2-${box.z||'raw'}`:`v${box.v}`):null;
export async function open(box,passphrase){
  if(!box||![1,2].includes(box.v)||!box.ct||(box.v===2&&box.z!=='gzip'))throw Error('Unrecognized vault format');
  // The stored iteration count is honoured within sane bounds, as the dashboard's reader does.
  const n=Number(box.iterations),iterations=Number.isSafeInteger(n)&&n>=100000&&n<=5000000?n:ITERATIONS;
  const key=await deriveKey(passphrase,unb64(box.salt),iterations);
  let plain;
  try{plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(box.iv)},key,unb64(box.ct)))}
  catch{throw Error('Vault could not be decrypted: wrong LINKFORGE_DATA_KEY or corrupted file')}
  try{return JSON.parse(box.v===2?gunzipSync(plain).toString('utf8'):dec.decode(plain))}
  catch{throw Error('Vault could not be decrypted: wrong LINKFORGE_DATA_KEY or corrupted file')}
}
