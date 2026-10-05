import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { createHub } from './lib/hub.mjs';
import { createAuth } from './lib/auth.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DESKTOP_PORT || 4097);
const publicOrigin = process.env.DESKTOP_ORIGIN || `http://127.0.0.1:${port}`;
const origins = new Set([publicOrigin, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
const hosts = new Set([...origins].map(x => new URL(x).host));
const passwordFile = process.env.DESKTOP_PASSWORD_FILE || path.join(os.homedir(), '.opencode-remote', 'password.txt');
// The password file is now only the machine-to-machine secret (and OpenCode's local password); people sign in with passkeys.
const password = fs.readFileSync(passwordFile, 'utf8').trim();
if (!password) throw Error('Password file is empty.');
const pendingInput = new Map();
const auth = createAuth({ passwordFile, publicOrigin, origins, json, readJson: req => readJson(req), log: (...a) => console.log(new Date().toISOString(), ...a), root });
const sessionFor = req => auth.sessionFor(req);
// The tailnet account that owns this machine; requests that Tailscale says come from anyone else are refused.
let ownerLogin = process.env.DP_OWNER_LOGIN || '';
let bridge, bridgeReady = false, nativeBuffer = Buffer.alloc(0), frame = null, meta = null;
let frameTime = 0, captureStarted = 0, captureBusy = false, captureError = '', controller = null, inputId = 1;
let selectedMonitor = '', quality = { width: 1280, quality: 65, interval: 100 };
// desktop-pocket-perf: pipelined frames, capture right after input, skip unchanged frames.
const MAX_IN_FLIGHT = Number(process.env.DP_MAX_IN_FLIGHT || 2), KEEPALIVE_MS = 1500, BURST_MS = 1500, IDLE_AFTER_MS = 2500, IDLE_INTERVAL = 250;
let frameSeq = 0, frameHash = '', lastChange = 0, lastInput = 0, captureSoon = false;
// Changed-region updates: the bridge sends the changed rectangle as a small JPEG (kind 3) before the full frame.
// Only viewers that say {type:'hello', patches:true} get them; everyone else keeps getting full frames.
let bridgePatches = false, latestSeq = 0, forceFull = false; const patchLog = [];
// Text-box detection: the bridge reports focus changes and answers "is this spot a text box?" probes.
let bridgeFocus = false, focusEditable = false, probeId = 1; const pendingProbes = new Map();
function features(ws) { send(ws, { type: 'features', patches: bridgePatches, focus: bridgeFocus, probe: bridgeFocus }); if (bridgeFocus) send(ws, { type: 'focus', editable: focusEditable }); }
function patchChain(from, to) {
  const chain = []; let at = from;
  for (const p of patchLog) if (p.base === at && p.seq <= to) { chain.push(p); at = p.seq; }
  return at === to ? chain : null;
}
let stopWatcher, stopping = false;
// The screen tab needs the Windows capture bridge; every other tab runs on any OS.
const bridgeExe = path.join(root, 'native', 'DesktopBridge.exe');
const screenAvailable = (process.platform === 'win32' || process.env.DP_ALLOW_BRIDGE === '1') && fs.existsSync(bridgeExe);
const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024, perMessageDeflate: false });
const fullWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
const fullTickets = new Map();
let fullClient = null, fullReconnectAfter = 0;
function fullCredentials() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root,'run','vnc.json'),'utf8'));
    return value.ready && value.port === 5905 && value.password?.length === 8 && value.viewPassword?.length === 8 ? value : null;
  } catch { return null; }
}
function fullAvailable() {
  // Do not create unauthenticated VNC health-probe clients. Availability of the
  // actual service is checked by the viewer's real, authenticated connection.
  return Promise.resolve(!!fullCredentials());
}
function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(data));
}
function token() { return crypto.randomBytes(32).toString('base64url'); }
function native(command) {
  if (bridgeReady && !bridge.stdin.destroyed) bridge.stdin.write(JSON.stringify(command) + '\n');
}
function send(ws, message) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
function controlState() {
  for (const ws of wss.clients) send(ws, { type: 'control', yours: controller === ws, occupied: !!controller || !!fullClient?.control });
}
function release() {
  controller = null; native({ op: 'release' }); controlState();
}
// A session ended (signed out, locked after 15 minutes away, passkey removed): close everything it had open.
auth.onRevoke(session => {
  session.revoked = true;
  for (const [key,ticket] of fullTickets) if (ticket.session === session) fullTickets.delete(key);
  for (const ws of fullWss.clients) if (ws.session === session) ws.close(4001,'Signed out');
  for (const ws of wss.clients) if (ws.session === session) { if (controller === ws) release(); ws.close(4001, 'Signed out'); }
});
function startBridge() {
  bridge = spawn(bridgeExe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  bridge.stdin.on('error', () => {});
  bridge.stderr.on('data', () => {});
  bridge.stdout.on('data', chunk => {
    nativeBuffer = Buffer.concat([nativeBuffer, chunk]);
    while (nativeBuffer.length >= 4) {
      const length = nativeBuffer.readUInt32LE(0);
      if (length > 24 * 1024 * 1024 || length < 1) { bridge.kill(); break; }
      if (nativeBuffer.length < length + 4) break;
      const kind = nativeBuffer[4], body = nativeBuffer.subarray(5, length + 4);
      nativeBuffer = nativeBuffer.subarray(length + 4);
      if (kind === 1) {
        const value = JSON.parse(body.toString('utf8'));
        if (value.ready) { bridgeReady = true; captureError = ''; bridgePatches = value.patches === true; bridgeFocus = value.focus === true; patchLog.length = 0; for (const ws of wss.clients) if (ws.hello) features(ws); }
        if (value.focus === true && 'editable' in value) { focusEditable = !!value.editable; for (const ws of wss.clients) if (ws.hello) send(ws, { type: 'focus', editable: focusEditable }); }
        if (value.probe !== undefined) { const p = pendingProbes.get(value.probe); pendingProbes.delete(value.probe); if (p && p.ws.readyState === WebSocket.OPEN) send(p.ws, { type: 'probe', id: p.clientId, editable: !!value.editable }); }
        if (value.capture) {
          captureBusy = false; captureError = value.error; frame = null;
          if (/Display changed/.test(value.error)) selectedMonitor = '';
          if (controller) release();
          for (const ws of wss.clients) send(ws, { type: 'error', message: value.error });
        }
        if (value.id) {
          const target = pendingInput.get(value.id); pendingInput.delete(value.id);
          if (target) send(target.ws, { type: 'input-result', id: target.clientId, ok: !!value.ok, message: value.error });
        }
      } else if (kind === 2) {
        captureBusy = false;
        const metaLength = body.readUInt32LE(0);
        const nextMeta = JSON.parse(body.subarray(4, 4 + metaLength).toString('utf8'));
        // Discard an in-flight frame for a display the controller just left.
        if (selectedMonitor && nextMeta.monitor !== selectedMonitor) continue;
        if (nextMeta.same) {
          if (!frame || nextMeta.monitor !== meta?.monitor) { forceFull = true; continue; }   // we have nothing to repeat; ask for a full frame
          captureError = ''; frameTime = Date.now(); for (const ws of wss.clients) deliverFrame(ws); continue;
        }
        const hash = crypto.createHash('sha1').update(body.subarray(4 + metaLength)).digest('base64');
        const changed = hash !== frameHash || !frame || nextMeta.monitor !== meta?.monitor || nextMeta.width !== meta?.width;
        captureError = ''; frameTime = Date.now(); meta = nextMeta; selectedMonitor = meta.monitor;
        if (changed) {
          frameHash = hash; frame = Buffer.from(body); lastChange = frameTime;
          frameSeq = Number.isFinite(nextMeta.seq) ? nextMeta.seq : frameSeq + 1; latestSeq = Math.max(latestSeq, frameSeq);
        }
        for (const ws of wss.clients) deliverFrame(ws);
      } else if (kind === 3) {
        const metaLength = body.readUInt32LE(0);
        const patchMeta = JSON.parse(body.subarray(4, 4 + metaLength).toString('utf8'));
        if (selectedMonitor && patchMeta.monitor !== selectedMonitor) continue;
        patchLog.push({ seq: patchMeta.seq, base: patchMeta.base, buf: Buffer.from(body) });
        if (patchLog.length > 30) patchLog.shift();
        latestSeq = Math.max(latestSeq, patchMeta.seq); lastChange = Date.now();
        for (const ws of wss.clients) deliverFrame(ws);
      }
    }
  });
  bridge.on('error', () => { captureError = 'Desktop bridge could not start. Restart Desktop Pocket on the PC.'; });
  bridge.on('exit', () => {
    bridgeReady = false; captureBusy = false; nativeBuffer = Buffer.alloc(0); frame = null;
    captureError = 'Desktop bridge stopped. Restart Desktop Pocket on the PC.';
    release(); for (const ws of wss.clients) send(ws, { type: 'error', message: captureError });
  });
}
function deliverFrame(ws) {
  if (!frame || Date.now() - frameTime > 3000 || !ws.active || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256000) return;
  if ((ws.inFlight || 0) >= MAX_IN_FLIGHT) return;
  // Viewers that understand patches get just the changed regions when that's smaller than a full frame.
  if (ws.patches && ws.sentSeq >= 0 && latestSeq > ws.sentSeq) {
    const chain = patchChain(ws.sentSeq, latestSeq);
    if (chain && chain.reduce((n, p) => n + p.buf.length, 0) < frame.length * 0.6) {
      if (!ws.inFlight) ws.pendingSince = Date.now();
      for (const p of chain) { ws.inFlight = (ws.inFlight || 0) + 1; ws.send(p.buf, { binary: true }); }
      ws.sentSeq = latestSeq; ws.frameSent = Date.now(); return;
    }
    if (frameSeq < latestSeq) return;   // the full frame for this change is a few ms behind its patch
  }
  // Nothing new for this viewer: only resend now and then so older clients don't think the stream stalled.
  if (ws.sentSeq === frameSeq && Date.now() - (ws.frameSent || 0) < KEEPALIVE_MS) return;
  // Patch-aware viewers just get a tiny "still the same" note instead of the whole picture again.
  if (ws.sentSeq === frameSeq && ws.patches) { ws.frameSent = Date.now(); send(ws, { type: 'same', seq: frameSeq }); return; }
  if (!ws.inFlight) ws.pendingSince = Date.now();
  ws.inFlight = (ws.inFlight || 0) + 1; ws.sentSeq = frameSeq; ws.frameSent = Date.now();
  ws.send(frame, { binary: true });
}
function validInput(data) {
  if (!['move','click','double','down','up','scroll','key','text'].includes(data.op)) return false;
  if (['move','click','double','down','up','scroll'].includes(data.op)) {
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || data.x < 0 || data.x > 1 || data.y < 0 || data.y > 1) return false;
    if (data.monitor !== selectedMonitor) return false;
    if (data.button && !['left','right'].includes(data.button)) return false;
  }
  if (data.op === 'scroll' && (!Number.isFinite(data.delta) || Math.abs(data.delta) > 1200)) return false;
  if (data.op === 'text' && (typeof data.text !== 'string' || data.text.length > 4096)) return false;
  if (data.op === 'key' && (!Array.isArray(data.keys) || data.keys.length < 1 || data.keys.length > 5 || data.keys.some(k => typeof k !== 'string' || k.length > 12))) return false;
  return true;
}
async function readJson(req) {
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16384) throw Error('Request too large'); }
  return JSON.parse(body);
}
const assets = new Map([
  ['/', ['index.html','text/html; charset=utf-8']], ['/app.js',['app.js','text/javascript; charset=utf-8']], ['/phone-link.js',['phone-link.js','text/javascript; charset=utf-8']],
  ['/style.css',['style.css','text/css; charset=utf-8']], ['/phone-setup.css',['phone-setup.css','text/css; charset=utf-8']], ['/icon.svg',['icon.svg','image/svg+xml']],
  ['/icon-192.png',['icon-192.png','image/png']], ['/icon-512.png',['icon-512.png','image/png']],
  ['/manifest.webmanifest',['manifest.webmanifest','application/manifest+json']], ['/sw.js',['sw.js','text/javascript; charset=utf-8']]
  ,['/full',['index.html','text/html; charset=utf-8']], ['/full.js',['full.js','text/javascript; charset=utf-8']], ['/full.css',['full.css','text/css; charset=utf-8']]
]);
const hub = createHub({ root, password, sessionFor, json, readJson, publicOrigin, hosts, origins, auth, gateCheck: req => gateCheck(req) });
auth.attachSync(hub.api);
await hub.loadModules();
// Learn the owner's Tailscale login (retrying while Tailscale starts up).
(function learnOwner() {
  if (ownerLogin) return;
  hub.api.status().then(st => { const u = st?.User?.[st?.Self?.UserID]; ownerLogin = u?.LoginName || '*'; if (ownerLogin === '*') console.log('security: Tailscale did not say who owns this machine; the owner check is off (passkeys still required).'); }).catch(() => {})
    .finally(() => { if (!ownerLogin && !process.env.DP_TAILSCALE_STATUS_FILE) setTimeout(learnOwner, 15000).unref(); });
})();
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  ...(publicOrigin.startsWith('https:') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};
/** Requests that are refused before anything else looks at them. */
function gateCheck(req) {
  const who = req.headers['tailscale-user-login'];
  // Tailscale says who is connecting. Anyone but the owner is refused; if the owner isn't known yet, nobody else gets in either.
  if (who && !ownerLogin && !process.env.DP_TAILSCALE_STATUS_FILE) return 'Starting up. Try again in a moment.';
  if (who && ownerLogin && ownerLogin !== '*' && String(who).toLowerCase() !== ownerLogin.toLowerCase()) return 'This app belongs to another tailnet account.';
  // Another site (even another app on your tailnet) can't make this one do things or read from it.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none' && !(req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate')) return 'Cross-site request refused.';
  return '';
}
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (!hosts.has(req.headers.host)) return json(res, 403, { error: 'Unknown host' });
  const refused = gateCheck(req);
  if (refused) { auth.audit(req, 'request refused', { reason: refused, path: req.url.split('?')[0] }); return json(res, 403, { error: refused }); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (await hub.handleRequest(req, res, url)) return;
    if (req.method === 'POST') {
      const expected = req.headers.host === new URL(publicOrigin).host ? publicOrigin : `http://${req.headers.host}`;
      if (req.headers.origin !== expected) return json(res, 403, { error: 'Origin rejected' });
    }
    // Passwords no longer sign anyone in.
    if (req.method === 'POST' && url.pathname === '/api/login') return json(res, 410, { error: 'Passwords are turned off. Sign in with your passkey.' });
    if (await auth.handle(req, res, url)) return;
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { app: 'desktop-pocket', ready: bridgeReady });
    if(req.method==='GET'&&url.pathname==='/'&&url.searchParams.get('mode')!=='normal'&&fullCredentials()&&sessionFor(req)) {
      res.writeHead(302,{Location:'/full'});return res.end();
    }
    const asset = assets.get(url.pathname);
    if (req.method === 'GET' && asset) {
      res.setHeader('Content-Type',asset[1]); return res.end(fs.readFileSync(path.join(root,'public',asset[0])));
    }
    if (req.method === 'GET' && /^\/novnc\/(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)) {
      const packageRoot = path.join(root,'node_modules','@novnc','novnc');
      const moduleFile = path.resolve(packageRoot,'.' + url.pathname.slice('/novnc'.length));
      if (!moduleFile.startsWith(packageRoot + path.sep) || !fs.existsSync(moduleFile)) return json(res,404,{error:'Not found'});
      res.setHeader('Content-Type','text/javascript; charset=utf-8'); return res.end(fs.readFileSync(moduleFile));
    }
    const session = sessionFor(req);
    if (!session) return json(res, 401, { error: 'Sign in to continue.' });
    if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { csrf: session.csrf, lockMinutes: 15, machine: os.hostname(), platform: process.platform, screen: screenAvailable, tabs: hub.tabs(), ready: bridgeReady, fullDesktop:!!fullCredentials(), error: captureError, meta, frameAge: frameTime ? Date.now() - frameTime : null });
    if (req.method === 'GET' && url.pathname === '/api/full/status') return json(res,200,{ready:await fullAvailable(),occupied:!!fullClient,control:!!fullClient?.control});
    if (req.method === 'POST' && url.pathname === '/api/full/connect') {
      if (req.headers['x-csrf-token'] !== session.csrf) return json(res,403,{error:'Token rejected'});
      const data = await readJson(req), credentials = fullCredentials();
      if (!credentials || !await fullAvailable()) return json(res,503,{error:'Full desktop service is not installed or running. Complete the one-time setup on the PC.'});
      if (fullClient || (data.control === true && controller)) return json(res,409,{error:'Another connection is active. Disconnect it or return control first.'});
      for (const [key,ticket] of fullTickets) if (ticket.session.id === session.id || ticket.expires < Date.now()) fullTickets.delete(key);
      const key = token(), control = data.control === true;
      fullTickets.set(key,{session,control,expires:Date.now()+10000});
      return json(res,200,{ticket:key,password:control?credentials.password:credentials.viewPassword,control});
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      if (req.headers['x-csrf-token'] !== session.csrf) return json(res, 403, { error: 'Token rejected' });
      auth.signOut(req, res); return json(res, 200, { ok: true });
    }
    return json(res,404,{error:'Not found'});
  } catch { json(res,400,{error:'Invalid request'}); }
});
// Big uploads in the Files tab can take a while on cellular; keep a short limit for the request headers.
server.requestTimeout = 30 * 60 * 1000; server.headersTimeout = 20000;
server.on('upgrade', (req, socket, head) => {
  try { if (hub.handleUpgrade(req, socket, head, new URL(req.url, `http://${req.headers.host}`))) return; } catch { socket.destroy(); return; }
  const origin = req.headers.origin;
  if (!hosts.has(req.headers.host) || !origins.has(origin) || new URL(origin).host !== req.headers.host || gateCheck(req)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`), session = sessionFor(req);
  if (url.pathname === '/full-stream') {
    const key = url.searchParams.get('ticket'), ticket = fullTickets.get(key);
    if (!session || !ticket || ticket.session.id !== session.id || ticket.expires < Date.now() || !fullCredentials()) {socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
    fullTickets.delete(key);
    if (fullClient || (ticket.control && controller)) {socket.end('HTTP/1.1 409 Conflict\r\n\r\n');return;}
    fullWss.handleUpgrade(req,socket,head,ws=>{ws.session=session;ws.control=ticket.control;fullClient=ws;fullWss.emit('connection',ws);});
    return;
  }
  if (url.pathname !== '/stream' || !session || url.searchParams.get('token') !== session.csrf) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  if (wss.clients.size >= 8) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => { ws.session = session; wss.emit('connection', ws); });
});
fullWss.on('connection',ws=>{
  controlState(); ws.lastPong = Date.now();
  const tcp = new net.Socket();
  let closed = false;
  const cleanup = () => {if(closed)return;closed=true;clearTimeout(connectTimer);tcp.destroy();if(fullClient===ws){fullClient=null;fullReconnectAfter=Date.now()+1500;controlState();}};
  // TightVNC tears down its desktop helper after its last viewer leaves. Its
  // afterLastClientDisconnect callback can otherwise kill an immediate new
  // connection while that teardown is still running.
  const connectTimer = setTimeout(()=>{if(!closed&&ws.readyState===WebSocket.OPEN)tcp.connect({host:'127.0.0.1',port:5905});},Math.max(0,fullReconnectAfter-Date.now()));
  tcp.setNoDelay(true);
  tcp.on('data',chunk=>{
    if(ws.readyState!==WebSocket.OPEN)return;
    if(ws.bufferedAmount>16*1024*1024){ws.close(1008,'Viewer too slow');cleanup();return;}
    ws.send(chunk,{binary:true},error=>{if(error){cleanup();return;}if(ws.bufferedAmount<1024*1024)tcp.resume();});
    if(ws.bufferedAmount>4*1024*1024)tcp.pause();
  });
  tcp.on('error',()=>{ws.close(1011,'Desktop service unavailable');cleanup();});
  tcp.on('close',()=>{if(ws.readyState===WebSocket.OPEN)ws.close(1000,'Desktop disconnected');cleanup();});
  ws.on('message',(raw,binary)=>{
    if(!binary){ws.close(1003,'Binary protocol required');cleanup();return;}
    if(!auth.touch(ws.session)){ws.close(4001,'Session expired');cleanup();return;}
    if(!tcp.remoteAddress){ws.close(1002,'Wait for desktop handshake');cleanup();return;}
    if(tcp.writableLength>1024*1024){ws.close(1008,'Too much input');cleanup();return;}
    tcp.write(raw);
  });
  ws.on('pong',()=>{ws.lastPong=Date.now();});   // proves the connection, not that you're there: doesn't keep the session unlocked
  ws.on('error',cleanup); ws.on('close',cleanup);
});
wss.on('connection', ws => {
  // The same browser reconnecting (phone woke up or switched networks): its old connection gives up control at once.
  if (controller && controller !== ws && controller.session === ws.session) { const old = controller; controller = null; old.terminate(); }
  ws.active = true; ws.inFlight = 0; ws.sentSeq = -1; ws.lastBeat = Date.now(); ws.budget = 0; ws.budgetStart = Date.now();
  controlState(); deliverFrame(ws);
  ws.on('error', () => {});
  ws.on('message', (raw, binary) => {
    if (binary) return ws.close(1003, 'Text commands only');
    if (!auth.touch(ws.session)) return ws.close(4001,'Session expired');
    if (Date.now() - ws.budgetStart > 1000) { ws.budget = 0; ws.budgetStart = Date.now(); }
    if (++ws.budget > 180) return ws.close(1008, 'Too many messages');
    let data; try { data = JSON.parse(raw.toString()); if (!data || typeof data !== 'object') return; } catch { return; }
    if (data.type === 'heartbeat') { ws.lastBeat = Date.now(); return send(ws,{type:'pong',time:data.time}); }
    if (data.type === 'hello') { ws.hello = true; ws.patches = data.patches === true; features(ws); return; }
    if (data.type === 'probe') {
      if (controller !== ws || !bridgeFocus || !Number.isFinite(data.x) || !Number.isFinite(data.y) || data.x < 0 || data.x > 1 || data.y < 0 || data.y > 1) return;
      const id = probeId++; pendingProbes.set(id, { ws, clientId: data.id, time: Date.now() });
      if (pendingProbes.size > 50) pendingProbes.delete(pendingProbes.keys().next().value);
      native({ op: 'probe', x: data.x, y: data.y, monitor: selectedMonitor, id }); return;
    }
    if (data.type === 'resync') { ws.sentSeq = -1; ws.inFlight = 0; deliverFrame(ws); return; }
    if (data.type === 'ack') { ws.inFlight = Math.max(0, (ws.inFlight || 0) - 1); ws.pendingSince = ws.inFlight ? Date.now() : 0; deliverFrame(ws); return; }
    if (data.type === 'active') { const was = ws.active; ws.active = !!data.active; ws.inFlight = 0; captureSoon = ws.active; if (ws.active && !was) ws.sentSeq = -1; if (!ws.active && controller === ws) release(); return; }
    if (data.type === 'take') {
      if (fullClient?.control) return send(ws,{type:'error',message:'Another device has full-desktop control. Return control there first.'});
      if (!ws.active || !bridgeReady || captureError || !frame || Date.now() - frameTime > 3000) return send(ws,{type:'error',message:'Wait for a live desktop image before taking control.'});
      // The same phone reconnecting (woke up, changed networks) takes over from its own older connection right away.
      if (controller && controller !== ws && controller.session.id === ws.session.id) { const old = controller; controller = null; old.terminate(); }
      if (controller && controller !== ws) return send(ws,{type:'error',message:'Another device has control. Return control there first.'});
      controller = ws; ws.lastBeat = Date.now(); return controlState();
    }
    if (data.type === 'release') { if (controller === ws) release(); return; }
    if (data.type === 'display') {
      if (controller !== ws || !meta?.monitors.some(x => x.id === data.monitor)) return;
      native({op:'release'}); selectedMonitor = data.monitor; frame = null;
      for (const other of wss.clients) other.inFlight = 0; captureSoon = true;
      return;
    }
    if (data.type === 'quality') {
      if (controller !== ws) return;
      quality = data.value === 'sharp' ? {width:1920,quality:80,interval:125} : data.value === 'lite' ? {width:960,quality:50,interval:166} : {width:1280,quality:65,interval:100}; return;
    }
    if (data.type === 'input') {
      if (controller !== ws || !ws.active || !bridgeReady || captureError || Date.now() - frameTime > 3000) return send(ws,{type:'error',message:'Take control while the desktop is live to interact.'});
      if (!validInput(data)) return send(ws,{type:'error',message:'Invalid input or display changed.'});
      const id = inputId++;
      pendingInput.set(id, { ws, clientId: data.id, time: Date.now() });
      native({ ...data, id });
      lastInput = Date.now(); captureSoon = true;
    }
  });
  ws.on('close', () => { if (controller === ws) release(); for (const [id,item] of pendingInput) if (item.ws === ws) pendingInput.delete(id); });
});
let lastCapture = 0;
const ticker = setInterval(() => {
  const now = Date.now();
  for (const [key,ticket] of fullTickets) if(ticket.expires<now)fullTickets.delete(key);
  for (const ws of fullWss.clients) {
    if(now-ws.lastPong>12000||ws.session.revoked){ws.terminate();continue;}
    if(!ws.lastPing||now-ws.lastPing>3000){ws.lastPing=now;ws.ping();}
  }
  if (controller && now - controller.lastBeat > 8000) release();
  for (const ws of wss.clients) {
    if (now - ws.lastBeat > 15000 || ws.session.revoked) { ws.terminate(); continue; }
    if (ws.inFlight > 0 && now - (ws.pendingSince || ws.frameSent || now) > 10000) ws.terminate();
  }
  for (const [id,item] of pendingInput) if (now - item.time > 5000) pendingInput.delete(id);
  if (captureBusy && now - captureStarted > 5000) { bridge.kill(); return; }
  // Back-to-back captures right after input; normal pace while watching; slower when nothing changes.
  const interval = captureError ? 1000 : (captureSoon || now - lastInput < BURST_MS) ? 0
    : now - Math.max(lastChange, lastInput) > IDLE_AFTER_MS ? Math.max(quality.interval, IDLE_INTERVAL) : quality.interval;
  if (!bridgeReady || captureBusy || now - lastCapture < interval) return;
  const ahead = process.env.DP_CAPTURE_AHEAD === '1' && now - lastInput < BURST_MS;
  if (![...wss.clients].some(ws => ws.active && (ahead || (ws.inFlight || 0) < MAX_IN_FLIGHT) && ws.readyState === WebSocket.OPEN)) return;
  const patches = bridgePatches && !forceFull && [...wss.clients].some(ws => ws.patches && ws.active); forceFull = false;
  captureSoon = false; captureBusy = true; captureStarted = lastCapture = now; native({ op:'capture', monitor:selectedMonitor, ...quality, patches });
},8);
server.listen(port, '127.0.0.1', () => {
  fs.mkdirSync(path.join(root,'run'),{recursive:true}); fs.writeFileSync(path.join(root,'run','server.pid'), String(process.pid));
  stopWatcher = fs.watch(path.join(root,'run'), () => { if (fs.existsSync(path.join(root,'run','stop.flag'))) shutdown(); });
  console.log(`Desktop Pocket listening on http://127.0.0.1:${port} (private proxy: ${publicOrigin})`);
  if (screenAvailable) startBridge(); else captureError = 'Screen sharing runs on Windows PCs. Use the Terminal and Files tabs here.';
});
server.on('error', error => { console.error(error.message); process.exit(1); });
function shutdown() {
  if (stopping) return; stopping = true; stopWatcher?.close();
  clearInterval(ticker); release(); for (const ws of wss.clients) ws.terminate();
  for (const ws of fullWss.clients) ws.terminate(); fullTickets.clear();
  bridge?.stdin.end(); server.close(); setTimeout(() => { bridge?.kill(); process.exit(0); },1500).unref();
}
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
