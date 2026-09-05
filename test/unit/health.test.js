import { describe, expect, it } from "vitest";
import {
  HEALTH_DEFS,
  MIN_FUEL_DROPS,
  SPREAD_WATCH_C,
  TYRE_CORNERS,
  cToF,
  defFor,
  displayDelta,
  displayValue,
  fuelBurn,
  fuelHtml,
  hasHealthData,
  healthCardsHtml,
  healthHtml,
  healthLaps,
  healthStatus,
  healthSummary,
  healthTableHtml,
  hotPressures,
  kpaToPsi,
  lapValue,
  nextTimeNote,
  pressureLoop,
  pressureLoopHtml,
  psiToKpa,
  roundPsi,
  scalarSeries,
  sessionExtreme,
  sessionHealth,
  sessionSpread,
  sparklineSvg,
  suggestCold,
  tyreSpread,
  tyreSpreadHtml,
} from "../../public/js/health.js";

// Three laps of a warming car: oil climbing through the watch line and over
// it, fuel draining, tyres growing, the battery sagging on the last lap.
// `boost` is a trace, so its per-lap peak is derived; lap 2 stores no
// coolant so the column has a hole.
const lap1 = {
  n: 1, timeMs: 95_000, speed: [100, 100, 100],
  oilC: 105, coolantC: 96, transC: 88, oilKpa: 320, fuelPct: 80, battV: 13.9,
  tyreKpaLF: 190, tyreKpaRF: 188, tyreKpaLR: 185, tyreKpaRR: 184,
  tyreCLF: 60, tyreCRF: 55, tyreCLR: 52, tyreCRR: 50,
  boost: [0, 40, 75, 20],
};
const lap2 = {
  n: 2, timeMs: 92_000, speed: [100, 100, 100],
  oilC: 124, transC: 101, oilKpa: 290, fuelPct: 77, battV: 13.8,
  tyreKpaLF: 210, tyreKpaRF: 206, tyreKpaLR: 200, tyreKpaRR: 199,
  tyreCLF: 82, tyreCRF: 70, tyreCLR: 66, tyreCRR: 63,
  boost: [0, 60, 88, 10],
};
const lap3 = {
  n: 3, timeMs: 91_000, speed: [100, 100, 100],
  oilC: 131, coolantC: 104, transC: 109, oilKpa: 240, fuelPct: 74.5, battV: 12.4,
  tyreKpaLF: 216, tyreKpaRF: 211, tyreKpaLR: 204, tyreKpaRR: 203,
  tyreCLF: 90, tyreCRF: 76, tyreCLR: 70, tyreCRR: 66,
  boost: [0, 55, 80, 15],
};
const hand = { n: 4, timeMs: 99_000, speed: [100, 100, 100] };
const channels = { v: 1, dStepM: 20, laps: [lap1, lap2, lap3, hand] };
const lit = new Map([[2, "var(--chart-line)"]]);
const label = (i) => `Lap ${i + 1}`;

describe("lapValue / hasHealthData / healthLaps", () => {
  it("reads a stored scalar as-is and derives boost from the trace", () => {
    expect(lapValue(lap1, "oilC")).toBe(105);
    expect(lapValue(lap1, "boost")).toBe(75);
    expect(lapValue(lap2, "coolantC")).toBeNull();
    expect(lapValue(hand, "oilC")).toBeNull();
    expect(lapValue({ boost: [] }, "boost")).toBeNull();
    expect(lapValue(null, "oilC")).toBeNull();
  });
  it("a hand-entered lap carries nothing, so the strip is absent for it", () => {
    expect(hasHealthData(lap1)).toBe(true);
    expect(hasHealthData(hand)).toBe(false);
    expect(healthLaps(channels).map((l) => l.chIdx)).toEqual([0, 1, 2]);
    expect(healthLaps({ laps: [hand] })).toEqual([]);
    expect(healthLaps(null)).toEqual([]);
  });
});

