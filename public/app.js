// Desktop Pocket: your PC as a touchscreen on your iPhone.
// Everyday use streams through /stream (fast). Protected Windows screens (UAC prompts, the lock screen)
// automatically switch to the full-desktop service (/full-stream, noVNC) and switch back afterwards.
// Server protocol: /api/auth/* (passkeys), /api/session, /api/logout, /api/full/connect and the /stream WebSocket
// (control, error, input-result, pong, focus, probe, same; binary frames [u32 metaLength][meta JSON][JPEG]).
'use strict';

const $ = id => document.getElementById(id);
let scannedSetup = window.DesktopPocketLink.consume(location, history);
const screen = $('screen'), stage = $('stage'), ctx2d = screen.getContext('2d', { alpha: false });
const app = $('app');

// ---------- state ----------
let socket = null, csrf = '', signedIn = false;
let controlling = false, occupied = false, wantControl = true, takePending = 0;
let screenAvailable = true, fullDesktop = false, features = {}, pcEditable = false, probeSeq = 1, autoKeyboard = false, disconnected = false;
let qualityValue = 'balanced';
let meta = null, lastFrame = 0, frameGeneration = 0;
let zoom = 1, panX = 0, panY = 0, fitScale = 1;
let cursor = { x: .5, y: .5 }, cursorTouchedAt = 0;
let reconnectTimer = 0, reconnectDelay = 1000, inputSeq = 1;
// lastRx: anything at all from the PC (pongs every 2 s). failures: reconnects in a row that didn't get a picture.
let lastRx = 0, failures = 0, resyncSent = 0, staleSince = 0;
let frames = 0, bytes = 0, meterStart = performance.now(), latency = 0, fps = 0, kbps = 0;
let statusFadeTimer = 0, toastTimer = 0;

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch {} }

// ---------- small UI helpers ----------
function toast(message, ms = 2600) {
  const el = $('toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function setStatus(state, text) {
  const el = $('status'); el.dataset.state = state; $('status-text').textContent = text;
  el.classList.remove('faded'); clearTimeout(statusFadeTimer);
  if (state === 'live') statusFadeTimer = setTimeout(() => el.classList.add('faded'), 2200);
}
function notice(title, text, { spinner = false, action = '' } = {}) {
  $('notice').hidden = false; $('notice-title').textContent = title; $('notice-text').textContent = text;
  $('notice-spinner').hidden = !spinner;
  $('notice-action').hidden = !action; $('notice-action').textContent = action;
  if (action === 'Open full desktop') $('notice-action').dataset.full = '1'; else delete $('notice-action').dataset.full;
}
function hideNotice() { $('notice').hidden = true; }
function live() { return !!socket && socket.readyState === WebSocket.OPEN && lastFrame && Date.now() - lastFrame < 3000; }

function refreshStatus() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!lastFrame) return setStatus('connecting', 'Connecting');
  if (controlling) return setStatus('live', 'Live');
  if (occupied) return setStatus('busy', 'In use on another device');
  if (!wantControl) return setStatus('idle', 'Watching only');
  setStatus('connecting', 'Getting control');
}
function syncControls() {
  const can = controlling;
  for (const el of document.querySelectorAll('[data-quality], #display-list button')) el.disabled = !can;
  $('settings-hint').hidden = can || !live();
  $('control-switch').checked = wantControl;
  refreshStatus();
}

// ---------- sending ----------
function send(obj) { if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(obj)); return true; } return false; }
function input(op, data = {}) {
  if (!controlling || !live()) return false;
  return send({ type: 'input', op, id: inputSeq++, monitor: meta?.monitor, ...data });
}
function requestControl() {
  if (!wantControl || controlling || occupied || secure.rfb || !live() || document.hidden || currentTab !== 'screen') return;
  if (Date.now() - takePending < 1500) return;
  takePending = Date.now(); send({ type: 'take' });
}
function releaseControl() { cancelGesture(); send({ type: 'release' }); }

// ---------- view transform ----------
function stageRect() { return stage.getBoundingClientRect(); }
// iPhone edges are unreliable for taps (home indicator, notch, Safari's own bars), so the picture is kept
// a little away from them, and controls get their own strip instead of covering the PC's tabs or taskbar.
const EDGE = 12, CONTROLS = 56, PAN_MARGIN = 64;
function safeInsets() {
  if (window.__safe) return window.__safe;
  const cs = getComputedStyle($('safe-probe'));
  return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
}
function availableBox(r) {
  const s = safeInsets(), landscape = r.width > r.height && r.height < 560;
  // Portrait: keep the picture clear of the floating tab capsule (it sits in the letterbox, so this costs nothing).
  const bar = $('tabbar'), dock = !landscape && !bar.hidden && bar.offsetParent ? r.bottom - bar.getBoundingClientRect().top + 6 : 0;
  const top = s.t + (landscape ? EDGE : CONTROLS), bottom = r.height - Math.max(s.b + EDGE, dock);
  const left = s.l + EDGE, right = r.width - s.r - (landscape ? CONTROLS : EDGE);
  return { x: left, y: top, w: Math.max(50, right - left), h: Math.max(50, bottom - top) };
}
function layout() {
  if (!meta) return;
  const r = stageRect();
  const landscape = r.width > r.height, reserveB = 0;
  const A = availableBox(r);
  fitScale = Math.min(A.w / screen.width, A.h / screen.height);
  const scale = fitScale * zoom, w = screen.width * scale, h = screen.height * scale;
  // Zoomed in, you can drag any edge of the PC screen well clear of the phone's edges.
  const maxX = w > A.w + 1 ? (w - A.w) / 2 + PAN_MARGIN : 0, maxY = h > A.h + 1 ? (h - A.h) / 2 + PAN_MARGIN : 0;
  panX = clamp(panX, -maxX, maxX); panY = clamp(panY, -maxY, maxY);
  const left = A.x + A.w / 2 - w / 2 + panX, top = A.y + A.h / 2 - h / 2 + panY;
  screen.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  screen.dataset.left = left; screen.dataset.top = top; screen.dataset.scale = scale;
  $('fit').hidden = zoom < 1.02;
  setDockMini(currentTab === 'screen' && zoom > 1.02);
  const hint = $('rotate-hint');
  hint.style.top = `${top + h + 18}px`;
  hint.hidden = landscape || zoom > 1.02 || top + h + 60 > r.height - reserveB;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function screenBox() {
  const s = +screen.dataset.scale || 1;
  return { left: +screen.dataset.left || 0, top: +screen.dataset.top || 0, width: screen.width * s, height: screen.height * s };
}
function localPoint(e) { const r = stageRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function toRemote(p, allowOutside = false) {
  if (!meta) return null;
  const b = screenBox(), x = (p.x - b.left) / b.width, y = (p.y - b.top) / b.height;
  // A finger landing just outside the picture still counts as its edge (tabs, taskbar, scrollbars live there).
  const TOL = 28;
  if (!allowOutside && (p.x < b.left - TOL || p.x > b.left + b.width + TOL || p.y < b.top - TOL || p.y > b.top + b.height + TOL)) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}
function toLocal(n) { const b = screenBox(); return { x: b.left + n.x * b.width, y: b.top + n.y * b.height }; }
function setZoom(next, anchor) {
  const r = stageRect(); anchor ??= { x: r.width / 2, y: r.height / 2 };
  const before = toRemote(anchor, true); zoom = clamp(next, 1, 6); layout();
  if (before) { const after = toLocal(before); panX += anchor.x - after.x; panY += anchor.y - after.y; layout(); }
}
// ---------- touch feedback ----------
function ripple(p, kind = '') {
  const el = document.createElement('div'); el.className = 'ripple' + (kind ? ' ripple-' + kind : '');
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  $('touch-layer').append(el); setTimeout(() => el.remove(), 420);
}
let holdEl = null;
function showHold(p) {
  hideHold();
  holdEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  holdEl.setAttribute('viewBox', '0 0 64 64'); holdEl.setAttribute('class', 'hold');
  holdEl.innerHTML = '<circle cx="32" cy="32" r="28"/>';
  holdEl.style.left = p.x + 'px'; holdEl.style.top = p.y + 'px';
  $('touch-layer').append(holdEl); void holdEl.getBoundingClientRect(); holdEl.classList.add('go');
}
function hideHold() { holdEl?.remove(); holdEl = null; }

// ---------- gestures ----------
// Works like the iPhone's own touchscreen. One finger works the PC; two fingers move your view.
//  tap = click, drag = scroll, hold = right-click, hold then drag = select / move, pinch = zoom.
const HOLD_MS = 450, SLOP = 9;
const pointers = new Map();
let g = null, lastSent = 0, inertia = 0;

function remoteScale() { return (+screen.dataset.scale || 1) / ((meta?.monitors?.find(m => m.id === meta.monitor)?.width || screen.width) / screen.width); }
function sendScroll(at, pixels) {
  // Finger pixels -> desktop pixels -> wheel units. Windows scrolls ~0.4 px per wheel unit,
  // so x2 keeps the page roughly under your finger.
  const delta = clamp(Math.round(pixels / remoteScale() * 2), -1200, 1200);
  if (delta) input('scroll', { ...at, delta });
}
function stopInertia() { cancelAnimationFrame(inertia); inertia = 0; }
function startInertia(at, velocity) {
  stopInertia();
  let v = velocity, acc = 0, last = performance.now(), lastPush = last;
  const step = now => {
    const dt = now - last; last = now; acc += v * dt; v *= Math.pow(.92, dt / 16);
    if (now - lastPush > 40 && Math.abs(acc) >= 1) { sendScroll(at, acc); acc = 0; lastPush = now; }
    if (Math.abs(v) > .04) inertia = requestAnimationFrame(step); else { if (Math.abs(acc) >= 1) sendScroll(at, acc); inertia = 0; }
  };
  inertia = requestAnimationFrame(step);
}

stage.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault(); stopInertia();
  try { stage.setPointerCapture(e.pointerId); } catch {}
  const p = localPoint(e); pointers.set(e.pointerId, p);
  if (!controlling && wantControl && !occupied) requestControl();

  if (pointers.size === 1) {
    const now = performance.now();
    g = { kind: 'pending', start: p, last: p, t0: now, startRemote: toRemote(p), samples: [{ t: now, y: p.y }] };
    // Ask the PC, while the finger is still down, whether this spot is a text box; if the answer
    // arrives before the finger lifts, the keyboard opens with the tap (iOS only allows that during a touch).
    if (controlling && features.probe && g.startRemote) { g.probe = { id: probeSeq++, editable: null }; send({ type: 'probe', id: g.probe.id, ...g.startRemote, monitor: meta?.monitor }); }
    if (controlling) {
      showHold(p);
      g.holdTimer = setTimeout(() => {
        if (g?.kind !== 'pending') return;
        g.kind = 'held'; holdEl?.classList.add('done');
      }, HOLD_MS);
    }
  } else if (pointers.size === 2) {
    endSingle(true);
    const [a, b] = [...pointers.values()];
    g = { kind: 'two', d0: dist(a, b), c0: mid(a, b), lastC: mid(a, b), z0: zoom, anchor: toRemote(mid(a, b), true), sub: null };
  }
});

