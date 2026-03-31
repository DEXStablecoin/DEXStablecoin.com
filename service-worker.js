// ════════════════════════════════════════════════
// StableX DEX — Service Worker
// PWA offline support, cache-first for static assets
// ════════════════════════════════════════════════

const CACHE_NAME    = 'stablex-v1';
const OFFLINE_URL   = '/mobile.html';

// Static assets to pre-cache on install
const PRECACHE_URLS = [
  '/mobile.html',
  '/manifest.json',
  // Google Fonts (cached on first load via fetch handler)
];

// ── Install: pre-cache shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: strategy per request type ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. WebSocket — never intercept
  if (request.url.startsWith('ws://') || request.url.startsWith('wss://')) return;

  // 2. Backend API calls — network-only (real-time data, no caching)
  const isApiCall = (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('trycloudflare.com') ||
    url.hostname.includes('ngrok')
  );
  if (isApiCall) {
    event.respondWith(fetch(request).catch(() => networkError()));
    return;
  }

  // 3. Google Fonts / CDN scripts — cache-first with network fallback
  const isCDN = (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  );
  if (isCDN) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // 4. Navigation requests (HTML pages) — network-first, offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache the fresh page
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline: serve cached page or offline shell
          return caches.match(request)
            .then(cached => cached || caches.match(OFFLINE_URL));
        })
    );
    return;
  }

  // 5. Static assets (JS, CSS, images, fonts) — cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached || networkError());
    })
  );
});

function networkError() {
  return new Response(
    JSON.stringify({ ok: false, error: 'Network unavailable' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

// ── Background sync: retry failed buy orders when back online ──
self.addEventListener('sync', event => {
  if (event.tag === 'retry-buy') {
    event.waitUntil(retryPendingBuys());
  }
});

async function retryPendingBuys() {
  // Placeholder: retrieve queued buy payloads from IndexedDB and retry
  // Implementation depends on your backend /api/broadcast-tx endpoint
  console.log('[SW] Background sync: retry-buy triggered');
}

// ── Push notifications (optional) ──
self.addEventListener('push', event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch(e) { return; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'StableX DEX', {
      body:    data.body || '',
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     data.tag  || 'stablex',
      data:    data.url  ? { url: data.url } : {},
      actions: data.actions || [],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/mobile.html';
  event.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      const existing = list.find(c => c.url === url && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
