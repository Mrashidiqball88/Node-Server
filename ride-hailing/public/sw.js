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

// ── Push: show notification when the app is closed ──────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title   = data.title || '🚗 New Ride Request!';
  const options = {
    body:              data.body  || 'A new ride request is waiting for you.',
    icon:              '/icon-192.png',
    badge:             '/icon-192.png',
    tag:               'ride-request',
    requireInteraction: true,
    vibrate:           [400, 150, 400, 150, 400],
    data:              { url: data.url || '/driver' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click: focus or open the Driver App ─────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/driver';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus an existing driver-app tab if one is open
      for (const client of list) {
        if (client.url.includes('/driver') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
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