stage.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId) || !g) return;
  e.preventDefault();
  const p = localPoint(e); pointers.set(e.pointerId, p);

  if (g.kind === 'two') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()], d = dist(a, b), c = mid(a, b);
    if (!g.sub) {
      if (Math.abs(d - g.d0) > 14) g.sub = 'view';
      else if (Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > 10) g.sub = zoom > 1.02 || !controlling ? 'view' : 'scroll';
    }
    if (g.sub === 'view') {
      zoom = clamp(g.z0 * d / Math.max(1, g.d0), 1, 6); layout();
      if (g.anchor) { const now = toLocal(g.anchor); panX += c.x - now.x; panY += c.y - now.y; layout(); }
    } else if (g.sub === 'scroll') {
      const now = performance.now();
      if (now - lastSent > 33) { sendScroll(cursorForScroll(c), c.y - g.lastC.y); g.lastC = c; lastSent = now; }
    }
    return;
  }

  const moved = Math.hypot(p.x - g.start.x, p.y - g.start.y) > SLOP;
  if (g.kind === 'pending' && moved) {
    clearTimeout(g.holdTimer); hideHold();
    g.kind = controlling ? 'scroll' : 'pan';
  } else if (g.kind === 'held' && moved) {
    hideHold(); g.kind = 'drag';
    const at = g.startRemote || toRemote(g.start, true);
    cursor = at; input('down', at);
  }

  const now = performance.now(), dx = p.x - g.last.x, dy = p.y - g.last.y;
  if (g.kind === 'pan') { panX += dx; panY += dy; layout(); }
  else if (g.kind === 'scroll') {
    g.samples.push({ t: now, y: p.y }); if (g.samples.length > 6) g.samples.shift();
    g.pending = (g.pending || 0) + dy;
    if (now - lastSent > 33) { sendScroll(g.startRemote || cursor, g.pending); g.pending = 0; lastSent = now; }
  } else if (g.kind === 'drag') {
    cursor = toRemote(p, true); cursorTouchedAt = Date.now();
    if (now - lastSent > 20) { input('move', cursor); lastSent = now; }
  }
  g.last = p;
});

function endPointer(e, cancelled) {
  if (!pointers.has(e.pointerId)) return;
  const p = localPoint(e); pointers.delete(e.pointerId);
  if (!g) return;
  if (g.kind === 'two') { if (pointers.size === 0) g = null; else g = { kind: 'done' }; return; }
  if (g.kind === 'done') { if (pointers.size === 0) g = null; return; }
  clearTimeout(g.holdTimer); hideHold();
  const now = performance.now();
  if (!cancelled && controlling) {
    if (g.kind === 'pending') {
      const at = toRemote(p);
      if (at) {
        cursor = at; cursorTouchedAt = Date.now(); input('click', { ...at, button: 'left' }); ripple(p);
        // Tapped a text box: bring up the keyboard right away, like tapping a text field on the phone.
        if (g.probe?.editable === true && keybar.hidden) openKeyboard(true);
      }
    } else if (g.kind === 'held') {
      const at = g.startRemote || toRemote(p, true);
      cursor = at; input('click', { ...at, button: 'right' }); ripple(g.start, 'right');
    } else if (g.kind === 'scroll') {
      if (g.pending) sendScroll(g.startRemote || cursor, g.pending);
      const s = g.samples, first = s[0], last = s[s.length - 1];
      const v = last && first && last.t - first.t > 0 && now - last.t < 60 ? (last.y - first.y) / (last.t - first.t) : 0;
      if (Math.abs(v) > .35) startInertia(g.startRemote || cursor, v);
    }
  }
  if (g.kind === 'drag') input('up', cursor);
  g = null;
}
stage.addEventListener('pointerup', e => endPointer(e, false));
stage.addEventListener('pointercancel', e => endPointer(e, true));
stage.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());   // stop Safari's own page zoom
document.addEventListener('gesturechange', e => e.preventDefault());

