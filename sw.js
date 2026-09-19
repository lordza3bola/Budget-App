// Budget app service worker.
// Goal: the app shell (app.html + the pinned library versions it loads)
// opens instantly and works with no connection. Firebase's own traffic
// (auth + Firestore sync) is left completely alone — never cached, never
// intercepted — so your data always reflects the network, not a stale copy.
const CACHE_NAME = 'budget-app-shell-v1';

// Same-origin app shell — always cached on install.
const CORE_ASSETS = [
  './app.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png'
];

// Third-party assets the app itself loads with a <script>/<link> tag.
// These are pinned to exact versions in app.html, so caching them
// indefinitely is safe — a version bump in app.html is a new URL anyway.
const LIB_HOSTS = [
  'cdnjs.cloudflare.com',
  'www.gstatic.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// Hosts that must NEVER be cached or served from cache — live sync traffic.
const NEVER_CACHE_HOSTS = [
  'firestore.googleapis.com',
  'www.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch writes/POSTs — let them hit the network directly

  const url = new URL(req.url);
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return; // let Firebase traffic through untouched

  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !LIB_HOSTS.includes(url.hostname)) return; // unknown third party — don't intercept

  // A plain "/" or "/Budget-App/" request should resolve to the app shell too.
  const isNavigation = req.mode === 'navigate';

  event.respondWith(
    caches.match(isNavigation ? './app.html' : req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(isNavigation ? './app.html' : req, copy));
        }
        return res;
      }).catch(() => cached); // offline — fall back to whatever's cached
      // Cache-first: instant load if we have it, and refresh the cache quietly in the background.
      return cached || network;
    })
  );
});
