const CACHE_VERSION = 'v5';
const CACHE_NAME = `sheti-diary-pro-${CACHE_VERSION}`;
const FALLBACK_URL = './index.html';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192x192.png',
  './icon-512x512.png',
  './image_0.png',
  './image_01.png',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+Marathi:wght@400;600;700;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js',
  'https://cdn.jsdelivr.net/npm/sweetalert2@11',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/compressorjs/1.1.1/compressor.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.css'
  , './styles.css'
];

function isNavigationRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('install', event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await Promise.all(PRECACHE_URLS.map(async url => {
        try {
          const request = new Request(url, {
            mode: url.startsWith('http') ? 'no-cors' : 'same-origin'
          });
          const response = await fetch(request);
          if (response && (response.ok || response.type === 'opaque')) {
            await cache.put(url, response.clone());
          }
        } catch (error) {
          console.warn('Precache failed for:', url, error);
        }
      }));
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(cacheName => cacheName !== CACHE_NAME)
          .map(oldCache => caches.delete(oldCache))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') {
    return;
  }

  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
    return;
  }

  if (isNavigationRequest(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(FALLBACK_URL))
    );
    return;
  }

  // Stale-While-Revalidate Strategy:
  // 1. Return cached version immediately (if available)
  // 2. Update cache from network in background
  // 3. Next visit will have fresh content
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      // If we have a cached response, serve it immediately
      if (cachedResponse) {
        // Fetch fresh content in background without blocking the response
        fetch(event.request)
          .then(networkResponse => {
            // Only cache successful responses
            if (networkResponse && networkResponse.ok && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseClone);
              });
            }
          })
          .catch(error => {
            console.debug('Background fetch failed (will use cache):', event.request.url, error);
          });
        
        return cachedResponse;
      }

      // No cached response, fetch from network
      return fetch(event.request)
        .then(networkResponse => {
          // Cache successful responses
          if (networkResponse && networkResponse.ok && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // Network failed and no cache available
          if (isNavigationRequest(event.request)) {
            return caches.match(FALLBACK_URL);
          }
          return new Response('Network request failed and cache is not available', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({
              'Content-Type': 'text/plain'
            })
          });
        });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
