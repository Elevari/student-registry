/* ============================================================
   ClassTrack Service Worker
   ============================================================ */
const CACHE_NAME = 'classtrack-v11';

// Build absolute URLs based on the SW's own location
const BASE = self.location.href.replace('/service-worker.js', '');

const STATIC_ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/styles.css',
  BASE + '/app.js',
  BASE + '/manifest.json',
  BASE + '/icons/icon-192.png',
  BASE + '/icons/icon-512.png'
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of STATIC_ASSETS) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
          await cache.put(url, res);
          console.log('[SW] Cached:', url);
        }
      } catch (e) {
        console.warn('[SW] Failed to cache:', url, e.message);
      }
    }
    await self.skipWaiting();
  })());
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
    console.log('[SW] Active, controlling all clients');
  })());
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always network: GAS API calls
  if (url.host.includes('script.google') || url.pathname.includes('/exec')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Always network: cross-origin (Google Fonts etc.)
  if (url.origin !== self.location.origin) return;

  // Cache-first for same-origin assets
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;

    try {
      const response = await fetch(event.request);
      if (response && response.status === 200) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      // Offline — serve cached index.html for page navigations
      if (event.request.mode === 'navigate') {
        const fallback = await caches.match(BASE + '/index.html')
                      || await caches.match(BASE + '/');
        if (fallback) return fallback;
      }
      return new Response('Offline', { status: 503 });
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
