// Google Analytics (GA4) for the docs site, behind a consent banner for
// visitors in the UK and the EU.
//
// The same rules as the web app's public/js/analytics.js — keep the two in
// step. A choice the visitor made is final either way. With none, a visitor
// whose time zone is in Europe gets the banner and no tag until they accept;
// anyone else gets the tag, with Google's consent mode defaulting
// analytics_storage to denied for the EEA, the UK and Switzerland (by IP) as
// the backstop. The choice lives in this browser's localStorage, and the
// footer's "Cookies" link reopens the banner to change it. Google Tag Manager
// loads with the GA tag, under the same decision and after the consent
// defaults; its <noscript> iframe is left out because a visitor without
// JavaScript can't be shown the banner.
(function () {
  var ID = "G-JXM9CX77RQ";
  var GTM = "GTM-MQD633J7";
  var KEY = "te-analytics-consent";
  var HOSTS = ["docs.trackevolution.app", "richie97.github.io"];
  var REGIONS = [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
    "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
    "IS", "LI", "NO", "GB", "CH",
  ];
  var ZONES = /^(Europe\/|Arctic\/|Atlantic\/(Azores|Canary|Faroe|Madeira|Reykjavik)$|Asia\/(Nicosia|Famagusta)$)/;
  var privacyUrl = new URL("docs/privacy.html#analytics", document.currentScript.src).href;
  // The phone apps open these pages in their own web view, which marks its
  // user agent "TrackEvolution-App". The apps report screens by route shape
  // and nothing else, so a page read inside one sends nothing and asks nothing.
  var inApp = /\bTrackEvolution-App\b/.test(navigator.userAgent);
  var enabled = !inApp && HOSTS.indexOf(location.hostname) !== -1;
  var loaded = false;

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "granted" || v === "denied" ? v : null;
    } catch (e) {
      return null;
    }
  }
  function save(v) {
    try {
      localStorage.setItem(KEY, v);
    } catch (e) {}
  }
  function timeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {
      return "";
    }
  }

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    dataLayer.push(arguments);
  }

  function load(explicit) {
    loaded = true;
    var noAds = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };
    gtag("consent", "default", Object.assign({ analytics_storage: "granted" }, noAds));
    if (!explicit) gtag("consent", "default", Object.assign({ analytics_storage: "denied", region: REGIONS }, noAds));
    gtag("js", new Date());
    gtag("config", ID);
    dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
    [
      "https://www.googletagmanager.com/gtag/js?id=" + ID,
      "https://www.googletagmanager.com/gtm.js?id=" + GTM,
    ].forEach(function (src) {
      var s = document.createElement("script");
      s.async = true;
      s.src = src;
      document.head.appendChild(s);
    });
  }

  function clearCookies() {
    document.cookie.split(";").forEach(function (c) {
      var n = c.split("=")[0].trim();
      if (!/^_ga(_|$)/.test(n)) return;
      ["", "; domain=" + location.hostname, "; domain=." + location.hostname].forEach(function (d) {
        document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" + d;
      });
    });
  }

  function choose(v) {
    save(v);
    var el = document.getElementById("consent-banner");
    if (el) el.remove();
    if (!enabled) return;
    window["ga-disable-" + ID] = v !== "granted";
    if (v === "granted") {
      if (!loaded) load(true);
      else gtag("consent", "update", { analytics_storage: "granted" });
    } else if (loaded) {
      gtag("consent", "update", { analytics_storage: "denied" });
      clearCookies();
    }
  }

  function open() {
    if (document.getElementById("consent-banner")) return;
    var el = document.createElement("div");
    el.id = "consent-banner";
    el.className = "consent-banner";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Cookie consent");
    el.innerHTML =
      '<p>We use Google Analytics cookies to count visits. <a href="' + privacyUrl + '">Learn more</a></p>' +
      '<div class="consent-actions">' +
      '<button type="button" class="btn" data-consent="denied">Decline</button>' +
      '<button type="button" class="btn" data-consent="granted">Accept</button>' +
      "</div>";
    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-consent]");
      if (b) choose(b.getAttribute("data-consent"));
    });
    document.body.appendChild(el);
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-consent-open]")) open();
  });

  if (!enabled) return;
  var choice = read();
  if (choice === "granted") load(true);
  else if (choice === null && !ZONES.test(timeZone())) load(false);
  else if (choice === null) {
    if (document.body) open();
    else document.addEventListener("DOMContentLoaded", open);
  }
})();
