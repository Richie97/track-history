import { describe, expect, it } from "vitest";
import {
  MIN_DISAGREE_POINTS,
  fmtRpm,
  gearDisagreements,
  gearRibbonSvg,
  gearSegments,
  lapShifts,
  ordinal,
  shiftNotes,
  shiftPoints,
  shiftTableHtml,
} from "../../public/js/gears.js";

// A lap in 2nd, up to 3rd, a clutch-in blip, 4th, then back down to 3rd.
const gearA = [2, 2, 2, 3, 3, 3, 3, 0, 4, 4, 4, 4, 3, 3];
// rpm climbs before each upshift and drops after it.
const rpmA = [5000, 6000, 7000, 4500, 5500, 6500, 7100, 7100, 4800, 5200, 5600, 6000, 6900, 5000];

describe("ordinal / fmtRpm", () => {
  it("spells gears as ordinals and 0 as no gear", () => {
    expect([0, 1, 2, 3, 4, 8].map(ordinal)).toEqual(["no gear", "1st", "2nd", "3rd", "4th", "8th"]);
  });
  it("groups thousands without touching the locale", () => {
    expect(fmtRpm(6400)).toBe("6,400");
    expect(fmtRpm(999.6)).toBe("1,000");
    expect(fmtRpm(12)).toBe("12");
  });
});

describe("gearSegments", () => {
  it("cuts a lap into runs of one gear, keeping gear-0 runs", () => {
    expect(gearSegments(gearA)).toEqual([
      { gear: 2, k0: 0, k1: 2 },
      { gear: 3, k0: 3, k1: 6 },
      { gear: 0, k0: 7, k1: 7 },
      { gear: 4, k0: 8, k1: 11 },
      { gear: 3, k0: 12, k1: 13 },
    ]);
  });
  it("is empty for a missing or empty series", () => {
    expect(gearSegments(undefined)).toEqual([]);
    expect(gearSegments([])).toEqual([]);
  });
});

describe("lapShifts", () => {
  it("reports each step with the rpm at the last sample in the old gear", () => {
    expect(lapShifts({ gear: gearA, rpm: rpmA })).toEqual([
      { k: 3, from: 2, to: 3, up: true, rpm: 7000 },
      { k: 8, from: 3, to: 4, up: true, rpm: 7100 }, // read at k=6, the last sample in 3rd, not the clutch-in blip
      { k: 12, from: 4, to: 3, up: false, rpm: 6000 },
    ]);
  });
  it("skips a clutch-in stretch rather than counting it as a gear", () => {
    expect(lapShifts({ gear: [3, 0, 0, 3] })).toEqual([]);
  });
  it("gives null rpm without an rpm series and nothing without a gear series", () => {
    expect(lapShifts({ gear: [2, 3] })).toEqual([{ k: 1, from: 2, to: 3, up: true, rpm: null }]);
    expect(lapShifts({ rpm: rpmA })).toEqual([]);
    expect(lapShifts(null)).toEqual([]);
  });
});

describe("shiftPoints", () => {
  const channels = {
    v: 1,
    dStepM: 20,
    laps: [
      { n: 1, timeMs: 90_000, gear: gearA, rpm: rpmA },
      { n: 2, timeMs: 89_000, gear: gearA, rpm: rpmA.map((v, k) => (k === 2 ? 6400 : k === 6 ? 7300 : v)) },
      { n: 3, timeMs: 91_000, gear: gearA }, // no rpm: not counted
      { n: 4, timeMs: 92_000, speed: [100, 100] }, // no gear: not counted
    ],
  };

  it("reduces upshifts to min / median / max rpm per gear, downshifts excluded", () => {
    const sp = shiftPoints(channels);
    expect(sp.gears).toEqual([
      { gear: 2, count: 2, minRpm: 6400, medianRpm: 6700, maxRpm: 7000 },
      { gear: 3, count: 2, minRpm: 7100, medianRpm: 7200, maxRpm: 7300 },
    ]);
    expect(sp.medianRpm).toBe(Math.round((7000 + 7100) / 2));
    expect(sp.maxRpm).toBe(7300);
  });

  it("is null when no lap carries gear and rpm, or nothing upshifts", () => {
    expect(shiftPoints({ v: 1, dStepM: 20, laps: [channels.laps[2], channels.laps[3]] })).toBeNull();
    expect(shiftPoints({ v: 1, dStepM: 20, laps: [{ n: 1, gear: [3, 3, 3], rpm: [5000, 5000, 5000] }] })).toBeNull();
    expect(shiftPoints(null)).toBeNull();
  });
});

