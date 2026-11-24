import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_LONG_TOLERANCE,
  CATALOG_SHORT_TOLERANCE,
  VENUE_RADIUS_M,
  distanceM,
  eventBodyFor,
  eventForDate,
  groupImports,
  locateTrack,
  otherTrackHere,
  recordingPlace,
} from "../../public/js/import/locate.js";
import { projectTrace, lapTrace, traceOrigin } from "../../public/js/import/geo.js";

// NS-57: which track a recording was driven at, and which event it joins.

const VIR = { lat: 36.5617, lon: -79.2047 };
const catalog = [
  { id: 1, name: "Virginia International Raceway (Full)", ...VIR, length_m: 5262 },
  { id: 2, name: "Virginia International Raceway (North)", lat: 36.5655, lon: -79.2055, length_m: 3621 },
  { id: 3, name: "Pocono Raceway", lat: 41.0554, lon: -75.5115, length_m: null },
];
const at = (place, lengthM) => ({ ...place, lengthM });

describe("locateTrack", () => {
  it("pre-fills the one layout the lap's length fits", () => {
    const r = locateTrack(at(VIR, 5200), [], catalog);
    expect(r.confidence).toBe("exact");
    expect(r.candidates.map((c) => c.name)).toEqual(["Virginia International Raceway (Full)"]);
  });

  it("asks when length cannot be checked, and never guesses a layout", () => {
    expect(locateTrack(at(VIR, null), [], catalog).confidence).toBe("choose");
    expect(locateTrack(at(catalog[2], 4000), [], catalog).confidence).toBe("choose");
  });

  it("allows a driven lap to run short of the published length, but hardly long", () => {
    // Real footage: 0.7–4.0 % short at every venue tried, never long.
    expect(locateTrack(at(VIR, 5262 * (1 - CATALOG_SHORT_TOLERANCE) + 1), [], catalog).confidence).toBe("exact");
    expect(locateTrack(at(VIR, 5262 * (1 - CATALOG_SHORT_TOLERANCE) - 1), [], catalog).venueOnly).toBe(true);
    expect(locateTrack(at(VIR, 5262 * (1 + CATALOG_LONG_TOLERANCE) - 1), [], catalog).confidence).toBe("exact");
    expect(locateTrack(at(VIR, 5262 * (1 + CATALOG_LONG_TOLERANCE) + 1), [], catalog).venueOnly).toBe(true);
    // Sebring's 12-hour course, as a SmartyCam drove it: 4.0 % short.
    const sebring = [{ id: 7, name: "Sebring International Raceway", lat: 27.4534, lon: -81.3548, length_m: 6019 }];
    expect(locateTrack({ lat: 27.4528, lon: -81.3522, lengthM: 5778 }, [], sebring).confidence).toBe("exact");
  });

  it("offers the venue, and pre-fills nothing, when the lap fits none of its layouts", () => {
    // Mid-Ohio's 2.258 mi course against a catalog that holds only the 2.4 mi one.
    const midOhio = [{ id: 8, name: "Mid-Ohio Sports Car Course", lat: 40.688, lon: -82.6364, length_m: 3862 }];
    const r = locateTrack({ lat: 40.6892, lon: -82.6362, lengthM: 3560 }, [], midOhio);
    expect(r).toMatchObject({ confidence: "choose", venueOnly: true, candidates: [{ source: "catalog", id: 8 }] });
    // Every layout there, the nearest in length first.
    const vir = locateTrack(at(VIR, 4400), [], catalog);
    expect(vir).toMatchObject({ confidence: "choose", venueOnly: true });
    expect(vir.candidates.map((c) => c.id)).toEqual([1, 2]);
    // A row the driver has a track for comes back as that track here too.
    const own = [{ id: 4, name: "Mid-Ohio", catalog_id: 8, geo: null }];
    expect(locateTrack({ lat: 40.6892, lon: -82.6362, lengthM: 3560 }, own, midOhio).candidates).toMatchObject([{ source: "own", id: 4 }]);
    // An ordinary match, and nowhere, are not venue-only.
    expect(locateTrack(at(VIR, 5200), [], catalog).venueOnly).toBe(false);
    expect(locateTrack(at({ lat: 10, lon: 10 }, 4400), [], catalog)).toEqual({ confidence: "none", candidates: [], venueOnly: false });
    // The card carries it, and stays unanswered until the driver picks or names.
    const [g] = groupImports([{ id: 0, date: "2026-06-26", time: "09:00", place: r, located: r }], []);
    expect(g).toMatchObject({ track: null, confidence: "choose", venueOnly: true });
  });

  it("knows a track the driver named once, catalog or not", () => {
    const own = [{ id: 9, name: "The Farm", catalog_id: null, geo: { lat: 40.5, lon: -90.5, length_m: 1800 } }];
    const r = locateTrack(at({ lat: 40.5005, lon: -90.5 }, 1790), own, catalog);
    expect(r).toMatchObject({ confidence: "exact", candidates: [{ source: "own", id: 9, name: "The Farm" }] });
    // …but not another layout there.
    expect(locateTrack(at({ lat: 40.5, lon: -90.5 }, 2400), own, catalog).confidence).toBe("none");
  });

  it("answers a catalog row the driver already has as their own track", () => {
    const own = [{ id: 4, name: "VIR Full", catalog_id: 1, geo: null }];
    expect(locateTrack(at(VIR, 5200), own, catalog).candidates[0]).toMatchObject({ source: "own", id: 4, name: "VIR Full" });
  });

  it("is nowhere for a GPS that never got a fix", () => {
    expect(locateTrack({ lat: 0, lon: 0, lengthM: 5200 }, [], catalog).confidence).toBe("none");
    expect(locateTrack(null, [], catalog).confidence).toBe("none");
  });
});