function endSingle(silent) {
  if (!g) return;
  clearTimeout(g.holdTimer); hideHold();
  if (g.kind === 'drag') input('up', cursor);
  if (!silent && g.kind === 'scroll' && g.pending) sendScroll(g.startRemote || cursor, g.pending);
  g = null;
}
function cancelGesture() { stopInertia(); endSingle(true); pointers.clear(); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function cursorForScroll(c) { return toRemote(c, true) || cursor; }

// Mouse wheel and trackpad on a laptop/iPad.
stage.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) { setZoom(zoom * Math.exp(-e.deltaY * .01), localPoint(e)); return; }
  if (controlling) input('scroll', { ...(toRemote(localPoint(e)) || cursor), delta: clamp(Math.round(-e.deltaY), -1200, 1200) });
}, { passive: false });

$('fit').onclick = () => { zoom = 1; panX = panY = 0; layout(); };

// ---------- keyboard ----------
const kb = $('kb'), keybar = $('keybar'), SENTINEL = '​';
const mods = new Set();
function openKeyboard(auto = false) {
  if (!controlling && !secure.rfb) { toast(wantControl ? 'Waiting for control of the PC.' : 'Turn on Control your PC first.'); return; }
  autoKeyboard = auto; keybar.hidden = false; $('type-pill').hidden = true; app.classList.add('keybar-open');
  kb.value = SENTINEL; kb.focus({ preventScroll: true }); try { kb.setSelectionRange(1, 1); } catch {}
  placeKeybar();
}
function closeKeyboard() {
  keybar.hidden = true; autoKeyboard = false; app.classList.remove('keybar-open');
  clearMods(); if (document.activeElement === kb) kb.blur();
}
// The PC tells us when a text box gets or loses focus.
function onFocusChange(editable) {
  pcEditable = editable;
  if (!editable) { $('type-pill').hidden = true; if (autoKeyboard && !keybar.hidden) closeKeyboard(); return; }
  if (keybar.hidden && controlling) $('type-pill').hidden = false;
}
$('type-pill').onclick = () => openKeyboard(true);
function placeKeybar() {
  const vv = window.visualViewport; if (!vv || keybar.hidden) return;
  const lift = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  keybar.style.transform = `translateY(${-lift}px)`; keybar.classList.toggle('lifted', lift > 0);
}
window.visualViewport?.addEventListener('resize', () => { placeKeybar(); layout(); });
window.visualViewport?.addEventListener('scroll', placeKeybar);

function clearMods() { mods.clear(); for (const b of document.querySelectorAll('[data-mod]')) b.setAttribute('aria-pressed', 'false'); }
function sendKeys(keys) { if (secure.rfb) return secureKeys(keys); input('key', { keys }); }
function typeText(text) {
  if (!text) return;
  if (secure.rfb) { if (mods.size) { for (const ch of text) secureKeys([...mods, ch]); clearMods(); } else secureText(text); return; }
  if (mods.size) { for (const ch of text) sendKeys([...mods, ch.length === 1 ? ch.toLowerCase() : ch]); clearMods(); return; }
  for (let i = 0; i < text.length; i += 2000) input('text', { text: text.slice(i, i + 2000) });
}
kb.addEventListener('input', () => {
  const v = kb.value;
  if (v.length < SENTINEL.length) sendKeys([...mods, 'Backspace']), clearMods();
  else typeText(v.startsWith(SENTINEL) ? v.slice(SENTINEL.length) : v.replaceAll(SENTINEL, ''));
  kb.value = SENTINEL; try { kb.setSelectionRange(1, 1); } catch {}
});
kb.addEventListener('keydown', e => {
  const special = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };
  if (special[e.key]) { e.preventDefault(); sendKeys([...mods, ...modsFrom(e), special[e.key]]); clearMods(); }
  else if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1) { e.preventDefault(); sendKeys([...modsFrom(e), e.key.toLowerCase()]); }
  else if (e.key === 'Backspace' && kb.value === SENTINEL && kb.selectionStart === 0) { e.preventDefault(); sendKeys(['Backspace']); }
});
kb.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== kb && !keybar.hidden) closeKeyboard(); }, 120); });
function modsFrom(e) { return [...(e.ctrlKey || e.metaKey ? ['Control'] : []), ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey && e.key.length > 1 ? ['Shift'] : [])]; }

// Key buttons act on press and never take focus, so the iPhone keyboard stays up.
for (const btn of keybar.querySelectorAll('button')) {
  const act = async () => {
    btn.classList.add('pressed'); setTimeout(() => btn.classList.remove('pressed'), 120);
    if (btn.dataset.mod) {
      const on = !mods.has(btn.dataset.mod); on ? mods.add(btn.dataset.mod) : mods.delete(btn.dataset.mod);
      btn.setAttribute('aria-pressed', String(on));
    } else if (btn.dataset.key) { sendKeys([...mods, btn.dataset.key]); clearMods(); }
    else if (btn.dataset.action === 'paste') {
      try { const text = await navigator.clipboard.readText(); if (text) { typeText(text.slice(0, 4096)); toast('Pasted on your PC.'); } else toast('Your phone clipboard is empty.'); }
      catch { toast('Allow paste to send your phone clipboard.'); }
    } else if (btn.dataset.action === 'done') { closeKeyboard(); return; }
    if (!keybar.hidden && document.activeElement !== kb) kb.focus({ preventScroll: true });
  };
  btn.addEventListener('pointerdown', e => e.preventDefault());
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', e => { e.preventDefault(); act(); });
}

// Hardware keyboard (iPad, Bluetooth) when the on-screen keyboard is closed.
document.addEventListener('keydown', e => {
  if ((!controlling && !secure.rfb) || e.target === kb || e.target.closest?.('input, select, textarea, .sheet, .secure')) return;
  const special = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
  if (special.includes(e.key)) { e.preventDefault(); sendKeys([...(e.ctrlKey ? ['Control'] : []), ...(e.altKey ? ['Alt'] : []), ...(e.shiftKey ? ['Shift'] : []), e.key]); }
  else if (e.key.length === 1) { e.preventDefault(); if (e.ctrlKey || e.metaKey) sendKeys([e.ctrlKey ? 'Control' : 'Meta', e.key.toLowerCase()]); else typeText(e.key); }
});

// ---------- settings, guide ----------
function openSheet() { cancelGesture(); closeKeyboard(); $('sheet').hidden = false; $('sheet-backdrop').hidden = false; updateStats(); syncControls(); }
function closeSheet() { $('sheet').hidden = true; $('sheet-backdrop').hidden = true; }
$('more').onclick = openSheet; $('sheet-keyboard').onclick = () => { closeSheet(); openKeyboard(false); }; $('sheet-close').onclick = closeSheet; $('sheet-backdrop').onclick = () => { closeSheet(); closeSecurity(); };
$('status').onclick = () => { if (!wantControl) { wantControl = true; syncControls(); requestControl(); } else openSheet(); };

