#!/usr/bin/env node
/**
 * One-time Autopilot setup: `npm run autopilot:setup`
 * Stores credentials as encrypted GitHub Actions secrets via the GitHub CLI (`gh`).
 * Values are piped over stdin — never written to disk, argv or shell history.
 */
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';

const gh=(args,input)=>spawnSync('gh',args,{input,encoding:'utf8',shell:process.platform==='win32'});
function ask(q,{hidden=false,def=''}={}){
  return new Promise(res=>{
    const rl=createInterface({input:process.stdin,output:process.stdout,terminal:true});
    if(hidden){rl._writeToOutput=s=>{if(s.includes(q))process.stdout.write(s);else process.stdout.write('*'.repeat(s.length>1?0:1))}}
    rl.question(q+(def?` [${def}]`:'')+': ',a=>{rl.close();if(hidden)process.stdout.write('\n');res(a.trim()||def)});
  });
}
const existing=()=>new Set((gh(['secret','list','--json','name','-q','.[].name']).stdout||'').split(/\s+/).filter(Boolean));
const setSecret=(name,value)=>{const r=gh(['secret','set',name],value);if(r.status!==0)throw Error(`gh secret set ${name} failed: ${r.stderr}`);console.log(`  ✓ secret ${name}`)};
const setVar=(name,value)=>{const r=gh(['variable','set',name,'--body',value]);if(r.status!==0)throw Error(`gh variable set ${name} failed: ${r.stderr}`);console.log(`  ✓ variable ${name}=${value}`)};

if(gh(['auth','status']).status!==0){console.error('Install the GitHub CLI and run `gh auth login` first.');process.exit(1)}
const have=existing();
console.log('\nLinkForge Autopilot setup — press Enter to keep an existing value.\n');

if(!have.has('LINKFORGE_DATA_KEY')){
  const key=randomBytes(24).toString('base64url');setSecret('LINKFORGE_DATA_KEY',key);
  mkdirSync('.linkforge',{recursive:true});writeFileSync('.linkforge/autopilot-unlock-key.txt',key+'\n',{mode:0o600});
  console.log('  Saved your dashboard unlock key to .linkforge/autopilot-unlock-key.txt (git-ignored).');
}else console.log('  ✓ LINKFORGE_DATA_KEY already set');

const steps=[
  ['DATAFORSEO_LOGIN','DataForSEO API login (email)',false],
  ['DATAFORSEO_PASSWORD','DataForSEO API password (dashboard → API Access)',true],
  ['GMAIL_ADDRESS','Gmail address that sends outreach',false],
  ['GMAIL_APP_PASSWORD','Gmail App Password (myaccount.google.com/apppasswords, needs 2-Step Verification)',true],
  ['ANTHROPIC_API_KEY','Anthropic API key for AI-written pitches (optional)',true],
  ['SENDER_POSTAL_ADDRESS','Postal address for the email footer (optional, recommended for CAN-SPAM)',false],
];
for(const [name,label,hidden] of steps){
  const v=await ask(`${label}${have.has(name)?' (set)':''}`,{hidden});
  if(v)setSecret(name,v);
}
const sender=await ask('Sender name shown in emails (e.g. "Alex from GearUpToFit")');if(sender)setVar('SENDER_NAME',sender);
const mode=await ask('Outreach mode: draft (pitches land in Gmail Drafts) or send (fully hands-free)',{def:'draft'});
if(['draft','send','off'].includes(mode))setVar('OUTREACH_MODE',mode);
const limit=await ask('Max new pitches per day',{def:'12'});if(/^\d+$/.test(limit))setVar('OUTREACH_DAILY_LIMIT',limit);

const run=await ask('Start the first Autopilot run now? (y/n)',{def:'y'});
if(/^y/i.test(run)){const r=gh(['workflow','run','autopilot.yml']);console.log(r.status===0?'  ✓ Autopilot run started — results appear on your dashboard in ~5 minutes.':'  Could not start the workflow: '+r.stderr)}
if(existsSync('.linkforge/autopilot-unlock-key.txt'))console.log('\nOpen your dashboard and paste the key from .linkforge/autopilot-unlock-key.txt to unlock prospect details.');
