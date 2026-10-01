// Google Analytics (GA4) for the web app — page views only, behind a consent
// banner for visitors in the UK and the EU.
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
// Consent (analyticsPlan): a choice the visitor made is final either way. With
// none, a visitor whose time zone is in Europe (consentTimeZone) gets the
// banner and no tag at all until they accept; anyone else gets the tag, with
// Google's consent mode defaulting analytics_storage to denied for the
// CONSENT_REGIONS as the backstop for a European whose clock doesn't say so —
// Google decides that one by IP, which the client can't. The choice lives in
// this browser's localStorage and is changed from the footer's "Cookies" link
// or Settings, both of which reopen the banner. site/analytics.js is the docs
// site's copy of the same rules; keep the two in step.
//
// Google Tag Manager (GTM_CONTAINER_ID) loads in the same place and under
// the same decision as the GA tag: never from index.html, never before the
// consent defaults are in the dataLayer, and not at all where the visitor
// hasn't been asked or said no. GTM's <noscript> iframe is deliberately left
// out — it would load for a visitor with JavaScript off, who can't be shown
// the banner, and the app doesn't run without JavaScript anyway. Each page
// view is also pushed as a plain "te_page_view" dataLayer event carrying the
// shaped page fields, which is what a container's triggers and variables
// should read rather than GTM's built-in Page URL / Page Title.
//
// It runs on the production hosts only, so local dev, the test suites and
// the promo capture never send anything.

export const GA_MEASUREMENT_ID = "G-JXM9CX77RQ";
export const GTM_CONTAINER_ID = "GTM-MQD633J7";
export const ANALYTICS_HOSTS = new Set(["trackevolution.app", "www.trackevolution.app"]);
export const CONSENT_KEY = "te-analytics-consent";
export const PRIVACY_URL = "https://docs.trackevolution.app/docs/privacy.html#analytics";

// The EEA, the UK and Switzerland, as ISO 3166-1 codes for consent mode.
export const CONSENT_REGIONS = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO", "GB", "CH",
];

// Every Europe/* zone, plus the EU's and EEA's Atlantic islands and Cyprus.
const CONSENT_ZONES = /^(Europe\/|Arctic\/|Atlantic\/(Azores|Canary|Faroe|Madeira|Reykjavik)$|Asia\/(Nicosia|Famagusta)$)/;

// Whether this host reports to Google Analytics.
export function analyticsEnabled(hostname) {
  return ANALYTICS_HOSTS.has(hostname);
}

// Whether a visitor in this IANA time zone is asked before anything loads.
export function consentTimeZone(tz) {
  return CONSENT_ZONES.test(tz || "");
}

// What to do on load: { load, banner }. `choice` is "granted", "denied" or
// null (never asked).
export function analyticsPlan(choice, tz) {
  if (choice === "granted") return { load: true, banner: false };
  if (choice === "denied") return { load: false, banner: false };
  return consentTimeZone(tz) ? { load: false, banner: true } : { load: true, banner: false };
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

export function consentBannerHtml() {
  return `<p>We use Google Analytics cookies to count visits. <a href="${PRIVACY_URL}" target="_blank" rel="noopener">Learn more</a></p>
  <div class="consent-actions">
    <button type="button" class="btn small" data-consent="denied">Decline</button>
    <button type="button" class="btn small" data-consent="granted">Accept</button>
  </div>`;
}

function timeZone(win) {
  try {
    return (win.Intl || Intl).DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

export function readConsent(win = window) {
  try {
    const v = win.localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

function saveConsent(win, choice) {
  try {
    win.localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Storage unavailable — the choice holds for this page only.
  }
}

let gtagFn = null;
let enabled = false;

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

// `explicit`: the visitor accepted, so no regional default applies.
function loadTag(win, explicit) {
  win.dataLayer = win.dataLayer || [];
  gtagFn = function gtag() {
    win.dataLayer.push(arguments);
  };
  win.gtag = gtagFn;
  const noAds = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };
  gtagFn("consent", "default", { ...noAds, analytics_storage: "granted" });
  if (!explicit) gtagFn("consent", "default", { ...noAds, analytics_storage: "denied", region: CONSENT_REGIONS });
  gtagFn("js", new Date());
  gtagFn("config", GA_MEASUREMENT_ID, { ...pageFields(win), send_page_view: false });
  // Tag Manager after the consent defaults, so its tags start from them.
  win.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  for (const src of [
    `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`,
    `https://www.googletagmanager.com/gtm.js?id=${GTM_CONTAINER_ID}`,
  ]) {
    const s = win.document.createElement("script");
    s.async = true;
    s.src = src;
    win.document.head.appendChild(s);
  }
}

// GA's own cookies (_ga, _ga_<id>), on the bare host and the parent domain.
function clearGaCookies(win) {
  const doc = win.document;
  const names = (doc.cookie || "").split(";").map((c) => c.split("=")[0].trim()).filter((n) => /^_ga(_|$)/.test(n));
  const host = win.location.hostname;
  for (const n of names) {
    for (const domain of ["", `; domain=${host}`, `; domain=.${host.replace(/^www\./, "")}`]) {
      doc.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
    }
  }
}

// Record the visitor's choice and act on it now.
export function setAnalyticsConsent(choice, win = window) {
  saveConsent(win, choice);
  closeConsentBanner(win);
  if (!enabled) return;
  win[`ga-disable-${GA_MEASUREMENT_ID}`] = choice !== "granted";
  if (choice === "granted") {
    if (!gtagFn) {
      loadTag(win, true);
      trackPageView(win);
    } else {
      gtagFn("consent", "update", { analytics_storage: "granted" });
    }
  } else {
    gtagFn?.("consent", "update", { analytics_storage: "denied" });
    clearGaCookies(win);
  }
}

// Show the banner (again). Works on any host, so the control can be tried in
// dev; only the production hosts ever load the tag.
export function openConsentBanner(win = window) {
  const doc = win.document;
  if (doc.getElementById("consent-banner")) return;
  const el = doc.createElement("div");
  el.id = "consent-banner";
  el.className = "consent-banner";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "Cookie consent");
  el.innerHTML = consentBannerHtml();
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-consent]");
    if (btn) setAnalyticsConsent(btn.dataset.consent, win);
  });
  doc.body.appendChild(el);
}

function closeConsentBanner(win) {
  win.document.getElementById("consent-banner")?.remove();
}

// Decide, and load the tag or ask. Call once, after the invite token has left
// the address bar.
export function initAnalytics(win = window) {
  if (enabled || !analyticsEnabled(win.location.hostname)) return;
  enabled = true;
  const choice = readConsent(win);
  const plan = analyticsPlan(choice, timeZone(win));
  if (plan.load) loadTag(win, choice === "granted");
  if (plan.banner) openConsentBanner(win);
}

// Report the page now showing. A no-op when analytics is off or declined.
export function trackPageView(win = window) {
  if (!gtagFn || win[`ga-disable-${GA_MEASUREMENT_ID}`]) return;
  const fields = pageFields(win);
  gtagFn("set", fields);
  gtagFn("event", "page_view", fields);
  win.dataLayer.push({ event: "te_page_view", ...fields });
}
