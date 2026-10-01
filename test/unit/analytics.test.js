import { describe, expect, it } from "vitest";
import { analyticsEnabled, analyticsPath } from "../../public/js/analytics.js";

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

describe("initAnalytics / trackPageView", () => {
  function fakeWindow(hostname, pathname, hash) {
    const appended = [];
    return {
      location: { hostname, pathname, hash, origin: `https://${hostname}` },
      document: { createElement: () => ({}), head: { appendChild: (el) => appended.push(el) } },
      appended,
    };
  }

  it("does nothing off the production hosts", async () => {
    const { initAnalytics, trackPageView } = await import("../../public/js/analytics.js?off");
    const win = fakeWindow("localhost", "/", "#/event/4");
    initAnalytics(win);
    trackPageView(win);
    expect(win.dataLayer).toBeUndefined();
    expect(win.appended).toEqual([]);
  });

  it("loads the tag without a page view, then reports each page by its shape", async () => {
    const { initAnalytics, trackPageView } = await import("../../public/js/analytics.js?on");
    const win = fakeWindow("trackevolution.app", "/", "#/event/4");
    initAnalytics(win);
    expect(win.appended[0].src).toBe("https://www.googletagmanager.com/gtag/js?id=G-JXM9CX77RQ");
    const config = [...win.dataLayer.find((a) => a[0] === "config")];
    expect(config[2]).toMatchObject({ send_page_view: false, page_location: "https://trackevolution.app/event/:id" });
    win.location.hash = "#/track/9";
    trackPageView(win);
    const calls = win.dataLayer.map((a) => [...a]);
    expect(calls.at(-2)).toEqual(["set", expect.objectContaining({ page_path: "/track/:id" })]);
    expect(calls.at(-1)).toEqual(["event", "page_view", expect.objectContaining({ page_location: "https://trackevolution.app/track/:id" })]);
  });
});
