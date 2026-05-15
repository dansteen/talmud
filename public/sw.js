// Service worker for offline support.
//
// Three buckets:
//   - APP_CACHE: app shell (index.html + manifest + icons) and hashed
//     /assets/* — populated on install and on first request, cache-first.
//     Bumping APP_VERSION causes old shells to be evicted in `activate`.
//   - PDF_CACHE: shas-api PDFs (cache-first, indefinite). Survives app
//     shell version bumps so cached pages stay readable after updates.
//
// On a new deploy: a new sw.js is downloaded, install fires, it
// caches the fresh shell, and the SW enters `waiting`. We do NOT
// auto-skip waiting — the page asks via postMessage SKIP_WAITING so
// the user controls when the swap happens.

const APP_VERSION = 'v1';
const APP_CACHE = `talmud-app-${APP_VERSION}`;
const PDF_CACHE = 'talmud-pdfs-v1';
const SHAS_PATH = '/shas-api/';

// Files known at SW install time. /assets/* (Vite hashed bundles) aren't
// listed here because their hashes change per build; they're cached on
// first request by the fetch handler instead.
const APP_PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // addAll is atomic — any miss aborts install. Use individual puts so
    // a single 404 (e.g. icons not yet deployed) doesn't block the rest.
    await Promise.all(APP_PRECACHE.map(async url => {
      try {
        const resp = await fetch(url, { cache: 'reload' });
        if (resp.ok) await cache.put(url, resp);
      } catch { /* offline at install time — fine, populated on first load */ }
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => {
      if (n !== APP_CACHE && n !== PDF_CACHE) return caches.delete(n);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // shas-api PDFs: cache-first, store in PDF cache so they survive
  // app shell version bumps.
  if (url.pathname.startsWith(SHAS_PATH)) {
    event.respondWith(cacheFirst(req, PDF_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return; // pass-through

  // Navigations: network-first (fresh HTML when online), cache fallback
  // so the app still loads offline from a previously-cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstThenCache(req, APP_CACHE, '/index.html'));
    return;
  }

  // Hashed assets and the static app shell files: cache-first.
  if (url.pathname.startsWith('/assets/') || APP_PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(req, APP_CACHE));
    return;
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstThenCache(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fb = await cache.match(fallbackUrl);
      if (fb) return fb;
    }
    return new Response('Offline and not cached', { status: 503 });
  }
}

// Prefetch all pages of a tractate on demand (unchanged from before —
// preserves the existing tractate-prefetch behavior the app uses).
self.addEventListener('message', async event => {
  if (event.data?.type !== 'PREFETCH_TRACTATE') return;

  const { slug, pages } = event.data;
  const cache = await caches.open(PDF_CACHE);
  const client = await self.clients.get(event.source.id);

  let loaded = 0;
  const total = pages.length;

  const BATCH = 4;
  for (let i = 0; i < pages.length; i += BATCH) {
    const batch = pages.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ url }) => {
      if (await cache.match(url)) { loaded++; return; }
      try {
        const resp = await fetch(url);
        if (resp.ok) await cache.put(url, resp);
      } catch { /* skip failed pages */ }
      loaded++;
      client?.postMessage({ type: 'PREFETCH_PROGRESS', slug, loaded, total });
    }));
  }

  client?.postMessage({ type: 'PREFETCH_DONE', slug });
});