describe("scalarSeries / sessionExtreme", () => {
  it("skips laps without the column and keeps channel indexes", () => {
    expect(scalarSeries(channels, "coolantC")).toEqual([
      { chIdx: 0, v: 96 },
      { chIdx: 2, v: 104 },
    ]);
  });
  it("takes the session's worst case by the column's own rule", () => {
    expect(sessionExtreme(defFor("oilC"), scalarSeries(channels, "oilC"))).toEqual({ chIdx: 2, v: 131 });
    expect(sessionExtreme(defFor("oilKpa"), scalarSeries(channels, "oilKpa"))).toEqual({ chIdx: 2, v: 240 });
    expect(sessionExtreme(defFor("battV"), scalarSeries(channels, "battV"))).toEqual({ chIdx: 2, v: 12.4 });
    // an end-of-lap reading's extreme is the highest, the pressure the tyre reached
    expect(sessionExtreme(defFor("tyreKpaLF"), scalarSeries(channels, "tyreKpaLF"))).toEqual({ chIdx: 2, v: 216 });
    expect(sessionExtreme(defFor("oilC"), [])).toBeNull();
  });
});

describe("healthStatus", () => {
  it("shades past the lines, inclusive, on the right side for a floor", () => {
    const oil = defFor("oilC");
    expect(healthStatus(oil, 119)).toBe("ok");
    expect(healthStatus(oil, 120)).toBe("low");
    expect(healthStatus(oil, 130)).toBe("due");
    const batt = defFor("battV");
    expect(healthStatus(batt, 13.5)).toBe("ok");
    expect(healthStatus(batt, 13)).toBe("low");
    expect(healthStatus(batt, 12.5)).toBe("due");
    expect(healthStatus(batt, 12.4)).toBe("due");
  });
  it("is null for a column with no line, and for nothing", () => {
    expect(healthStatus(defFor("tyreCLF"), 200)).toBeNull();
    expect(healthStatus(defFor("oilC"), null)).toBeNull();
    expect(healthStatus(null, 1)).toBeNull();
  });
  it("every column with a watch line has an over line on the same side", () => {
    for (const d of HEALTH_DEFS) {
      if (d.watch == null) continue;
      expect(d.over).toBeDefined();
      expect(d.low ? d.over < d.watch : d.over > d.watch).toBe(true);
    }
  });
});

describe("sessionHealth", () => {
  it("reduces the session to rows and columns with each column's status", () => {
    const sh = sessionHealth(channels);
    expect(sh.laps.map((l) => l.chIdx)).toEqual([0, 1, 2]);
    expect(sh.laps[1].values.coolantC).toBeUndefined();
    expect(sh.laps[1].values.boost).toBe(88);
    const col = (k) => sh.columns.find((c) => c.key === k);
    expect(col("oilC")).toMatchObject({ extreme: { chIdx: 2, v: 131 }, status: "due" });
    expect(col("transC")).toMatchObject({ extreme: { v: 109 }, status: "ok" });
    expect(col("battV")).toMatchObject({ extreme: { v: 12.4 }, status: "due" });
    expect(col("fuelPct")).toMatchObject({ extreme: { v: 80 }, status: "ok" });
    expect(col("tyreCLF").status).toBeNull();
    // columns come out in HEALTH_DEFS order, only the ones present
    expect(sh.columns.map((c) => c.key)).toEqual(HEALTH_DEFS.map((d) => d.key));
  });
  it("is null with nothing to show", () => {
    expect(sessionHealth({ v: 1, dStepM: 20, laps: [hand] })).toBeNull();
    expect(sessionHealth(null)).toBeNull();
  });
});

describe("tyreSpread / sessionSpread", () => {
  it("is left minus right per axle and front minus rear by axle mean", () => {
    expect(tyreSpread(lap3, "tyreC")).toEqual({ front: 14, rear: 4, axle: 15 });
    expect(tyreSpread(lap3, "tyreKpa")).toEqual({ front: 5, rear: 1, axle: 10 });
    expect(sessionSpread(channels, "tyreC").map((s) => s.chIdx)).toEqual([0, 1, 2]);
  });
  it("needs all four corners", () => {
    const { tyreCRR: _rr, ...three } = lap1;
    expect(tyreSpread(three, "tyreC")).toBeNull();
    expect(sessionSpread({ laps: [three, hand] }, "tyreC")).toEqual([]);
  });
});