describe("recordingPlace", () => {
  it("finds a driven lap where it was driven, whatever the projection origin", () => {
    // A 3.2 km circle around VIR's centre, projected from its first fix as a parser does.
    const r = 3200 / (2 * Math.PI);
    const gps = Array.from({ length: 400 }, (_, i) => {
      const a = (2 * Math.PI * i) / 400;
      return { lat: VIR.lat + (r * Math.cos(a)) / 110540, lon: VIR.lon + (r * Math.sin(a)) / (111320 * Math.cos((VIR.lat * Math.PI) / 180)), t: i, v: 40 };
    });
    const trace = projectTrace(gps);
    const best = lapTrace(trace, 0, 399);
    const place = recordingPlace({ bestLapTrace: best, traceGeo: traceOrigin(gps), gps });
    expect(distanceM(place, VIR)).toBeLessThan(5);
    expect(Math.abs(place.lengthM - 3200) / 3200).toBeLessThan(0.01);
  });

  it("gives the venue and no length before there are laps", () => {
    expect(recordingPlace({ gps: [{ lat: 36.55, lon: -79.21 }, { lat: 36.57, lon: -79.2 }, { lat: 0, lon: 0 }] })).toEqual({
      lat: 36.56,
      lon: expect.closeTo(-79.205, 9),
      lengthM: null,
    });
    expect(recordingPlace({ laps: [] })).toBeNull();
  });
});

