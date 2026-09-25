import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInProUser, signedInUser } from "./helpers";

async function publicShare(slug: string) {
  const res = await SELF.fetch(`https://example.com/api/share/${slug}`);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("PUT /api/share", () => {
  it("sets a share slug (normalised to lowercase)", async () => {
    const { api } = await signedInUser();
    const res = await api("PUT", "/share", { slug: "  My-Laps  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "my-laps" });
    expect((await api("GET", "/me")).body.user.share_slug).toBe("my-laps");
  });

  it("rejects invalid slugs", async () => {
    const { api } = await signedInUser();
    for (const slug of ["", "ab", "-abc", "abc-", "a b", "a".repeat(33)]) {
      expect((await api("PUT", "/share", { slug })).status, slug).toBe(400);
    }
  });

  it("rejects a slug already taken by another user", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    expect((await a.api("PUT", "/share", { slug: "taken-slug" })).status).toBe(200);
    const res = await b.api("PUT", "/share", { slug: "taken-slug" });
    expect(res.status).toBe(409);
  });
});

describe("GET /api/share/:slug (public)", () => {
  it("serves the user's stats without authentication", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { best_time_ms: 121000, club: "VIR Club", notes: "secret notes" });
    await api("PUT", "/share", { slug: "public-driver" });

    const { status, body } = await publicShare("public-driver");
    expect(status).toBe(200);
    expect(body.totals.events).toBe(1);
    expect(body.tracks).toHaveLength(1);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].best_ms).toBe(121000);
    expect(body.events[0].club).toBe("VIR Club");
  });

  it("strips private data: notes, email and per-lap detail", async () => {
    const { api, email } = await signedInUser();
    const eventId = await createEvent(api, { notes: "secret notes" });
    await api("POST", `/events/${eventId}/sessions`, { notes: "session secret", laps: [121000] });
    await api("PUT", "/share", { slug: "privacy-check" });

    const { body } = await publicShare("privacy-check");
    expect(body.events[0]).not.toHaveProperty("notes");
    expect(body.events[0]).not.toHaveProperty("sessions");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret notes");
    expect(raw).not.toContain("session secret");
    expect(raw).not.toContain(email);
  });

  it("strips what the day cost: the line items and the total (#147)", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { cost_entry_cents: 45_000, cost_fuel_cents: 12_050 });
    await api("PUT", "/share", { slug: "cost-check" });

    const { body } = await publicShare("cost-check");
    const [ev] = body.events;
    for (const key of ["cost_entry_cents", "cost_fuel_cents", "cost_travel_cents", "cost_misc_cents", "cost_cents"])
      expect(ev, key).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toContain("45000");
  });

  it("matches slugs case-insensitively via lowercasing", async () => {
    const { api } = await signedInUser();
    await api("PUT", "/share", { slug: "case-slug" });
    expect((await publicShare("CASE-SLUG")).status).toBe(200);
  });

  it("404s for unknown slugs", async () => {
    expect((await publicShare("does-not-exist")).status).toBe(404);
  });
});