$('control-switch').onchange = () => {
  wantControl = $('control-switch').checked;
  if (wantControl) requestControl(); else { closeKeyboard(); releaseControl(); }
  syncControls();
};
for (const b of document.querySelectorAll('[data-quality]')) b.onclick = () => {
  qualityValue = b.dataset.quality; send({ type: 'quality', value: qualityValue });
  for (const o of document.querySelectorAll('[data-quality]')) o.setAttribute('aria-checked', String(o === b));
};
$('reconnect').onclick = () => { closeSheet(); connect(); };
$('logout').onclick = async () => {
  releaseControl(); closeSheet();
  try { await fetch('/api/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } }); } catch {}
  wasSignedIn = false; showLogin('', { locked: false });
};
$('notice-action').onclick = () => { if (disconnected) reconnectNow(); else { failures = 0; reconnectDelay = 1000; connect(); } };
// One tap to stop showing and controlling the PC; one tap to come back.
function disconnect() {
  disconnected = true; clearTimeout(reconnectTimer); cancelGesture(); closeKeyboard(); $('type-pill').hidden = true;
  if (secure.rfb) leaveSecure();
  send({ type: 'release' }); send({ type: 'active', active: false });
  const old = socket; socket = null; old?.close(); controlling = false; lastFrame = 0;
  ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, screen.width, screen.height);
  $('power').setAttribute('aria-pressed', 'true'); $('power').setAttribute('aria-label', 'Connect');
  setStatus('idle', 'Disconnected');
  notice('Disconnected', 'Your PC isn’t being shown or controlled from this phone.', { action: 'Connect' });
}
function reconnectNow() {
  disconnected = false; $('power').setAttribute('aria-pressed', 'false'); $('power').setAttribute('aria-label', 'Disconnect');
  reconnectDelay = 1000; connect();
}
$('power').onclick = () => disconnected ? reconnectNow() : disconnect();

const GESTURES = [
  ['tap', 'Tap', 'Click. Tap a text box to type.'],
  ['drag', 'Drag', 'Scroll'],
  ['hold', 'Hold', 'Right-click'],
  ['holddrag', 'Hold, then drag', 'Select text or move things'],
  ['two', 'Pinch', 'Zoom in and move around'],
];
const GLYPHS = {
  tap: '<circle class="g-finger" cx="22" cy="22" r="8"/>',
  drag: '<path class="g-path" d="M22 36V10"/><circle class="g-finger" cx="22" cy="14" r="7"/>',
  hold: '<circle class="g-hold" cx="22" cy="22" r="13"/><circle class="g-finger" cx="22" cy="22" r="7"/>',
  holddrag: '<path class="g-path" d="M14 30 32 14"/><circle class="g-hold" cx="14" cy="30" r="10"/><circle class="g-finger" cx="14" cy="30" r="6"/>',
  two: '<path class="g-path" d="M10 34 4 40M34 10l6-6"/><circle class="g-finger" cx="14" cy="30" r="6"/><circle class="g-finger" cx="30" cy="14" r="6"/>',
};
function renderCoach() {
  $('coach-list').replaceChildren(...GESTURES.map(([glyph, name, does]) => {
    const li = document.createElement('li');
    li.innerHTML = `<svg viewBox="0 0 44 44" aria-hidden="true">${GLYPHS[glyph]}</svg><div><strong></strong><span></span></div>`;
    li.querySelector('strong').textContent = name; li.querySelector('span').textContent = does; return li;
  }));
}
function showCoach() { closeSheet(); renderCoach(); $('coach').hidden = false; }
$('show-gestures').onclick = showCoach;
$('coach-done').onclick = () => { $('coach').hidden = true; writePref('dp-coach', '1'); };

// ---------- full height on the Home Screen app ----------
// iOS sometimes lays a Home Screen web app out a little shorter than the screen, leaving an empty band at the
// bottom. When the app owns the whole screen, size it to the screen itself.
function fitViewport() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const root = document.documentElement;
  root.classList.toggle('standalone', standalone);
  if (!standalone) { root.style.removeProperty('--app-h'); return; }
  const scr = window.screen;   // (plain `screen` is the canvas in this file)
  const long = Math.max(scr.width, scr.height), short = Math.min(scr.width, scr.height);
  const portrait = innerHeight >= innerWidth, w = portrait ? short : long, h = portrait ? long : short;
  const fullWidth = Math.abs(innerWidth - w) < 2;   // not in Split View / Stage Manager
  const gap = h - innerHeight;
  if (fullWidth && gap > 0 && gap < 160) root.style.setProperty('--app-h', `${h}px`); else root.style.removeProperty('--app-h');
  window.scrollTo(0, 0);
}
fitViewport();
addEventListener('resize', () => { fitViewport(); placeLens(); });
addEventListener('orientationchange', () => setTimeout(() => { fitViewport(); layout(); placeLens(); }, 300));

// ---------- the floating tab capsule ----------
let dockMini = false, dockPeek = 0;
function placeLens() {
  const bar = $('tabbar'), lens = bar.querySelector('.tab-lens'), b = bar.querySelector('button[aria-selected="true"]');
  if (!lens || !b || bar.hidden) return;
  lens.style.width = `${b.offsetWidth}px`; lens.style.height = `${b.offsetHeight}px`;
  lens.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
}
function setDockMini(on) {
  if (Date.now() < dockPeek) on = false;
  if (on === dockMini) return;
  dockMini = on; $('tabbar').classList.toggle('mini', on); requestAnimationFrame(placeLens);
}

// ---------- tabs ----------
// Screen is built in; Terminal, Files and any other tab come from server modules (GET /api/session -> tabs).
const TAB_ICONS = {
  screen: '<rect x="3" y="5" width="22" height="15" rx="2.5"/><path d="M10 24h8"/>',
  terminal: '<rect x="3" y="5" width="22" height="18" rx="3"/><path d="m8 11 4 3-4 3M14 18h6"/>',
  files: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H11l2.5 2.5h8A2.5 2.5 0 0 1 24 11v9.5A2.5 2.5 0 0 1 21.5 23h-15A2.5 2.5 0 0 1 4 20.5Z"/>',
  other: '<circle cx="14" cy="14" r="9"/>',
};
let tabList = [], currentTab = null; const tabState = new Map();
function setupTabs(serverTabs) {
  const next = [...(screenAvailable ? [{ id: 'screen', title: 'Screen' }] : []), ...serverTabs];
  if (JSON.stringify(next.map(t => t.id)) === JSON.stringify(tabList.map(t => t.id))) return;
  tabList = next;
  const bar = $('tabbar');
  bar.replaceChildren(...tabList.map(t => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.tab = t.id; b.setAttribute('role', 'tab');
    b.innerHTML = `<svg viewBox="0 0 28 28" aria-hidden="true">${TAB_ICONS[t.id] || TAB_ICONS.other}</svg><span></span>`;
    b.querySelector('span').textContent = t.title; b.setAttribute('aria-label', t.title);
    b.onclick = () => {
      // The small dot (while zoomed in) opens up first, so you can pick a tab.
      if (dockMini && t.id === currentTab) { dockPeek = Date.now() + 4000; setDockMini(false); setTimeout(() => layout(), 4100); return; }
      showTab(t.id);
    };
    return b;
  }));
  const lens = document.createElement('i'); lens.className = 'tab-lens'; lens.setAttribute('aria-hidden', 'true'); bar.prepend(lens);
  bar.hidden = tabList.length < 2; app.classList.toggle('has-tabs', tabList.length > 1);
  const wanted = readPref('dp-tab', '');
  showTab(tabList.some(t => t.id === wanted) ? wanted : tabList[0]?.id, true);
}
async function showTab(id, initial = false) {
  if (!id || id === currentTab) return;
  const prev = currentTab; currentTab = id; writePref('dp-tab', id);
  for (const b of $('tabbar').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
  dockPeek = 0; setDockMini(id === 'screen' && zoom > 1.02); requestAnimationFrame(placeLens);
  if (prev === 'screen') { cancelGesture(); closeKeyboard(); if (secure.rfb) leaveSecure(); send({ type: 'release' }); send({ type: 'active', active: false }); }
  if (prev && prev !== 'screen') { const st = tabState.get(prev); st?.pane && (st.pane.hidden = true); st?.hide.forEach(f => { try { f(); } catch {} }); }
  $('tab-screen').hidden = id !== 'screen';
  if (id === 'screen') {
    if (initial) { layout(); return; }   // the first connect() is already under way
    wake();
    layout(); return;
  }
  let st = tabState.get(id);
  if (!st) {
    const t = tabList.find(x => x.id === id), pane = document.createElement('section');
    pane.className = 'tab-pane'; pane.dataset.tab = id; $('tab-panes').append(pane);
    st = { pane, show: [], hide: [] }; tabState.set(id, st);
    if (t.style) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = t.style; document.head.append(l); }
    try {
      const mod = await import(t.script);
      mod.mount(pane, {
        csrf: () => csrf,
        api: async (path, opts = {}) => { const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { ...(opts.method && opts.method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...(opts.headers || {}) } }); if (r.status === 401) showLogin(); return r; },
        devices: async () => { const r = await fetch('/api/devices', { cache: 'no-store' }); if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || 'Couldn’t list devices.'); return (await r.json()).devices; },
        toast, onShow: f => st.show.push(f), onHide: f => st.hide.push(f),
      });
    } catch (e) { pane.textContent = 'This tab didn’t load. Reload the app.'; console.error(e); }
  }
  if (currentTab !== id) return;
  st.pane.hidden = false; st.show.forEach(f => { try { f(); } catch {} });
}

