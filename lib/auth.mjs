// Passkey sign-in for every app on the tailnet (Face ID, Touch ID, Windows Hello, security keys).
//
//  * One passkey works on every machine: the WebAuthn RP ID is the tailnet's domain (tailXXXX.ts.net, a
//    registrable domain because ts.net is on the public suffix list).
//  * Passwords never sign anyone in. The first passkey is added with a one-time setup code printed on a
//    computer (security-setup), and lost-phone recovery uses one-time recovery codes printed the same way.
//  * Every machine running Desktop Pocket keeps the same passkey list: changes are pushed to the others and
//    pulled every few minutes over signed machine-to-machine calls (lib/hub.mjs).
//  * A session locks after 15 minutes without the app open, and after 12 hours regardless. Sensitive changes
//    (adding or removing a passkey, adding a computer, signing out everywhere) need Face ID again.
//
// The store lives next to the shared password file: ~/.opencode-remote/passkeys.json (user-only access).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {enrollmentUrl,qrImage} from './phone-qr.mjs';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from './vendor/simplewebauthn.mjs';   // bundled: no npm install needed

export const IDLE_LOCK_MS = Number(process.env.DP_IDLE_LOCK_MS || 15 * 60 * 1000);
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
const FRESH_MS = 5 * 60 * 1000;            // "you just used Face ID" window for sensitive changes
const FLOW_MS = 5 * 60 * 1000;             // a passkey prompt must finish within this
const SETUP_CODE_MS = 15 * 60 * 1000;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no 0/O, 1/I/L

const KNOWN_AUTHENTICATORS = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
};

const b64u = buf => Buffer.from(buf).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(s).digest('base64url');
export function makeCode(groups = 2, size = 4) {
  const out = [];
  for (let g = 0; g < groups; g++) { let s = ''; for (let i = 0; i < size; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]; out.push(s); }
  return out.join('-');
}
const normCode = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
export function hashCode(code, salt = crypto.randomBytes(16).toString('base64url')) {
  return { salt, hash: crypto.scryptSync(normCode(code), salt, 32).toString('base64url') };
}
function codeMatches(code, entry) {
  if (!entry?.salt || !entry?.hash) return false;
  const a = crypto.scryptSync(normCode(code), entry.salt, 32), b = Buffer.from(entry.hash, 'base64url');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- the store (shared with lib/auth-cli.mjs) ----------
export function storePath(passwordFile) {
  return process.env.DP_AUTH_FILE || path.join(path.dirname(passwordFile), 'passkeys.json');
}
export function readStore(file) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  s.v = 1; s.credentials ||= []; s.recovery ||= { rev: 0, codes: [] }; s.epoch ||= 0;
  s.user ||= { id: b64u(crypto.randomBytes(32)), name: process.env.DP_USER_NAME || os.userInfo().username };
  return s;
}
export function writeStore(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}
/** Merge two copies of the synced part. Removals win; counters and last-used take the newest; recovery codes
 *  come from the newest set, and a code used anywhere is used everywhere. */
export function mergeStores(a, b) {
  const out = { ...a };
  const byId = new Map(a.credentials.map(c => [c.id, { ...c }]));
  for (const c of b.credentials || []) {
    const mine = byId.get(c.id);
    if (!mine) { byId.set(c.id, { ...c }); continue; }
    const removed = [mine.removed, c.removed].filter(Boolean);
    if (removed.length) mine.removed = Math.min(...removed);
    mine.counter = Math.max(mine.counter || 0, c.counter || 0);
    mine.lastUsed = Math.max(mine.lastUsed || 0, c.lastUsed || 0);
    if (c.renamed > (mine.renamed || 0)) { mine.name = c.name; mine.renamed = c.renamed; }
  }
  out.credentials = [...byId.values()];
  const ra = a.recovery || { rev: 0, codes: [] }, rb = b.recovery || { rev: 0, codes: [] };
  if ((rb.rev || 0) > (ra.rev || 0)) out.recovery = rb;
  else if ((rb.rev || 0) === (ra.rev || 0) && rb.id === ra.id) out.recovery = { ...ra, codes: ra.codes.map((c, i) => ({ ...c, used: c.used || rb.codes?.[i]?.used || undefined })) };
  else out.recovery = ra;
  out.epoch = Math.max(a.epoch || 0, b.epoch || 0);
  if (b.user?.created && (!a.user?.created || b.user.created < a.user.created)) out.user = b.user;   // the oldest user id wins
  return out;
}
const syncedPart = s => ({ credentials: s.credentials, recovery: s.recovery, epoch: s.epoch, user: s.user });

