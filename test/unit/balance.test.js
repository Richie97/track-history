import { describe, expect, it } from "vitest";
import {
  MIN_SPEED_KPH,
  MIN_STEER_DEG,
  NEUTRAL_PCT,
  SLIGHT_PCT,
  balanceHtml,
  balanceLabel,
  balanceLaps,
  balancePoints,
  balanceScatterSvg,
  balanceSummary,
  balanceTableHtml,
  cornerBalance,
  fmtBalance,
  hasBalanceData,
  median,
  referenceGain,
  sessionBalance,
  usableAt,
  yawGain,
  yawSign,
} from "../../public/js/balance.js";
import { sessionCorners } from "../../public/js/corners.js";

// A car with yaw gain K: yaw = K · v · δ (v in m/s). Fourteen grid points at a
// constant 100 km/h: a right-hander at k 2–5, a left-hander at k 9–11, straight
// elsewhere (three clear points between them, so the segmenter's merge gap
// keeps them apart). The neutral lap answers the steering exactly in both
// corners; the pushing lap delivers only 75% of the rotation asked for in the
// left-hander and answers the right-hander exactly.
const K = 0.03;
const V = 100 / 3.6;
const N = 15;
const steering = [0, 0, 20, 40, 40, 20, 0, 0, 0, -30, -30, -30, 0, 0, 0];
const latG = [0, 0, 0.5, 0.9, 0.9, 0.5, 0, 0, 0, 0.8, 0.8, 0.8, 0, 0, 0];
const yawFor = (scaleAt) => steering.map((d, k) => K * V * d * scaleAt(k));
const neutral = { n: 1, timeMs: 90_000, speed: Array(N).fill(100), steering, latG, yaw: yawFor(() => 1) };
const pushing = { n: 2, timeMs: 91_000, speed: Array(N).fill(100), steering, latG, yaw: yawFor((k) => (k >= 9 ? 0.75 : 1)) };
const channels = { v: 1, dStepM: 20, laps: [neutral, pushing] };

describe("hasBalanceData / balanceLaps", () => {
  it("needs yaw, steering and speed", () => {
    expect(hasBalanceData(neutral)).toBe(true);
    expect(hasBalanceData({ yaw: [1], steering: [1] })).toBe(false);
    expect(hasBalanceData({ yaw: [1], speed: [1] })).toBe(false);
    expect(hasBalanceData(undefined)).toBe(false);
    expect(balanceLaps(channels).map((l) => l.chIdx)).toEqual([0, 1]);
    expect(balanceLaps({ laps: [{ speed: [1] }, pushing] }).map((l) => l.chIdx)).toEqual([1]);
    expect(balanceLaps(null)).toEqual([]);
  });
});

describe("usableAt", () => {
  it("counts a sample only with steering to divide by and the car moving", () => {
    expect(usableAt(neutral, 3)).toBe(true);
    expect(usableAt(neutral, 0)).toBe(false); // straight
    expect(usableAt({ ...neutral, steering: steering.map(() => MIN_STEER_DEG - 0.1) }, 3)).toBe(false);
    expect(usableAt({ ...neutral, speed: Array(N).fill(MIN_SPEED_KPH - 1) }, 3)).toBe(false);
    expect(usableAt(neutral, 99)).toBe(false);
    expect(usableAt({ yaw: [1] }, 0)).toBe(false);
  });
});

describe("yawSign", () => {
  it("is measured, not assumed: a recorder whose yaw runs against its steering reads -1", () => {
    expect(yawSign(channels)).toBe(1);
    const flipped = { laps: [{ ...neutral, yaw: neutral.yaw.map((y) => -y) }] };
    expect(yawSign(flipped)).toBe(-1);
    expect(yawSign({ laps: [{ speed: [1] }] })).toBe(1); // nothing to measure
  });
});

