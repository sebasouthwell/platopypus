// PlatOpypus service worker: one job. When the box does not answer (it is stopped, or Cloudflare says the origin is
// down), show the "box is off" page kept on this device, which can start the box through the control Lambda.
// Nothing else is cached: the app itself always comes from the box, so updates are never held back.
const CACHE = 'plato-offline-v3';
const OFFLINE = ['/offline.html', '/offline.js', '/offline.css', '/mascot.svg', '/fonts/geist.woff2', '/icons/icon-192.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('plato-offline-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Cloudflare's own error pages when the box is unreachable, and the plain gateway errors.
const DOWN = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
const offlinePage = async () => (await caches.match('/offline.html')) || new Response('The box is off.', { status: 503, headers: { 'Content-Type': 'text/plain' } });

self.addEventListener('fetch', e => {
    const req = e.request; const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    // the offline page's own files, from the cache when the box is off
    if (OFFLINE.includes(url.pathname)) { e.respondWith(fetch(req).catch(() => caches.match(url.pathname))); return; }
    if (req.mode !== 'navigate') return;                       // API calls, assets: straight to the box as always
    e.respondWith((async () => {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
        try { const res = await fetch(req, { signal: ctl.signal }); clearTimeout(t); return DOWN.has(res.status) ? offlinePage() : res; }
        catch { clearTimeout(t); return offlinePage(); }
    })());
});
