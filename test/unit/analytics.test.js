import { describe, expect, it, vi } from "vitest";
import { analyticsEnabled, analyticsPath, analyticsPlan, consentBannerHtml, consentTimeZone } from "../../public/js/analytics.js";

describe("analyticsEnabled", () => {
  it("reports from the production hosts only", () => {
    expect(analyticsEnabled("trackevolution.app")).toBe(true);
    expect(analyticsEnabled("www.trackevolution.app")).toBe(true);
    for (const h of ["localhost", "127.0.0.1", "[::1]", "10.0.2.2", "track-history.example.workers.dev", "docs.trackevolution.app"]) {
      expect(analyticsEnabled(h)).toBe(false);
    }
  });
});

describe("analyticsPath", () => {
  it("reads the dashboard and plain routes as they are", () => {
    expect(analyticsPath("/", "")).toBe("/");
    expect(analyticsPath("/", "#/")).toBe("/");
    expect(analyticsPath("/", "#/garage")).toBe("/garage");
    expect(analyticsPath("/", "#/settings")).toBe("/settings");
    expect(analyticsPath("/", "#/coach")).toBe("/coach");
  });

  it("replaces record ids, temp ids included, and drops the query", () => {
    expect(analyticsPath("/", "#/event/42")).toBe("/event/:id");
    expect(analyticsPath("/", "#/event/tmp-3/edit")).toBe("/event/:id/edit");
    expect(analyticsPath("/", "#/track/7/leaderboard/912?mine=55")).toBe("/track/:id/leaderboard/:id");
    expect(analyticsPath("/", "#/track/7/lap-compare?a=1&b=2")).toBe("/track/:id/lap-compare");
    expect(analyticsPath("/", "#/new?track=Road%20Atlanta")).toBe("/new");
    expect(analyticsPath("/", "#/student/12/event/40")).toBe("/student/:id/event/:id");
  });

  it("keeps a Wrapped year, which is not a record", () => {
    expect(analyticsPath("/", "#/wrapped/2026")).toBe("/wrapped/2026");
    expect(analyticsPath("/", "#/wrapped")).toBe("/wrapped");
  });

  it("never reports a share slug", () => {
    expect(analyticsPath("/share/eric-r", "")).toBe("/share/:slug");
    expect(analyticsPath("/share/eric-r/", "#/track/3")).toBe("/share/:slug/track/:id");
    expect(analyticsPath("/share/eric-r/wrapped/2025", "")).toBe("/share/:slug/wrapped/2025");
  });

  it("never reports another path, an invite token's included", () => {
    expect(analyticsPath(`/coach/${"a".repeat(64)}`, "")).toBe("/");
  });
});

describe("consentTimeZone", () => {
  it("asks in Europe, its Atlantic islands and Cyprus", () => {
    for (const tz of ["Europe/London", "Europe/Berlin", "Europe/Dublin", "Atlantic/Canary", "Atlantic/Madeira", "Atlantic/Reykjavik", "Asia/Nicosia", "Arctic/Longyearbyen"]) {
      expect(consentTimeZone(tz)).toBe(true);
    }
  });

  it("doesn't ask elsewhere, or when the zone is unknown", () => {
    for (const tz of ["America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Atlantic/Bermuda", "UTC", "Etc/UTC", "", undefined]) {
      expect(consentTimeZone(tz)).toBe(false);
    }
  });
});

describe("analyticsPlan", () => {
  it("honours a choice anywhere", () => {
    expect(analyticsPlan("granted", "Europe/Paris")).toEqual({ load: true, banner: false });
    expect(analyticsPlan("denied", "America/Chicago")).toEqual({ load: false, banner: false });
  });

  it("asks before loading in Europe, and loads elsewhere", () => {
    expect(analyticsPlan(null, "Europe/London")).toEqual({ load: false, banner: true });
    expect(analyticsPlan(null, "America/Chicago")).toEqual({ load: true, banner: false });
  });
});

describe("consentBannerHtml", () => {
  it("offers both choices, decline first, and links the policy", () => {
    const html = consentBannerHtml();
    expect(html.indexOf('data-consent="denied"')).toBeLessThan(html.indexOf('data-consent="granted"'));
    expect(html).toContain("privacy.html#analytics");
  });
});

