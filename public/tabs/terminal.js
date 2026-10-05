// Terminal tab: the same full-screen terminal for every computer on your tailnet.
import { Terminal } from '/vendor/xterm/xterm.js';
import { FitAddon } from '/vendor/xterm/addon-fit.js';

const ICON = {
  windows: '<path d="M4 6.5 12 5.4v7.4H4zM13.2 5.2 24 3.8v9H13.2zM4 14.1h8v7.5l-8-1.1zM13.2 14.1H24V23l-10.8-1.5z"/>',
  mac: '<path d="M18.6 14.9c0-2.4 2-3.6 2.1-3.6a4.6 4.6 0 0 0-3.6-1.9c-1.5-.2-3 .9-3.7.9-.8 0-2-.9-3.2-.8a4.8 4.8 0 0 0-4 2.4c-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8s1.9.8 3.2.8 2.1-1.2 2.9-2.4a10 10 0 0 0 1.3-2.7 4.2 4.2 0 0 1-2.3-4.1ZM16.2 7.8A4.3 4.3 0 0 0 17.2 4.6a4.4 4.4 0 0 0-2.9 1.5 4.1 4.1 0 0 0-1 3 3.6 3.6 0 0 0 2.9-1.3Z"/>',
  linux: '<circle cx="14" cy="14" r="9"/>',
};
const isTouch = matchMedia('(pointer: coarse)').matches;
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} };

