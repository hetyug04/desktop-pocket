// Passkey gate for other web apps on this computer (OpenCode first).
//
// Tailscale Serve sends https://<this-machine>.<tailnet>.ts.net (port 443) here, to 127.0.0.1:4095. Every request
// needs the same signed-in session as Desktop Pocket (the session cookie is shared across ports on the same
// machine name). Without one, a page visit goes to Desktop Pocket's sign-in and comes straight back after Face ID.
// The app behind the gate keeps its own password, which only this gate knows; nobody types it any more.
//
// Settings (optional) in DP_GATES, a JSON list: [{ "name", "listen", "target", "user", "passwordFile" }]
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT = [{ name: 'OpenCode', listen: 4095, target: 'http://127.0.0.1:4096', user: 'opencode' }];

export default function register(api) {
  if (process.env.DP_GATES === 'off') return;
  const gates = process.env.DP_GATES ? JSON.parse(process.env.DP_GATES) : DEFAULT;
  const passwordFile = process.env.DESKTOP_PASSWORD_FILE || path.join(os.homedir(), '.opencode-remote', 'password.txt');
  const machineHost = new URL(api.publicOrigin).hostname;            // machine.tailXXXX.ts.net
  const open = new Map();                                            // socket -> session (closed when the session ends)
  api.onSessionEnd?.(session => { for (const [sock, s] of open) if (s === session) sock.destroy(); });

  for (const g of gates) {
    const target = new URL(g.target);
    const allowedOrigins = new Set([`https://${machineHost}`, `http://127.0.0.1:${g.listen}`, `http://localhost:${g.listen}`]);
    const allowedHosts = new Set([machineHost, `${machineHost}:443`, `127.0.0.1:${g.listen}`, `localhost:${g.listen}`, ...(g.hosts || [])]);
    const secret = () => {
      const pw = fs.readFileSync(g.passwordFile || passwordFile, 'utf8').trim();
      return 'Basic ' + Buffer.from(`${g.user || 'opencode'}:${pw}`).toString('base64');
    };
    // Who's asking, and are they signed in? Returns [status, message] when refused.
    function check(req, isUpgrade = false) {
      if (!allowedHosts.has(req.headers.host)) return [421, 'Unknown host'];
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none' && !(req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate')) return [403, 'Cross-site request refused'];
      // Anything that changes something must come from the app's own page (browsers always send Origin for these).
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isUpgrade) {
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedOrigins.has(origin)) return [403, 'Cross-site request refused'];
        if (origin === undefined && !isUpgrade && site !== 'same-origin') return [403, 'Request refused (no origin)'];
      }
      const session = api.sessionFor(req);
      if (!session) return [401, 'Sign in with your passkey'];
      return [0, '', session];
    }
    function forwardHeaders(req) {
      const h = { ...req.headers };
      // Never pass our session cookie (or any credentials from the browser) to the app behind the gate.
      if (h.cookie) { const kept = h.cookie.split(';').map(x => x.trim()).filter(x => x && !/^(__Host-)?pocket=/.test(x)); if (kept.length) h.cookie = kept.join('; '); else delete h.cookie; }
      delete h.authorization; delete h['proxy-authorization'];
      h.authorization = secret();
      h['x-forwarded-proto'] = 'https'; h['x-forwarded-host'] = req.headers.host;
      h.host = target.host;
      return h;
    }
    const server = http.createServer((req, res) => {
      const [status, message, session] = check(req);
      if (status) {
        api.audit?.(req, status === 401 ? 'gate: sign-in needed' : 'gate: request refused', { app: g.name, path: String(req.url).split('?')[0].slice(0, 80) });
        const wantsPage = req.method === 'GET' && (req.headers['sec-fetch-mode'] === 'navigate' || /text\/html/.test(req.headers.accept || ''));
        if (status === 401 && wantsPage) {
          const back = `https://${machineHost}${req.url}`;
          res.writeHead(302, { Location: `${api.publicOrigin}/?next=${encodeURIComponent(back)}`, 'Cache-Control': 'no-store' }); return res.end();
        }
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(message + '\n');
      }
      const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req) }, upRes => {
        const headers = { ...upRes.headers };
        delete headers['www-authenticate'];   // the browser never sees the app's own password prompt
        headers['x-frame-options'] ||= 'SAMEORIGIN'; headers['referrer-policy'] ||= 'no-referrer'; headers['x-content-type-options'] ||= 'nosniff';
        if (api.publicOrigin.startsWith('https:')) headers['strict-transport-security'] = 'max-age=31536000';
        res.writeHead(upRes.statusCode, headers); upRes.pipe(res);
      });
      open.set(req.socket, session); req.socket.once('close', () => open.delete(req.socket));
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`${g.name} isn’t running on this computer.\n`); } else res.destroy(); });
      req.pipe(up);
    });
    server.on('upgrade', (req, socket, head) => {
      const [status] = check(req, true);
      if (status) { socket.end(`HTTP/1.1 ${status} Refused\r\n\r\n`); return; }
      const session = api.sessionFor(req);
      const up = net.connect(Number(target.port), target.hostname, () => {
        const h = forwardHeaders(req);
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
        if (head?.length) up.write(head);
        up.pipe(socket); socket.pipe(up);
      });
      open.set(socket, session);
      const done = () => { open.delete(socket); socket.destroy(); up.destroy(); };
      up.on('error', done); socket.on('error', done); socket.on('close', done); up.on('close', done);
    });
    server.requestTimeout = 0; server.headersTimeout = 20000;   // the app streams events for a long time
    let tries = 0;   // right after a restart the old process may still hold the port for a moment
    server.on('error', e => {
      if (e.code === 'EADDRINUSE' && ++tries <= 15) { setTimeout(() => server.listen(g.listen, '127.0.0.1'), 1000); return; }
      api.log(`gate: ${g.name} couldn't listen on ${g.listen}:`, e.message);
    });
    server.on('listening', () => api.log(`gate: ${g.name} behind passkeys on 127.0.0.1:${g.listen} -> ${g.target}`));
    server.listen(g.listen, '127.0.0.1');
  }
  api.route('GET', '/api/gates', (req, res, ctx) => ctx.json(200, { gates: gates.map(g => ({ name: g.name, listen: g.listen })) }));
}