describe("initAnalytics / trackPageView / setAnalyticsConsent", () => {
  function fakeWindow({ hostname = "trackevolution.app", hash = "#/event/4", tz = "America/Chicago", stored = null } = {}) {
    const store = new Map(stored ? [["te-analytics-consent", stored]] : []);
    const appended = [];
    const banners = [];
    const win = {
      location: { hostname, pathname: "/", hash, origin: `https://${hostname}` },
      Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) },
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
      document: {
        cookie: "",
        createElement: () => ({ setAttribute() {}, addEventListener() {}, remove() { banners.length = 0; } }),
        head: { appendChild: (el) => appended.push(el) },
        body: { appendChild: (el) => banners.push(el) },
        getElementById: () => banners[0] ?? null,
      },
    };
    return { win, appended, banners, store };
  }
  // gtag() calls (arguments objects) and plain dataLayer events, apart.
  const gtagCalls = (win) => win.dataLayer.filter((e) => !("event" in e)).map((a) => [...a]);
  const events = (win) => win.dataLayer.filter((e) => "event" in e);
  const SCRIPTS = [
    "https://www.googletagmanager.com/gtag/js?id=G-JXM9CX77RQ",
    "https://www.googletagmanager.com/gtm.js?id=GTM-MQD633J7",
  ];
  // Fresh module state per test.
  const load = () => {
    vi.resetModules();
    return import("../../public/js/analytics.js");
  };

  it("does nothing off the production hosts", async () => {
    const { initAnalytics, trackPageView } = await load();
    const { win, appended, banners } = fakeWindow({ hostname: "localhost", tz: "Europe/London" });
    initAnalytics(win);
    trackPageView(win);
    expect(win.dataLayer).toBeUndefined();
    expect(appended).toEqual([]);
    expect(banners).toEqual([]);
  });

  it("outside Europe, loads the tag with the regional default and reports each page by its shape", async () => {
    const { initAnalytics, trackPageView } = await load();
    const { win, appended, banners } = fakeWindow();
    initAnalytics(win);
    expect(banners).toEqual([]);
    expect(appended.map((s) => s.src)).toEqual(SCRIPTS);
    expect(appended.every((s) => s.async)).toBe(true);
    // Tag Manager starts after the consent defaults, so its tags inherit them.
    const gtmAt = win.dataLayer.findIndex((e) => e.event === "gtm.js");
    const lastDefault = win.dataLayer.findLastIndex((e) => !("event" in e) && e[0] === "consent");
    expect(lastDefault).toBeGreaterThanOrEqual(0);
    expect(gtmAt).toBeGreaterThan(lastDefault);
    expect(win.dataLayer[gtmAt]["gtm.start"]).toEqual(expect.any(Number));
    const calls = () => gtagCalls(win);
    const defaults = calls().filter((a) => a[0] === "consent");
    expect(defaults[0][2]).toMatchObject({ analytics_storage: "granted", ad_storage: "denied" });
    expect(defaults[1][2]).toMatchObject({ analytics_storage: "denied", region: expect.arrayContaining(["GB", "DE"]) });
    const config = calls().find((a) => a[0] === "config");
    expect(config[2]).toMatchObject({ send_page_view: false, page_location: "https://trackevolution.app/event/:id" });
    win.location.hash = "#/track/9";
    trackPageView(win);
    expect(calls().at(-2)).toEqual(["set", expect.objectContaining({ page_path: "/track/:id" })]);
    expect(calls().at(-1)).toEqual(["event", "page_view", expect.objectContaining({ page_location: "https://trackevolution.app/track/:id" })]);
    // …and the same shaped fields as a plain event for the container's triggers.
    expect(events(win).at(-1)).toEqual({
      event: "te_page_view",
      page_location: "https://trackevolution.app/track/:id",
      page_path: "/track/:id",
      page_title: "Track Evolution",
    });
  });

  it("in Europe, loads nothing until the visitor accepts", async () => {
    const { initAnalytics, trackPageView, setAnalyticsConsent } = await load();
    const { win, appended, banners, store } = fakeWindow({ tz: "Europe/London" });
    initAnalytics(win);
    trackPageView(win);
    expect(win.dataLayer).toBeUndefined();
    expect(appended).toEqual([]);
    expect(banners).toHaveLength(1);
    setAnalyticsConsent("granted", win);
    expect(store.get("te-analytics-consent")).toBe("granted");
    expect(banners).toEqual([]);
    expect(appended.map((s) => s.src)).toEqual(SCRIPTS);
    const calls = gtagCalls(win);
    // An explicit yes carries no regional "denied" default.
    expect(calls.filter((a) => a[0] === "consent")).toHaveLength(1);
    expect(calls.at(-1)).toEqual(["event", "page_view", expect.objectContaining({ page_path: "/event/:id" })]);
  });

  it("a stored decline loads nothing, and a later decline stops page views", async () => {
    const first = await load();
    const declined = fakeWindow({ tz: "Europe/London", stored: "denied" });
    first.initAnalytics(declined.win);
    expect(declined.appended).toEqual([]);
    expect(declined.banners).toEqual([]);

    const second = await load();
    const { win } = fakeWindow({ stored: "granted" });
    second.initAnalytics(win);
    second.setAnalyticsConsent("denied", win);
    const before = win.dataLayer.length;
    second.trackPageView(win);
    expect(win.dataLayer.length).toBe(before);
    expect(gtagCalls(win).at(-1)).toEqual(["consent", "update", { analytics_storage: "denied" }]);
  });
});

