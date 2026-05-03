const CACHE = 'talmud-pdfs-v1';
const SHAS_PATH = '/shas-api/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith(SHAS_PATH)) {
    event.respondWith(cacheFirst(event.request));
  }
  // All other requests go straight to network (app shell is versioned by Vite)
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

// Prefetch all pages of a tractate on demand
self.addEventListener('message', async event => {
  if (event.data?.type !== 'PREFETCH_TRACTATE') return;

  const { slug, pages } = event.data; // pages: [{url, daf, amud}]
  const cache = await caches.open(CACHE);
  const client = await self.clients.get(event.source.id);

  let loaded = 0;
  const total = pages.length;

  // Fetch with limited concurrency (4 at a time)
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
