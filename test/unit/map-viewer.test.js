import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAP_TYPE,
  MAP_TYPES,
  NOTE_APPROX,
  NOTE_NOT_SET_UP,
  NOTE_NO_ANCHOR,
  NOTE_OFFLINE,
  TAP_RADIUS_PX,
  currentMapType,
  headingDeg,
  placeAt,
  pointAlong,
  rampColor,
  readoutText,
  setMapType,
  startType,
  tapHit,
  traceMetres,
  viewerPlan,
} from "../../public/js/map-viewer.js";
import { projectTrace } from "../../public/js/import/geo.js";

// NS-53 ticket 4: the web map viewer's pure half.

const geo = { lat: 36.5607, lon: -79.2064 };
const store = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

describe("viewerPlan", () => {
  it("offers every type over an anchored trace, with nothing to explain", () => {
    expect(viewerPlan({ geo, mapsOn: true })).toEqual({ types: MAP_TYPES, note: null });
  });
  it("says a borrowed anchor is an estimate", () => {
    expect(viewerPlan({ geo: { ...geo, approx: true }, mapsOn: true })).toEqual({ types: MAP_TYPES, note: NOTE_APPROX });
  });
  it("keeps to the line, and says why, in each case that has no map", () => {
    expect(viewerPlan({ geo: null, mapsOn: true })).toEqual({ types: ["line"], note: NOTE_NO_ANCHOR });
    expect(viewerPlan({ geo, mapsOn: false })).toEqual({ types: ["line"], note: NOTE_NOT_SET_UP });
    expect(viewerPlan({ geo, mapsOn: true, loadFailed: true })).toEqual({ types: ["line"], note: NOTE_OFFLINE });
    // No anchor is the reason that stands, whatever else is also true.
    expect(viewerPlan({ geo: null, mapsOn: false, loadFailed: true }).note).toBe(NOTE_NO_ANCHOR);
  });
});

describe("the remembered map type", () => {
  it("defaults to satellite and remembers a valid choice", () => {
    const s = store();
    expect(currentMapType(s)).toBe(DEFAULT_MAP_TYPE);
    setMapType("standard", s);
    expect(currentMapType(s)).toBe("standard");
    setMapType("globe", s);
    expect(currentMapType(s)).toBe("standard");
  });
  it("survives storage that throws", () => {
    const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(currentMapType(broken)).toBe(DEFAULT_MAP_TYPE);
    expect(() => setMapType("line", broken)).not.toThrow();
  });
  it("opens on the remembered type only when the plan still offers it", () => {
    expect(startType({ types: MAP_TYPES }, "standard")).toBe("standard");
    expect(startType({ types: ["line"] }, "satellite")).toBe("line");
  });
});

describe("rampColor", () => {
  it("runs from the slow colour to the fast one at bucket midpoints", () => {
    expect(rampColor(0, 2, "#000000", "#ffffff")).toBe("rgb(64,64,64)");
    expect(rampColor(1, 2, "#000", "#fff")).toBe("rgb(191,191,191)");
    expect(rampColor(7, 16, " #102030", "#102030")).toBe("rgb(16,32,48)");
  });
});

describe("a tap on the map", () => {
  // A 400 m straight heading east from the anchor, then north.
  const trace = [[0, 0, 0], [100, 0, 0], [200, 0, 0], [400, 0, 0], [400, 300, 0]];

  it("traceMetres inverts the projection", () => {
    const [p] = projectTrace([{ t: 0, lat: 36.5631, lon: -79.2019 }], geo);
    const [x, y] = traceMetres(36.5631, -79.2019, geo);
    expect(x).toBeCloseTo(p.x, 9);
    expect(y).toBeCloseTo(p.y, 9);
  });

  it("reads the line within the tap radius and nothing beyond it", () => {
    const at = (x, y) => [geo.lat + y / 110540, geo.lon + x / (111320 * Math.cos((geo.lat * Math.PI) / 180))];
    // 1 m per pixel: 20 m off the line is inside 24 px, 30 m is not.
    const hit = tapHit(trace, geo, ...at(250, 20), 1);
    expect(hit.alongM).toBeCloseTo(250, 6);
    expect(hit.offM).toBeCloseTo(20, 6);
    expect(tapHit(trace, geo, ...at(250, 30), 1)).toBeNull();
    // Zoomed out to 2 m per pixel, the same tap is within reach.
    expect(tapHit(trace, geo, ...at(250, 30), 2)).not.toBeNull();
    expect(TAP_RADIUS_PX).toBe(24);
  });

  it("pointAlong is the point on the line, not the nearer fix", () => {
    expect(pointAlong(trace, 250)).toEqual([250, 0]);
    expect(pointAlong(trace, 500)).toEqual([400, 100]);
    expect(pointAlong(trace, 9999)).toEqual([400, 300]);
  });

  it("headingDeg is the way round, clockwise from north", () => {
    expect(headingDeg(trace, 1)).toBeCloseTo(90, 9);
    expect(headingDeg(trace, 4)).toBeCloseTo(0, 9);
    expect(headingDeg([[0, 0, 0], [-10, 0, 0]], 0)).toBeCloseTo(270, 9);
  });
});

describe("the read-out", () => {
  const entry = { speed: [100, 120, 140, 160, 180] };
  it("reads speed and distance off the lap's own channel entry", () => {
    const place = placeAt({ frac: 0.625, alongM: 999 }, entry, 20);
    expect(place.kph).toBeCloseTo(150, 9);
    expect(place.distM).toBeCloseTo(50, 9);
    expect(readoutText(place, "metric")).toBe("150 km/h · 50 m");
    expect(readoutText(place, "imperial")).toBe("93 mph · 164 ft");
  });
  it("holds at the lap's last sample", () => {
    expect(placeAt({ frac: 1, alongM: 0 }, entry, 20)).toEqual({ kph: 180, distM: 80 });
  });
  it("is the distance along the drawn line alone without a channel entry", () => {
    const place = placeAt({ frac: 0.5, alongM: 1240.4 }, null, null);
    expect(place).toEqual({ kph: null, distM: 1240.4 });
    expect(readoutText(place, "metric")).toBe("1.2 km");
    expect(placeAt({ frac: 0.5, alongM: 7 }, { speed: [1] }, 20).kph).toBeNull();
  });
});
