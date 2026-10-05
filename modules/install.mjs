// One-line setup for another computer, served by a computer that already runs Desktop Pocket.
// Passwords are off, so the command carries a one-time code made in the app (⋯ → Security → Add a computer,
// confirmed with Face ID). The code is good for 15 minutes and three downloads (script, app, machine key).
//
//   Mac:  curl -fsS "https://<this-pc>.<tailnet>.ts.net:8443/install/mac?t=<code>" | bash
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const PACKAGE = ['server.mjs', 'lib', 'modules', 'public', 'package.json', 'package-lock.json', 'docs'];

export default function register(api) {
  const tries = new Map();
  const auth = (req, res, url) => {
    const who = req.headers['tailscale-user-login'] || req.socket.remoteAddress, now = Date.now();
    const recent = (tries.get(who) || []).filter(t => now - t < 600000);
    if (recent.length >= 10) { res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Too many tries. Wait ten minutes.\n'); return false; }
    if (api.useInstallToken(url.searchParams.get('t') || '')) return true;
    recent.push(now); tries.set(who, recent);
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('This setup link has expired or was already used.\nMake a new one in Desktop Pocket: ⋯ → Security → Add a computer.\n');
    return false;
  };

  api.route('GET', '/install/mac', (req, res, ctx) => {
    if (!auth(req, res, ctx.url)) return;
    const origin = `https://${req.headers.host}`, token = ctx.url.searchParams.get('t');
    const filesHost = String(req.headers.host).split(':')[0].split('.')[0];
    const script = fs.readFileSync(path.join(api.root, 'docs', 'install-mac.sh'), 'utf8')
      .replaceAll('__SOURCE__', origin).replaceAll('__TOKEN__', token).replaceAll('__FILES_HOST__', filesHost);
    api.audit?.(req, 'computer setup started', { os: 'mac' });
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' }); res.end(script);
  }, { auth: 'none' });

  api.route('GET', '/install/package.tgz', (req, res, ctx) => {
    if (!auth(req, res, ctx.url)) return;
    const items = PACKAGE.filter(p => fs.existsSync(path.join(api.root, p)));
    const tar = spawn(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', '-', ...items], { cwd: api.root, windowsHide: true });
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="desktop-pocket.tgz"' });
    tar.stdout.pipe(res);
    tar.on('error', e => { api.log('install: tar failed', e.message); res.destroy(); });
    tar.on('close', code => { if (code) { api.log('install: tar exited', code); res.destroy(); } });
    req.on('close', () => tar.kill());
  }, { auth: 'none' });

  // The machine-to-machine key, so the new computer can talk to this one (and share the passkey list).
  api.route('GET', '/install/key', (req, res, ctx) => {
    if (!auth(req, res, ctx.url)) return;
    const file = process.env.DESKTOP_PASSWORD_FILE || path.join(os.homedir(), '.opencode-remote', 'password.txt');
    api.audit?.(req, 'machine key handed to a new computer');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(fs.readFileSync(file, 'utf8').trim());
  }, { auth: 'none' });
}
