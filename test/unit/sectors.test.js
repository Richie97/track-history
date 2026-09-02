import { describe, expect, it } from "vitest";
import { SECTOR_COUNT, sectorTableHtml, sectorTimes, sessionSectors } from "../../public/js/sectors.js";

// A lap that runs at one speed for the first half of its distance and double
// that for the second, so the first sectors are visibly the slow ones.
const slowThenFast = (timeMs = null) => ({
  n: 1,
  timeMs,
  speed: [...Array(31).fill(60), ...Array(30).fill(120)],
});

describe("sectorTimes", () => {
  it("splits a constant-speed lap into equal sectors that sum to the lap time", () => {
    const s = sectorTimes({ speed: Array(61).fill(90), timeMs: 90_000 }, 20);
    expect(s).toHaveLength(SECTOR_COUNT);
    expect(s.reduce((a, b) => a + b, 0)).toBe(90_000);
    for (const v of s) expect(v).toBe(30_000);
  });

  it("puts more time in the sectors where the car was slower", () => {
    const s = sectorTimes(slowThenFast(90_000), 20);
    expect(s[0]).toBeGreaterThan(s[2]);
    expect(s.reduce((a, b) => a + b, 0)).toBe(90_000);
    // Speed doubles halfway: the first sector is all slow (1/3 of distance at
    // 60), the last all fast (1/3 at 120), so S1 is twice S3.
    expect(s[0] / s[2]).toBeCloseTo(2, 1);
  });

  it("lets the last sector absorb the rounding residual so the sum is exact", () => {
    const s = sectorTimes({ speed: Array(61).fill(90), timeMs: 90_001 }, 20);
    expect(s.reduce((a, b) => a + b, 0)).toBe(90_001);
  });

  it("uses the integrated duration when the lap carries no timed duration", () => {
    // 60 cells of 20 m at 72 km/h = 20 m/s: 1 s per cell, 60 s total.
    const s = sectorTimes({ speed: Array(61).fill(72), timeMs: null }, 20);
    expect(s.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it("honours a different sector count, one sector being the whole lap", () => {
    expect(sectorTimes({ speed: Array(61).fill(90), timeMs: 90_000 }, 20, 1)).toEqual([90_000]);
    expect(sectorTimes({ speed: Array(61).fill(90), timeMs: 90_000 }, 20, 6)).toHaveLength(6);
  });

  it("returns null for laps without a usable speed series", () => {
    expect(sectorTimes({ rpm: Array(61).fill(5000), timeMs: 90_000 }, 20)).toBeNull();
    expect(sectorTimes({ speed: [90], timeMs: 90_000 }, 20)).toBeNull();
    expect(sectorTimes(null, 20)).toBeNull();
    expect(sectorTimes({ speed: Array(61).fill(90), timeMs: 90_000 }, 20, 0)).toBeNull();
  });
});

describe("sessionSectors", () => {
  const channels = {
    v: 1,
    dStepM: 20,
    laps: [
      { n: 1, timeMs: 90_000, speed: [...Array(31).fill(60), ...Array(30).fill(120)] }, // slow start
      { n: 2, timeMs: 90_000, speed: [...Array(31).fill(120), ...Array(30).fill(60)] }, // slow finish
      { n: 3, timeMs: 95_000, rpm: Array(61).fill(5000) }, // no speed: left out
      { n: 4, timeMs: 89_500, speed: Array(61).fill(90) }, // actual best, even sectors
    ],
  };

  it("takes the best of each sector across laps and sums them to the theoretical best", () => {
    const sec = sessionSectors(channels);
    expect(sec.n).toBe(3);
    expect(sec.laps.map((l) => l.chIdx)).toEqual([0, 1, 3]);
    // Lap 2 (fast start) owns S1, lap 1 (fast finish) owns S3.
    expect(sec.bestSectorLap[0]).toBe(1);
    expect(sec.bestSectorLap[2]).toBe(0);
    expect(sec.theoreticalBestMs).toBe(sec.bestSectors.reduce((a, b) => a + b, 0));
    expect(sec.bestLapIdx).toBe(3);
    expect(sec.bestLapMs).toBe(89_500);
    expect(sec.gapMs).toBe(89_500 - sec.theoreticalBestMs);
    expect(sec.theoreticalBestMs).toBeLessThan(sec.bestLapMs);
  });

  it("gives a zero gap when the best lap already owns every best sector", () => {
    const sec = sessionSectors({ v: 1, dStepM: 20, laps: [channels.laps[3], channels.laps[2]] });
    expect(sec.laps).toHaveLength(1);
    expect(sec.gapMs).toBe(0);
    expect(sec.theoreticalBestMs).toBe(89_500);
  });

  it("keeps the earlier lap on a tied sector, like the strict comparison in the JS", () => {
    const sec = sessionSectors({
      v: 1,
      dStepM: 20,
      laps: [
        { n: 1, timeMs: 90_000, speed: Array(61).fill(90) },
        { n: 2, timeMs: 90_000, speed: Array(61).fill(90) },
      ],
    });
    expect(sec.bestSectorLap).toEqual([0, 0, 0]);
  });

  it("returns null when no lap can be split", () => {
    expect(sessionSectors({ v: 1, dStepM: 20, laps: [channels.laps[2]] })).toBeNull();
    expect(sessionSectors({ v: 1, dStepM: 20, laps: [] })).toBeNull();
    expect(sessionSectors(null)).toBeNull();
  });
});

describe("sectorTableHtml", () => {
  const channels = {
    v: 1,
    dStepM: 20,
    laps: [
      { n: 1, timeMs: 90_000, speed: [...Array(31).fill(60), ...Array(30).fill(120)] },
      { n: 2, timeMs: 90_000, speed: [...Array(31).fill(120), ...Array(30).fill(60)] },
    ],
  };
  const labelFor = (i) => `Lap ${i + 1}`;

  it("renders a row per highlighted lap, the best sectors marked, plus the theoretical best row", () => {
    const lit = new Map([
      [0, "var(--chart-line)"],
      [1, "var(--chart-line-b)"],
    ]);
    const html = sectorTableHtml(channels, lit, labelFor);
    expect(html).toContain("Theoretical best");
    expect((html.match(/<tr>/g) || []).length).toBe(3); // header + 2 laps
    expect(html).toContain('class="sec-theo"');
    expect(html).toContain("Lap 1");
    expect(html).toContain("Lap 2");
    // Each lap owns one end of the lap, so both mark a best sector and both show a gap.
    expect((html.match(/sec-best/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("sec-gap");
    expect(html).toContain("quicker than the best lap");
  });

  it("shows only the highlighted laps and no theoretical row for a single-lap session", () => {
    const one = { v: 1, dStepM: 20, laps: [channels.laps[0]] };
    const html = sectorTableHtml(one, new Map([[0, "var(--chart-line)"]]), labelFor);
    expect(html).not.toContain("Theoretical best");
    expect(html).not.toContain("sec-theo");
    expect((html.match(/<tr>/g) || []).length).toBe(2);
  });

  it("returns '' when nothing highlighted can be split", () => {
    expect(sectorTableHtml(channels, new Map(), labelFor)).toBe("");
    expect(sectorTableHtml({ v: 1, dStepM: 20, laps: [{ n: 1, timeMs: 1, rpm: [1, 2] }] }, new Map([[0, "x"]]), labelFor)).toBe("");
  });
});
