// Google Analytics (GA4) for the web app — page views only.
//
// Loaded from app.js rather than pasted into index.html's <head>, for two
// reasons. A coach invite link carries a single-use token in its path
// (/coach/<token>, NS-38), and app.js moves it out of the address bar before
// anything else runs — a tag in <head> would run first and could report the
// token as the page's URL or as the next page's referrer. And the app routes
// by hash, which GA4's page reports drop, so every screen would read as "/".
// So the tag is configured with send_page_view off and app.js reports each
// navigation itself through trackPageView, with the route reduced by
// analyticsPath to its shape: "/event/:id", never a record id, query string,
// share slug or driver's name.
//
// It runs on the production hosts only, so local dev, the test suites and
// the promo capture never send anything.

export const GA_MEASUREMENT_ID = "G-JXM9CX77RQ";
export const ANALYTICS_HOSTS = new Set(["trackevolution.app", "www.trackevolution.app"]);

// Whether this host reports to Google Analytics.
export function analyticsEnabled(hostname) {
  return ANALYTICS_HOSTS.has(hostname);
}

// A record id: a server id, or an offline-created temp id ("tmp-3").
const ID_SEGMENT = /^(\d+|tmp-\d+)$/;

// The page as Analytics sees it: the hash route's shape with ids replaced.
// The path matters only for share pages (/share/<slug>[/wrapped/<year>]);
// every other page is the SPA shell at "/".
export function analyticsPath(pathname, hash) {
  let prefix = "";
  const share = (pathname || "").match(/^\/share\/[^/]+(?:\/wrapped\/(\d{4}))?\/?$/);
  if (share) prefix = share[1] ? `/share/:slug/wrapped/${share[1]}` : "/share/:slug";
  const route = (hash || "").replace(/^#/, "").split("?")[0];
  const parts = route.split("/").filter(Boolean);
  const shaped = parts.map((p, i) => (parts[i - 1] === "wrapped" && /^\d{4}$/.test(p) ? p : ID_SEGMENT.test(p) ? ":id" : p));
  const tail = shaped.length ? `/${shaped.join("/")}` : "";
  return prefix + tail || "/";
}

let gtagFn = null;

// The page fields every hit carries — page views and GA's own automatic
// events alike, so neither sees the real address.
function pageFields(win) {
  const path = analyticsPath(win.location.pathname, win.location.hash);
  return {
    page_location: win.location.origin + path,
    page_path: path,
    // A share page's title names its driver; the path already says which page.
    page_title: "Track Evolution",
  };
}

// Load gtag.js and configure it. Call once, after the invite token has left
// the address bar.
export function initAnalytics(win = window) {
  if (gtagFn || !analyticsEnabled(win.location.hostname)) return;
  win.dataLayer = win.dataLayer || [];
  gtagFn = function gtag() {
    win.dataLayer.push(arguments);
  };
  win.gtag = gtagFn;
  gtagFn("js", new Date());
  gtagFn("config", GA_MEASUREMENT_ID, { ...pageFields(win), send_page_view: false });
  const s = win.document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  win.document.head.appendChild(s);
}

// Report the page now showing. A no-op when analytics is off.
export function trackPageView(win = window) {
  if (!gtagFn) return;
  const fields = pageFields(win);
  gtagFn("set", fields);
  gtagFn("event", "page_view", fields);
}
