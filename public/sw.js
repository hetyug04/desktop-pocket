// Never cache sessions, screen frames or API responses. Offline is an explicit state.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desktop Pocket — offline</title><body style="background:#000;color:#f1f2f8;font:16px system-ui;padding:32px"><h1>Desktop is offline</h1><p>Connect Tailscale on your phone and keep the PC awake. Then reopen Desktop Pocket.</p><button onclick="location.reload()" style="padding:16px;font:inherit">Try again</button>',{headers:{'Content-Type':'text/html; charset=utf-8'}})));
});