// ---------- session + stream ----------
async function session() {
  const res = await fetch('/api/session', { cache: 'no-store' });
  if (res.status === 401) { showLogin(); return false; }
  if (!res.ok) throw Error('unreachable');
  const data = await res.json(); csrf = data.csrf; signedIn = true; wasSignedIn = true; fullDesktop = !!data.fullDesktop;
  screenAvailable = data.screen !== false; setupTabs(data.tabs || []);
  $('sheet-title').textContent = data.machine || 'Your PC';
  $('login').hidden = true; app.hidden = false;
  return true;
}

async function connect() {
  if (disconnected) return;
  if (!screenAvailable) { try { await session(); } catch { } return; }
  clearTimeout(reconnectTimer);
  const old = socket; socket = null; old?.close();
  controlling = false; occupied = false; lastFrame = 0; frameGeneration++;
  setStatus('connecting', 'Connecting');
  if (!meta) notice('Connecting to your PC', 'This takes a second.', { spinner: true });
  try { if (!await session()) return; }
  catch { offline(); return; }

  if (socket) dropSocket();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream?token=${encodeURIComponent(csrf)}`);
  ws.binaryType = 'arraybuffer'; socket = ws;
  ws.onopen = () => { if (socket !== ws) return; lastRx = Date.now(); send({ type: 'hello', patches: true, focus: true }); send({ type: 'active', active: !document.hidden && currentTab === 'screen' }); heartbeat(); };
  // Frames are acknowledged the moment they arrive so the PC can send the next one while this one decodes.
  // They are drawn strictly in order; a full frame makes anything queued before it irrelevant.
  const queue = []; let drawing = false, seq = -1, resyncAt = 0;
  const resync = () => { queue.length = 0; if (Date.now() - resyncAt > 500) { resyncAt = Date.now(); send({ type: 'resync' }); } };
  const drain = async () => {
    if (drawing) return; drawing = true;
    while (queue.length && socket === ws) {
      const { packet, next, len } = queue.shift(), generation = frameGeneration;
      try {
        const patch = next.patch;
        if (patch && next.base !== seq) { resync(); continue; }   // missed a piece; ask for a full frame
        const image = await decode(new Blob([new Uint8Array(packet, 4 + len)], { type: 'image/jpeg' }));
        if (socket !== ws || generation !== frameGeneration) { image.close?.(); break; }
        if (patch) {
          ctx2d.drawImage(image, patch.x, patch.y); image.close?.();
          if (Number.isFinite(next.seq)) seq = next.seq;
          lastFrame = Date.now(); frames++; bytes += packet.byteLength;
          if (next.cursorX >= 0 && !g && Date.now() - cursorTouchedAt > 800) cursor = { x: clamp(next.cursorX, 0, 1), y: clamp(next.cursorY, 0, 1) };
          continue;
        }
        const resized = screen.width !== next.width || screen.height !== next.height;
        const switched = meta && meta.monitor !== next.monitor;
        meta = next; if (resized) { screen.width = next.width; screen.height = next.height; }
        if (switched) { zoom = 1; panX = panY = 0; }
        ctx2d.drawImage(image, 0, 0); image.close?.();
        seq = Number.isFinite(next.seq) ? next.seq : -1;
        const first = !lastFrame; lastFrame = Date.now(); frames++; bytes += packet.byteLength;
        if (next.cursorX >= 0 && !g && Date.now() - cursorTouchedAt > 800) cursor = { x: clamp(next.cursorX, 0, 1), y: clamp(next.cursorY, 0, 1) };
        if (first || resized || switched) { renderDisplays(); layout(); }
        if (secure.rfb && Date.now() - secure.since > 1500) leaveSecure();   // Windows is back to the normal desktop
        hideNotice(); failures = 0; reconnectDelay = 1000;
        if (first) { requestControl(); refreshStatus(); if (readPref('dp-coach', '') !== '1') showCoach(); }
      } catch { notice('The picture didn’t load', 'Reconnect to get a fresh one.', { action: 'Reconnect' }); }
    }
    drawing = false;
  };
  ws.onmessage = ev => {
    if (socket !== ws) return;
    lastRx = Date.now();
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      if (m.type === 'same') { if (meta && !document.hidden) { const was = lastFrame; lastFrame = Date.now(); if (!was) { hideNotice(); refreshStatus(); } } return; }
      return onMessage(m);
    }
    send({ type: 'ack' });
    if (document.hidden) return;
    try {
      const packet = ev.data, len = new DataView(packet).getUint32(0, true);
      const next = JSON.parse(new TextDecoder().decode(new Uint8Array(packet, 4, len)));
      if (!next.patch) for (let i = queue.length - 1; i >= 0; i--) queue.splice(i, 1);   // a full frame replaces everything waiting
      queue.push({ packet, next, len }); drain();
    } catch { resync(); }
  };
  ws.onclose = ev => {
    if (socket !== ws) return;
    socket = null; controlling = false; lastFrame = 0; cancelGesture(); syncControls();
    if (ev.code === 4001) { showLogin(); return; }
    if (!disconnected) offline();
  };
  ws.onerror = () => {};
}
function offline() {
  // A dropped connection usually comes straight back (phone switched networks, woke up, Wi-Fi to cellular),
  // so the first few retries are quick and quiet; the "can't reach" card only appears if it really is gone.
  failures++;
  if (failures <= 3) {
    setStatus('connecting', 'Reconnecting');
    clearTimeout(reconnectTimer);
    if (signedIn && !document.hidden && !disconnected) reconnectTimer = setTimeout(connect, failures === 1 ? 150 : 900 * failures);
    return;
  }
  setStatus('offline', 'Offline');
  notice('Can’t reach your PC', 'Check that Tailscale is on, on both devices. Trying again…', { action: 'Try now' });
  scheduleReconnect();
}
function dropSocket() { const old = socket; socket = null; try { old?.close(); } catch {} controlling = false; lastFrame = 0; }
// Ask the PC for a complete picture (after the app was in the background or on another tab, frames were skipped).
function askFresh() { if (Date.now() - resyncSent < 1500) return; resyncSent = Date.now(); send({ type: 'active', active: true }); send({ type: 'resync' }); }
// The Screen tab came back into view (tab switch or the app returning to the front).
function wake() {
  if (disconnected || !signedIn) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) { failures = 0; connect(); return; }
  if (lastFrame) lastFrame = Date.now();   // keep the last picture up while the fresh one comes in
  askFresh(); heartbeat(); setTimeout(requestControl, 300);
  // iOS can hand back a socket that died while the phone slept. If not even a pong comes back, start over.
  const since = Date.now();
  setTimeout(() => {
    if (socket && socket.readyState === WebSocket.OPEN && lastRx < since && !document.hidden && !disconnected) { dropSocket(); failures = 0; connect(); }
  }, 1800);
}
function onMessage(m) {
  if (m.type === 'control') {
    const had = controlling; controlling = !!m.yours; occupied = !!m.occupied && !m.yours && !secure.rfb; takePending = 0;
    if (had && !controlling && !secure.rfb) { cancelGesture(); closeKeyboard(); $('type-pill').hidden = true; }
    syncControls();
    if (!controlling && !occupied && !secure.rfb) requestControl();
  } else if (m.type === 'error') {
    if (/another device/i.test(m.message)) { occupied = true; syncControls(); return; }
    if (/wait for a live/i.test(m.message)) { takePending = 0; return; }
    if (/locked|secure prompt/i.test(m.message)) { lastFrame = 0; enterSecure(); return; }
    if (/bridge|display changed|unavailable/i.test(m.message)) {
      lastFrame = 0; setStatus('busy', 'Needs the PC'); notice('Your PC needs you', m.message, { action: 'Reconnect' });
    } else if (!/full-desktop control/i.test(m.message)) toast(m.message);
  } else if (m.type === 'input-result' && !m.ok) { if (!/secure prompt|locked/i.test(m.message || '')) toast(m.message || 'Windows blocked that.'); }
  else if (m.type === 'features') features = m;
  else if (m.type === 'focus') onFocusChange(!!m.editable);
  else if (m.type === 'probe') { if (g?.probe?.id === m.id) g.probe.editable = !!m.editable; }
  else if (m.type === 'pong') { latency = Math.round(performance.now() - m.time); if (failures && currentTab !== 'screen') failures = 0; }
}
// ---------- protected screens (UAC prompts, lock screen) ----------
const secure = { rfb: null, since: 0, busy: false };
async function enterSecure() {
  if (secure.rfb || secure.busy) return;
  if (!fullDesktop) {
    setStatus('busy', 'Needs the PC');
    notice('Windows is showing a protected screen', 'An admin prompt or the lock screen is up. Answer it on the PC.', { action: 'Reconnect' });
    return;
  }
  secure.busy = true; cancelGesture(); closeKeyboard(); $('type-pill').hidden = true;
  setStatus('busy', 'Protected screen'); notice('Windows is asking for permission', 'Opening the protected screen…', { spinner: true });
  try {
    send({ type: 'release' }); controlling = false;
    const res = await fetch('/api/full/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ control: true }) });
    const ticket = await res.json(); if (!res.ok) throw Error(ticket.error || 'unavailable');
    const { default: RFB } = await import('/novnc/core/rfb.js');
    const box = $('secure'); box.replaceChildren(); box.hidden = false;
    const rfb = new RFB(box, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/full-stream?ticket=${encodeURIComponent(ticket.ticket)}`, { shared: true, credentials: { password: ticket.password } });
    rfb.viewOnly = false; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.qualityLevel = 6; rfb.compressionLevel = 2;
    secure.rfb = rfb; secure.since = Date.now();
    rfb.addEventListener('connect', () => { if (secure.rfb !== rfb) return; hideNotice(); setStatus('busy', 'Protected screen'); toast('Windows is showing a protected screen. Tap to answer it.', 3500); });
    rfb.addEventListener('disconnect', () => { if (secure.rfb !== rfb) return; leaveSecure(); });
    rfb.addEventListener('credentialsrequired', () => rfb.disconnect());
  } catch {
    $('secure').hidden = true; secure.rfb = null;
    setStatus('busy', 'Needs the PC');
    notice('Windows is showing a protected screen', 'An admin prompt or the lock screen is up. Answer it on the PC.', { action: 'Reconnect' });
  } finally { secure.busy = false; }
}
function leaveSecure() {
  const rfb = secure.rfb; secure.rfb = null;
  try { rfb?.disconnect(); } catch {}
  $('secure').hidden = true; $('secure').replaceChildren(); closeKeyboard();
  setTimeout(() => { takePending = 0; requestControl(); refreshStatus(); }, 400);
}
const KEYSYM = { Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b, Delete: 0xffff, Meta: 0xffeb, Control: 0xffe3, Alt: 0xffe9, Shift: 0xffe1,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56 };
const keysym = k => KEYSYM[k] ?? (k.codePointAt(0) <= 255 ? k.codePointAt(0) : 0x01000000 | k.codePointAt(0));
function secureKeys(keys) {
  const rfb = secure.rfb; if (!rfb) return;
  for (const k of keys) rfb.sendKey(keysym(k), null, true);
  for (const k of [...keys].reverse()) rfb.sendKey(keysym(k), null, false);
}
function secureText(text) { for (const ch of text) secure.rfb?.sendKey(keysym(ch), null); }

