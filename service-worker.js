/* ============================================================
   ClassTrack Service Worker  v1.0
   ============================================================ */

const CACHE_NAME = 'classtrack-v10';

const STATIC_ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const asset of STATIC_ASSETS) {
        try {
          await cache.add(new Request(asset, { cache: 'reload' }));
        } catch (e) {
          console.warn('[SW] Could not cache:', asset);
        }
      }
    }).then(() => {
      console.log('[SW] Install complete, skipping waiting');
      return self.skipWaiting();
    })
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => {
        console.log('[SW] Activated, claiming clients');
        return self.clients.claim();
      })
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip Google Apps Script requests — always network
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

  // Skip cross-origin requests (fonts, etc.)
  if (url.origin !== self.location.origin) return;

  // Cache-first for everything else
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        console.log('[SW] Serving from cache:', event.request.url);
        return cached;
      }
      return fetch(event.request).then(response => {
        // Cache successful responses
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — serve index.html for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('index.html');
        }
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
