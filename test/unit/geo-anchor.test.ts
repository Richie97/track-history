import { describe, expect, it } from "vitest";
import {
  BORROW_MAX_MISMATCH,
  KX,
  KY,
  borrowAnchor,
  parseTraceGeo,
  resolveTraceGeo,
  sanitizeTraceGeo,
  startFinish,
  traceCentre,
  trackPlace,
  unproject,
} from "../../src/lib/geo";
import * as web from "../../public/js/import/geo.js";
import { gateFromSf, knownLines, lineFits, recordingPlace } from "../../public/js/import/locate.js";

// NS-53: where a trace lies on Earth. The server's half (src/lib/geo.ts) and
// the web's (public/js/import/geo.js) restate the same two constants, and the
// first block here is what keeps them the same.

type Trace = [number, number, number][];
const ring = (r: number, n = 60, ox = 0, oy = 0, squash = 1): Trace =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / (n - 1);
    return [ox + r * Math.sin(a), oy + squash * (r - r * Math.cos(a)), 30 + (i % 20)];
  });

describe("the projection constants", () => {
  it("are the same on the server and the web", () => {
    expect(KY).toBe(web.KY);
    for (const lat of [0, 36.56, -33.8, 60]) expect(KX(lat)).toBe(web.KX(lat));
  });

  it.each([0.5, 36.5607, -37.85, 60.2])("invert projectTrace exactly at latitude %s", (lat) => {
    const origin = { lat, lon: -79.2064 };
    const gps = Array.from({ length: 50 }, (_, i) => ({
      t: i,
      lat: lat + 0.0004 * i - 0.01,
      lon: origin.lon + 0.0007 * Math.sin(i) * i,
    }));
    const trace = web.projectTrace(gps, origin).map((p: { x: number; y: number }) => [p.x, p.y, 0]);
    const back = web.unprojectTrace(trace, origin);
    gps.forEach((p, i) => {
      expect(back[i].lat).toBeCloseTo(p.lat, 10);
      expect(back[i].lon).toBeCloseTo(p.lon, 10);
      const s = unproject(trace[i][0], trace[i][1], origin);
      expect(s.lat).toBe(back[i].lat);
      expect(s.lon).toBe(back[i].lon);
    });
  });
});

describe("sanitizeTraceGeo", () => {
  const trace = ring(300);
  it("keeps a plausible coordinate, rounded to 7 decimals", () => {
    expect(sanitizeTraceGeo({ lat: 36.56071234567, lon: -79.20641234567 }, trace)).toEqual({
      lat: 36.5607123,
      lon: -79.2064123,
    });
  });
  it("drops unknown keys, a client's approx flag included", () => {
    expect(sanitizeTraceGeo({ lat: 1, lon: 2, approx: true, x: 1 }, trace)).toEqual({ lat: 1, lon: 2 });
  });
  it.each([
    ["no anchor", undefined],
    ["null", null],
    ["an array", [36, -79]],
    ["a string", "36,-79"],
    ["a string latitude", { lat: "36", lon: -79 }],
    ["NaN", { lat: NaN, lon: -79 }],
    ["a latitude past the poles", { lat: 91, lon: 0 }],
    ["a longitude off the map", { lat: 36, lon: 181 }],
    ["a GPS with no fix", { lat: 0, lon: 0 }],
    ["nearly no fix", { lat: 0.001, lon: -0.002 }],
  ])("answers null — never undefined — for %s", (_, v) => {
    expect(sanitizeTraceGeo(v, trace)).toBeNull();
  });
  it("answers null without a trace: an anchor describes one", () => {
    expect(sanitizeTraceGeo({ lat: 36, lon: -79 }, null)).toBeNull();
  });
  it("keeps the equator and the meridian apart from null island", () => {
    expect(sanitizeTraceGeo({ lat: 0, lon: 101.7 }, trace)).toEqual({ lat: 0, lon: 101.7 });
    expect(sanitizeTraceGeo({ lat: 52.07, lon: 0 }, trace)).toEqual({ lat: 52.07, lon: 0 });
  });
});

