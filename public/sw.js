// Track Evolution service worker: offline app shell + last-known API data.
//
// Strategies:
//  - App shell (same-origin static files): stale-while-revalidate, so there's
//    no build-step cache busting to manage — updates land on the next load.
//  - Navigations: network-first, falling back to the cached shell offline
//    (the Worker serves index.html for every SPA path, so "/" covers them all).
//  - GET /api/*: network-first with the last successful response as the
//    offline fallback — the logbook stays readable at the track.
//  - /auth/* and non-GET requests are never intercepted.

const VERSION = "v1";
const SHELL_CACHE = `th-shell-${VERSION}`;
// app.js deletes caches matching the "th-data" prefix on sign-out — keep the
// two in sync if this name ever changes.
const DATA_CACHE = `th-data-${VERSION}`;

const SHELL = [
  "/",
  "/style.css",
  "/app.js",
  "/pdr.js",
  "/js/api.js",
  "/js/chart.js",
  "/js/format.js",
  "/js/pdr-import.js",
  "/js/theme.js",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Fetch, and on 2xx store a copy in the named cache.
async function fetchAndCache(req, cacheName) {
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(cacheName);
    cache.put(req, res.clone());
  }
  return res;
}

async function networkFirst(req, cacheName, fallbackUrl) {
  try {
    return await fetchAndCache(req, cacheName);
  } catch (err) {
    const cached = await caches.match(fallbackUrl || req);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cached = await caches.match(req);
  const refresh = fetchAndCache(req, cacheName).catch(() => cached);
  return cached || refresh;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/auth/")) return; // never cache auth
    if (url.pathname.startsWith("/api/")) {
      e.respondWith(networkFirst(req, DATA_CACHE));
      return;
    }
    if (req.mode === "navigate") {
      e.respondWith(networkFirst(req, SHELL_CACHE, "/"));
      return;
    }
    e.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  // Google Fonts (css + woff2), so type survives offline too.
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
});