async function decode(blob) {
  if ('createImageBitmap' in window) { try { return await createImageBitmap(blob); } catch {} }
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(Error('decode')); };
    img.src = url;
  });
}
function scheduleReconnect() {
  if (!signedIn || document.hidden || disconnected) return;
  clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(10000, reconnectDelay * 1.5);
}
function heartbeat() { send({ type: 'heartbeat', time: performance.now() }); }

function renderDisplays() {
  const list = meta?.monitors || [];
  $('display-group').hidden = list.length < 2;
  $('display-list').replaceChildren(...list.map((m, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio');
    b.textContent = m.name || `Screen ${i + 1}`; b.setAttribute('aria-checked', String(m.id === meta.monitor)); b.disabled = !controlling;
    b.onclick = () => { if (m.id === meta.monitor) return; cancelGesture(); zoom = 1; panX = panY = 0; send({ type: 'display', monitor: m.id }); for (const o of $('display-list').children) o.setAttribute('aria-checked', String(o === b)); };
    return b;
  }));
}
function updateStats() {
  const el = $('sheet-stats');
  if (!live()) { el.textContent = socket ? 'Connecting' : 'Offline'; return; }
  el.textContent = `Live at ${fps} fps with ${latency} ms delay`;
}

// ---------- lifecycle ----------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelGesture(); closeKeyboard(); if (secure.rfb) leaveSecure(); send({ type: 'release' }); send({ type: 'active', active: false }); clearTimeout(reconnectTimer); }
  else if (signedIn && !disconnected) { if (currentTab === 'screen') wake(); else if (!socket || socket.readyState !== WebSocket.OPEN) { failures = 0; connect(); } else { send({ type: 'active', active: false }); heartbeat(); } }
});
window.addEventListener('pagehide', () => { cancelGesture(); send({ type: 'release' }); send({ type: 'active', active: false }); });
window.addEventListener('pageshow', e => { if (e.persisted && signedIn) connect(); });
new ResizeObserver(() => layout()).observe(stage);
window.addEventListener('orientationchange', () => setTimeout(layout, 250));

setInterval(() => {
  if (document.hidden) return;
  heartbeat();
  const now = performance.now(), secs = (now - meterStart) / 1000;
  fps = Math.round(frames / secs); kbps = bytes * 8 / 1000 / secs; frames = bytes = 0; meterStart = now;
  if (!$('sheet').hidden) updateStats();
  if (socket && socket.readyState === WebSocket.OPEN && lastRx && Date.now() - lastRx > 5000 && !disconnected) {
    // Not even a pong in 5 s: the connection is gone even though the phone still calls it open.
    dropSocket(); offline();
  } else if (!disconnected && currentTab === 'screen' && socket && socket.readyState === WebSocket.OPEN && meta) {
    if (lastFrame && Date.now() - lastFrame > 4000) { lastFrame = 0; staleSince = Date.now(); setStatus('connecting', 'Reconnecting'); }
    if (!lastFrame) {
      staleSince ||= Date.now(); askFresh();
      if (Date.now() - staleSince > 9000) { staleSince = 0; notice('Waiting for your PC', 'The picture stopped updating. Touch is paused until it’s back.', { spinner: true, action: 'Reconnect' }); dropSocket(); failures = 0; connect(); }
    } else staleSince = 0;
  }
  if (live() && !controlling && !secure.rfb) requestControl();
}, 2000);

