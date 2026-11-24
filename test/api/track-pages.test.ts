import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";
import { trackSlug } from "../../src/lib/trackPages";

// The public track pages (#457, src/routes/trackPages.ts): /tracks,
// /tracks/<slug> and /tracks/sitemap.xml. Public and indexable, so the tests
// are about what a page must never say: who set a time, anything a driver
// typed, or anything from a driver who has not joined the leaderboards.

// D1 is shared across the tests in this file, so each test that adds drivers
// uses a track of its own.
const pageOf = (track: string) => `https://example.com/tracks/${trackSlug(track)}`;

function channelsFor(laps: number[]) {
  const arr = (v: number) => Array.from({ length: 12 }, (_, i) => v + i);
  return { v: 1, dStepM: 20, laps: laps.map((timeMs, i) => ({ n: i + 1, timeMs, speed: arr(100) })) };
}

async function driver(track: string, name: string, laps: number[], { optIn = true, timed = true, extra = {} } = {}) {
  const u = await signedInUser();
  await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, u.id).run();
  if (optIn) await u.api("PUT", "/me/leaderboard", { opt_in: true });
  const eventId = await createEvent(u.api, { track_name: track, start_date: "2026-04-10", ...extra });
  const res = await u.api("POST", `/events/${eventId}/sessions`, {
    laps,
    ...(timed ? { channels: channelsFor(laps) } : {}),
  });
  expect(res.status).toBe(201);
  return u;
}

describe("GET /tracks/:slug", () => {
  it("renders a track with no laps without JavaScript, canonical and structured data", async () => {
    const res = await SELF.fetch(pageOf("Road Atlanta"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("public");
    expect(res.headers.get("x-robots-tag")).toBeNull();
    const html = await res.text();
    expect(html).toContain("<h1>Road Atlanta lap times</h1>");
    expect(html).toContain(`<link rel="canonical" href="https://trackevolution.app/tracks/road-atlanta">`);
    expect(html).toContain('"@type": "SportsActivityLocation"');
    expect(html).toContain('"@type": "BreadcrumbList"');
    expect(html).toContain("No Track Evolution driver has put a measured lap");
    // The catalog's length (migration 0026), in both systems.
    expect(html).toMatch(/Lap length<\/th><td>2\.54 mi \(4\.09 km\)/);
    // Nothing on the page needs a script to show its content.
    expect(html).not.toContain("/app.js");
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    expect(ld["@graph"].map((n: { "@type": string }) => n["@type"])).toEqual([
      "WebPage",
      "SportsActivityLocation",
      "BreadcrumbList",
    ]);
  });

  it("shows opted-in drivers' best device-timed laps as bare times, and names nobody", async () => {
    const T = "Sebring International Raceway";
    await driver(T, "Alice Fastlane", [98000, 97000], { extra: { car: "Zonda-Unique-Car", notes: "secret-notes" } });
    await driver(T, "Bob Midfield", [99500]);
    // Faster than everyone, but never joined the leaderboards.
    await driver(T, "Ghost Hidden", [90000], { optIn: false });
    // Joined, but the lap was typed in: it never ranks.
    await driver(T, "Typed Tina", [91000], { timed: false });

    const html = await (await SELF.fetch(pageOf(T))).text();
    expect(html).toContain("<td>1</td><td>1:37.0</td>");
    expect(html).toContain("<td>2</td><td>1:39.5</td>");
    expect(html).toMatch(/Drivers on the leaderboard<\/th><td>2</);
    expect(html).toMatch(/Fastest lap logged<\/th><td>1:37\.0</);
    expect(html).not.toContain("1:30.0");
    expect(html).not.toContain("1:31.0");
    for (const hidden of ["Alice", "Fastlane", "Bob", "Ghost", "Tina", "Zonda", "secret-notes", "2026-04-10"]) {
      expect(html).not.toContain(hidden);
    }
  });

  it("drops a driver the moment they leave the leaderboards", async () => {
    const T = "Lime Rock Park";
    const a = await driver(T, "Alice Fastlane", [97000]);
    expect(await (await SELF.fetch(pageOf(T))).text()).toContain("1:37.0");
    await a.api("PUT", "/me/leaderboard", { opt_in: false });
    const html = await (await SELF.fetch(pageOf(T))).text();
    expect(html).not.toContain("1:37.0");
    expect(html).toContain("No Track Evolution driver has put a measured lap");
  });

  it("lists at most ten times and still counts every driver", async () => {
    const T = "Road America";
    for (let i = 0; i < 12; i++) await driver(T, `Driver ${i}`, [100000 + i * 1000]);
    const html = await (await SELF.fetch(pageOf(T))).text();
    expect(html.match(/<tr><td>\d+<\/td><td>/g)).toHaveLength(10);
    expect(html).toMatch(/Drivers on the leaderboard<\/th><td>12</);
    expect(html).toContain("out of 12");
  });

  it("links a venue's other layouts", async () => {
    const html = await (await SELF.fetch("https://example.com/tracks/virginia-international-raceway-full")).text();
    expect(html).toContain('href="/tracks/virginia-international-raceway-north"');
    expect(html).not.toContain('href="/tracks/virginia-international-raceway-full"');
  });

  it("answers an unknown slug with a noindex 404", async () => {
    const res = await SELF.fetch("https://example.com/tracks/no-such-track");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toContain("Track not found");
  });
});

describe("GET /tracks and /tracks/sitemap.xml", () => {
  it("gives every catalog row one slug of its own, a link on the index and a sitemap entry", async () => {
    const rows = (await env.DB.prepare("SELECT name FROM track_catalog").all<{ name: string }>()).results;
    expect(rows.length).toBeGreaterThan(50);
    const slugs = rows.map((r) => trackSlug(r.name));
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);

    const index = await SELF.fetch("https://example.com/tracks");
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('<link rel="canonical" href="https://trackevolution.app/tracks">');

    const map = await SELF.fetch("https://example.com/tracks/sitemap.xml");
    expect(map.headers.get("content-type")).toContain("application/xml");
    const xml = await map.text();
    expect(xml).toContain("<loc>https://trackevolution.app/tracks</loc>");
    for (const s of slugs) {
      expect(html).toContain(`href="/tracks/${s}"`);
      expect(xml).toContain(`<loc>https://trackevolution.app/tracks/${s}</loc>`);
    }
  });
});
