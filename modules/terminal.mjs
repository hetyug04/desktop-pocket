// Terminal tab: a real shell on any computer in the tailnet that runs Desktop Pocket.
//
//   browser ──/term?device=<id>──▶ this machine ──(device is me)──▶ local shell (node-pty)
//                                               └─(another machine)─▶ wss://<peer>:8443/agent/term ──▶ its shell
//
// One persistent shell per machine. It survives the phone going to sleep or the page reloading: reattaching
// replays recent output. Several screens can watch and type into the same shell, like a shared tmux session.
//
// Wire format (WebSocket text frames, JSON):
//   client → shell   {t:'i', d:'ls\r'}   input          {t:'r', c:120, r:40}  resize     {t:'restart'}  new shell
//   shell  → client  {t:'hello', name, os, shell}    {t:'o', d:'...'} output    {t:'x', code} shell exited    {t:'err', m}
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const SCROLLBACK = 256 * 1024, IDLE_KILL_MS = 12 * 3600 * 1000;

function pickShell() {
  if (process.env.DP_SHELL) return { file: process.env.DP_SHELL, args: [] };
  if (process.platform === 'win32') {
    const dirs = (process.env.PATH || '').split(';');
    const pwsh = dirs.map(d => path.join(d, 'pwsh.exe')).find(f => { try { return fs.existsSync(f); } catch { return false; } });
    return pwsh ? { file: pwsh, args: ['-NoLogo'] } : { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
}

export default async function register(api) {
  let pty = null, ptyError = '';
  try { const m = await import('node-pty'); pty = m.default || m; } catch (e) { ptyError = 'The terminal component (node-pty) is not installed on ' + api.hostname + '.'; api.log('terminal: node-pty unavailable', e?.message); }

  api.tab({ id: 'terminal', title: 'Terminal', script: '/tabs/terminal.js', style: '/tabs/terminal.css', order: 20 });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
  let shell = null;   // { proc, buffer, clients:Set, cols, rows, info, idleTimer }

  function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of shell?.clients || []) if (ws.readyState === WebSocket.OPEN) ws.send(s); }
  function startShell(cols, rows) {
    const { file, args } = pickShell();
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const k of Object.keys(env)) if (k.startsWith('DESKTOP_') || k.startsWith('DP_')) delete env[k];
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env });
    const s = { proc, buffer: '', clients: shell?.clients || new Set(), cols, rows, info: { name: api.hostname, os: api.platform, shell: path.basename(file) } };
    shell = s;
    proc.onData(d => {
      if (shell !== s) return;
      s.buffer += d; if (s.buffer.length > SCROLLBACK) s.buffer = s.buffer.slice(-SCROLLBACK);
      broadcast({ t: 'o', d });
    });
    proc.onExit(({ exitCode }) => { if (shell !== s) return; broadcast({ t: 'x', code: exitCode }); shell = { ...s, proc: null }; });
    api.log('terminal: started', file);
    return s;
  }
  function attach(ws, cols, rows) {
    if (!pty) { ws.send(JSON.stringify({ t: 'err', m: ptyError })); ws.close(1011, 'no pty'); return; }
    if (!shell?.proc) startShell(cols, rows);
    clearTimeout(shell.idleTimer);
    shell.clients.add(ws);
    ws.send(JSON.stringify({ t: 'hello', ...shell.info, ping: true }));
    if (shell.buffer) ws.send(JSON.stringify({ t: 'o', d: shell.buffer, replay: true }));
    resize(cols, rows);
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'i' && typeof m.d === 'string' && shell?.proc) shell.proc.write(m.d);
      else if (m.t === 'r') resize(m.c, m.r);
      else if (m.t === 'p') { if (ws.readyState === WebSocket.OPEN) ws.send('{"t":"P"}'); }   // the phone checking the line after waking up
      else if (m.t === 'restart') { try { shell?.proc?.kill(); } catch {} const c = shell?.clients || new Set(); shell = { clients: c }; startShell(m.c || 100, m.r || 30); broadcast({ t: 'hello', ...shell.info, restarted: true }); }
    });
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000);
    ws.on('close', () => {
      clearInterval(ping); shell?.clients.delete(ws);
      if (shell && !shell.clients.size) shell.idleTimer = setTimeout(() => { try { shell?.proc?.kill(); } catch {} shell = null; }, IDLE_KILL_MS);
    });
    ws.on('error', () => {});
  }
  function resize(c, r) {
    c = Math.max(20, Math.min(400, Number(c) || 0)); r = Math.max(5, Math.min(200, Number(r) || 0));
    if (!shell?.proc || !c || !r || (c === shell.cols && r === shell.rows)) return;
    shell.cols = c; shell.rows = r; try { shell.proc.resize(c, r); } catch {}
  }
  const size = url => [Number(url.searchParams.get('cols')) || 100, Number(url.searchParams.get('rows')) || 30];

  // Another Desktop Pocket asking for this machine's shell.
  api.upgrade('/agent/term', (req, socket, head, ctx) => {
    wss.handleUpgrade(req, socket, head, ws => attach(ws, ...size(ctx.url)));
  }, { auth: 'agent' });

  // A session that ends (signed out, or locked after 15 minutes away) closes its terminals right away.
  const browserSockets = new Map();
  api.onSessionEnd?.(session => { for (const [ws, s] of browserSockets) if (s === session) ws.close(4001, 'Signed out'); });

  // The browser: local shell, or relay to the chosen machine.
  api.upgrade('/term', async (req, socket, head, ctx) => {
    const id = ctx.url.searchParams.get('device') || '';
    let device = null;
    try { device = id ? await api.findDevice(id) : null; } catch {}
    wss.handleUpgrade(req, socket, head, ws => {
      browserSockets.set(ws, ctx.session); ws.on('close', () => browserSockets.delete(ws));
      if (!device || device.self) return attach(ws, ...size(ctx.url));
      if (!device.online) { ws.send(JSON.stringify({ t: 'err', m: `${device.name} is offline. Trying again…`, retry: true })); return ws.close(1000); }
      if (!device.agent) { ws.send(JSON.stringify({ t: 'err', m: `${device.name} doesn’t have Desktop Pocket set up yet.` })); return ws.close(1000); }
      const [c, r] = size(ctx.url), p = `/agent/term?cols=${c}&rows=${r}`;
      const upstream = new WebSocket(api.peerSocketUrl(device.dns, p), { headers: api.agentHeaders('GET', '/agent/term', device.dns), perMessageDeflate: false, handshakeTimeout: 8000 });
      const pending = [];
      upstream.on('open', () => { for (const m of pending.splice(0)) upstream.send(m); });
      upstream.on('message', (data, binary) => { if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary }); });
      upstream.on('close', () => { if (ws.readyState === WebSocket.OPEN) ws.close(1000); });
      upstream.on('error', e => {
        api.log('terminal: relay to', device.dns, 'failed:', e.message);
        if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ t: 'err', m: `Couldn’t reach ${device.name}. Trying again…`, retry: true })); ws.close(1011); }
      });
      ws.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); else if (pending.length < 100) pending.push(data); });
      ws.on('close', () => { try { upstream.close(); } catch {} });
      ws.on('error', () => {});
    });
  });
}
