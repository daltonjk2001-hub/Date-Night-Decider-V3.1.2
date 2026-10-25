'use strict';

/* Date Night Decider Service Worker v3.1.2 */

const CACHE_NAME = 'date-night-decider-v3.1.2-fix1';
const LEGACY_CACHE_PREFIX = 'date-night-decider-';

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=3.1.2-fix1',
  './app.js?v=3.1.2-fix1',
  './vendor/dexie.min.js',
  './vendor/peerjs.min.js'
];

const OPTIONAL_ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

async function cacheSafely(cache, request, response) {
  try {
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn('Cache update failed:', request.url, error);
  }
}

async function findCachedResponse(cache, request, cacheKey) {
  return (
    await cache.match(request, { ignoreSearch: true }) ||
    await cache.match(cacheKey, { ignoreSearch: true }) ||
    null
  );
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(CORE_ASSETS);
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
    await Promise.all(OPTIONAL_ASSETS.map(asset => cache.add(asset).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => {
      if (key.startsWith(LEGACY_CACHE_PREFIX) && key !== CACHE_NAME) {
        return caches.delete(key);
      }
      return Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  const scopeUrl = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scopeUrl.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = request.mode === 'navigate' ? new URL('./index.html', scopeUrl).href : request;

    try {
      const response = await fetch(request);
      if (response.ok) {
        await cacheSafely(cache, cacheKey, response);
        return response;
      }
      const fallback = await findCachedResponse(cache, request, cacheKey);
      if (fallback) return fallback;
      return response;
    } catch (error) {
      const fallback = await findCachedResponse(cache, request, cacheKey);
      if (fallback) return fallback;
      if (request.mode === 'navigate') {
        const indexUrl = new URL('./index.html', scopeUrl).href;
        const indexFallback = await cache.match(indexUrl);
        if (indexFallback) return indexFallback;
      }
      throw error;
    }
  })());
});
