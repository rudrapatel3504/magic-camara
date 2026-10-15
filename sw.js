// Service Worker - OnePlus 12R Camera v14
const CACHE_NAME = 'magic-camera-v14';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((res) => res)
      .catch(() => caches.match(event.request))
  );
});