describe("shiftNotes", () => {
  it("names the gears taken to the top of the rev range and the ones shifted early", () => {
    const notes = shiftNotes({
      gears: [
        { gear: 2, count: 3, minRpm: 6900, medianRpm: 7000, maxRpm: 7150 },
        { gear: 3, count: 3, minRpm: 6800, medianRpm: 6950, maxRpm: 7100 },
        { gear: 4, count: 2, minRpm: 6000, medianRpm: 6200, maxRpm: 6400 },
        { gear: 5, count: 1, minRpm: 5000, medianRpm: 5000, maxRpm: 5000 }, // one shift: not a pattern
      ],
      medianRpm: 6900,
      maxRpm: 7200,
    });
    expect(notes).toEqual([
      "Upshifts from 2nd and 3rd run to the top of the rev range seen today (≈7,200 rpm).",
      "Upshifts from 4th come ≈800 rpm earlier than from 2nd.",
    ]);
  });
  it("says nothing when the gears agree and none reaches the limit", () => {
    expect(
      shiftNotes({
        gears: [
          { gear: 2, count: 3, minRpm: 6400, medianRpm: 6500, maxRpm: 6600 },
          { gear: 3, count: 3, minRpm: 6300, medianRpm: 6400, maxRpm: 6500 },
        ],
        medianRpm: 6450,
        maxRpm: 7200,
      })
    ).toEqual([]);
    expect(shiftNotes(null)).toEqual([]);
  });
});

describe("gearDisagreements", () => {
  it("outlines runs where highlighted laps sit in different gears", () => {
    const a = [2, 2, 3, 3, 3, 3, 3, 3, 4, 4];
    const b = [2, 2, 4, 4, 4, 4, 3, 3, 4, 4]; // 4th where a is in 3rd for four points
    expect(gearDisagreements([a, b])).toEqual([{ k0: 2, k1: 5 }]);
  });
  it("ignores a shift that merely lands a sample later, and gear 0 on either lap", () => {
    const a = [2, 2, 3, 3, 3, 3, 3];
    const b = [2, 2, 2, 3, 3, 3, 3]; // one-point offset: a shift, not a choice
    expect(gearDisagreements([a, b])).toEqual([]);
    const c = [2, 2, 0, 0, 0, 0, 3]; // clutch in where a is in 3rd: no disagreement
    expect(gearDisagreements([a, c])).toEqual([]);
    expect(MIN_DISAGREE_POINTS).toBe(3);
  });
  it("needs two series and honours the run threshold", () => {
    expect(gearDisagreements([[2, 3]])).toEqual([]);
    expect(gearDisagreements([[2, 3, 3], [2, 4, 4]], 1)).toEqual([{ k0: 1, k1: 2 }]);
  });
});

describe("gearRibbonSvg", () => {
  const channels = {
    v: 1,
    dStepM: 20,
    laps: [
      { n: 1, timeMs: 90_000, speed: Array(14).fill(100), gear: gearA, rpm: rpmA },
      { n: 2, timeMs: 89_000, speed: Array(14).fill(100), gear: [2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3] },
      { n: 3, timeMs: 91_000, speed: Array(14).fill(100) }, // no gear
    ],
  };
  const label = (i) => `Lap ${i + 1}`;

  it("draws one block per gear run, a gap for gear 0, on the channel charts' axis", () => {
    const svg = gearRibbonSvg(channels, new Map([[0, "var(--chart-line)"]]), label);
    expect(svg).toContain('data-channel="gear"');
    expect(svg).toContain('data-padl="56"');
    expect(svg).toContain(`data-x1="${13 * 20}"`);
    expect((svg.match(/<rect /g) || []).length).toBe(4); // 2, 3, 4, 3 — the 0 run is a gap
    expect(svg).toContain("Lap 1");
    expect(svg).not.toContain("dashed");
  });

  it("outlines the runs where two highlighted laps disagree", () => {
    const lit = new Map([
      [0, "var(--chart-line)"],
      [1, "var(--chart-line-b)"],
    ]);
    const svg = gearRibbonSvg(channels, lit, label);
    // 4 blocks + 2 blocks + one dashed outline (lap 1 in 4th for k=8..11 while lap 2 stays in 3rd)
    expect((svg.match(/<rect /g) || []).length).toBe(7);
    expect(svg).toContain('stroke-dasharray="3 2"');
    expect(svg).toContain("laps disagree");
  });

  it("returns '' when no highlighted lap has a gear series", () => {
    expect(gearRibbonSvg(channels, new Map([[2, "var(--chart-line)"]]), label)).toBe("");
    expect(gearRibbonSvg(channels, new Map(), label)).toBe("");
  });
});

describe("shiftTableHtml", () => {
  it("tabulates upshift rpm per gear with the notes beneath, and is '' without data", () => {
    const html = shiftTableHtml({
      v: 1,
      dStepM: 20,
      laps: [
        { n: 1, gear: gearA, rpm: rpmA },
        { n: 2, gear: gearA, rpm: rpmA },
      ],
    });
    expect(html).toContain('class="ch-shifts"');
    expect(html).toContain("From 2nd");
    expect(html).toContain("From 3rd");
    expect(html).toContain("7,100"); // 3rd's upshift rpm
    expect(html).toContain("run to the top of the rev range"); // 3rd hits the session max
    expect(shiftTableHtml({ v: 1, dStepM: 20, laps: [{ n: 1, speed: [1, 2] }] })).toBe("");
  });
});
