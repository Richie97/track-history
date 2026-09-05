import { describe, expect, it } from "vitest";
import {
  COMBINED_MIN_G,
  MIN_LOAD_G,
  PEAK_PERCENTILE,
  frictionCircleSvg,
  gripCircleHtml,
  gripLaps,
  gripPoints,
  gripReadoutHtml,
  gripShares,
  hasGripData,
  latSign,
  peakCombinedG,
  sessionGrip,
} from "../../public/js/grip.js";

// Eight grid points each. The "cross" lap brakes in a straight line, turns,
// then accelerates — the two axes are never used together. The "circle" lap
// trails the brake in (k1, k2) and feeds the power out (k4-k6), all while
// cornering, and steers left throughout so its samples mirror to -x.
const cross = {
  n: 1,
  timeMs: 90_000,
  speed: Array(8).fill(120),
  latG: [0, 0, 0, 1.2, 1.2, 0, 0, 0],
  longG: [0, -1, -1, 0, 0, 0.5, 0.5, 0],
};
const circle = {
  n: 2,
  timeMs: 88_000,
  speed: Array(8).fill(120),
  latG: [0, 0.6, 0.9, 1.1, 1.0, 0.8, 0.4, 0],
  longG: [0, -0.9, -0.6, 0, 0.3, 0.5, 0.6, 0],
  steering: [0, -10, -12, -14, -12, -8, -3, 0],
};
const channels = { v: 1, dStepM: 20, laps: [cross, circle] };

describe("hasGripData / gripLaps", () => {
  it("needs both channels", () => {
    expect(hasGripData(cross)).toBe(true);
    expect(hasGripData({ latG: [1, 2] })).toBe(false);
    expect(hasGripData({ longG: [1, 2] })).toBe(false);
    expect(hasGripData(undefined)).toBe(false);
    expect(gripLaps(channels).map((l) => l.chIdx)).toEqual([0, 1]);
    // a lap without both is left out, and the indexes stay channel indexes
    expect(gripLaps({ laps: [{ speed: [1] }, circle] }).map((l) => l.chIdx)).toEqual([1]);
    expect(gripLaps(null)).toEqual([]);
  });
});

describe("latSign", () => {
  it("takes the side from the steering trace, +1 without one", () => {
    expect(latSign(circle, 1)).toBe(-1);
    expect(latSign(circle, 0)).toBe(1); // straight: sign doesn't matter, latG ~ 0
    expect(latSign(cross, 3)).toBe(1); // no steering stored
    expect(latSign(circle, 99)).toBe(1); // past the end of the trace
  });
});

describe("gripPoints", () => {
  it("signs lateral by steering and keeps longitudinal as stored", () => {
    const pts = gripPoints(circle);
    expect(pts).toHaveLength(8);
    expect(pts[1].lat).toBeCloseTo(-0.6, 9); // steering negative -> left
    expect(pts[1].long).toBeCloseTo(-0.9, 9); // braking stays negative
    expect(pts[1].g).toBeCloseTo(Math.hypot(0.6, 0.9), 9);
    expect(pts[1].k).toBe(1);
    expect(gripPoints(cross)[3].lat).toBeCloseTo(1.2, 9); // no steering: right side
  });
  it("plots the samples both channels cover, and nothing without them", () => {
    expect(gripPoints({ latG: [1, 1, 1], longG: [0, 0] })).toHaveLength(2);
    expect(gripPoints({ speed: [1, 2] })).toEqual([]);
  });
  it("a magnitude stored with a sign is still a magnitude", () => {
    // pdr.js stores abs(lateral acceleration); a negative would be a bug in a
    // source, and it must not flip a sample to the other side of the plot.
    expect(gripPoints({ latG: [-1.1], longG: [0] })[0].lat).toBeCloseTo(1.1, 9);
  });
});

describe("gripShares", () => {
  it("scores the cross at zero on both quadrants", () => {
    const sh = gripShares(cross);
    expect(sh.loaded).toBe(6); // the two zero samples are the tyre doing nothing
    expect(sh.trailBrake).toBe(0);
    expect(sh.powerDown).toBe(0);
    expect(sh.trailPct).toBe(0);
    expect(sh.powerPct).toBe(0);
  });
  it("scores the filled circle on both", () => {
    const sh = gripShares(circle);
    expect(sh.samples).toBe(8);
    expect(sh.loaded).toBe(6);
    expect(sh.trailBrake).toBe(2);
    expect(sh.powerDown).toBe(3);
    expect(sh.trailPct).toBeCloseTo((2 / 6) * 100, 9);
    expect(sh.powerPct).toBeCloseTo((3 / 6) * 100, 9);
  });
  it("needs both axes past the threshold to count as combined", () => {
    const under = {
      latG: [1, COMBINED_MIN_G - 0.01, 1],
      longG: [-(COMBINED_MIN_G - 0.01), -1, -COMBINED_MIN_G],
    };
    expect(gripShares(under).trailBrake).toBe(1); // only the third sample
  });
  it("is null for a lap that never loads the tyre", () => {
    expect(gripShares({ latG: [0, 0.1], longG: [0, -0.1] })).toBeNull();
    expect(gripShares({ speed: [1] })).toBeNull();
    // exactly at the threshold counts as loaded
    expect(gripShares({ latG: [MIN_LOAD_G], longG: [0] }).loaded).toBe(1);
  });
});