describe("DELETE /api/share", () => {
  it("disables the public page", async () => {
    const { api } = await signedInUser();
    await api("PUT", "/share", { slug: "soon-gone" });
    expect((await publicShare("soon-gone")).status).toBe(200);
    expect((await api("DELETE", "/share")).status).toBe(200);
    expect((await publicShare("soon-gone")).status).toBe(404);
    expect((await api("GET", "/me")).body.user.share_slug).toBeNull();
  });

  it("share management endpoints require auth", async () => {
    const res = await SELF.fetch("https://example.com/api/share", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "sneaky" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /share/:slug (the HTML share page)", () => {
  async function sharePage(slug: string) {
    const res = await SELF.fetch(`https://example.com/share/${slug}`);
    return { status: res.status, html: await res.text(), headers: res.headers };
  }

  it("serves the SPA shell with per-slug OG meta for scrapers", async () => {
    const { api } = await signedInUser();
    await createEvent(api, {
      track_name: "Road Atlanta",
      best_time_ms: 98_760,
      start_date: "2026-03-01",
      days: 2,
    });
    await api("PUT", "/share", { slug: "og-driver" });

    const { status, html, headers } = await sharePage("og-driver");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<title>Test User&#39;s track logbook</title>");
    expect(html).toContain('property="og:title" content="Test User&#39;s track logbook"');
    expect(html).toContain("1 event · 2 track days · Road Atlanta 1:38.76");
    expect(html).toContain('property="og:url" content="https://example.com/share/og-driver"');
    // Still the real app shell — human visitors boot the SPA as before.
    expect(html).toContain('<script type="module" src="/app.js"></script>');
  });

  it("serves the stock shell for unknown slugs (the SPA renders not-found)", async () => {
    const { status, html } = await sharePage("no-such-driver");
    expect(status).toBe(200);
    expect(html).toContain("<title>Track Evolution</title>");
    expect(html).toContain('content="Track Evolution"');
  });

  it("escapes a hostile display name instead of injecting it", async () => {
    const user = await signedInUser();
    const { env } = await import("cloudflare:test");
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?")
      .bind(`<script>alert(1)</script>`, user.id)
      .run();
    await user.api("PUT", "/share", { slug: "xss-check" });

    const { html } = await sharePage("xss-check");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("GET /api/share/:slug privacy for new fields", () => {
  it("shares conditions but strips course notes and checklists", async () => {
    const { api } = await signedInUser();
    await createEvent(api, {
      track_name: "VIR Full",
      conditions: "dry",
      temp_f: 72,
      checklist: [{ text: "secret prep item", done: false }],
    });
    const track = (await api("GET", "/tracks")).body[0];
    await api("PUT", `/tracks/${track.id}`, { notes: "secret course notes" });
    await api("PUT", "/share", { slug: "fields-check" });

    const { body } = await publicShare("fields-check");
    expect(body.events[0].conditions).toBe("dry");
    expect(body.events[0].track_name).toBe("VIR Full");
    expect(body.tracks[0].name).toBe("VIR Full");
    expect(body.events[0]).not.toHaveProperty("checklist");
    expect(body.tracks[0]).not.toHaveProperty("notes");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret prep item");
    expect(raw).not.toContain("secret course notes");
  });
});

describe("a shared Season Wrapped (NS-36)", () => {
  const year = new Date().getUTCFullYear();
  const past = `${year}-01-01`;

  it("serves the free card set, with no `pro` key, under the owner's slug", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "Road Atlanta", start_date: past, best_time_ms: 98_760, days: 2 });
    await api("PUT", "/share", { slug: "wrapped-driver" });

    const res = await SELF.fetch(`https://example.com/api/share/wrapped-driver/wrapped/${year}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.year).toBe(year);
    expect(body.name).toBe("Test User");
    expect(body.totals).toMatchObject({ events: 1, track_days: 2, tracks: 1 });
    expect(body.fastest.best_ms).toBe(98_760);
    expect(body).not.toHaveProperty("pro");
  });

  it("is a 404 for an unknown slug or an empty year, and a 400 for a bad year", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { start_date: past });
    await api("PUT", "/share", { slug: "wrapped-empty" });
    expect((await SELF.fetch(`https://example.com/api/share/no-such-slug/wrapped/${year}`)).status).toBe(404);
    expect((await SELF.fetch("https://example.com/api/share/wrapped-empty/wrapped/1999")).status).toBe(404);
    expect((await SELF.fetch("https://example.com/api/share/wrapped-empty/wrapped/99")).status).toBe(400);
  });

  it("never carries a Pro owner's garage or anything channel-derived", async () => {
    const { api } = await signedInProUser();
    const vehicle = (await api("POST", "/vehicles", { name: "Secret Garage Car" })).body;
    await api("POST", `/vehicles/${vehicle.id}/parts`, {
      kind: "tires",
      name: "Secret Tire Compound",
      installed_on: `${year - 1}-01-01`,
    });
    const ev = await createEvent(api, { start_date: past, car: "Secret Garage Car" });
    await api("POST", `/events/${ev}/sessions`, {
      laps: [90_000],
      channels: {
        dStepM: 20,
        laps: [{ n: 1, timeMs: 90_000, speed: Array.from({ length: 50 }, (_, i) => 150 + i), rpm: Array(50).fill(7777) }],
      },
    });
    await api("PUT", "/share", { slug: "wrapped-pro" });

    const res = await SELF.fetch(`https://example.com/api/share/wrapped-pro/wrapped/${year}`);
    const text = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(text);
    expect(body).not.toHaveProperty("pro");
    for (const secret of ["Secret Tire Compound", "Secret Garage Car", "7777", "199", "top_speed", "tire"])
      expect(text, secret).not.toContain(secret);
  });

  it("previews with the season's own title and description", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "Road Atlanta", start_date: past, days: 2 });
    const ev = await createEvent(api, { track_name: "Road Atlanta", start_date: past });
    await api("POST", `/events/${ev}/sessions`, { laps: [99_000, 98_000] });
    await api("PUT", "/share", { slug: "wrapped-og" });

    const res = await SELF.fetch(`https://example.com/share/wrapped-og/wrapped/${year}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(html).toContain(`<title>Test User&#39;s ${year} on Track Evolution</title>`);
    // Road Atlanta is a catalog track with a seeded length: 2 laps × 4,088 m.
    expect(html).toContain("3 track days · 1 track · 2 laps · 5 track miles · most driven Road Atlanta");
    expect(html).toContain(`property="og:url" content="https://example.com/share/wrapped-og/wrapped/${year}"`);
    expect(html).toContain('<script type="module" src="/app.js"></script>');
  });

  it("serves the stock shell for a year with nothing in it", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { start_date: past });
    await api("PUT", "/share", { slug: "wrapped-og-empty" });
    const html = await (await SELF.fetch("https://example.com/share/wrapped-og-empty/wrapped/1999")).text();
    expect(html).toContain("<title>Track Evolution</title>");
  });
});