describe("fuelBurn", () => {
  it("is the median drop and the laps left at that rate", () => {
    // drops: 3, 2.5 → median 2.75; 74.5 / 2.75 = 27.09 → 27 laps
    expect(fuelBurn(channels)).toEqual({ perLapPct: 2.75, lastPct: 74.5, lapsRemaining: 27, drops: 2 });
  });
  it("ignores a refuel and needs enough drops", () => {
    const laps = (pcts) => ({ laps: pcts.map((fuelPct, i) => ({ n: i + 1, timeMs: 1, fuelPct })) });
    expect(fuelBurn(laps([80, 78, 95, 93, 90]))).toEqual({ perLapPct: 2, lastPct: 90, lapsRemaining: 45, drops: 3 });
    expect(fuelBurn(laps([80, 78]))).toBeNull();
    expect(MIN_FUEL_DROPS).toBe(2);
    expect(fuelBurn({ laps: [hand] })).toBeNull();
  });
});

describe("hotPressures", () => {
  it("is the highest end-of-lap reading per corner, with the lap and the last", () => {
    const hot = hotPressures(channels);
    expect(hot.LF).toEqual({ peakKpa: 216, peakChIdx: 2, lastKpa: 216 });
    expect(Object.keys(hot)).toEqual(TYRE_CORNERS.map(([c]) => c));
    // a corner the session never stored is simply absent
    const { tyreKpaRR: _rr, ...noRR } = lap1;
    expect(hotPressures({ laps: [noRR] }).RR).toBeUndefined();
    expect(hotPressures({ laps: [hand] })).toBeNull();
  });
});

describe("suggestCold", () => {
  it("takes the overshoot off the cold pressure, on the sheet's step", () => {
    // 22.6 cold → 31.3 hot vs 30 target: overshoot 1.3, 21.3 → 21.5
    expect(suggestCold(22.6, 31.3, 30)).toEqual({ coldPsi: 22.6, hotPsi: 31.3, targetPsi: 30, suggestedPsi: 21.5, deltaPsi: 21.5 - 22.6 });
    expect(suggestCold(30, 34, 34).deltaPsi).toBe(0);
    expect(suggestCold(30, 32, 34).suggestedPsi).toBe(32);
    expect(suggestCold(null, 31, 30)).toBeNull();
    expect(suggestCold(30, 31, null)).toBeNull();
    expect(roundPsi(21.24)).toBe(21);
    expect(roundPsi(21.26)).toBe(21.5);
  });
});

describe("pressureLoop", () => {
  const sheet = { tp_cold: { fl: 27, fr: 27, rl: 26, rr: 26 }, notes: "baseline" };
  it("pairs the sheet's cold with the import's hot and suggests per corner", () => {
    const loop = pressureLoop(channels, sheet, 30);
    expect(loop.rows.map((r) => r.corner)).toEqual(["LF", "RF", "LR", "RR"]);
    const lf = loop.rows[0];
    expect(lf.coldPsi).toBe(27);
    expect(lf.hotPsi).toBeCloseTo(kpaToPsi(216), 9); // 31.33 psi
    expect(lf.hotChIdx).toBe(2);
    expect(lf.suggestion.suggestedPsi).toBe(25.5); // 27 − (31.33 − 30) = 25.67 → 25.5
    expect(loop.coldSheet).toEqual({ fl: 25.5, fr: 26.5, rl: 26.5, rr: 26.5 }); // RF 30.6 hot, the rears under target
    expect(loop.hotSheet).toEqual({ fl: 31.5, fr: 30.5, rl: 29.5, rr: 29.5 });
  });
  it("shows the hots without a sheet or a target, and suggests nothing", () => {
    const loop = pressureLoop(channels, null, null);
    expect(loop.rows[0].coldPsi).toBeNull();
    expect(loop.rows[0].suggestion).toBeNull();
    expect(loop.coldSheet).toBeNull();
    expect(Object.keys(loop.hotSheet)).toHaveLength(4);
    // a partial sheet suggests for the corners it has and no cold sheet
    const partial = pressureLoop(channels, { tp_cold: { fl: 27 } }, 30);
    expect(partial.rows[0].suggestion).not.toBeNull();
    expect(partial.rows[1].suggestion).toBeNull();
    expect(partial.coldSheet).toBeNull();
  });
  it("is null when the session stored no hot pressure", () => {
    expect(pressureLoop({ laps: [hand] }, sheet, 30)).toBeNull();
  });
  it("writes a next-time note that carries the suggestion forward", () => {
    const note = nextTimeNote(pressureLoop(channels, sheet, 30));
    expect(note).toBe("Next time cold: LF 25.5 / RF 26.5 / LR 26.5 / RR 26.5 psi (hots ran 31.5 / 30.5 / 29.5 / 29.5 vs 30.0 target)");
    expect(nextTimeNote(pressureLoop(channels, null, null))).toBeNull();
  });
});