describe("grouping", () => {
  const own = [{ id: 7, name: "VIR Full", catalog_id: 1, geo: null }];
  const item = (id, date, place, tracks = own) => ({ id, date, time: "09:00", place, located: locateTrack(place, tracks, catalog) });

  it("makes a weekend one event and a later day another", () => {
    const groups = groupImports(
      [item(0, "2026-03-14", at(VIR, 5200), []), item(1, "2026-03-15", at(VIR, 5200), []), item(2, "2026-04-20", at(VIR, 5200), [])],
      []
    );
    expect(groups.map((g) => [g.start, g.days, g.itemIds])).toEqual([
      ["2026-03-14", 2, [0, 1]],
      ["2026-04-20", 1, [2]],
    ]);
    expect(eventBodyFor(groups[0], "C7")).toEqual({
      track_name: "Virginia International Raceway (Full)",
      start_date: "2026-03-14",
      days: 2,
      car: "C7",
    });
  });

  it("joins an event at the same track and never one at another", () => {
    const events = [
      { id: 1, track_id: 7, start_date: "2026-03-14", days: 1 },
      { id: 2, track_id: 99, start_date: "2026-03-14", days: 3 },
    ];
    expect(eventForDate(events, 7, "2026-03-15")?.id).toBe(1); // a UTC clock's next day
    expect(eventForDate(events, 7, "2026-03-16")).toBeNull();
    const [g] = groupImports([item(0, "2026-03-14", at(VIR, 5200))], events, { ownTracks: own });
    expect(g.eventId).toBe(1);
    const [n] = groupImports([item(0, "2026-03-14", at(VIR, 5200), [])], events);
    expect(n.eventId).toBeNull();
  });

  it("leaves an unanswered group without a track until the driver names it", () => {
    const unknown = { lat: 10, lon: 10, lengthM: 2500 };
    const items = [item(0, "2026-06-20", unknown), item(1, "2026-06-20", unknown)];
    expect(groupImports(items, [])).toMatchObject([{ track: null, confidence: "none", itemIds: [0, 1] }]);
    const named = groupImports(items, [], { choices: { 0: { name: "Paddock Loop" }, 1: { name: "Paddock Loop" } } });
    expect(named).toMatchObject([{ track: { source: "new", name: "Paddock Loop" }, confidence: "chosen" }]);
  });

  it("warns on an event page only when sure it is another track", () => {
    const sure = locateTrack(at(VIR, 5200), [], catalog);
    expect(otherTrackHere(sure, { id: 3, catalog_id: null })).toBe("Virginia International Raceway (Full)");
    expect(otherTrackHere(sure, { id: 3, catalog_id: 1 })).toBeNull();
    expect(otherTrackHere(locateTrack(at(VIR, null), [], catalog), { id: 3, catalog_id: null })).toBeNull();
  });
});

// The seeded catalog: every row has a place, and no two layouts at one venue
// are closer in length than the match can tell apart — a new row that breaks
// that would mis-place someone's laps, so it fails here instead.
describe("the catalog's coordinates", () => {
  const rows = new Map();
  for (const f of readdirSync("migrations").sort()) {
    const sql = readFileSync(`migrations/${f}`, "utf8");
    if (f.startsWith("0007_")) for (const m of sql.matchAll(/^\s+\('((?:[^']|'')+)'\)[,;]/gm)) rows.set(m[1], {});
    for (const m of sql.matchAll(/UPDATE track_catalog SET name = '([^']+)'\s+WHERE name = '([^']+)'/g)) {
      rows.set(m[1], rows.get(m[2]));
      rows.delete(m[2]);
    }
    for (const m of sql.matchAll(/UPDATE track_catalog SET length_m = (\d+) WHERE name = '([^']+)'/g)) rows.get(m[2]).length_m = Number(m[1]);
    for (const m of sql.matchAll(/UPDATE track_catalog SET lat = (-?[\d.]+), lon = (-?[\d.]+) WHERE name = '([^']+)'/g)) {
      Object.assign(rows.get(m[3]), { lat: Number(m[1]), lon: Number(m[2]) });
    }
  }
  const list = [...rows].map(([name, r]) => ({ name, ...r }));

  it("places every row inside the contiguous United States", () => {
    expect(list.length).toBeGreaterThanOrEqual(59);
    for (const r of list) {
      expect(r.lat, r.name).toBeGreaterThan(24);
      expect(r.lat, r.name).toBeLessThan(50);
      expect(r.lon, r.name).toBeGreaterThan(-125);
      expect(r.lon, r.name).toBeLessThan(-66);
    }
  });

  it("can tell every pair of layouts at one venue apart by length", () => {
    const clash = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (distanceM(a, b) > 2 * VENUE_RADIUS_M || a.length_m == null || b.length_m == null) continue;
        // Their windows — [−short, +long] around each published length — must not overlap.
        const [lo, hi] = a.length_m < b.length_m ? [a, b] : [b, a];
        if (lo.length_m * (1 + CATALOG_LONG_TOLERANCE) >= hi.length_m * (1 - CATALOG_SHORT_TOLERANCE)) clash.push(`${a.name} / ${b.name}`);
      }
    }
    expect(clash).toEqual([]);
  });
});
