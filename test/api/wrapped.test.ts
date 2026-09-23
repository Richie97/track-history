import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiClient, createEvent, signedInProUser, signedInUser } from "./helpers";

const METRES_PER_MILE = 1609.344;
const thisYear = new Date().getUTCFullYear();
// January 1st is always past (or today) whenever the suite runs.
const pastDate = `${thisYear}-01-01`;

// A gridded lap of `points` samples at 20 m — `points × 20` metres driven.
const channelLap = (n: number, timeMs: number, points: number) => ({
  n,
  timeMs,
  speed: Array.from({ length: points }, (_, i) => 100 + (i % 7)),
});

describe("GET /api/wrapped/:year", () => {
  it("wants a four-digit year", async () => {
    const { api } = await signedInUser();
    for (const y of ["26", "20266", "abcd", "2026x"]) {
      const res = await api("GET", `/wrapped/${y}`);
      expect(res.status, y).toBe(400);
    }
  });

  it("is a 404 for a year with no past events", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { start_date: `${thisYear + 1}-05-01` });
    const res = await api("GET", `/wrapped/${thisYear + 1}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: `no events in ${thisYear + 1}` });
    expect((await api("GET", "/wrapped/1999")).status).toBe(404);
  });

  it("requires a session", async () => {
    expect((await apiClient()("GET", "/wrapped/2026")).status).toBe(401);
  });

  it("returns the season", async () => {
    const { api } = await signedInUser();
    // A catalog track with a seeded length…
    const vir = await createEvent(api, {
      track_name: "Virginia International Raceway (Full)",
      start_date: pastDate,
      days: 2,
      temp_f: 95,
    });
    await api("POST", `/events/${vir}/sessions`, { laps: [125_000, 122_000, 121_000] });
    // …a track the catalog doesn't know, measured from its telemetry…
    const home = await createEvent(api, { track_name: "Home Circuit", start_date: pastDate });
    await api("POST", `/events/${home}/sessions`, {
      laps: [80_000, 79_000],
      channels: { dStepM: 20, laps: [channelLap(1, 80_000, 100), channelLap(2, 79_000, 100)] },
    });
    // …and one with nothing to measure it by.
    const blank = await createEvent(api, { track_name: "Nowhere Park", start_date: pastDate });
    await api("POST", `/events/${blank}/sessions`, { laps: [60_000] });

    const res = await api("GET", `/wrapped/${thisYear}`);
    expect(res.status).toBe(200);
    const w = res.body;
    expect(w.year).toBe(thisYear);
    expect(w.years).toEqual([thisYear]);
    expect(w.name).toBe("Test User");
    expect(w.pro).toBeNull();

    const virM = (await env.DB.prepare(
      "SELECT length_m FROM track_catalog WHERE name = 'Virginia International Raceway (Full)'"
    ).first<{ length_m: number }>())!.length_m;
    expect(virM).toBeGreaterThan(5000);
    expect(w.totals).toMatchObject({ events: 3, track_days: 4, tracks: 3, laps: 6, miles_tracks_counted: 2 });
    expect(w.totals.miles).toBeCloseTo((3 * virM + 2 * 2000) / METRES_PER_MILE, 1);

    expect(w.most_driven).toMatchObject({ track_name: "Virginia International Raceway (Full)", track_days: 2, laps: 3, best_ms: 121_000 });
    expect(w.fastest).toMatchObject({ track_name: "Nowhere Park", best_ms: 60_000, event_id: blank });
    expect(w.new_tracks).toHaveLength(3);
    expect(w.hottest).toMatchObject({ event_id: vir, temp_c: 35 });
  });

  it("never reads another user's events", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await createEvent(a.api, { start_date: pastDate, best_time_ms: 90_000 });
    const res = await b.api("GET", `/wrapped/${thisYear}`);
    expect(res.status).toBe(404);

    await createEvent(b.api, { track_name: "Test Ring", start_date: pastDate });
    const mine = (await b.api("GET", `/wrapped/${thisYear}`)).body;
    expect(mine.totals.events).toBe(1);
    expect(mine.fastest).toBeNull();
    expect(mine.improvement).toBeNull();
  });

  it("carries a null `pro` for free and Pro accounts alike (until ticket 4)", async () => {
    for (const who of [await signedInUser(), await signedInProUser()]) {
      await createEvent(who.api, { start_date: pastDate });
      const res = await who.api("GET", `/wrapped/${thisYear}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("pro", null);
    }
  });
});

describe("migration 0026 — track_catalog.length_m", () => {
  it("leaves GET /api/catalog as { id, name }", async () => {
    const { api } = await signedInUser();
    const rows = (await api("GET", "/catalog")).body as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["id", "name"]);
  });

  it("leaves the ambiguous layouts NULL", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM track_catalog WHERE length_m IS NULL ORDER BY name"
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["MotorSport Ranch (Cresson)", "Pocono Raceway", "Utah Motorsports Campus"]);
  });
});
