// MyRide Service Worker — v1
// Strategy: network-first for API/socket, cache-first for static assets.

const CACHE_NAME = 'myride-v1';

// Static assets worth caching for fast repeat loads
const PRECACHE = [
  '/customer',
  '/driver',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ── Install: pre-cache static shell ─────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Use individual adds so one failure doesn't abort the whole install
      Promise.allSettled(PRECACHE.map(url => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: remove stale caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API & socket, cache-first for everything else ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept: API calls, Socket.io, cross-origin (CDN assets handled separately)
  const isApi    = url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io');
  const isChrome = url.protocol === 'chrome-extension:';
  if (isApi || isChrome) return;  // fall through to browser default

  event.respondWith(
    // Network first — keeps pages fresh
    fetch(request)
      .then(networkResponse => {
        // Cache successful GET responses
        if (request.method === 'GET' && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return networkResponse;
      })
      .catch(() =>
        // Network failed — serve from cache (offline fallback)
        caches.match(request).then(cached => {
          if (cached) return cached;
          // Last resort: return a minimal offline page for navigation requests
          if (request.mode === 'navigate') {
            return caches.match('/customer') || caches.match('/driver');
          }
          return new Response('Offline', { status: 503 });
        })
      )
  );
});
