/* Lift Ledger service worker: lets the app open offline.
 * Strategy: network first (testers always get the newest files when online), falling back to the
 * saved copy after 3 seconds or when offline. Only same-origin GET requests are handled, and the
 * app never calls any other site.
 */
const CACHE = 'lift-ledger-v1';
const SHELL = [
  './', './index.html', './styles.css', './config.js', './logic.js', './storage.js', './app.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png',
  './icons/icon-512.png', './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

function networkFirst(req, fallbackUrl) {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (res) { if (!settled && res) { settled = true; resolve(res); } };
    const fromCache = async function () {
      return (await caches.match(req)) || (fallbackUrl ? await caches.match(fallbackUrl) : undefined);
    };
    const timer = setTimeout(async function () { done(await fromCache()); }, 3000);
    fetch(req).then(async function (res) {
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      clearTimeout(timer);
      done(res);
    }).catch(async function () {
      clearTimeout(timer);
      done((await fromCache()) || Response.error());
    });
  });
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req, req.mode === 'navigate' ? './index.html' : null));
});