// ---------- passkeys (Face ID, Touch ID, Windows Hello) ----------
// One passkey signs you in on every computer in your tailnet. Passwords are off: the first passkey on a device
// is added with a one-time code from security-setup on your PC, and recovery codes cover a lost phone.
const b64uToBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)).buffer;
function bufToB64u(b) { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function creationOptions(j) {
  if (window.PublicKeyCredential?.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(j);
  return { ...j, challenge: b64uToBuf(j.challenge), user: { ...j.user, id: b64uToBuf(j.user.id) }, excludeCredentials: (j.excludeCredentials || []).map(c => ({ ...c, id: b64uToBuf(c.id) })) };
}
function requestOptions(j) {
  if (window.PublicKeyCredential?.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(j);
  return { ...j, challenge: b64uToBuf(j.challenge), allowCredentials: (j.allowCredentials || []).map(c => ({ ...c, id: b64uToBuf(c.id) })) };
}
function credentialJSON(c) {
  try { if (typeof c.toJSON === 'function') return c.toJSON(); } catch {}
  const r = c.response, out = { id: c.id, rawId: bufToB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults?.() || {},
    authenticatorAttachment: c.authenticatorAttachment || undefined, response: { clientDataJSON: bufToB64u(r.clientDataJSON) } };
  if (r.attestationObject) { out.response.attestationObject = bufToB64u(r.attestationObject); out.response.transports = r.getTransports?.() || []; }
  else { out.response.authenticatorData = bufToB64u(r.authenticatorData); out.response.signature = bufToB64u(r.signature); if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle); }
  return out;
}
async function authPost(path, body = {}, token = csrf) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = Error(data.error || 'Something went wrong.'); e.status = res.status; e.stepUp = !!data.stepUp; throw e; }
  return data;
}
function passkeyError(err) {
  if (err instanceof TypeError) return 'Can’t reach your PC. Turn on Tailscale and try again.';
  if (err?.name === 'NotAllowedError') return 'Cancelled, or the passkey prompt timed out.';
  if (err?.name === 'InvalidStateError') return 'This device already has a passkey for your tailnet. Use Sign in instead.';
  if (err?.name === 'SecurityError') return 'Passkeys need the https address of this app.';
  return err?.message || 'Something went wrong.';
}
const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials?.create);
async function passkeySignIn() {
  const { flow, options } = await authPost('/api/auth/login/options', {}, '');
  const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
  await authPost('/api/auth/login/verify', { flow, response: credentialJSON(cred) }, '');
}
async function passkeyCreate(start, token = '') {
  const { flow, options } = await start();
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  return authPost('/api/auth/register/verify', { flow, response: credentialJSON(cred) }, token);
}
/** Face ID again before a sensitive change (good for five minutes). */
async function confirmIt() {
  const { flow, options } = await authPost('/api/auth/verify/options');
  const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
  await authPost('/api/auth/verify/verify', { flow, response: credentialJSON(cred) });
}
async function withConfirm(fn) {
  try { return await fn(); } catch (e) { if (!e.stepUp) throw e; await confirmIt(); return fn(); }
}

// ---------- sign-in screen ----------
let loginMode = 'signin', wasSignedIn = false, storeReady = true;
function setLoginMode(mode) {
  loginMode = mode;
  const code = mode === 'setup' || mode === 'recovery';
  $('signin-panel').hidden = code; $('code-form').hidden = !code;
  $('code-label').textContent = mode === 'recovery' ? 'Recovery code' : 'Setup code from your PC';
  $('code-input').placeholder = mode === 'recovery' ? 'XXXX-XXXX-XXXX' : 'XXXX-XXXX';
  $('code-help').innerHTML = mode === 'recovery'
    ? 'One of the codes security-setup printed. It lets you add a new passkey here, then it’s used up.'
    : 'On your PC, double-click <b>SECURITY-SETUP.cmd</b> and scan its QR. No code to type. A camera-free fallback is on that page.';
  $('show-signin').hidden = !code || !storeReady; $('show-setup').hidden = mode === 'setup'; $('show-recovery').hidden = mode === 'recovery' || !storeReady;
  $('login-error').textContent = '';
  const scanned = mode === 'setup' && !!scannedSetup?.code;
  $('code-label').hidden = scanned; $('code-input').hidden = scanned;
  $('change-setup-code').hidden = !scanned;
  $('code-submit-label').textContent = 'Create passkey';
  if (scanned) {
    $('code-input').value = scannedSetup.code;
    $('code-help').textContent = 'Setup QR scanned. Tap Create passkey and confirm with Face ID — no code to type.';
  }
  if (code && !scanned) setTimeout(() => $('code-input').focus(), 50);
}
async function showLogin(message = '', { locked = wasSignedIn } = {}) {
  signedIn = false; controlling = false; clearTimeout(reconnectTimer);
  const old = socket; socket = null; old?.close();
  meta = null; lastFrame = 0; closeKeyboard(); closeSheet(); closeSecurity();
  app.hidden = true; $('login').hidden = false; $('code-input').blur(); $('code-input').value = '';
  $('install-tip').hidden = !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  $('login-title').textContent = locked ? 'Locked' : 'Desktop Pocket';
  $('login-lead').textContent = locked ? 'Locked after time away. Unlock to keep going.' : 'Your PC, on your phone.';
  $('passkey-signin-label').textContent = locked ? 'Unlock' : 'Sign in with passkey';
  try { const st = await (await fetch('/api/auth/state', { cache: 'no-store' })).json(); storeReady = !!st.ready; } catch {}
  setLoginMode(scannedSetup?.code ? 'setup' : (storeReady ? 'signin' : 'setup'));
  if (!storeReady) $('login-lead').textContent = 'Add your first passkey to start.';
  if (scannedSetup?.code) $('login-lead').textContent = 'Your setup QR is ready. Create your passkey.';
  $('login-error').textContent = message || scannedSetup?.error || (passkeysSupported() ? '' : 'This browser can’t use passkeys. Update iOS, or use Safari or Chrome.');
}
// Safari can reuse an open tab for a new QR instead of reloading it.
window.addEventListener('hashchange', () => {
  const incoming = window.DesktopPocketLink.consume(location, history);
  if (!incoming) return;
  scannedSetup = incoming;
  showLogin('', { locked: false });
});
// Came here from another app on this computer (OpenCode) to sign in? Go back to it.
function goNext() {
  try {
    const next = new URL(new URLSearchParams(location.search).get('next') || '', location.href);
    if (!new URLSearchParams(location.search).get('next') || next.hostname !== location.hostname || !/^https?:$/.test(next.protocol)) return false;
    location.replace(next.href); return true;
  } catch { return false; }
}
async function afterSignIn() { scannedSetup = null; wasSignedIn = true; disconnected = false; $('code-input').blur(); if (goNext()) return; await connect(); }
function busy(btn, on) { btn.disabled = on; btn.classList.toggle('is-busy', on); }
$('passkey-signin').onclick = async () => {
  const btn = $('passkey-signin'); busy(btn, true); $('login-error').textContent = '';
  try { await passkeySignIn(); await afterSignIn(); }
  catch (err) { $('login-error').textContent = passkeyError(err); }
  finally { busy(btn, false); }
};
$('change-setup-code').onclick = () => { scannedSetup = null; $('code-input').value = ''; setLoginMode('setup'); };
$('show-signin').onclick = () => setLoginMode('signin');
$('show-setup').onclick = () => setLoginMode('setup');
$('show-recovery').onclick = () => setLoginMode('recovery');
$('code-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('code-submit'), code = $('code-input').value.trim(); busy(btn, true); $('login-error').textContent = '';
  try {
    if (loginMode === 'setup' && scannedSetup?.expires && scannedSetup.expires <= Date.now()) throw Error('This setup QR expired. Run SECURITY-SETUP.cmd on your PC for a fresh one.');
    if (loginMode === 'recovery') {
      const r = await authPost('/api/auth/recover', { code }, '');
      await passkeyCreate(() => authPost('/api/auth/register/options', {}, r.csrf), r.csrf);
      toast(r.left ? `Passkey added. ${r.left} recovery code${r.left === 1 ? '' : 's'} left.` : 'Passkey added. That was your last recovery code: make new ones on your PC.', 5000);
    } else {
      await passkeyCreate(() => authPost('/api/auth/setup/options', { code }, ''));
      toast('Passkey added. Next time just tap Sign in.');
    }
    await afterSignIn();
  } catch (err) { $('login-error').textContent = passkeyError(err); }
  finally { busy(btn, false); }
});
// Keep the session alive while you're looking at the app; it locks itself after time away.
setInterval(async () => {
  if (document.hidden || !signedIn) return;
  try { const r = await fetch('/api/auth/ping', { cache: 'no-store' }); if (r.status === 401) showLogin(); } catch {}
}, 60000);

