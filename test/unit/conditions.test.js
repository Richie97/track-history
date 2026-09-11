import { describe, expect, it } from "vitest";
import {
  BAND_MIN_SPAN_C,
  ambientMidC,
  ambientText,
  bandAlpha,
  bandLabel,
  conditionsBand,
  conditionsChipHtml,
  conditionsLegendHtml,
  cToF,
  elevationText,
  eventAmbient,
  fToC,
  sessionAmbientC,
  sessionElevationM,
  tempText,
  trackElevationM,
} from "../../public/js/conditions.js";

const ev = (o = {}) => ({ ambient_lo_c: null, ambient_hi_c: null, elevation_m: null, temp_f: null, ...o });

describe("conditions — units", () => {
  it("converts both ways", () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(fToC(32)).toBe(0);
    expect(Math.round(fToC(72))).toBe(22);
  });

  it("words a temperature in either system, whole degrees", () => {
    expect(tempText(21.4, "us")).toBe("71 °F");
    expect(tempText(21.4)).toBe("21 °C");
  });
});

describe("sessionAmbientC / sessionElevationM", () => {
  it("prefers the column and falls back to the channel meta", () => {
    expect(sessionAmbientC({ ambient_c: 18.5, channels: { meta: { ambientC: 99 } } })).toBe(18.5);
    // A free account's channels are stripped and the column is not; a response
    // cached before migration 0020 is the other way round.
    expect(sessionAmbientC({ channels: { meta: { ambientC: 24 } } })).toBe(24);
    expect(sessionElevationM({ channels: { meta: { elevationM: 38 } } })).toBe(38);
  });

  it("has nothing for a hand-entered or GPS-recorded session", () => {
    expect(sessionAmbientC({ ambient_c: null, channels: null })).toBeNull();
    expect(sessionAmbientC({})).toBeNull();
    expect(sessionElevationM({ elevation_m: null, channels: { meta: {} } })).toBeNull();
  });
});

describe("eventAmbient — recorded beats typed", () => {
  it("uses the recorded range when there is one", () => {
    const a = eventAmbient(ev({ ambient_lo_c: 14.2, ambient_hi_c: 31.8, temp_f: 61 }));
    expect(a).toEqual({ loC: 14.2, hiC: 31.8, source: "recorded" });
  });

  it("falls back to the typed °F, converted", () => {
    const a = eventAmbient(ev({ temp_f: 68 }));
    expect(a.source).toBe("manual");
    expect(a.loC).toBeCloseTo(20, 6);
    expect(a.loC).toBe(a.hiC);
  });

  it("has nothing when neither exists", () => {
    expect(eventAmbient(ev())).toBeNull();
    expect(eventAmbient(undefined)).toBeNull();
  });

  it("orders a reversed range rather than trusting the column order", () => {
    const a = eventAmbient(ev({ ambient_lo_c: 30, ambient_hi_c: 12 }));
    expect([a.loC, a.hiC]).toEqual([12, 30]);
  });
});

describe("ambientText", () => {
  it("says one figure, or the day's range", () => {
    expect(ambientText({ loC: 20, hiC: 20 }, "us")).toBe("68 °F");
    expect(ambientText({ loC: 14.2, hiC: 31.8 }, "us")).toBe("58–89 °F");
    expect(ambientText({ loC: 14.2, hiC: 31.8 })).toBe("14–32 °C");
  });

  it("collapses a range that rounds to one number", () => {
    // 21.4 and 21.8 °C are 70.5 and 71.2 °F: one number, not "71–71 °F".
    expect(ambientText({ loC: 21.4, hiC: 21.8 }, "us")).toBe("71 °F");
  });

  it("is empty with nothing to say", () => {
    expect(ambientText(null, "us")).toBe("");
  });
});

