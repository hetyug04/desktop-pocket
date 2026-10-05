import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import jsQR from 'jsqr';
import {PNG} from 'pngjs';
import {enrollmentUrl,qrImage,phonePage} from '../lib/phone-qr.mjs';
import {createAuth,readStore,writeStore,hashCode} from '../lib/auth.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const origin='https://friends-pc.tailqr123.ts.net:8443';
function decode(dataURL){const png=PNG.sync.read(Buffer.from(dataURL.split(',')[1],'base64'));const result=jsQR(new Uint8ClampedArray(png.data),png.width,png.height);assert.ok(result,'QR must be decodable');return result.data;}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-pocket-qr-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function consume(hash,now=Date.now()){
  const win={};vm.runInNewContext(fs.readFileSync(path.join(root,'public','phone-link.js'),'utf8'),{window:win,URLSearchParams,Date,Number});
  let cleaned=null;const result=win.DesktopPocketLink.consume({hash,pathname:'/',search:'?next=%2Ffull'},{state:null,replaceState:(_,__,url)=>cleaned=url},now);return {result,cleaned};
}
test('phone QR decodes to the private origin with enrollment in the fragment only',async()=>{
  const expires=Date.now()+900000,link=enrollmentUrl(origin,'ABCD-EFGH',expires),url=new URL(link);
  assert.equal(url.origin,origin);assert.equal(url.search,'');assert.equal(new URLSearchParams(url.hash.slice(1)).get('setup'),'ABCD-EFGH');
  assert.equal(decode(await qrImage(link)),link);
  assert.throws(()=>enrollmentUrl('http://outside.invalid','ABCD-EFGH',expires));
  assert.throws(()=>enrollmentUrl(origin,'bad-code',expires));
  const {result,cleaned}=consume(url.hash);
  assert.equal(result.code,'ABCD-EFGH');assert.equal(cleaned,'/?next=%2Ffull');
});
test('expired or malformed scans are erased from history and require a fresh QR',()=>{
  const expired=consume('#setup=ABCD-EFGH&expires=1');assert.match(expired.result.error,/expired/);assert.equal(expired.cleaned,'/?next=%2Ffull');
  const malformed=consume('#setup=%3Cscript%3E&expires=123');assert.match(malformed.result.error,/valid/);assert.equal(malformed.cleaned,'/?next=%2Ffull');
  const normal=consume('#screen');assert.equal(normal.result,null);assert.equal(normal.cleaned,null);
});
test('setup page contains locally rendered app, Tailscale install QRs and a one-click recovery kit',async()=>{
  const expires=Date.now()+900000,html=await phonePage({origin,code:'ABCD-EFGH',expires,codes:['ABCD-EFGH-JKMP']});
  const pngs=[...html.matchAll(/src="(data:image\/png;base64,[^"]+)"/g)].map(m=>decode(m[1]));
  assert.deepEqual(pngs,[enrollmentUrl(origin,'ABCD-EFGH',expires),'https://tailscale.com/download/ios','https://tailscale.com/download/android']);
  assert.match(html,/download="DesktopPocket-recovery.txt"/);assert.match(html,/No address or setup code to type/);assert.ok(!html.includes('<script src='));
});
test('QR generation needs a real passkey session, CSRF and recent verification; code still only enrolls',async t=>{
  const dir=fixture(t),file=path.join(dir,'passkeys.json'),keyFile=path.join(dir,'machine-key.txt');fs.writeFileSync(keyFile,crypto.randomBytes(32).toString('base64'));
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const jwk=publicKey.export({format:'jwk'}),x=Buffer.from(jwk.x,'base64url'),y=Buffer.from(jwk.y,'base64url');
  const cose=Buffer.concat([Buffer.from([0xa5,0x01,0x02,0x03,0x26,0x20,0x01,0x21,0x58,0x20]),x,Buffer.from([0x22,0x58,0x20]),y]);
  const id=crypto.randomBytes(32).toString('base64url'),store=readStore(file);
  store.credentials=[{id,publicKey:cose.toString('base64url'),counter:0,created:Date.now(),name:'Test key'}];writeStore(file,store);
  const previous=process.env.DP_AUTH_FILE;process.env.DP_AUTH_FILE=file;t.after(()=>{if(previous===undefined)delete process.env.DP_AUTH_FILE;else process.env.DP_AUTH_FILE=previous;});
  t.after(()=>fs.unwatchFile(file));
  const auth=createAuth({passwordFile:keyFile,publicOrigin:origin,origins:new Set([origin]),root:dir,json:(res,status,data)=>{res.status=status;res.data=data;},readJson:async req=>req.body,log:()=>{}});
  async function call(p,body={},cookie='',csrf=''){
    const req={method:'POST',headers:{origin,cookie,'x-csrf-token':csrf,'user-agent':'Test Windows'},socket:{remoteAddress:'127.0.0.1'},body};
    const res={headers:{},setHeader(k,v){this.headers[k]=v;}};await auth.handle(req,res,new URL(p,origin));return {req,...res};
  }
  assert.equal((await call('/api/auth/setup-link')).status,401);
  const options=await call('/api/auth/login/options');assert.equal(options.status,200);
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.data.options.challenge,origin,crossOrigin:false}));
  const counter=Buffer.alloc(4);counter.writeUInt32BE(1);
  const data=Buffer.concat([crypto.createHash('sha256').update('tailqr123.ts.net').digest(),Buffer.from([0x05]),counter]);
  const signature=crypto.sign('sha256',Buffer.concat([data,crypto.createHash('sha256').update(client).digest()]),privateKey);
  const login=await call('/api/auth/login/verify',{flow:options.data.flow,response:{id,rawId:id,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:client.toString('base64url'),authenticatorData:data.toString('base64url'),signature:signature.toString('base64url')}}});
  assert.equal(login.status,200);const cookie=login.headers['Set-Cookie'].split(';')[0];
  const session=auth.sessionFor({headers:{cookie}});assert.ok(session);
  assert.equal((await call('/api/auth/setup-link',{},cookie)).status,403);
  const issued=await call('/api/auth/setup-link',{},cookie,session.csrf);assert.equal(issued.status,200);assert.equal(decode(issued.data.image),issued.data.url);
  const code=new URLSearchParams(new URL(issued.data.url).hash.slice(1)).get('setup');
  assert.equal((await call('/api/auth/setup/options',{code})).status,200);
  assert.equal((await call('/api/auth/setup-link',{code})).status,401,'A QR enrollment code is not a full session');
  session.uvAt=Date.now()-6*60000;
  const stale=await call('/api/auth/setup-link',{},cookie,session.csrf);assert.equal(stale.status,403);assert.equal(stale.data.stepUp,true);
  const stored=fs.readFileSync(file,'utf8'),audit=fs.readFileSync(path.join(dir,'run','security.log'),'utf8');assert.ok(!stored.includes(code));assert.ok(!audit.includes(code));assert.ok(!audit.includes(issued.data.url));
  const expired=readStore(file);expired.enroll={...hashCode(code),expires:Date.now()-1};writeStore(file,expired);
  assert.equal((await call('/api/auth/setup/options',{code})).status,401);
});
test('CLI setup produces a private, scannable page while preserving existing passkeys',t=>{
  const dir=fixture(t),key=path.join(dir,'machine-key.txt'),file=path.join(dir,'passkeys.json'),page=path.join(dir,'phone-setup.html');fs.writeFileSync(key,'disposable-test-key');
  const store=readStore(file);store.credentials=[{id:'preserve-test',name:'Existing key',created:Date.now()}];writeStore(file,store);
  const env={...process.env,DESKTOP_PASSWORD_FILE:key,DESKTOP_ORIGIN:origin,DP_AUTH_FILE:file};
  const child=spawnSync(process.execPath,[path.join(root,'lib','auth-cli.mjs'),'setup','--qr-file',page],{env,cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);const html=fs.readFileSync(page,'utf8'),data=html.match(/id="main-qr" class="qr" src="([^"]+)"/)[1];
  assert.equal(new URL(decode(data)).origin,origin);assert.equal(readStore(file).credentials[0].id,'preserve-test');
  assert.ok(!fs.readFileSync(file,'utf8').includes(new URLSearchParams(new URL(decode(data)).hash.slice(1)).get('setup')));
  if(process.platform==='win32'){
    const acl=spawnSync('icacls.exe',[page],{encoding:'utf8',windowsHide:true});assert.equal(acl.status,0);assert.ok(!acl.stdout.includes('(I)'), 'Private QR page must not inherit other-user access');
  }
});
