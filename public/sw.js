// Track Evolution service worker: offline app shell + last-known API data.
//
// Strategies:
//  - App shell (same-origin static files): stale-while-revalidate, so there's
//    no build-step cache busting to manage — updates land on the next load.
//  - Navigations: network-first, falling back to the cached shell offline.
//    The shell is cached as SHELL_URL, never as "/": the Worker answers "/"
//    with the landing page for a visitor with no session, and that must not
//    become what a signed-in driver gets offline.
//  - GET /api/*: network-first with the last successful response as the
//    offline fallback — the logbook stays readable at the track.
//  - /auth/* and non-GET requests are never intercepted.

const VERSION = "v1";
const SHELL_CACHE = `th-shell-${VERSION}`;
// app.js deletes caches matching the "th-data" prefix on sign-out — keep the
// two in sync if this name ever changes.
const DATA_CACHE = `th-data-${VERSION}`;

// A path the Worker doesn't claim, so it is always the app shell (index.html).
// The landing page's "Open the app" points here too (tools/landing.mjs).
const SHELL_URL = "/login";

const SHELL = [
  SHELL_URL,
  "/style.css",
  "/app.js",
  "/pdr.js",
  "/js/api.js",
  "/js/celebrate.js",
  "/js/channel-graphs.js",
  "/js/chart.js",
  "/js/format.js",
  "/js/lap-stats.js",
  "/js/theme.js",
  "/js/trackmap.js",
  "/js/year-review.js",
  "/js/import/channels.js",
  "/js/import/geo.js",
  "/js/import/gpmf.js",
  "/js/import/parse.js",
  "/js/import/pdr-laps.js",
  "/js/import/ui.js",
  "/js/import/vbo.js",
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

// A navigation: the network's answer, else the cached shell. An online load
// of the app's home refreshes that cached shell — unless the answer is the
// landing page (the Worker marks it X-TE-Page: landing), which must never
// become what a signed-in driver gets offline.
async function navigate(req) {
  try {
    const res = await fetch(req);
    const path = new URL(req.url).pathname;
    if (res.ok && (path === "/" || path === SHELL_URL) && res.headers.get("X-TE-Page") !== "landing") {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(SHELL_URL, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(SHELL_URL);
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
    // The store redirect answers per device; a cached copy (or the shell
    // fallback offline) would be the wrong answer.
    if (url.pathname === "/get") return;
    // A coach invite link carries a single-use token in its path; keep it out
    // of both caches (NS-38).
    if (url.pathname.startsWith("/coach/") || url.pathname.startsWith("/api/coaching/invites/")) return;
    // A logbook export (NS-44) is a download, not data: network-first would
    // copy the whole file — telemetry and all — into th-data-*.
    if (url.pathname.startsWith("/api/export/")) return;
    // Web billing (NS-49): a price or a trial answered from a cache is one the
    // checkout behind it may not honour — the plans are live or not shown.
    if (url.pathname.startsWith("/api/billing/")) return;
    // Best-lap video (NS-45): the file is a ranged stream a cache would copy
    // whole, and its signed URL expires in an hour — neither belongs in a cache.
    if (url.pathname.startsWith("/clips/") || /^\/api\/(students\/\d+\/)?clips\//.test(url.pathname)) return;
    // Connecting YouTube (NS-46) is a redirect round trip with Google, never
    // a page to cache or to answer with the shell offline.
    if (url.pathname.startsWith("/youtube/")) return;
    if (url.pathname.startsWith("/api/")) {
      e.respondWith(networkFirst(req, DATA_CACHE));
      return;
    }
    if (req.mode === "navigate") {
      e.respondWith(navigate(req));
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
