import { describe, expect, it } from "vitest";
import { boxes, series } from "../../public/pdr.js";

describe("series", () => {
  const s = series([
    { t: 0, v: 0 },
    { t: 10, v: 100 },
    { t: 20, v: 300 },
  ]);

  it("interpolates values at a time", () => {
    expect(s.at(5)).toBe(50);
    expect(s.at(15)).toBe(200);
    expect(s.at(10)).toBe(100);
  });

  it("inverts monotonic series with timeAt", () => {
    expect(s.timeAt(50)).toBe(5);
    expect(s.timeAt(200)).toBe(15);
  });

  it("computes a central-difference rate", () => {
    // between t=10 and t=20 the slope is 20 v/t
    expect(s.rate(15, 2)).toBe(20);
  });

  it("exposes first/last and length", () => {
    expect(s.n).toBe(3);
    expect(s.first).toEqual({ t: 0, v: 0 });
    expect(s.last).toEqual({ t: 20, v: 300 });
  });
});

describe("boxes", () => {
  // Build a buffer holding two MP4 boxes: "ftyp" (12 bytes) and "free" (8 bytes).
  function buildBoxes() {
    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    const put = (off, size, type) => {
      dv.setUint32(off, size);
      [...type].forEach((ch, i) => dv.setUint8(off + 4 + i, ch.charCodeAt(0)));
    };
    put(0, 12, "ftyp");
    put(12, 8, "free");
    return dv;
  }

  it("parses consecutive box headers", () => {
    const dv = buildBoxes();
    const out = boxes(dv, 0, 20);
    expect(out).toEqual([
      { type: "ftyp", start: 0, body: 8, size: 12 },
      { type: "free", start: 12, body: 20, size: 8 },
    ]);
  });

  it("stops at garbage instead of running away", () => {
    const dv = buildBoxes();
    dv.setUint32(12, 3); // invalid size < 8
    expect(boxes(dv, 0, 20)).toHaveLength(1);
  });
});