// ---------- security sheet ----------
const fmtDay = t => { const d = new Date(t), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
async function openSecurity() {
  clearPhoneQr(); closeSheet(); $('sec-sheet').hidden = false; $('sheet-backdrop').hidden = false; $('computer-box').hidden = true;
  await renderSecurity();
}
function closeSecurity() { clearPhoneQr(); if ($('sec-sheet')) { $('sec-sheet').hidden = true; if ($('sheet').hidden) $('sheet-backdrop').hidden = true; } }
async function renderSecurity() {
  const list = $('passkey-list');
  try {
    const r = await fetch('/api/auth/passkeys', { cache: 'no-store' }); if (r.status === 401) return showLogin();
    const data = await r.json();
    list.replaceChildren(...data.passkeys.map(p => {
      const li = document.createElement('li'); li.className = 'row passkey-row';
      li.innerHTML = '<span><strong></strong><small></small></span><button class="round-button passkey-remove" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9m0-9l-9 9"/></svg></button>';
      li.querySelector('strong').textContent = p.name;
      li.querySelector('small').textContent = [p.current ? 'This sign-in' : '', `Added ${fmtDay(p.created)}`, p.lastUsed ? `used ${fmtDay(p.lastUsed)}` : '', p.backedUp ? 'synced' : ''].filter(Boolean).join(' · ');
      const rm = li.querySelector('button'); rm.setAttribute('aria-label', `Remove ${p.name}`); rm.hidden = data.passkeys.length < 2;
      rm.onclick = async () => {
        try { await withConfirm(() => authPost('/api/auth/passkeys/remove', { id: p.id })); toast('Passkey removed. It can’t sign in anywhere now.'); renderSecurity(); }
        catch (e) { if (e.status === 401) return showLogin(); toast(passkeyError(e)); }
      };
      return li;
    }));
    $('recovery-note').textContent = data.recoveryTotal
      ? `Recovery codes left: ${data.recoveryLeft} of ${data.recoveryTotal}. For new ones, run security-setup recovery on your PC.`
      : 'No recovery codes yet. Run security-setup on your PC to make them.';
    $('security-summary').textContent = `${data.passkeys.length} passkey${data.passkeys.length === 1 ? '' : 's'} · Face ID after ${data.lockMinutes} minutes away`;
  } catch { list.replaceChildren(); }
  try {
    const a = await (await fetch('/api/auth/activity', { cache: 'no-store' })).json();
    $('activity-list').replaceChildren(...(a.events || []).slice(0, 6).map(ev => {
      const li = document.createElement('li'); li.className = 'row';
      li.innerHTML = '<span><strong></strong><small></small></span>';
      li.querySelector('strong').textContent = ev.event.charAt(0).toUpperCase() + ev.event.slice(1);
      li.querySelector('small').textContent = [ev.device, ev.passkey, fmtDay(ev.t)].filter(Boolean).join(' · ');
      if (/refused/.test(ev.event)) li.classList.add('row-warn');
      return li;
    }));
  } catch {}
}
$('open-security').onclick = openSecurity;
$('sec-close').onclick = closeSecurity;
let phoneQrTimer = null, phoneQrLink = '';
function clearPhoneQr() {
  clearInterval(phoneQrTimer); phoneQrTimer = null; phoneQrLink = '';
  $('phone-qr-box').hidden = true; $('phone-qr-image').removeAttribute('src');
}
$('pair-phone').onclick = async () => {
  const button = $('pair-phone'); busy(button, true); clearPhoneQr();
  try {
    const r = await withConfirm(() => authPost('/api/auth/setup-link'));
    if ($('sec-sheet').hidden) return;
    phoneQrLink = r.url; $('phone-qr-image').src = r.image; $('phone-qr-image').hidden = false;
    $('copy-phone-link').hidden = false; $('phone-qr-box').hidden = false;
    const update = () => {
      const left = Math.max(0, r.expires - Date.now());
      $('phone-qr-expiry').textContent = left ? `Expires in ${Math.ceil(left / 60000)} minutes.` : 'Expired. Tap Set up another phone for a new QR.';
      if (!left) { clearInterval(phoneQrTimer); phoneQrLink = ''; $('phone-qr-image').removeAttribute('src'); $('phone-qr-image').hidden = true; $('copy-phone-link').hidden = true; }
    };
    update(); phoneQrTimer = setInterval(update, 1000); $('phone-qr-box').scrollIntoView({block:'nearest'});
  } catch (e) { if (e.status === 401) return showLogin(); toast(passkeyError(e)); }
  finally { busy(button, false); }
};
$('copy-phone-link').onclick = async () => { if (!phoneQrLink) return; try { await navigator.clipboard.writeText(phoneQrLink); toast('Private setup link copied.'); } catch { toast('Use the QR, or make one on your PC with SECURITY-SETUP.cmd.'); } };
$('add-passkey').onclick = async () => {
  try { await withConfirm(() => passkeyCreate(() => authPost('/api/auth/register/options'), csrf)); await session(); toast('Passkey added.'); renderSecurity(); }
  catch (e) { if (e.status === 401) return showLogin(); toast(passkeyError(e)); }
};
$('add-computer').onclick = async () => {
  try {
    const r = await withConfirm(() => authPost('/api/auth/install-token'));
    $('computer-cmd').textContent = `curl -fsS "${location.origin}/install/mac?t=${r.token}" | bash`;
    $('computer-box').hidden = false;
  } catch (e) { if (e.status === 401) return showLogin(); toast(passkeyError(e)); }
};
$('copy-cmd').onclick = async () => { try { await navigator.clipboard.writeText($('computer-cmd').textContent); toast('Copied.'); } catch { toast('Select the text and copy it.'); } };
$('signout-all').onclick = async () => {
  try { await withConfirm(() => authPost('/api/auth/signout-everywhere')); wasSignedIn = false; showLogin('Signed out on every device.', { locked: false }); }
  catch (e) { if (e.status === 401) return showLogin(); toast(passkeyError(e)); }
};

// ---------- start ----------
renderCoach();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
session().then(ok => { if (ok && !goNext()) connect(); }).catch(() => { showLogin('Can’t reach your PC. Turn on Tailscale and try again.', { locked: false }); });