describe("elevation", () => {
  it("takes the largest range seen at the track, never a sum", () => {
    expect(trackElevationM([ev({ elevation_m: 38 }), ev({ elevation_m: 41 }), ev()])).toBe(41);
    expect(trackElevationM([ev(), ev()])).toBeNull();
    expect(trackElevationM([])).toBeNull();
  });

  it("words it in one line", () => {
    expect(elevationText(41, "us")).toBe("135 ft of elevation change");
    expect(elevationText(41)).toBe("41 m of elevation change");
    expect(elevationText(null, "us")).toBe("");
  });
});

describe("conditionsBand", () => {
  const cool = ev({ ambient_lo_c: 10, ambient_hi_c: 10 });
  const warm = ev({ ambient_lo_c: 20, ambient_hi_c: 20 });
  const hot = ev({ ambient_lo_c: 30, ambient_hi_c: 30 });

  it("normalizes over the events in view, coolest to hottest", () => {
    const band = conditionsBand([cool, warm, hot]);
    expect([band.loC, band.hiC]).toEqual([10, 30]);
    expect(band.cells.map((c) => c.intensity)).toEqual([0, 0.5, 1]);
    expect(band.cells[0].alpha).toBeCloseTo(0.05, 6);
    expect(band.cells[2].alpha).toBeCloseTo(0.3, 6);
  });

  it("shades by the midpoint of a day that warmed up", () => {
    const band = conditionsBand([cool, ev({ ambient_lo_c: 14, ambient_hi_c: 26 }), hot]);
    expect(band.cells[1].c).toBe(20);
    expect(band.cells[1].intensity).toBe(0.5);
  });

  it("draws nothing for an event with no reading rather than the coolest shade", () => {
    const band = conditionsBand([cool, ev(), hot]);
    expect(band.cells[1]).toBeNull();
    expect(band.cells[0]).not.toBeNull();
  });

  it("counts a typed temperature too — most logbooks have no telemetry", () => {
    const band = conditionsBand([ev({ temp_f: 50 }), ev({ temp_f: 90 })]);
    expect(band.cells.every((c) => c != null)).toBe(true);
  });

  it("refuses a spread too small to mean anything", () => {
    expect(conditionsBand([cool, ev({ ambient_lo_c: 10 + BAND_MIN_SPAN_C - 0.1, ambient_hi_c: 10 + BAND_MIN_SPAN_C - 0.1 })])).toBeNull();
    expect(conditionsBand([cool, ev({ ambient_lo_c: 10 + BAND_MIN_SPAN_C, ambient_hi_c: 10 + BAND_MIN_SPAN_C })])).not.toBeNull();
  });

  it("refuses a single known event, and an empty list", () => {
    expect(conditionsBand([cool, ev(), ev()])).toBeNull();
    expect(conditionsBand([])).toBeNull();
    expect(conditionsBand(null)).toBeNull();
  });

  it("clamps the wash to its range", () => {
    expect(bandAlpha(-1)).toBe(0.05);
    expect(bandAlpha(2)).toBe(0.3);
  });

  it("speaks the shading for a screen reader", () => {
    expect(bandLabel(conditionsBand([cool, hot]), "us")).toBe(
      "shaded by ambient temperature, 50 °F to 86 °F"
    );
    expect(bandLabel(null, "us")).toBe("");
  });

  it("takes the midpoint of an event's range", () => {
    expect(ambientMidC({ loC: 10, hiC: 30 })).toBe(20);
    expect(ambientMidC(null)).toBeNull();
  });
});

describe("web rendering", () => {
  it("chips a session that recorded its own air temperature", () => {
    expect(conditionsChipHtml({ ambient_c: 31.5 })).toContain("89 °F");
    // The event's typed figure is not repeated onto every session.
    expect(conditionsChipHtml({ ambient_c: null })).toBe("");
  });

  it("keys the band with both ends", () => {
    const html = conditionsLegendHtml(conditionsBand([ev({ ambient_lo_c: 10, ambient_hi_c: 10 }), ev({ ambient_lo_c: 30, ambient_hi_c: 30 })]));
    expect(html).toContain("50 °F");
    expect(html).toContain("86 °F");
    expect(conditionsLegendHtml(null)).toBe("");
  });
});
