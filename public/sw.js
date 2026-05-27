const CACHE = 'dads-nightmare-v1';

// Don't skip waiting automatically — let the page prompt the user to update.
// The page sends { type: 'SKIP_WAITING' } when the user taps the banner.
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      try {
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        return (await cache.match(e.request)) ?? new Response('Offline', { status: 503 });
      }
    })
  );
});
