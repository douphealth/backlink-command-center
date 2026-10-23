/**
 * Encrypted private state. The repository is public, so prospect contacts and
 * outreach history are stored only as AES-256-GCM ciphertext. The same format is
 * decrypted in the dashboard (public/autopilot-view.js) with WebCrypto.
 */
const ITERATIONS=210000;
const enc=new TextEncoder(),dec=new TextDecoder();
const b64=u8=>Buffer.from(u8).toString('base64');
const unb64=s=>new Uint8Array(Buffer.from(s,'base64'));

async function deriveKey(passphrase,salt){
  const base=await crypto.subtle.importKey('raw',enc.encode(String(passphrase)),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function seal(value,passphrase){
  if(!passphrase||String(passphrase).length<16)throw Error('LINKFORGE_DATA_KEY must be at least 16 characters');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(passphrase,salt);
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(JSON.stringify(value))));
  return {v:1,alg:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:b64(salt),iv:b64(iv),ct:b64(ct),sealed_at:new Date().toISOString()};
}
export async function open(box,passphrase){
  if(!box||box.v!==1||!box.ct)throw Error('Unrecognized vault format');
  const key=await deriveKey(passphrase,unb64(box.salt));
  try{return JSON.parse(dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(box.iv)},key,unb64(box.ct))))}
  catch{throw Error('Vault could not be decrypted: wrong LINKFORGE_DATA_KEY or corrupted file')}
}