describe("units", () => {
  it("converts for display and keeps the stored unit as the default", () => {
    expect(displayValue(defFor("oilC"), 130)).toEqual({ value: 130, unit: "°C", dp: 0, text: "130 °C" });
    expect(displayValue(defFor("oilC"), 130, "us").text).toBe("266 °F");
    expect(displayValue(defFor("tyreKpaLF"), 216, "us").text).toBe("31.3 psi");
    expect(displayValue(defFor("battV"), 12.4, "us").text).toBe("12.4 V");
    expect(cToF(100)).toBe(212);
    expect(psiToKpa(kpaToPsi(200))).toBeCloseTo(200, 9);
  });
  it("scales a temperature delta without the offset", () => {
    expect(displayDelta(defFor("tyreCLF"), 10, "us").text).toBe("+18 °F");
    expect(displayDelta(defFor("tyreCLF"), -10).text).toBe("-10 °C");
    expect(displayDelta(defFor("tyreKpaLF"), 6.894757, "us").text).toBe("+1.0 psi");
  });
});

describe("healthSummary", () => {
  it("names what is past a line, worst first, and the fuel outlook", () => {
    expect(healthSummary(channels)).toBe("car: oil temp 131 °C, battery 12.4 V, ≈27 laps of fuel at this rate");
    expect(healthSummary(channels, "us")).toBe("car: oil temp 268 °F, battery 12.4 V, ≈27 laps of fuel at this rate");
  });
  it("puts a watch after an over, and says nothing when there is nothing to say", () => {
    const warm = { laps: [{ ...lap1, oilC: 125, battV: 12.3, fuelPct: undefined }] };
    expect(healthSummary(warm)).toBe("car: battery 12.3 V, oil temp 125 °C");
    expect(healthSummary({ laps: [{ ...lap1, fuelPct: undefined }] })).toBeNull();
    expect(healthSummary({ laps: [hand] })).toBeNull();
  });
});