describe("parseTraceGeo", () => {
  it("reads a stored anchor and degrades anything else to null", () => {
    expect(parseTraceGeo('{"lat":36.5,"lon":-79.2}')).toEqual({ lat: 36.5, lon: -79.2 });
    for (const raw of [null, "", "{", "null", '{"lat":"a","lon":1}', 5]) expect(parseTraceGeo(raw)).toBeNull();
  });
});

describe("borrowAnchor", () => {
  const donorGeo = { lat: 36.5607, lon: -79.2064 };
  const donor = ring(400);

  it("puts the same lap, projected from another origin, back where it was", () => {
    // The same line with its origin 730 m east and 210 m south of the donor's.
    const moved: Trace = donor.map(([x, y, v]) => [x - 730, y + 210, v]);
    const geo = borrowAnchor(moved, donor, donorGeo)!;
    expect(geo.approx).toBe(true);
    const a = unproject(moved[7][0], moved[7][1], geo);
    const b = unproject(donor[7][0], donor[7][1], donorGeo);
    // Within centimetres: only the 7-decimal rounding and cos(lat) of two
    // origins 210 m apart separate them.
    expect(Math.abs(a.lat - b.lat) * KY).toBeLessThan(0.05);
    expect(Math.abs(a.lon - b.lon) * KX(36.56)).toBeLessThan(0.05);
  });

  it("matches centres, so a slightly different line still lands on the track", () => {
    const wider = ring(410, 80, 55, -20);
    const geo = borrowAnchor(wider, donor, donorGeo)!;
    const [cx, cy] = traceCentre(wider)!;
    const [dx, dy] = traceCentre(donor)!;
    const a = unproject(cx, cy, geo);
    const b = unproject(dx, dy, donorGeo);
    expect(Math.abs(a.lat - b.lat) * KY).toBeLessThan(0.05);
    expect(Math.abs(a.lon - b.lon) * KX(36.56)).toBeLessThan(0.05);
  });

  it("refuses an outline that isn't this track's", () => {
    expect(borrowAnchor(ring(400 / (1 - BORROW_MAX_MISMATCH) + 5), donor, donorGeo)).toBeNull();
    expect(borrowAnchor(ring(400, 60, 0, 0, 0.6), donor, donorGeo)).toBeNull();
    expect(borrowAnchor(ring(200), donor, donorGeo)).toBeNull();
    // …and takes one just inside the line.
    expect(borrowAnchor(ring(400 / (1 - BORROW_MAX_MISMATCH) - 5), donor, donorGeo)).not.toBeNull();
  });

  it("needs a donor with both a trace and an anchor", () => {
    expect(borrowAnchor(donor, donor, null)).toBeNull();
    expect(borrowAnchor(donor, null, donorGeo)).toBeNull();
    expect(borrowAnchor(null, donor, donorGeo)).toBeNull();
  });
});

describe("resolveTraceGeo", () => {
  const trace = ring(300);
  const donor = { trace: JSON.stringify(ring(300, 60, 40, 40)), trace_geo: '{"lat":36.5,"lon":-79.2}' };
  it("prefers the session's own anchor, unflagged", () => {
    expect(resolveTraceGeo(trace, '{"lat":10,"lon":20}', donor)).toEqual({ lat: 10, lon: 20 });
  });
  it("borrows when it has none, flagged", () => {
    expect(resolveTraceGeo(trace, null, donor)).toMatchObject({ approx: true });
  });
  it("is null with no trace, or no donor", () => {
    expect(resolveTraceGeo(null, '{"lat":10,"lon":20}', donor)).toBeNull();
    expect(resolveTraceGeo(trace, null, undefined)).toBeNull();
  });
});

