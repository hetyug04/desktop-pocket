// Desktop Pocket hub: the parts every machine runs (Windows and Mac alike).
//  * Tab modules: modules/*.mjs register HTTP routes and WebSocket upgrades through a small API.
//  * Machine-to-machine calls: every Desktop Pocket on the tailnet shares the same secret file, so one
//    machine can call another's /api/agent/* routes with an HMAC derived from it. People sign in with passkeys (lib/auth.mjs).
//  * Device list from `tailscale status --json`, with a check for which peers run Desktop Pocket.
//  * Static files for tabs (public/tabs/*) and vendored browser libraries (/vendor/*).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const AGENT_HEADER = 'x-pocket-agent';
const VERSION = 3;   // 3: signatures cover the target machine and the body; signed replies

export function createHub(o) {
  const { root, password, sessionFor, json, publicOrigin, hosts, origins, auth } = o;
  const agentKey = crypto.scryptSync(password, 'desktop-pocket-agent-v1', 32);
  const pwSalt = crypto.randomBytes(16), pwHash = crypto.scryptSync(password, pwSalt, 32);
  const basicAttempts = new Map();
  /** HTTP Basic auth used to accept the shared password. Passwords are off now (passkeys only), so this always
   *  refuses; use api.useInstallToken() for one-time links instead. Kept so older modules still load. */
  function checkBasic(req) {
    if (auth) { if (req.headers.authorization) log('security: password (Basic) sign-in refused; passwords are off'); return false; }
    const who = req.headers['tailscale-user-login'] || req.socket.remoteAddress, now = Date.now();
    const recent = (basicAttempts.get(who) || []).filter(t => now - t < 600000);
    if (recent.length >= 10) return 'locked';
    const m = /^Basic (.+)$/.exec(req.headers.authorization || ''); let ok = false;
    if (m) {
      const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':'), pw = rest.join(':');
      ok = user === 'het' && pw.length <= 256 && crypto.timingSafeEqual(crypto.scryptSync(pw, pwSalt, 32), pwHash);
    }
    if (!ok && m) { recent.push(now); basicAttempts.set(who, recent); }
    return ok;
  }
  const peerPort = Number(process.env.DP_PEER_PORT || 8443);
  const routes = [], upgrades = [], tabs = [];
  const seenNonces = new Map();
  const log = (...a) => console.log(new Date().toISOString(), ...a);

  // ---------- machine-to-machine authentication ----------
  // A signature covers the time, a one-time nonce, the method and path, the machine it is addressed to (so it can't
  // be replayed to another machine) and a hash of the body (or "stream" for streamed uploads, which can't be
  // replayed elsewhere either). Replies that carry data back (passkey sync) are signed too, and a machine only counts
  // as Desktop Pocket if its ping reply proves it holds the key.
  const BODY_HEADER = 'x-pocket-body';
  const sha = b => crypto.createHash('sha256').update(b).digest('base64url');
  const hmac = s => crypto.createHmac('sha256', agentKey).update(s).digest();
  function bodyTag(body) { return body === undefined || body === null || body === '' ? 'none' : (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) ? sha(body) : 'stream'; }
  function sign(method, pathname, host, tag = 'none') {
    const ts = Date.now().toString(), nonce = crypto.randomBytes(12).toString('base64url');
    const mac = hmac(`v2.${ts}.${nonce}.${method}.${pathname}.${String(host).toLowerCase()}.${tag}`).toString('base64url');
    return { value: `${ts}.${nonce}.${mac}`, nonce };
  }
  function verifyAgent(req, url) {
    const value = req.headers[AGENT_HEADER]; if (typeof value !== 'string') return false;
    const [ts, nonce, mac] = value.split('.'); if (!ts || !nonce || !mac) return false;
    if (Math.abs(Date.now() - Number(ts)) > 60000 || seenNonces.has(nonce)) return false;
    const tag = String(req.headers[BODY_HEADER] || 'none');
    const expected = hmac(`v2.${ts}.${nonce}.${req.method}.${url.pathname}.${String(req.headers.host || '').toLowerCase()}.${tag}`);
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    seenNonces.set(nonce, Date.now());
    if (seenNonces.size > 5000) for (const [k, t] of seenNonces) if (Date.now() - t > 120000) seenNonces.delete(k);
    req.agentNonce = nonce; req.agentBodyTag = tag;
    return true;
  }
  /** For routes that read a small body: true if it is exactly the body that was signed. */
  function agentBodyOk(req, body) { return req.agentBodyTag === bodyTag(body); }
  /** Sign a reply so the caller knows it came from a machine holding the key, for this very request. */
  function replyHeaders(req, body) { return { 'x-pocket-reply': hmac(`reply.${req.agentNonce}.${bodyTag(body)}`).toString('base64url') }; }
  function replyOk(res, nonce, body) {
    const given = Buffer.from(String(res.headers.get('x-pocket-reply') || ''), 'base64url'), want = hmac(`reply.${nonce}.${bodyTag(body)}`);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  // ---------- tailnet devices ----------
  const tailscaleBin = process.env.DP_TAILSCALE || (process.platform === 'win32'
    ? (fs.existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale.exe')
    : process.platform === 'darwin' && fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale');
  function tailscale(args, { timeout = 15000 } = {}) {
    return new Promise(resolve => execFile(tailscaleBin, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || error?.message || '') })));
  }
  let statusCache = { at: 0, value: null };
  async function status() {
    if (process.env.DP_TAILSCALE_STATUS_FILE) return JSON.parse(fs.readFileSync(process.env.DP_TAILSCALE_STATUS_FILE, 'utf8'));
    if (Date.now() - statusCache.at < 5000 && statusCache.value) return statusCache.value;
    const r = await tailscale(['status', '--json']);
    if (r.code !== 0) throw Error('Tailscale is not running on this machine.');
    statusCache = { at: Date.now(), value: JSON.parse(r.stdout) }; return statusCache.value;
  }
  const peerUrls = process.env.DP_PEER_URLS ? JSON.parse(process.env.DP_PEER_URLS) : {};   // tests: dns -> base URL
  function peerBase(dns) { return peerUrls[dns] || `https://${dns}:${peerPort}`; }
  const agentCache = new Map();
  async function probeAgent(dns) {
    const hit = agentCache.get(dns); if (hit && Date.now() - hit.at < 20000) return hit.value;
    let value = null;
    try {
      const r = await callPeer(dns, '/api/agent/ping', { timeout: 2500 });
      if (r.ok) { const text = await r.text(); if (replyOk(r, r.agentNonce, text)) value = JSON.parse(text); else log('security: a machine answered as Desktop Pocket without the key:', dns); }
    } catch {}
    agentCache.set(dns, { at: Date.now(), value }); return value;
  }
  function short(dns) { return String(dns || '').replace(/\.$/, '').split('.')[0]; }
  function osLabel(s) { const v = String(s || '').toLowerCase(); return v === 'windows' ? 'windows' : v === 'macos' || v === 'darwin' ? 'mac' : v === 'ios' ? 'iphone' : v === 'android' ? 'android' : v === 'linux' ? 'linux' : v || 'other'; }
  async function peers() {
    const s = await status(), self = s.Self || {}, list = [];
    const selfDns = String(self.DNSName || '').replace(/\.$/, '');
    list.push({ id: short(selfDns) || os.hostname().toLowerCase(), name: self.HostName || os.hostname(), dns: selfDns, os: osLabel(process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform), online: true, self: true, agent: true });
    const others = Object.values(s.Peer || {}).filter(p => p.DNSName);
    const probes = await Promise.all(others.map(p => {
      const dns = String(p.DNSName).replace(/\.$/, ''), computer = ['windows', 'mac', 'linux'].includes(osLabel(p.OS));
      return p.Online && computer ? probeAgent(dns) : Promise.resolve(null);
    }));
    others.forEach((p, i) => {
      const dns = String(p.DNSName).replace(/\.$/, '');
      list.push({ id: short(dns), name: p.HostName || short(dns), dns, os: osLabel(p.OS), online: !!p.Online, self: false, agent: !!probes[i], agentInfo: probes[i] || undefined });
    });
    return list;
  }
  async function findDevice(id) { return (await peers()).find(d => d.id === id) || null; }
  async function callPeer(dns, pathname, { method = 'GET', headers = {}, body, timeout = 15000 } = {}) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const base = peerBase(dns), tag = bodyTag(body), sig = sign(method, pathname.split('?')[0], new URL(base).host, tag);
      const r = await fetch(base + pathname, { method, body, signal: ctrl.signal, duplex: body ? 'half' : undefined,
        headers: { ...headers, [AGENT_HEADER]: sig.value, [BODY_HEADER]: tag } });
      r.agentNonce = sig.nonce; return r;
    } finally { clearTimeout(timer); }
  }
  function peerSocketUrl(dns, pathname) { return peerBase(dns).replace(/^http/, 'ws') + pathname; }
  function agentHeaders(method, pathname, dns) { return { [AGENT_HEADER]: sign(method, pathname.split('?')[0], new URL(peerBase(dns)).host).value, [BODY_HEADER]: 'none' }; }

  // ---------- module API ----------
  const api = {
    /** route('GET'|'POST'|..., '/api/x' or '/api/x/' prefix ending with '*', handler(req, res, ctx), { auth: 'session'|'agent'|'either' }) */
    route(method, pattern, handler, opts = {}) { routes.push({ method, pattern, handler, auth: opts.auth || 'session' }); },
    /** upgrade('/x-socket', handler(req, socket, head, ctx), { auth }) — session auth needs ?token=<csrf> */
    upgrade(pattern, handler, opts = {}) { upgrades.push({ pattern, handler, auth: opts.auth || 'session' }); },
    /** tab({ id, title, script: '/tabs/x.js', style?: '/tabs/x.css', order }) shown in the app's tab bar */
    tab(t) { tabs.push(t); tabs.sort((a, b) => (a.order ?? 50) - (b.order ?? 50)); },
    peers, findDevice, callPeer, peerSocketUrl, agentHeaders, verifyAgent, agentBodyOk, replyHeaders, replyOk, checkBasic, tailscale, status, log, publicOrigin,
    /** onSessionEnd(fn(session, why)): a signed-in session ended (signed out, locked after time away, passkey removed). Close what it had open. */
    onSessionEnd: f => auth?.onRevoke(f), sessionFor, useInstallToken: t => !!auth?.useInstallToken(t), audit: (...a) => auth?.audit(...a),
    json, readJson: o.readJson, root,
    dataDir(name) { const d = path.join(root, 'run', name); fs.mkdirSync(d, { recursive: true }); return d; },
    platform: process.platform, hostname: os.hostname(),
  };

  function match(pattern, pathname) { return pattern.endsWith('*') ? pathname.startsWith(pattern.slice(0, -1)) : pattern === pathname; }
  function sameOrigin(req) {
    const expected = req.headers.host === new URL(publicOrigin).host ? publicOrigin : `http://${req.headers.host}`;
    return req.headers.origin === expected;
  }

  // ---------- static: tab scripts and vendored libraries ----------
  const vendor = {
    '/vendor/xterm/xterm.js': ['@xterm/xterm/lib/xterm.mjs', 'text/javascript'],
    '/vendor/xterm/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css'],
    '/vendor/xterm/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript'],
    '/vendor/xterm/addon-web-links.js': ['@xterm/addon-web-links/lib/addon-web-links.mjs', 'text/javascript'],
  };
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
  function serveFile(res, file, type) { res.setHeader('Content-Type', type + (type.startsWith('text/') ? '; charset=utf-8' : '')); res.end(fs.readFileSync(file)); return true; }

  async function handleRequest(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && vendor[p]) {
      const file = path.join(root, 'node_modules', vendor[p][0]);
      return fs.existsSync(file) ? serveFile(res, file, vendor[p][1]) : (json(res, 404, { error: 'Not installed' }), true);
    }
    if (req.method === 'GET' && /^\/tabs\/[a-z0-9-]+\.(js|css|svg|png|json)$/.test(p)) {
      const file = path.join(root, 'public', p);
      return fs.existsSync(file) ? serveFile(res, file, types[path.extname(p)]) : (json(res, 404, { error: 'Not found' }), true);
    }
    if (req.method === 'GET' && p === '/api/agent/ping') {
      if (!verifyAgent(req, url)) return json(res, 401, { error: 'Agent authentication failed.' }), true;
      const body = JSON.stringify({ app: 'desktop-pocket', version: VERSION, name: os.hostname(), os: process.platform, tabs: tabs.map(t => t.id) });
      res.writeHead(200, { 'Content-Type': 'application/json', ...replyHeaders(req, body) }); res.end(body); return true;
    }
    if (req.method === 'GET' && p === '/api/devices') {
      const session = sessionFor(req); if (!session) return json(res, 401, { error: 'Sign in to continue.' }), true;
      try { return json(res, 200, { devices: await peers() }), true; } catch (e) { return json(res, 503, { error: e.message }), true; }
    }
    if (req.method === 'GET' && p === '/api/tabs') {
      const session = sessionFor(req); if (!session) return json(res, 401, { error: 'Sign in to continue.' }), true;
      return json(res, 200, { tabs }), true;
    }
    const r = routes.find(x => x.method === req.method && match(x.pattern, p));
    if (!r) return false;
    const ctx = { url, session: null, agent: false, json: (s, d, h) => json(res, s, d, h) };
    if (r.auth === 'none') { try { await r.handler(req, res, ctx); } catch (e) { log('module route failed', p, e?.message); if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' }); } return true; }
    const agentOk = (r.auth === 'agent' || r.auth === 'either') && verifyAgent(req, url);
    if (agentOk) ctx.agent = true;
    else {
      if (r.auth === 'agent') return json(res, 401, { error: 'Agent authentication failed.' }), true;
      ctx.session = sessionFor(req);
      if (!ctx.session) return json(res, 401, { error: 'Sign in to continue.' }), true;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Origin rejected' }), true;
        if (req.headers['x-csrf-token'] !== ctx.session.csrf) return json(res, 403, { error: 'Token rejected' }), true;
      }
    }
    try { await r.handler(req, res, ctx); }
    catch (e) { log('module route failed', p, e?.message); if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the PC.' }); else res.destroy(); }
    return true;
  }

  function handleUpgrade(req, socket, head, url) {
    const u = upgrades.find(x => match(x.pattern, url.pathname));
    if (!u) return false;
    const deny = code => { socket.end(`HTTP/1.1 ${code}\r\n\r\n`); return true; };
    if (!hosts.has(req.headers.host)) return deny('403 Forbidden');
    const ctx = { url, session: null, agent: false };
    if ((u.auth === 'agent' || u.auth === 'either') && verifyAgent(req, url)) ctx.agent = true;
    else {
      if (u.auth === 'agent') return deny('401 Unauthorized');
      const origin = req.headers.origin;
      if (!origins.has(origin) || new URL(origin).host !== req.headers.host) return deny('403 Forbidden');
      if (o.gateCheck?.(req)) return deny('403 Forbidden');
      ctx.session = sessionFor(req);
      if (!ctx.session || url.searchParams.get('token') !== ctx.session.csrf) return deny('401 Unauthorized');
    }
    try { u.handler(req, socket, head, ctx); } catch (e) { log('module upgrade failed', url.pathname, e?.message); socket.destroy(); }
    return true;
  }

  async function loadModules() {
    const dir = path.join(root, 'modules'); if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) {
      try { const m = await import(pathToFileURL(path.join(dir, name)).href); await m.default(api); log('module loaded', name); }
      catch (e) { log('module failed to load', name, e?.stack || e); }
    }
  }
  return { handleRequest, handleUpgrade, loadModules, api, tabs: () => tabs };
}