export function mount(el, app) {
  el.classList.add('term-pane');
  el.innerHTML = `
    <header class="term-head">
      <button class="term-device" type="button" aria-haspopup="dialog">
        <span class="term-dot" aria-hidden="true"></span><span class="term-name">Choose a computer</span>
        <svg class="term-chev" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>
      </button>
      <button class="term-more" type="button" aria-label="Terminal options"><svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="7.5" cy="14" r="1.8"/><circle cx="14" cy="14" r="1.8"/><circle cx="20.5" cy="14" r="1.8"/></svg></button>
    </header>
    <div class="term-body"><div class="term-host"></div><div class="term-note" hidden></div></div>
    <div class="term-keys" role="toolbar" aria-label="Terminal keys" ${isTouch ? '' : 'hidden'}>
      <button data-k="esc">esc</button><button data-k="tab">tab</button><button data-mod="ctrl" aria-pressed="false">ctrl</button>
      <button data-k="up" aria-label="Up">↑</button><button data-k="down" aria-label="Down">↓</button><button data-k="left" aria-label="Left">←</button><button data-k="right" aria-label="Right">→</button>
      <button data-k="|">|</button><button data-k="~">~</button><button data-k="/">/</button><button data-k="-">-</button>
      <button data-k="paste">paste</button>
    </div>
    <div class="term-sheet-back" hidden></div>
    <div class="term-sheet" role="dialog" aria-label="Choose a computer" hidden><h2>Open a terminal on</h2><ul class="term-list"></ul></div>
    <div class="term-menu" hidden>
      <button data-act="restart">Restart shell</button><button data-act="bigger">Bigger text</button><button data-act="smaller">Smaller text</button>
    </div>`;
  const $ = s => el.querySelector(s);
  const host = $('.term-host'), note = $('.term-note');

  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, Consolas, "Cascadia Mono", monospace',
    fontSize: Number(pref('dp-term-font')) || (isTouch ? 12 : 14), lineHeight: 1.1, cursorBlink: true, scrollback: 5000,
    allowProposedApi: false, macOptionIsMeta: true, convertEol: false,
    theme: { background: '#000000', foreground: '#e9e9ec', cursor: '#60cdff', cursorAccent: '#000000', selectionBackground: 'rgba(96,205,255,.32)',
      black: '#1c1c1f', brightBlack: '#6b6b73', blue: '#5fa8ff', brightBlue: '#8cc4ff', cyan: '#60cdff', brightCyan: '#9be1ff' },
  });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(host);

  let device = null, ws = null, retry = 0, retryTimer = 0, visible = false, ctrl = false, lastSize = '';
  let lastRx = 0, canPing = false, hiddenAt = 0;
  function setNote(text) { note.textContent = text || ''; note.hidden = !text; }
  function setDot(state) { $('.term-dot').dataset.state = state; }
  function send(obj) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function refit() {
    if (!visible) return;
    try { fit.fit(); } catch { return; }
    const s = `${term.cols}x${term.rows}`; if (s !== lastSize) { lastSize = s; send({ t: 'r', c: term.cols, r: term.rows }); }
  }

  function connect() {
    clearTimeout(retryTimer); if (!device || !visible) return;
    try { ws?.close(); } catch {}
    setDot('connecting');
    const u = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/term?device=${encodeURIComponent(device.id)}&token=${encodeURIComponent(app.csrf())}&cols=${term.cols}&rows=${term.rows}`;
    const sock = new WebSocket(u); ws = sock; let got = false;
    sock.onmessage = ev => {
      if (ws !== sock) return; lastRx = Date.now(); let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'P') return;
      if (m.t === 'hello') { got = true; retry = 0; canPing = !!m.ping; setDot('live'); setNote(''); if (m.restarted) term.reset(); lastSize = ''; refit(); }
      else if (m.t === 'o') { if (m.replay) term.reset(); term.write(m.d); }
      else if (m.t === 'x') { term.write('\r\n\x1b[2m[shell exited — tap ⋯ → Restart shell]\x1b[0m\r\n'); setDot('idle'); }
      else if (m.t === 'err') { setNote(m.m); setDot(m.retry ? 'connecting' : 'off'); got = m.retry ? 'retry' : 'error'; if (m.retry) retry = Math.max(retry, 3); }
    };
    sock.onclose = ev => {
      if (ws !== sock) return; ws = null;
      if (ev.code === 4001) { setDot('off'); setNote('Locked. Unlock to keep going.'); app.api('/api/auth/ping'); return; }   // the app shows the unlock screen
      if (got === 'error' || !visible) return;
      setDot('connecting'); retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(connect, [0, 500, 1000, 2000, 4000, 8000, 10000][retry]);
      if (retry > 2) setNote(`Reconnecting to ${device.name}…`);
    };
  }
  term.onData(d => {
    if (ctrl && d.length === 1) { const c = d.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64); setCtrl(false); }
    send({ t: 'i', d });
  });

  // ---------- devices ----------
  function label(d) { return d.self ? `${d.name} (this one)` : d.name; }
  function choose(d) {
    device = d; pref('dp-term-device', d.id);
    $('.term-name').textContent = label(d); $('.term-device').dataset.os = d.os;
    term.reset(); setNote(''); closeSheet(); connect();
  }
  async function loadDevices() {
    const list = (await app.devices()).filter(d => ['windows', 'mac', 'linux'].includes(d.os));
    const saved = pref('dp-term-device');
    return { list, initial: list.find(d => d.id === saved && d.agent && d.online) || list.find(d => d.self) };
  }
  async function openSheet() {
    $('.term-sheet').hidden = false; $('.term-sheet-back').hidden = false;
    const ul = $('.term-list'); ul.innerHTML = '<li class="term-loading">Looking for your computers…</li>';
    try {
      const { list } = await loadDevices();
      ul.replaceChildren(...list.map(d => {
        const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
        const ready = d.self || (d.online && d.agent);
        b.disabled = !ready; b.dataset.current = String(device?.id === d.id);
        b.innerHTML = `<svg viewBox="0 0 28 28" aria-hidden="true">${ICON[d.os] || ICON.linux}</svg><span><strong></strong><small></small></span>`;
        b.querySelector('strong').textContent = label(d);
        b.querySelector('small').textContent = ready ? (d.os === 'mac' ? 'Mac' : d.os === 'windows' ? 'Windows' : 'Linux') : !d.online ? 'Offline' : 'Desktop Pocket isn’t set up here yet';
        b.onclick = () => choose(d); li.append(b); return li;
      }));
    } catch (e) { ul.innerHTML = ''; const li = document.createElement('li'); li.className = 'term-loading'; li.textContent = e.message; ul.append(li); }
  }
  function closeSheet() { $('.term-sheet').hidden = true; $('.term-sheet-back').hidden = true; }
  $('.term-device').onclick = openSheet; $('.term-sheet-back').onclick = closeSheet;

  // ---------- options ----------
  $('.term-more').onclick = () => { $('.term-menu').hidden = !$('.term-menu').hidden; };
  $('.term-menu').onclick = e => {
    const act = e.target.closest('button')?.dataset.act; $('.term-menu').hidden = true; if (!act) return;
    if (act === 'restart') { term.reset(); send({ t: 'restart', c: term.cols, r: term.rows }); }
    else { const f = Math.max(9, Math.min(22, term.options.fontSize + (act === 'bigger' ? 1 : -1))); term.options.fontSize = f; pref('dp-term-font', String(f)); refit(); }
    term.focus();
  };

  // ---------- touch key row ----------
  const KEYS = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
  function setCtrl(on) { ctrl = on; $('[data-mod="ctrl"]').setAttribute('aria-pressed', String(on)); }
  for (const b of el.querySelectorAll('.term-keys button')) {
    b.addEventListener('pointerdown', e => e.preventDefault());   // keep the iPhone keyboard up
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', async () => {
      if (b.dataset.mod) { setCtrl(!ctrl); return; }
      const k = b.dataset.k;
      if (k === 'paste') { try { const t = await navigator.clipboard.readText(); if (t) send({ t: 'i', d: t }); } catch { app.toast('Allow paste to use your phone’s clipboard.'); } return; }
      send({ t: 'i', d: KEYS[k] ?? k }); setCtrl(false);
    });
  }

  // ---------- sizing (including the iPhone keyboard) ----------
  const vv = window.visualViewport;
  function placeForKeyboard() {
    if (!visible || !vv) return;
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.classList.toggle('kbd-open', covered > 80);
    el.style.bottom = covered > 80 ? `${covered}px` : '';
    refit();
  }
  vv?.addEventListener('resize', placeForKeyboard); vv?.addEventListener('scroll', placeForKeyboard);
  new ResizeObserver(() => refit()).observe(host);
  // Coming back to the app: iOS may have quietly killed the connection while the phone slept.
  // Check the line with a ping and reconnect at once if nothing answers (the shell and its scrollback survive).
  function checkLine(patience = 1800) {
    if (!visible || !device) return;
    if (!ws || ws.readyState > 1) { retry = 0; connect(); return; }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!canPing) { if (hiddenAt && Date.now() - hiddenAt > 20000) { retry = 0; connect(); } return; }
    const since = Date.now(); send({ t: 'p' });
    setTimeout(() => { if (visible && ws?.readyState === WebSocket.OPEN && lastRx < since) { retry = 0; connect(); } }, patience);
  }
  // While you're looking at it, check the line every 10 s too, so a connection that died silently is replaced quickly.
  setInterval(() => { if (visible && !document.hidden && canPing && ws?.readyState === WebSocket.OPEN && Date.now() - lastRx > 8000) checkLine(3500); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else { checkLine(); hiddenAt = 0; } });

  app.onShow(async () => {
    visible = true; requestAnimationFrame(() => { refit(); placeForKeyboard(); });
    if (!device) { try { const { initial } = await loadDevices(); if (initial) choose(initial); else openSheet(); } catch (e) { setNote(e.message); } }
    else checkLine();
    if (!isTouch) term.focus();
  });
  app.onHide(() => { visible = false; document.documentElement.classList.remove('kbd-open'); el.style.bottom = ''; });
}