describe("web rendering", () => {
  it("draws one sparkline per column present, with the lit lap marked and the bands shaded", () => {
    const svg = sparklineSvg(defFor("oilC"), scalarSeries(channels, "oilC"), [0, 1, 2], lit, "us");
    expect(svg).toContain("<path");
    expect((svg.match(/<circle/g) ?? []).length).toBe(1);
    expect((svg.match(/<rect/g) ?? []).length).toBe(2); // over band + watch band
    expect(svg).toContain("221 °F on the first lap to 268 °F on the last");
    // a column with no line draws no band
    expect(sparklineSvg(defFor("tyreCLF"), scalarSeries(channels, "tyreCLF"), [0, 1, 2], lit, "us")).not.toContain("<rect");
    expect(sparklineSvg(defFor("oilC"), [], [0], lit, "us")).toBe("");
  });
  it("groups the cards and shades by status", () => {
    const html = healthCardsHtml(channels, lit, "us");
    expect(html).toContain("Temperatures");
    expect(html).toContain("Fuel &amp; electrical");
    expect(html).toContain('class="health-card hs-due" data-health-key="oilC"');
    expect(html).toContain('data-health-key="boost"');
    expect(html).not.toContain("hs-null");
    expect(healthCardsHtml({ laps: [hand] }, lit, "us")).toBe("");
  });
  it("tabulates every lap with a figure, holes as dashes, cells shaded", () => {
    const html = healthTableHtml(channels, lit, label, "us");
    expect((html.match(/<tr>/g) ?? []).length).toBe(2 + 3); // two header rows, three laps — not the hand-entered one
    expect(html).toContain('class="num hs-none">—');
    expect(html).toContain('class="num hs-due">268');
    expect(html).toContain('colspan="7" class="hg-head">Temperatures');
  });
  it("renders the spread tables and the fuel line", () => {
    const spread = tyreSpreadHtml(channels, lit, label, "us");
    expect(spread).toContain("Tyre temperature spread");
    expect(spread).toContain("Tyre pressure spread");
    expect(spread).toContain("+25 °F"); // lap 3 LF−RF: 14 °C
    expect(SPREAD_WATCH_C).toBe(10);
    expect(spread).toContain('class="num hs-low">+25 °F');
    expect(fuelHtml(channels)).toContain("≈27 laps");
    expect(fuelHtml({ laps: [hand] })).toBe("");
  });
  it("the loop card says what is missing and offers the right actions", () => {
    const sheet = { tp_cold: { fl: 27, fr: 27, rl: 26, rr: 26 } };
    const base = { day: 1, days: [1, 2], sheet, nextDay: 2, nextHasSheet: false };
    const full = pressureLoop(channels, sheet, 30);
    const html = pressureLoopHtml(
      { ...base, loop: full, vehicle: { id: 7, name: "Corvette", target_hot_psi: 30 }, noteLine: nextTimeNote(full) },
      label
    );
    expect(html).toContain("<b>25.5</b>");
    expect(html).toContain('data-health-record="1"');
    expect(html).toContain('data-health-next="2"');
    expect(html).toContain("Start the day 2 sheet from these");
    expect(html).toContain('data-health-day');
    expect(html).toContain('data-health-target="7"');
    // no target: the suggestion column is empty and the card says why
    const noTarget = pressureLoopHtml(
      { ...base, loop: pressureLoop(channels, sheet, null), vehicle: { id: 7, name: "Corvette", target_hot_psi: null }, noteLine: null },
      label
    );
    expect(noTarget).toContain("Set a target hot pressure");
    expect(noTarget).not.toContain("data-health-next");
    // no vehicle link: no target form at all
    const noVehicle = pressureLoopHtml({ ...base, loop: pressureLoop(channels, null, null), sheet: null, vehicle: null, noteLine: null }, label);
    expect(noVehicle).toContain("garage vehicles");
    expect(noVehicle).not.toContain("data-health-target");
    expect(noVehicle).toContain("Start the day 1 sheet with these");
    // already recorded: no record button, a note instead
    const recorded = { ...sheet, tp_hot: full.hotSheet, notes: nextTimeNote(full) };
    const done = pressureLoopHtml(
      { ...base, loop: full, sheet: recorded, vehicle: { id: 7, name: "Corvette", target_hot_psi: 30 }, noteLine: nextTimeNote(full) },
      label
    );
    expect(done).not.toContain("data-health-record");
    expect(done).toContain("Recorded on the day 1 sheet");
    expect(pressureLoopHtml({ ...base, loop: null }, label)).toBe("");
  });
  it("the whole tab is absent without a figure and carries the loop when given one", () => {
    expect(healthHtml({ laps: [hand] }, lit, label)).toBe("");
    const html = healthHtml(channels, lit, label, { loopHtml: '<div class="health-loop">loop</div>' });
    expect(html).toContain('class="ch-health"');
    expect(html).toContain("health-loop");
    expect(html).toContain("health-table");
  });
});
