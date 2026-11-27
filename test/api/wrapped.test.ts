import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { jpegHeader } from "../jpeg-fixture";
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

  it("carries `pro: null` for a free account, whatever its garage holds", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { start_date: pastDate });
    const res = await api("GET", `/wrapped/${thisYear}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("pro", null);
  });

  it("gives a Pro account the object, with nulls when there is nothing to show", async () => {
    const { api } = await signedInProUser();
    await createEvent(api, { start_date: pastDate });
    const res = await api("GET", `/wrapped/${thisYear}`);
    expect(res.body.pro).toEqual({ tire: null, top_speed: null });
  });

  it("gives a Pro account its favorite tire and top speed", async () => {
    const { api } = await signedInProUser();
    const car = (await api("POST", "/vehicles", { name: "Corvette C7" })).body;
    const old = (await api("POST", `/vehicles/${car.id}/parts`, { kind: "tires", name: "Falken RT660", installed_on: `${thisYear - 1}-01-01` })).body;
    await api("POST", `/vehicles/${car.id}/parts`, { kind: "pads_front", name: "Not a tire", installed_on: `${thisYear - 1}-01-01` });
    const ev = await createEvent(api, { track_name: "Road Atlanta", start_date: pastDate, days: 2, car: "Corvette C7" });
    await api("POST", `/events/${ev}/sessions`, {
      laps: [90_000, 91_000],
      channels: {
        dStepM: 20,
        laps: [
          { n: 1, timeMs: 90_000, speed: Array.from({ length: 40 }, (_, i) => 100 + i) },
          { n: 2, timeMs: 91_000, speed: Array.from({ length: 40 }, (_, i) => 120 + i * 2.5) },
        ],
      },
    });
    // Another user's faster day must not leak in.
    const other = await signedInProUser();
    const oev = await createEvent(other.api, { start_date: pastDate });
    await other.api("POST", `/events/${oev}/sessions`, {
      laps: [80_000],
      channels: { dStepM: 20, laps: [{ n: 1, timeMs: 80_000, speed: Array(40).fill(300) }] },
    });

    const { pro } = (await api("GET", `/wrapped/${thisYear}`)).body;
    expect(pro.tire).toEqual({ part_id: old.id, vehicle_id: car.id, vehicle_name: "Corvette C7", name: "Falken RT660", track_days: 2, hours: 2.5 });
    expect(pro.top_speed).toEqual({ kph: 217.5, track_id: expect.any(Number), track_name: "Road Atlanta", event_id: ev, date: pastDate });
  });
});

describe("migration 0026 — track_catalog.length_m", () => {
  // 0026 left the response as { id, name }; NS-57 (migration 0040) is what
  // added the length and the layout's place to it, for import matching.
  it("GET /api/catalog carries the length since NS-57, and nothing else new", async () => {
    const { api } = await signedInUser();
    const rows = (await api("GET", "/catalog")).body as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["id", "lat", "length_m", "lon", "name"]);
  });

  it("leaves the ambiguous layouts NULL", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM track_catalog WHERE length_m IS NULL ORDER BY name"
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["MotorSport Ranch (Cresson)", "Pocono Raceway", "Utah Motorsports Campus"]);
  });
});

// The link-preview image (#155): the owner's browser draws the poster and
// sends it; the share page (share.test.ts) names it as its og:image.
describe("PUT /api/wrapped/:year/image", () => {
  const put = (token: string | null, year: number | string, body: Uint8Array) =>
    SELF.fetch(`https://example.com/api/wrapped/${year}/image`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", ...(token ? { Cookie: `session=${token}` } : {}) },
      body,
    });
  const stored = (userId: number) =>
    env.DB.prepare("SELECT year, length(image) AS bytes FROM wrapped_images WHERE user_id = ? ORDER BY year")
      .bind(userId)
      .all<{ year: number; bytes: number }>()
      .then((r) => r.results);

  it("requires a session", async () => {
    expect((await put(null, thisYear, jpegHeader(1200, 630))).status).toBe(401);
  });

  it("keeps one image per year, replacing the last", async () => {
    const { id, token, api } = await signedInUser();
    await createEvent(api, { start_date: pastDate });
    const first = await put(token, thisYear, jpegHeader(1200, 630, 500));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect((await put(token, thisYear, jpegHeader(1200, 630, 900))).status).toBe(200);
    expect(await stored(id)).toEqual([{ year: thisYear, bytes: 900 }]);
  });

  it("is open to a free account — it is a write, and the share is free", async () => {
    const { token, api } = await signedInUser();
    await createEvent(api, { start_date: pastDate });
    expect((await api("GET", "/garage")).status).toBe(402);
    expect((await put(token, thisYear, jpegHeader(1200, 630))).status).toBe(200);
  });

  it("stores nothing for a year with no past events", async () => {
    const { id, token, api } = await signedInUser();
    await createEvent(api, { start_date: `${thisYear + 1}-05-01` });
    for (const y of [1999, thisYear + 1]) {
      const res = await put(token, y, jpegHeader(1200, 630));
      expect(res.status, String(y)).toBe(404);
      expect(await res.json()).toEqual({ error: `no events in ${y}` });
    }
    expect(await stored(id)).toEqual([]);
  });

  it("takes only a 1200×630 JPEG of a sane size", async () => {
    const { id, token, api } = await signedInUser();
    await createEvent(api, { start_date: pastDate });
    const cases: [Uint8Array, number, string][] = [
      [new TextEncoder().encode("<svg onload=alert(1)>".padEnd(64)), 400, "image must be a JPEG"],
      [jpegHeader(1080, 1920), 400, "image must be 1200×630"],
      [jpegHeader(1200, 630, 400_001), 413, "image is too large"],
    ];
    for (const [body, status, error] of cases) {
      const res = await put(token, thisYear, body);
      expect(res.status, error).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
    expect((await put(token, "26", jpegHeader(1200, 630))).status).toBe(400);
    expect(await stored(id)).toEqual([]);
  });

  it("goes with the account", async () => {
    const { id, token, api } = await signedInUser();
    await createEvent(api, { start_date: pastDate });
    await put(token, thisYear, jpegHeader(1200, 630));
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    expect(await stored(id)).toEqual([]);
  });
});