describe("the web's map helpers", () => {
  it("traceOrigin is gps[0] unless handed the projection's origin, and null off the map", () => {
    const gps = [{ t: 0, lat: 36.56071234567, lon: -79.2 }, { t: 1, lat: 36.57, lon: -79.21 }];
    expect(web.traceOrigin(gps)).toEqual({ lat: 36.5607123, lon: -79.2 });
    expect(web.traceOrigin(gps, { lat: 40, lon: -75 })).toEqual({ lat: 40, lon: -75 });
    expect(web.traceOrigin([{ t: 0, lat: 0, lon: 0 }])).toBeNull();
    expect(web.traceOrigin([])).toBeNull();
    expect(web.traceOrigin(null)).toBeNull();
  });

  it("the client's anchor is one the server keeps unchanged", () => {
    const o = web.traceOrigin([{ t: 0, lat: -33.80391234567, lon: 150.87041234567 }]);
    expect(sanitizeTraceGeo(o, ring(100))).toEqual(o);
  });

  it("traceGeoBounds boxes the line in degrees", () => {
    const geo = { lat: 36.5, lon: -79.2 };
    const b = web.traceGeoBounds([[-100, -50, 1], [300, 250, 2], [0, 0, 3]], geo)!;
    expect(b.south).toBeCloseTo(36.5 - 50 / KY, 12);
    expect(b.north).toBeCloseTo(36.5 + 250 / KY, 12);
    expect(b.west).toBeCloseTo(-79.2 - 100 / KX(36.5), 12);
    expect(b.east).toBeCloseTo(-79.2 + 300 / KX(36.5), 12);
    expect(web.traceGeoBounds([], geo)).toBeNull();
  });

  it("nearestOnTrace finds the place by distance driven, not by index", () => {
    // Dense through a slow corner at the start, then one long fast segment.
    const trace = [[0, 0, 5], [1, 0, 5], [2, 0, 5], [3, 0, 5], [103, 0, 60]];
    const hit = web.nearestOnTrace(trace, 43, 4);
    expect(hit).toEqual({ idx: 3, frac: 43 / 103, alongM: 43, offM: 4 });
    expect(web.nearestOnTrace(trace, 60, 4)!.idx).toBe(4);
    expect(web.nearestOnTrace(trace, 53, 30, 24)).toBeNull();
    expect(web.nearestOnTrace(trace, -10, 0)).toMatchObject({ idx: 0, frac: 0, offM: 10 });
    expect(web.nearestOnTrace([[0, 0, 1]], 0, 0)).toBeNull();
    expect(web.nearestOnTrace([[5, 5, 1], [5, 5, 1]], 5, 5)).toBeNull();
  });

  it("speedRuns cuts the line where its colour changes, covering every segment once", () => {
    const trace = [[0, 0, 10], [1, 0, 10], [2, 0, 20], [3, 0, 30], [4, 0, 30], [5, 0, 10]];
    const runs = web.speedRuns(trace, 4);
    expect(runs).toEqual([
      { from: 0, to: 2, bucket: 0 },
      { from: 2, to: 3, bucket: 2 },
      { from: 3, to: 5, bucket: 3 },
    ]);
    for (let i = 1; i < runs.length; i++) expect(runs[i].from).toBe(runs[i - 1].to);
    // One speed throughout is the middle of the ramp, as the drawn map has it.
    expect(web.speedRuns([[0, 0, 7], [1, 0, 7], [2, 0, 7]], 16)).toEqual([{ from: 0, to: 2, bucket: 8 }]);
    expect(web.speedRuns([[0, 0, 7]])).toEqual([]);
  });
});

