import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import register from '../modules/files.mjs';
import { readStore, writeStore, rpIdFor } from '../lib/auth.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('fresh machine gets its own local Files host rather than a sender host', async t => {
  const parent = path.join(root, 'run', 'files'); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'test-package-'));
  const previous = process.env.DP_FILES_HOST; delete process.env.DP_FILES_HOST;
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.DP_FILES_HOST; else process.env.DP_FILES_HOST = previous; });
  const routes = new Map(); register({hostname:'FRIENDS-PC',dataDir:()=>dir,tab:()=>{},route:(method,p,fn)=>routes.set(method+' '+p,fn),log:()=>{},peers:async()=>{throw Error('Local host must not relay');}});
  let reply;
  await routes.get('GET /api/files/inbox')({}, {headersSent:false}, {json:(status,data)=>{reply={status,data};},url:new URL('http://127.0.0.1:4098/api/files/inbox')});
  assert.equal(reply.status,200); assert.equal(reply.data.sharedHost,'friends-pc'); assert.equal(reply.data.machine,'FRIENDS-PC'); assert.deepEqual(reply.data.files,[]);
});
test('new passkey user and RP domain are independent; existing identity survives', t => {
  const parent=path.join(root,'run','files');fs.mkdirSync(parent,{recursive:true});
  const dir=fs.mkdtempSync(path.join(parent,'test-identity-')); const file=path.join(dir,'passkeys.json');
  const previous=process.env.DP_USER_NAME;process.env.DP_USER_NAME='Friend';
  t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.DP_USER_NAME;else process.env.DP_USER_NAME=previous;});
  const first=readStore(file),second=readStore(path.join(dir,'other.json'));
  assert.equal(first.user.name,'Friend');assert.notEqual(first.user.id,second.user.id);
  first.credentials=[{id:'test-existing',counter:10}];writeStore(file,first);
  process.env.DP_USER_NAME='Changed display default';const restored=readStore(file);
  assert.equal(restored.user.id,first.user.id);assert.equal(restored.user.name,'Friend');assert.deepEqual(restored.credentials,first.credentials);
  assert.equal(rpIdFor('https://friends-pc.tailabc123.ts.net:8443'),'tailabc123.ts.net');
  assert.equal(rpIdFor('https://other.tailxyz789.ts.net:8443'),'tailxyz789.ts.net');
});
