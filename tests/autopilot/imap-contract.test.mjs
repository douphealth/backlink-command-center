import test from 'node:test';
import assert from 'node:assert/strict';
import {Imap,parseFetch,classifyReply} from '../../scripts/autopilot/mail.mjs';

test('reply scan accepts command-trimmed SEARCH lines and excludes own messages',async()=>{
 const imap=new Imap({user:'owner@owned.example'});
 imap.cmd=async line=>{
  if(line.startsWith('LIST'))return '* LIST (\\All) "/" "[Gmail]/All Mail"';
  if(line.startsWith('SELECT'))return '* OK [UIDVALIDITY 100] valid';
  if(line.startsWith('UID SEARCH'))return '* SEARCH 10';
  if(line.startsWith('UID FETCH'))return '* 1 FETCH (UID 10 BODY[HEADER.FIELDS (FROM)] {30}\r\nFrom: owner@owned.example\r\n\r\n BODY[TEXT]<0> {2}\r\nno\r\n)';
  throw Error(line);
 };
 const batch=await imap.recentHeaders(new Date());
 assert.equal(batch.complete,true);assert.equal(batch.length,0);assert.equal(batch.cursor.uid,10);
});

test('encoded opt-out survives the stripped terminal FETCH newline',()=>{
 const encoded=Buffer.from('Please remove me').toString('base64');
 const raw='* 1 FETCH (UID 10 BODY[HEADER.FIELDS (FROM CONTENT-TRANSFER-ENCODING)] {80}\r\nFrom: editor@journal.example\r\nContent-Transfer-Encoding: base64\r\n\r\n BODY[TEXT]<0> {'+encoded.length+'}\r\n'+encoded+')';
 const [message]=parseFetch(raw);assert.equal(classifyReply(message),'negative');
});