// NS-57 phase 3: the line a lap was timed from, read back off its stored trace
// and used to time another day's recording with no click.
describe("a known start/finish line", () => {
  const VIR = { lat: 36.5617, lon: -79.2047 };
  // A 3 km oval driven clockwise at 10 Hz for `laps` laps and a bit, starting
  // `leadM` before the top of the oval.
  const drive = (laps: number, leadM: number, t0 = 0) => {
    const length = 3000;
    const r = length / (2 * Math.PI);
    const v = 40;
    const out: { lat: number; lon: number; t: number; speed: number }[] = [];
    for (let i = 0; i * v * 0.1 <= laps * length + 400; i++) {
      const a = ((i * v * 0.1 - leadM) / length) * 2 * Math.PI;
      const x = r * Math.sin(a);
      const y = 0.6 * r * Math.cos(a);
      out.push({ lat: VIR.lat + y / KY, lon: VIR.lon + x / KX(VIR.lat), t: t0 + i * 0.1, speed: v });
    }
    return out;
  };

  it("has no direction to read from a lap that never leaves its first point", () => {
    expect(startFinish([[0, 0, 1], [3, 4, 1], [5, 5, 1]], VIR)).toBeNull();
    expect(startFinish([], VIR)).toBeNull();
    expect(startFinish([[0, 0, 1], [0, 30, 1]], VIR)).toMatchObject({ lat: VIR.lat, lon: VIR.lon, heading: 0 });
    expect(startFinish([[0, 0, 1], [30, 0, 1]], VIR)?.heading).toBe(90);
    expect(startFinish([[0, 0, 1], [-30, 0, 1]], VIR)?.heading).toBe(270);
  });

  it("times a second day at the track the way the first day's picked line did", () => {
    const day1 = drive(4, 700);
    const trace1 = web.projectTrace(day1);
    const gate1 = web.buildGate(trace1, 200);
    const laps1 = web.deriveLaps(trace1, gate1);
    expect(laps1.length).toBe(3);
    const stored = web.bestLapTrace(trace1, gate1);
    const place = trackPlace(JSON.stringify(stored), JSON.stringify(web.traceOrigin(day1)));
    expect(place?.sf).not.toBeNull();

    // Another day, another projection origin, the same circuit.
    const day2 = drive(5, 1900, 1000);
    const trace2 = web.projectTrace(day2);
    const gate2 = gateFromSf(place!.sf, day2[0]);
    const laps2 = web.deriveLaps(trace2, gate2);
    expect(laps2.length).toBe(4);
    for (const l of laps2) expect(Math.abs(l.timeMs - laps1[0].timeMs)).toBeLessThan(150);

    const own = [{ id: 7, name: "The Oval", catalog_id: null, geo: place }];
    const parsed = { gps: day2, bestLapTrace: web.bestLapTrace(trace2, gate2), traceGeo: web.traceOrigin(day2) };
    const lines = knownLines(recordingPlace({ gps: day2 }), own);
    expect(lines).toMatchObject([{ id: 7, name: "The Oval" }]);
    expect(lineFits(7, [recordingPlace(parsed)], own, [])).toBe(true);
    expect(lineFits(8, [recordingPlace(parsed)], own, [])).toBe(false);
    expect(lineFits(7, [null], own, [])).toBe(false);
  });

  it("finds no laps for a day driven the other way round", () => {
    const day1 = drive(3, 700);
    const trace1 = web.projectTrace(day1);
    const gate1 = web.buildGate(trace1, 200);
    const place = trackPlace(JSON.stringify(web.bestLapTrace(trace1, gate1)), JSON.stringify(web.traceOrigin(day1)));
    const reversed = drive(3, 700).map((p, i, all) => ({ ...all[all.length - 1 - i], t: p.t }));
    expect(web.deriveLaps(web.projectTrace(reversed), gateFromSf(place!.sf, reversed[0]))).toEqual([]);
  });

  it("offers nothing away from the venue, or from a track with no line", () => {
    const sf = { lat: VIR.lat, lon: VIR.lon, heading: 10 };
    const own = [
      { id: 1, name: "Far", geo: { lat: 40, lon: -80, length_m: 3000, sf } },
      { id: 2, name: "No line", geo: { ...VIR, length_m: 3000, sf: null } },
      { id: 3, name: "Unanchored", geo: null },
    ];
    expect(knownLines({ ...VIR, lengthM: null }, own)).toEqual([]);
    expect(knownLines(null, own)).toEqual([]);
    expect(gateFromSf(null, VIR)).toBeNull();
    expect(gateFromSf(sf, null)).toBeNull();
  });
});