/** RP ID for an origin: the tailnet domain for *.ts.net names, otherwise the host itself. */
export function rpIdFor(origin) {
  if (process.env.DP_RP_ID) return process.env.DP_RP_ID;
  const host = new URL(origin).hostname;
  const parts = host.split('.');
  return host.endsWith('.ts.net') && parts.length >= 3 ? parts.slice(-3).join('.') : host;
}

export function createAuth(o) {
  const { passwordFile, publicOrigin, origins, json, readJson, log, root } = o;
  const file = storePath(passwordFile);
  const rpID = rpIdFor(publicOrigin);
  const secureCookie = publicOrigin.startsWith('https:');
  const cookieName = secureCookie ? '__Host-pocket' : 'pocket';
  const sessions = new Map();          // sha256(token) -> session
  const flows = new Map();             // flow id -> { challenge, kind, expires, sessionKey }
  const installTokens = new Map();     // sha256(token) -> { expires, uses }
  const limits = new Map();            // bucket -> [timestamps]
  const revokeHooks = [];
  const securityLog = path.join(root, 'run', 'security.log');
  let syncPeers = null;                // set by attachSync()

  const load = () => {
    const s = readStore(file);
    if (!s.user.created) { s.user.created = Date.now(); writeStore(file, s); }
    return s;
  };
  const save = (s, { push = true } = {}) => { s.updated = Date.now(); writeStore(file, s); if (push) setTimeout(() => syncNow().catch(() => {}), 10); };
  const active = s => s.credentials.filter(c => !c.removed);

  function audit(req, event, detail = {}) {
    const line = { t: new Date().toISOString(), event, who: req?.headers?.['tailscale-user-login'] || undefined,
      from: String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim() || undefined,
      device: deviceName(req?.headers?.['user-agent']), ...detail };
    try { fs.mkdirSync(path.dirname(securityLog), { recursive: true }); fs.appendFileSync(securityLog, JSON.stringify(line) + '\n'); } catch {}
    log?.('security:', event, JSON.stringify(detail));
  }
  function limited(bucket, max, windowMs) {
    const now = Date.now(), recent = (limits.get(bucket) || []).filter(t => now - t < windowMs);
    limits.set(bucket, recent); return recent.length >= max;
  }
  function hit(bucket) { const r = limits.get(bucket) || []; r.push(Date.now()); limits.set(bucket, r); }

  // ---------- sessions ----------
  function cookieOf(req) {
    const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='));
    return c ? c.slice(cookieName.length + 1) : '';
  }
  function revoke(key, why = 'signed out') {
    const s = sessions.get(key); if (!s) return;
    sessions.delete(key);
    for (const f of revokeHooks) { try { f(s, why); } catch {} }
  }
  let epochSeen = 0;
  function sessionFor(req, { allowSetup = false, touch = true } = {}) {
    const tok = cookieOf(req); if (!tok || tok.length > 100) return null;
    const key = sha256(tok), s = sessions.get(key); if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeen > IDLE_LOCK_MS) { revoke(key, 'locked'); return null; }
    if (now - s.uvAt > MAX_SESSION_MS && !s.setupOnly) { revoke(key, 'expired'); return null; }
    if (s.setupOnly && now - s.created > FLOW_MS * 2) { revoke(key, 'expired'); return null; }
    if (s.created < epochSeen) { revoke(key, 'signed out everywhere'); return null; }
    if (s.setupOnly && !allowSetup) return null;
    if (touch) s.lastSeen = now;
    return s;
  }
  /** For open connections: true if the session is still good (and marks it active); otherwise ends it. */
  function touch(s) {
    if (!s || s.revoked) return false;
    const now = Date.now();
    if (now - s.lastSeen > IDLE_LOCK_MS || (!s.setupOnly && now - s.uvAt > MAX_SESSION_MS) || s.created < epochSeen) { revoke(s.key, 'locked'); return false; }
    s.lastSeen = now; return true;
  }
  function newSession(req, res, { setupOnly = false, credentialId = '' } = {}) {
    const old = cookieOf(req); if (old) revoke(sha256(old), 'replaced');
    if (sessions.size >= 64) revoke([...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0][0], 'too many sessions');
    const tok = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    const s = { id: crypto.randomBytes(12).toString('base64url'), csrf: crypto.randomBytes(32).toString('base64url'), created: now, lastSeen: now, uvAt: setupOnly ? 0 : now, setupOnly, credentialId,
      device: deviceName(req.headers['user-agent']), expires: now + MAX_SESSION_MS };
    s.key = sha256(tok); sessions.set(s.key, s);
    res.setHeader('Set-Cookie', `${cookieName}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_SESSION_MS / 1000}${secureCookie ? '; Secure' : ''}`);
    return s;
  }
  function clearCookie(res) { res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`); }
  function signOut(req, res) { const t = cookieOf(req); if (t) revoke(sha256(t), 'signed out'); clearCookie(res); }
  // Sweep idle sessions so their open connections close too.
  setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (now - s.lastSeen > IDLE_LOCK_MS || (!s.setupOnly && now - s.uvAt > MAX_SESSION_MS) || s.created < epochSeen) revoke(k, 'locked');
    for (const [k, f] of flows) if (f.expires < now) flows.delete(k);
    for (const [k, t] of installTokens) if (t.expires < now) installTokens.delete(k);
  }, 30000).unref();

  // ---------- helpers ----------
  const userAgentOs = ua => /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  function deviceName(ua = '') { return userAgentOs(String(ua)); }
  function credentialName(aaguid, req) {
    const provider = KNOWN_AUTHENTICATORS[aaguid];
    const dev = deviceName(req.headers['user-agent']);
    return provider ? `${provider} (${dev})` : `Passkey (${dev})`;
  }
  function flowStart(kind, challenge, extra = {}) {
    const id = crypto.randomBytes(18).toString('base64url');
    if (flows.size > 200) flows.delete(flows.keys().next().value);
    flows.set(id, { kind, challenge, expires: Date.now() + FLOW_MS, ...extra }); return id;
  }
  function flowTake(id, kind) {
    const f = flows.get(id); flows.delete(id);
    return f && f.kind === kind && f.expires > Date.now() ? f : null;
  }
  const expectedOrigins = [...origins];
  async function registrationOptions(s, store) {
    return generateRegistrationOptions({
      rpName: 'Your tailnet', rpID, userName: store.user.name || 'Owner', userDisplayName: `${store.user.name || 'Owner'} (${rpID})`,
      userID: Buffer.from(store.user.id, 'base64url'), attestationType: 'none', timeout: 120000,
      excludeCredentials: active(store).map(c => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
    });
  }
  async function authenticationOptions(store, credentialIds) {
    return generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: 120000,
      allowCredentials: credentialIds ? active(store).filter(c => credentialIds.includes(c.id)).map(c => ({ id: c.id, transports: c.transports })) : [] });
  }
  async function checkAssertion(store, response, challenge) {
    const cred = active(store).find(c => c.id === response?.id);
    if (!cred) return { ok: false, why: 'This passkey isn’t on the list. Use another one, or a recovery code.' };
    const v = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: expectedOrigins, expectedRPID: rpID,
      credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, 'base64url'), counter: cred.counter || 0, transports: cred.transports }, requireUserVerification: true });
    if (!v.verified || !v.authenticationInfo.userVerified) return { ok: false, why: 'Face ID / Windows Hello didn’t confirm it was you.' };
    const n = v.authenticationInfo.newCounter;
    if (cred.counter && n && n <= cred.counter) return { ok: false, why: 'This passkey looks cloned. It was refused.', clone: true, cred };
    cred.counter = Math.max(cred.counter || 0, n || 0); cred.lastUsed = Date.now();
    return { ok: true, cred };
  }
  const publicCred = c => ({ id: c.id, name: c.name, created: c.created, lastUsed: c.lastUsed || null, backedUp: !!c.backedUp });
  const isFresh = s => Date.now() - s.uvAt < FRESH_MS;

  // ---------- HTTP ----------
  /** Handles /api/auth/*. Returns true when the request was handled. Same-origin is enforced for POSTs by the caller. */
  async function handle(req, res, url) {
    const p = url.pathname; if (!p.startsWith('/api/auth/')) return false;
    const reply = (status, data) => { json(res, status, data); return true; };
    const who = req.headers['tailscale-user-login'] || req.socket.remoteAddress;
    const store = load();
    const ready = active(store).length > 0;
    const body = req.method === 'POST' ? await readJson(req).catch(() => ({})) : {};
    const s = sessionFor(req, { allowSetup: true });
    const needCsrf = () => !s || req.headers['x-csrf-token'] !== s.csrf;

    if (req.method === 'GET' && p === '/api/auth/state') {
      return reply(200, { ready, rpID, signedIn: !!s && !s.setupOnly, setupOnly: !!s?.setupOnly, recoveryLeft: store.recovery.codes.filter(c => !c.used).length,
        lockMinutes: Math.round(IDLE_LOCK_MS / 60000), setupCodeActive: !!(store.enroll && store.enroll.expires > Date.now()) });
    }
    if (req.method === 'GET' && p === '/api/auth/ping') return reply(s && !s.setupOnly ? 200 : 401, { ok: !!s });

    // Sign in with a passkey (discoverable: no username, the phone offers the right passkey).
    if (req.method === 'POST' && p === '/api/auth/login/options') {
      if (!ready) return reply(409, { error: 'No passkeys yet. Run security-setup on your PC to add the first one.' });
      if (limited('login:' + who, 30, 600000)) return reply(429, { error: 'Too many tries. Wait ten minutes.' });
      const options = await authenticationOptions(store);
      return reply(200, { flow: flowStart('login', options.challenge), options });
    }
    if (req.method === 'POST' && p === '/api/auth/login/verify') {
      const f = flowTake(String(body.flow || ''), 'login'); if (!f) return reply(400, { error: 'That took too long. Try again.' });
      let r; try { r = await checkAssertion(store, body.response, f.challenge); } catch (e) { r = { ok: false, why: 'That passkey didn’t check out.' }; }
      if (!r.ok) { hit('login:' + who); audit(req, 'sign-in refused', { reason: r.why, credential: body.response?.id?.slice(0, 12) }); return reply(401, { error: r.why }); }
      save(store);
      newSession(req, res, { credentialId: r.cred.id });
      audit(req, 'signed in', { passkey: r.cred.name });
      return reply(200, { ok: true });
    }

    // First passkey on a device: one-time setup code from security-setup on a computer.
    if (req.method === 'POST' && p === '/api/auth/setup/options') {
      if (limited('setup', 6, 15 * 60000)) return reply(429, { error: 'Too many wrong codes. Run security-setup on your PC for a new one.' });
      const fresh = readStore(file);
      if (!fresh.enroll || fresh.enroll.expires < Date.now() || !codeMatches(body.code, fresh.enroll)) {
        hit('setup'); audit(req, 'setup code refused');
        if (limited('setup', 6, 15 * 60000) && fresh.enroll) { delete fresh.enroll; writeStore(file, fresh); }
        return reply(401, { error: fresh.enroll && fresh.enroll.expires > Date.now() ? 'That code isn’t right.' : 'That code has expired or was never made. Run security-setup on your PC.' });
      }
      fresh.enroll.uses = (fresh.enroll.uses || 0) + 1;
      if (fresh.enroll.uses >= 5) delete fresh.enroll;
      writeStore(file, fresh);
      const options = await registrationOptions(null, fresh);
      return reply(200, { flow: flowStart('register', options.challenge, { via: 'setup code' }), options });
    }
    // Recovery code: lets you add a new passkey (nothing else) after losing your devices.
    if (req.method === 'POST' && p === '/api/auth/recover') {
      if (limited('recover', 5, 15 * 60000)) return reply(429, { error: 'Too many wrong codes. Wait fifteen minutes.' });
      const fresh = readStore(file), idx = fresh.recovery.codes.findIndex(c => !c.used && codeMatches(body.code, c));
      if (idx < 0) { hit('recover'); audit(req, 'recovery code refused'); return reply(401, { error: 'That recovery code isn’t right or was already used.' }); }
      fresh.recovery.codes[idx].used = Date.now(); save(fresh);
      const rs = newSession(req, res, { setupOnly: true });
      audit(req, 'recovery code used', { left: fresh.recovery.codes.filter(c => !c.used).length });
      return reply(200, { ok: true, csrf: rs.csrf, left: fresh.recovery.codes.filter(c => !c.used).length });
    }
    // Add a passkey: after a recovery code, or signed in and just verified with Face ID.
    if (req.method === 'POST' && p === '/api/auth/register/options') {
      if (!s || needCsrf()) return reply(401, { error: 'Sign in first.' });
      if (!s.setupOnly && !isFresh(s)) return reply(403, { error: 'Confirm it’s you first.', stepUp: true });
      const options = await registrationOptions(s, store);
      return reply(200, { flow: flowStart('register', options.challenge, { sessionId: s.id, via: s.setupOnly ? 'recovery code' : 'signed in' }), options });
    }
    if (req.method === 'POST' && p === '/api/auth/register/verify') {
      const f = flowTake(String(body.flow || ''), 'register'); if (!f) return reply(400, { error: 'That took too long. Try again.' });
      if (f.sessionId && (!s || s.id !== f.sessionId)) return reply(401, { error: 'Sign in first.' });
      let v; try {
        v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: f.challenge, expectedOrigin: expectedOrigins, expectedRPID: rpID, requireUserVerification: true });
      } catch (e) { v = { verified: false, error: e.message }; }
      if (!v.verified) { audit(req, 'passkey refused', { error: v.error }); return reply(400, { error: 'The passkey couldn’t be added. Try again.' }); }
      const info = v.registrationInfo, fresh = readStore(file);
      if (fresh.credentials.some(c => c.id === info.credential.id)) return reply(409, { error: 'That passkey is already set up.' });
      const cred = { id: info.credential.id, publicKey: b64u(info.credential.publicKey), counter: info.credential.counter || 0,
        transports: info.credential.transports || [], aaguid: info.aaguid, backedUp: !!info.credentialBackedUp,
        name: String(body.name || '').trim().slice(0, 60) || credentialName(info.aaguid, req), created: Date.now(), lastUsed: Date.now(), addedVia: f.via };
      fresh.credentials.push(cred); save(fresh);
      if (!s || s.setupOnly) newSession(req, res, { credentialId: cred.id });   // signed-in devices keep their session
      audit(req, 'passkey added', { passkey: cred.name, via: f.via });
      return reply(200, { ok: true, passkey: publicCred(cred) });
    }

    // Everything below needs a full, signed-in session.
    if (!s || s.setupOnly) return reply(401, { error: 'Sign in to continue.' });
    if (req.method !== 'GET' && needCsrf()) return reply(403, { error: 'Token rejected' });

    // Step-up: Face ID again for a sensitive change.
    if (req.method === 'POST' && p === '/api/auth/verify/options') {
      const options = await authenticationOptions(store);
      return reply(200, { flow: flowStart('verify', options.challenge, { sessionId: s.id }), options });
    }
    if (req.method === 'POST' && p === '/api/auth/verify/verify') {
      const f = flowTake(String(body.flow || ''), 'verify'); if (!f || f.sessionId !== s.id) return reply(400, { error: 'That took too long. Try again.' });
      let r; try { r = await checkAssertion(store, body.response, f.challenge); } catch { r = { ok: false, why: 'That passkey didn’t check out.' }; }
      if (!r.ok) { audit(req, 'confirm refused', { reason: r.why }); return reply(401, { error: r.why }); }
      save(store); s.uvAt = Date.now(); return reply(200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/auth/passkeys') {
      return reply(200, { passkeys: active(store).sort((a, b) => a.created - b.created).map(c => ({ ...publicCred(c), current: c.id === s.credentialId })),
        recoveryLeft: store.recovery.codes.filter(c => !c.used).length, recoveryTotal: store.recovery.codes.length, fresh: isFresh(s), lockMinutes: Math.round(IDLE_LOCK_MS / 60000) });
    }
    if (req.method === 'POST' && p === '/api/auth/passkeys/remove') {
      if (!isFresh(s)) return reply(403, { error: 'Confirm it’s you first.', stepUp: true });
      const fresh2 = readStore(file), c = active(fresh2).find(x => x.id === body.id);
      if (!c) return reply(404, { error: 'Not found.' });
      if (active(fresh2).length <= 1) return reply(409, { error: 'This is your only passkey. Add another one first.' });
      c.removed = Date.now(); save(fresh2);
      for (const [k, x] of sessions) if (x.credentialId === c.id) revoke(k, 'passkey removed');
      audit(req, 'passkey removed', { passkey: c.name });
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auth/passkeys/rename') {
      const fresh2 = readStore(file), c = active(fresh2).find(x => x.id === body.id);
      if (!c) return reply(404, { error: 'Not found.' });
      c.name = String(body.name || '').trim().slice(0, 60) || c.name; c.renamed = Date.now(); save(fresh2);
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auth/signout-everywhere') {
      if (!isFresh(s)) return reply(403, { error: 'Confirm it’s you first.', stepUp: true });
      const fresh2 = readStore(file); fresh2.epoch = Date.now(); save(fresh2); epochSeen = fresh2.epoch;
      for (const k of [...sessions.keys()]) revoke(k, 'signed out everywhere');
      clearCookie(res); audit(req, 'signed out everywhere');
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auth/setup-link') {
      if (!isFresh(s)) return reply(403, { error: 'Confirm it’s you first.', stepUp: true });
      const code = makeCode(2, 4), expires = Date.now() + SETUP_CODE_MS;
      const url = enrollmentUrl(publicOrigin, code, expires), image = await qrImage(url);
      const fresh2 = readStore(file);
      fresh2.enroll = { ...hashCode(code), expires, uses: 0, created: Date.now() }; save(fresh2);
      audit(req, 'phone setup QR made');
      return reply(200, { url, image, expires });
    }
    if (req.method === 'POST' && p === '/api/auth/install-token') {
      if (!isFresh(s)) return reply(403, { error: 'Confirm it’s you first.', stepUp: true });
      const tok = makeCode(4, 5);
      installTokens.set(sha256(normCode(tok)), { expires: Date.now() + SETUP_CODE_MS, uses: 0 });
      audit(req, 'computer setup link made');
      return reply(200, { token: tok, minutes: SETUP_CODE_MS / 60000 });
    }
    if (req.method === 'GET' && p === '/api/auth/activity') {
      let lines = [];
      try { lines = fs.readFileSync(securityLog, 'utf8').trim().split('\n').slice(-40).reverse().map(l => JSON.parse(l)); } catch {}
      return reply(200, { events: lines.filter(e => /signed in|refused|recovery|added|removed|everywhere|setup/.test(e.event)).slice(0, 15).map(e => ({ t: e.t, event: e.event, device: e.device, passkey: e.passkey })) });
    }
    return reply(404, { error: 'Not found' });
  }

  /** One-time tokens for the Mac installer (made in the app with Face ID; good for 15 minutes, three downloads). */
  function useInstallToken(token) {
    const k = sha256(normCode(token)), t = installTokens.get(k);
    if (!t || t.expires < Date.now() || t.uses >= 3) return false;
    t.uses++; return true;
  }

  // ---------- keeping every machine's passkey list the same ----------
  function mergeIncoming(remote) {
    const local = load(), merged = mergeStores(local, { credentials: [], recovery: { rev: 0, codes: [] }, ...remote });
    const changed = JSON.stringify(syncedPart(merged)) !== JSON.stringify(syncedPart(local));
    if (changed) { writeStore(file, { ...local, ...syncedPart(merged), updated: Date.now() }); }
    if ((merged.epoch || 0) > epochSeen) { epochSeen = merged.epoch; for (const [k, x] of sessions) if (x.created < epochSeen) revoke(k, 'signed out everywhere'); }
    return merged;
  }
  let syncing = null;
  async function syncNow() {
    if (!syncPeers) return; if (syncing) return syncing;
    syncing = (async () => {
      const peers = await syncPeers.list().catch(() => []);
      for (const dns of peers) {
        try {
          const r = await syncPeers.call(dns, '/api/agent/auth/sync', JSON.stringify(syncedPart(load())));
          if (!r.ok) continue;
          const text = await r.text();
          if (!syncPeers.replyOk(r, r.agentNonce, text)) { log?.('security: passkey sync reply without a valid signature from', dns); continue; }
          mergeIncoming(JSON.parse(text));
        } catch {}
      }
    })().finally(() => { syncing = null; });
    return syncing;
  }
  /** hub: the hub API (callPeer, peers, verifyAgent). */
  function attachSync(hub) {
    syncPeers = {
      list: async () => (await hub.peers()).filter(p => !p.self && p.online && p.agent).map(p => p.dns),
      call: (dns, p, body) => hub.callPeer(dns, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeout: 8000 }),
      replyOk: hub.replyOk,
    };
    hub.route('POST', '/api/agent/auth/sync', async (req, res, ctx) => {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 512 * 1024) return ctx.json(413, { error: 'Too large' }); }
      if (!hub.agentBodyOk(req, body)) { audit(req, 'passkey sync refused: body not signed'); return ctx.json(401, { error: 'Body does not match its signature.' }); }
      const out = JSON.stringify(syncedPart(mergeIncoming(JSON.parse(body))));
      res.writeHead(200, { 'Content-Type': 'application/json', ...hub.replyHeaders(req, out) }); res.end(out);
    }, { auth: 'agent' });
    setTimeout(() => syncNow().catch(() => {}), 3000).unref();
    setInterval(() => syncNow().catch(() => {}), 120000).unref();
  }
  epochSeen = load().epoch || 0;
  let lastMtime = 0;
  fs.watchFile(file, { interval: 2000 }, st => {
    if (!st.mtimeMs || st.mtimeMs === lastMtime) return; lastMtime = st.mtimeMs;
    const s = readStore(file);
    if ((s.epoch || 0) > epochSeen) { epochSeen = s.epoch; for (const [k, x] of sessions) if (x.created < epochSeen) revoke(k, 'signed out everywhere'); }
    syncNow().catch(() => {});
  });

  return {
    handle, sessionFor, touch, signOut, revoke, onRevoke: f => revokeHooks.push(f), useInstallToken, attachSync, syncNow,
    rpID, cookieName, file, ready: () => active(load()).length > 0, sessions, audit,
  };
}