describe("yawGain / referenceGain / median", () => {
  it("recovers the car's gain from a usable sample, null otherwise", () => {
    expect(yawGain(neutral, 3)).toBeCloseTo(K, 9);
    expect(yawGain(neutral, 9)).toBeCloseTo(K, 9); // a left-hander gives the same gain
    expect(yawGain(pushing, 9)).toBeCloseTo(0.75 * K, 9);
    expect(yawGain(neutral, 0)).toBeNull();
    // the alignment sign is applied before dividing
    expect(yawGain({ ...neutral, yaw: neutral.yaw.map((y) => -y) }, 3, -1)).toBeCloseTo(K, 9);
  });
  it("takes the median over every usable sample of every lap", () => {
    // 14 usable samples: 11 at K, 3 at 0.75 K — the median is the car, not the corner.
    expect(referenceGain(channels)).toBeCloseTo(K, 9);
    expect(referenceGain({ laps: [{ speed: [1] }] })).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("balancePoints", () => {
  it("divides the speed out of the yaw so a neutral car is one line through the origin", () => {
    const pts = balancePoints(neutral);
    expect(pts).toHaveLength(N);
    expect(pts[3].steer).toBe(40);
    expect(pts[3].rot).toBeCloseTo(K * 40, 9); // yaw / v = K · δ
    expect(pts[3].speed).toBe(100);
    expect(pts[3].usable).toBe(true);
    expect(pts[0].usable).toBe(false);
    // a faster lap through the same corner lands on the same line
    const fast = { ...neutral, speed: Array(N).fill(200), yaw: steering.map((d) => K * (200 / 3.6) * d) };
    expect(balancePoints(fast)[3].rot).toBeCloseTo(pts[3].rot, 9);
  });
  it("skips a stationary sample and applies the alignment sign", () => {
    const parked = { ...neutral, speed: neutral.speed.map((v, k) => (k === 0 ? 0 : v)) };
    expect(balancePoints(parked)).toHaveLength(N - 1);
    expect(balancePoints({ ...neutral, yaw: neutral.yaw.map((y) => -y) }, -1)[3].rot).toBeCloseTo(K * 40, 9);
    expect(balancePoints({ speed: [1] })).toEqual([]);
  });
});

describe("cornerBalance", () => {
  const corners = sessionCorners(channels);
  it("reads a corner as the ratio of rotation delivered to rotation asked for", () => {
    expect(corners.map((c) => [c.k0, c.k1])).toEqual([
      [2, 5],
      [9, 11],
    ]);
    const n1 = cornerBalance(neutral, corners[0], K);
    expect(n1.samples).toBe(4);
    expect(n1.ratio).toBeCloseTo(1, 9);
    expect(n1.pct).toBeCloseTo(0, 9);
    const p2 = cornerBalance(pushing, corners[1], K);
    expect(p2.ratio).toBeCloseTo(0.75, 9);
    expect(p2.pct).toBeCloseTo(-25, 9);
    // a left-hander projects onto the steering's direction, so it reads the same way
    expect(cornerBalance(neutral, corners[1], K).pct).toBeCloseTo(0, 9);
  });
  it("is null without usable samples, a reference, or the channels", () => {
    expect(cornerBalance(neutral, { k0: 0, k1: 1 }, K)).toBeNull(); // straight
    expect(cornerBalance(neutral, corners[0], 0)).toBeNull();
    expect(cornerBalance({ speed: [1] }, corners[0], K)).toBeNull();
  });
});

describe("balanceLabel / fmtBalance", () => {
  it("names the reading by side and size", () => {
    expect(balanceLabel(0)).toBe("neutral");
    expect(balanceLabel(NEUTRAL_PCT - 0.1)).toBe("neutral");
    expect(balanceLabel(-NEUTRAL_PCT)).toBe("slight understeer");
    expect(balanceLabel(SLIGHT_PCT - 0.1)).toBe("slight oversteer");
    expect(balanceLabel(-SLIGHT_PCT)).toBe("understeer");
    expect(balanceLabel(40)).toBe("oversteer");
    expect(fmtBalance(-25.4)).toBe("understeer 25%");
    expect(fmtBalance(12)).toBe("slight oversteer 12%");
    expect(fmtBalance(3)).toBe("neutral");
  });
});

describe("sessionBalance", () => {
  it("reads every corner for every readable lap and pools the session", () => {
    const sb = sessionBalance(channels);
    expect(sb.sign).toBe(1);
    expect(sb.refGain).toBeCloseTo(K, 9);
    expect(sb.corners.map((c) => c.n)).toEqual([1, 2]);
    const t2 = sb.corners[1];
    expect(t2.laps.map((l) => l.chIdx)).toEqual([0, 1]);
    expect(t2.laps[0].pct).toBeCloseTo(0, 9);
    expect(t2.laps[1].pct).toBeCloseTo(-25, 9);
    // pooled: (1 + 0.75) / 2 of the rotation asked for
    expect(t2.all.pct).toBeCloseTo(-12.5, 9);
    expect(t2.all.samples).toBe(6);
  });
  it("is null without readable laps, without corners, or without a reference", () => {
    expect(sessionBalance({ laps: [{ speed: [1] }] })).toBeNull();
    expect(sessionBalance({ laps: [{ ...neutral, latG: undefined }] })).toBeNull(); // nowhere to find corners
    expect(sessionBalance({ laps: [{ ...neutral, yaw: neutral.yaw.map(() => 0) }] })).toBeNull(); // no rotation at all
    expect(sessionBalance(null)).toBeNull();
  });
  it("drops a corner no readable lap steered through", () => {
    // Lateral load with the wheel straight — a banked straight, say — is a
    // corner to the segmenter but gives the diagnosis nothing to divide by.
    const banked = { ...neutral, steering: steering.map((d, k) => (k >= 9 ? 0 : d)) };
    expect(sessionBalance({ laps: [banked] }).corners.map((c) => c.n)).toEqual([1]);
  });
});

describe("balanceSummary", () => {
  it("names the corners that sit off the reference, pooled across laps", () => {
    expect(balanceSummary(channels)).toBe("understeer in T2");
    expect(balanceSummary({ laps: [neutral] })).toBe("balance neutral");
    const loose = { laps: [{ ...neutral, yaw: neutral.yaw.map((y, k) => (k >= 9 ? y * 1.3 : y)) }] };
    expect(balanceSummary(loose)).toBe("oversteer in T2");
    expect(balanceSummary({ laps: [{ speed: [1] }] })).toBeNull();
  });
  it("counts rather than names once there are more than three", () => {
    // Eight corners, the odd ones pushing.
    const st = [], lg = [], yw = [];
    for (let c = 0; c < 8; c++) {
      st.push(0, 0, 30, 30, 30, 0);
      lg.push(0, 0, 0.8, 0.8, 0.8, 0);
      const s = c % 2 ? 0.7 : 1;
      yw.push(0, 0, K * V * 30 * s, K * V * 30 * s, K * V * 30 * s, 0);
    }
    const many = { laps: [{ speed: Array(st.length).fill(100), steering: st, latG: lg, yaw: yw }] };
    // With four pushing and four neutral, the median sits between them and
    // both sides read off it — the relative reading, stated in the docs.
    expect(balanceSummary(many)).toBe("understeer in 4 corners and oversteer in 4 corners");
    // Three or fewer are named.
    const few = { laps: [{ speed: many.laps[0].speed.slice(0, 36), steering: st.slice(0, 36), latG: lg.slice(0, 36), yaw: yw.slice(0, 36) }] };
    expect(balanceSummary(few)).toBe("understeer in T2, T4, T6 and oversteer in T1, T3, T5");
  });
});

describe("balanceScatterSvg", () => {
  const lit = new Map([[1, "var(--chart-line)"]]);
  const label = (i) => `Lap ${i + 1}`;
  it("renders nothing without the three channels", () => {
    expect(balanceScatterSvg({ dStepM: 20, laps: [{ speed: [1, 2] }] }, lit, label)).toBe("");
  });
  it("draws the highlighted lap as hoverable points and the rest as one dim path, with the reference dashed", () => {
    const svg = balanceScatterSvg(channels, lit, label);
    expect(svg).toContain('data-balance-lap="1"');
    expect(svg).not.toContain('data-balance-lap="0"');
    expect(svg.match(/data-bk="/g)).toHaveLength(N);
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain("stroke-dasharray");
    expect(svg).toContain('data-balance-label="Lap 2"');
    expect(svg).toContain("oversteer");
    expect(svg).toContain("understeer");
  });
  it("plots more rotation higher, so oversteer is above the line", () => {
    const one = {
      dStepM: 20,
      laps: [{ n: 1, timeMs: 1000, speed: [100, 100], steering: [30, 30], yaw: [10, 20], latG: [0.5, 0.5] }],
    };
    const svg = balanceScatterSvg(one, new Map([[0, "#fff"]]), () => "Lap 1");
    const pts = [...svg.matchAll(/cy="([\d.]+)" r="[\d.]+" data-bk="(\d+)"/g)].map((m) => ({ k: Number(m[2]), cy: Number(m[1]) }));
    expect(pts.find((p) => p.k === 1).cy).toBeLessThan(pts.find((p) => p.k === 0).cy);
  });
  it("draws a sample that doesn't count fainter", () => {
    const svg = balanceScatterSvg(channels, lit, label);
    expect(svg.match(/fill-opacity="0.3"/g)).toHaveLength(8); // the eight straight-line samples
  });
});

describe("balanceTableHtml / balanceHtml", () => {
  const label = (i) => `Lap ${i + 1}`;
  it("has a row per corner with a cell per highlighted lap and the session pooled", () => {
    const html = balanceTableHtml(channels, new Map([[1, "#fff"]]), label);
    expect(html.match(/<tr data-corner=/g)).toHaveLength(2);
    expect(html).toContain('data-corner="2" data-corner-k="10"'); // mid-point of k 9–11
    expect(html).toContain("understeer 25%");
    expect(html).toContain("slight understeer 13%"); // pooled T2
    expect(html).toContain("<th class=\"num\">Session</th>");
    expect(html).toContain("40 m"); // T1 starts at k 2
    expect(html).toContain("0.90"); // T1's peak G
  });
  it("skips the session column with one readable lap, and renders nothing without a highlighted readable lap", () => {
    expect(balanceTableHtml({ dStepM: 20, laps: [pushing] }, new Map([[0, "#fff"]]), label)).not.toContain("Session");
    expect(balanceTableHtml(channels, new Map([[5, "#fff"]]), label)).toBe("");
    expect(balanceTableHtml({ dStepM: 20, laps: [{ speed: [1] }] }, new Map([[0, "#fff"]]), label)).toBe("");
  });
  it("wraps the scatter and the table in the card, and says the reading is relative", () => {
    const html = balanceHtml(channels, new Map([[1, "#fff"]]), label);
    expect(html).toContain('class="ch-balance"');
    expect(html).toContain("data-balance=");
    expect(html).toContain("table class=\"balance\"");
    expect(html).toContain("reads neutral in every corner");
    expect(balanceHtml({ dStepM: 20, laps: [{ speed: [1] }] }, new Map(), label)).toBe("");
  });
});