describe("peakCombinedG", () => {
  it("is a percentile, so one kerb strike does not set the envelope", () => {
    const laps = [{ latG: Array(100).fill(1), longG: Array(100).fill(0) }];
    laps[0].latG[42] = 3; // the strike
    expect(peakCombinedG({ laps })).toBeCloseTo(1, 9);
    expect(PEAK_PERCENTILE).toBe(0.99);
    // and the max is still reachable when asked for
    expect(peakCombinedG({ laps }, 1)).toBeCloseTo(3, 9);
  });
  it("pools every plottable lap, and is null without one", () => {
    expect(peakCombinedG(channels)).toBeGreaterThan(1);
    expect(peakCombinedG({ laps: [{ speed: [1, 2] }] })).toBeNull();
    expect(peakCombinedG(null)).toBeNull();
  });
});

describe("sessionGrip", () => {
  it("keeps a row per lap and pools the session", () => {
    const sg = sessionGrip(channels);
    expect(sg.laps.map((l) => l.chIdx)).toEqual([0, 1]);
    expect(sg.maxG).toBeCloseTo(1.2, 9); // the max, unlike the arc
    expect(sg.all.loaded).toBe(12);
    expect(sg.all.trailBrake).toBe(2);
    expect(sg.all.powerDown).toBe(3);
    expect(sg.all.trailPct).toBeCloseTo((2 / 12) * 100, 9);
  });
  it("is null when no lap stored both channels", () => {
    expect(sessionGrip({ laps: [{ speed: [1, 2] }] })).toBeNull();
    expect(sessionGrip(null)).toBeNull();
  });
});

describe("frictionCircleSvg", () => {
  const lit = new Map([[1, "var(--chart-line)"]]);
  const label = (i) => `Lap ${i + 1}`;

  it("renders nothing without both channels", () => {
    expect(frictionCircleSvg({ dStepM: 20, laps: [{ speed: [1, 2] }] }, lit, label)).toBe("");
  });
  it("is square, so a circle looks like a circle", () => {
    const svg = frictionCircleSvg(channels, lit, label, { size: 460 });
    expect(svg).toContain('viewBox="0 0 460 460"');
  });
  it("draws the highlighted lap as hoverable points and the rest as one dim path", () => {
    const svg = frictionCircleSvg(channels, lit, label);
    expect(svg).toContain('data-grip-lap="1"');
    expect(svg).not.toContain('data-grip-lap="0"'); // unhighlighted
    expect(svg.match(/data-gk="/g)).toHaveLength(8); // one per grid sample
    expect(svg.match(/<path /g)).toHaveLength(1); // the whole dim envelope
    expect(svg).toContain('data-grip-label="Lap 2"');
  });
  it("plots braking above power", () => {
    // The one thing on this chart with a fixed place in a driver's head, and
    // it flips silently if the y mapping is ever 'fixed' to the usual sign.
    const one = { dStepM: 20, laps: [{ n: 1, timeMs: 1000, latG: [1, 1], longG: [-1, 1] }] };
    const svg = frictionCircleSvg(one, new Map([[0, "#fff"]]), () => "Lap 1");
    const pts = [...svg.matchAll(/cy="([\d.]+)" r="[\d.]+" data-gk="(\d+)"/g)].map((m) => ({
      k: Number(m[2]),
      cy: Number(m[1]),
    }));
    const braking = pts.find((p) => p.k === 0);
    const power = pts.find((p) => p.k === 1);
    expect(braking.cy).toBeLessThan(power.cy); // smaller y is higher on screen
  });
  it("draws the reference arc at the session's peak and says so", () => {
    const svg = frictionCircleSvg(channels, lit, label);
    const peak = peakCombinedG(channels);
    expect(svg).toContain(`${peak.toFixed(2)} G`);
    expect(svg).toContain("stroke-dasharray"); // the arc is dashed
    expect(svg).toContain("Braking plots up, power down");
  });
});

describe("gripReadoutHtml / gripCircleHtml", () => {
  const label = (i) => `Lap ${i + 1}`;
  it("reports the two quadrant shares per highlighted lap", () => {
    const html = gripReadoutHtml(channels, new Map([[1, "#fff"]]), label);
    expect(html).toContain("Braking + cornering");
    expect(html).toContain("33%"); // trail braking on the circle lap
    expect(html).toContain("50%"); // power down
  });
  it("pools the session under the rows only when there is more than one lap", () => {
    expect(gripReadoutHtml(channels, new Map([[1, "#fff"]]), label)).toContain("Session");
    const one = { dStepM: 20, laps: [circle] };
    expect(gripReadoutHtml(one, new Map([[0, "#fff"]]), label)).not.toContain("Session");
  });
  it("says nothing when the highlighted lap has no grip data", () => {
    expect(gripReadoutHtml(channels, new Map([[9, "#fff"]]), label)).toBe("");
    expect(gripCircleHtml({ dStepM: 20, laps: [{ speed: [1] }] }, new Map(), label)).toBe("");
  });
  it("frames the sampling honestly", () => {
    const html = gripCircleHtml(channels, new Map([[1, "#fff"]]), label);
    expect(html).toContain("shape of grip usage, not peak G");
  });
});
