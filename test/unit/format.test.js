import { describe, expect, it } from "vitest";
import { esc, fmtMs, parseTime, parseLapList, fmtConsistency } from "../../public/js/format.js";

describe("fmtMs", () => {
  it("formats null as an em dash", () => {
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(undefined)).toBe("—");
  });

  it("formats m:ss.fff with trailing zeros trimmed", () => {
    expect(fmtMs(121240)).toBe("2:01.24");
    expect(fmtMs(121000)).toBe("2:01.0");
    expect(fmtMs(121500)).toBe("2:01.5");
    expect(fmtMs(59999)).toBe("0:59.999");
    expect(fmtMs(60000)).toBe("1:00.0");
  });

  it("rounds fractional milliseconds", () => {
    expect(fmtMs(121239.6)).toBe("2:01.24");
  });
});

describe("parseTime", () => {
  it("parses m:ss.fff", () => {
    expect(parseTime("2:01.24")).toBe(121240);
    expect(parseTime("2:01")).toBe(121000);
    expect(parseTime("0:59.999")).toBe(59999);
  });

  it("parses bare seconds", () => {
    expect(parseTime("121.24")).toBe(121240);
    expect(parseTime("95")).toBe(95000);
  });

  it("accepts comma as the decimal separator", () => {
    expect(parseTime("2:01,5")).toBe(121500);
    expect(parseTime("95,25")).toBe(95250);
  });

  it("trims whitespace", () => {
    expect(parseTime("  1:05.5 ")).toBe(65500);
  });

  it("returns null for unparseable input", () => {
    expect(parseTime("")).toBeNull();
    expect(parseTime(null)).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("1:2:3")).toBeNull();
    expect(parseTime("1:234")).toBeNull(); // seconds are at most 2 digits
  });

  it("round-trips fmtMs output", () => {
    for (const ms of [59999, 60000, 95250, 121240, 754321]) {
      expect(parseTime(fmtMs(ms))).toBe(ms);
    }
  });
});

describe("parseLapList", () => {
  it("splits on commas, semicolons and whitespace", () => {
    expect(parseLapList("2:03.55\n2:01.24, 2:02.61; 2:00")).toEqual([123550, 121240, 122610, 120000]);
  });

  it("drops unparseable and non-positive entries", () => {
    expect(parseLapList("junk 0 2:01.24")).toEqual([121240]);
    expect(parseLapList("")).toEqual([]);
    expect(parseLapList(null)).toEqual([]);
  });
});

describe("esc", () => {
  it("escapes HTML metacharacters", () => {
    expect(esc(`<b>"a" & 'c'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;c&#39;&lt;/b&gt;");
  });

  it("stringifies nullish input to empty string", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});

describe("fmtConsistency", () => {
  it("formats a coefficient of variation as a percentage", () => {
    expect(fmtConsistency(0.0123)).toBe("1.2%");
    expect(fmtConsistency(null)).toBe("—");
  });
});
