const CACHE_NAME = 'flowstate-v1'
const OFFLINE_URL = '/offline'

const PRECACHE_URLS = [
  '/offline',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
]

// Install: precache offline page and critical assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  )
  self.skipWaiting()
})

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  )
  self.clients.claim()
})

// Fetch handler
self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Skip API routes and cross-origin requests
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    return
  }

  // Navigation: network-first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL))
    )
    return
  }

  // Static assets: stale-while-revalidate
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    /\.(js|css|woff2?|png|jpg|svg|ico)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const fetched = fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone())
            return response
          })
          return cached || fetched
        })
      )
    )
  }
})
