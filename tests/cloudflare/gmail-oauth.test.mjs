import test from 'node:test';
import assert from 'node:assert/strict';
import {gmailConfigured,sendingAuthorized,emailSafe,probeGmail,sendGmailMessage,hasSentToRecipient} from '../../functions/_lib/gmail.js';
const env={GMAIL_OAUTH_CLIENT_ID:'client',GMAIL_OAUTH_CLIENT_SECRET:'secret',GMAIL_OAUTH_REFRESH_TOKEN:'refresh',GMAIL_SENDER_ADDRESS:'sender@example.com'};
test('Worker sending remains off by default and requires exclusive ownership',()=>{
 assert.equal(gmailConfigured(env),true);
 assert.equal(sendingAuthorized(env,{outreach_paused:false}),false);
 assert.equal(sendingAuthorized({...env,GMAIL_OUTBOUND_ENABLED:'YES',LINKFORGE_SINGLE_SENDER:'worker',OUTREACH_CRM_SYNC_VERIFIED:'YES',OUTREACH_LEGACY_SENDER_DISABLED:'YES'},{outreach_paused:false}),true);
 assert.equal(emailSafe('a\r\nb@example.org'),false);
});
test('Worker verifies Gmail sender via OAuth without sending',async()=>{
 let calls=0;
 const fetchImpl=async(url,options)=>{calls++;if(url.includes('oauth2'))return Response.json({access_token:'test',expires_in:3600});return Response.json({emailAddress:'sender@example.com',messagesTotal:4});};
 assert.equal((await probeGmail(env,{fetchImpl})).ok,true);assert.equal(calls,2);
});
test('Gmail recipient deduplication uses real Sent query',async()=>{
 const fetchImpl=async(url,options)=>url.includes('oauth2')?Response.json({access_token:'x',expires_in:3600}):Response.json({messages:[{id:'abc'}]});
 assert.equal(await hasSentToRecipient(env,'editor@example.com',{fetchImpl}),true);
});
test('Gmail sends only valid payload and confirms Gmail IDs',async()=>{
 const requests=[];
 const fetchImpl=async(url,opts)=>{requests.push({url,opts});return url.includes('oauth2')?Response.json({access_token:'x',expires_in:3600}):Response.json({id:'gmail-id',threadId:'thread-id'});};
 const out=await sendGmailMessage(env,{to:'editor@example.com',subject:'Resource note',body:'Hello, useful information.',messageId:'<linkforge-abc@example.com>'},{fetchImpl});
 assert.equal(out.gmail_id,'gmail-id');
 assert.equal(requests.length,2);
 await assert.rejects(()=>sendGmailMessage(env,{to:'editor@example.com',subject:'Header\nInjection',body:'x'},{fetchImpl}));
});
