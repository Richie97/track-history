import { describe, expect, it } from "vitest";
import {
  buildRows,
  committedCatalogSql,
  keysInSql,
  readJson,
  renderInsert,
  rowKey,
  wheelbaseFromClaims,
  STEERING_RATIO_RANGE as SEED_STEERING_RANGE,
  WHEELBASE_MM_RANGE as SEED_WHEELBASE_RANGE,
} from "../../seed/cars/generate.mjs";
import { STEERING_RATIO_RANGE, WHEELBASE_MM_RANGE, isValidSteeringRatio, isValidWheelbaseMm } from "../../src/lib/validate";

// The seeded car catalog (#221). The migration is generated from three input
// files; these tests are what keeps a wrong number, an uncited ratio or a
// stale migration out of the tree.

const list = readJson("list.json");
const steering = readJson("steering.json");
const wikidata = readJson("wikidata.json");
const rows = buildRows(list, steering, wikidata);

describe("the generated car catalog", () => {
  it("mirrors the server's validation ranges", () => {
    expect(SEED_WHEELBASE_RANGE).toEqual(WHEELBASE_MM_RANGE);
    expect(SEED_STEERING_RANGE).toEqual(STEERING_RATIO_RANGE);
  });

  it("has a row per listed generation, each with a wheelbase the server would accept", () => {
    expect(rows.length).toBe(list.length);
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.wheelbase_mm, rowKey(r)).not.toBeNull();
      expect(isValidWheelbaseMm(r.wheelbase_mm), `${rowKey(r)} wheelbase ${r.wheelbase_mm}`).toBe(true);
      expect(isValidSteeringRatio(r.steering_ratio), `${rowKey(r)} ratio ${r.steering_ratio}`).toBe(true);
      expect(r.year_from).toBeGreaterThan(1980);
      if (r.year_to != null) expect(r.year_to).toBeGreaterThanOrEqual(r.year_from);
    }
  });

  it("cites every steering ratio and every wheelbase on the row", () => {
    for (const r of rows) {
      // The wheelbase half always names either the Wikidata item or a source URL.
      expect(r.source, rowKey(r)).toMatch(/^wheelbase [\d.]+ (mm|in \(\d+ mm\)): (Wikidata Q\d+ \(P3039\)|.*https?:\/\/)/);
      if (r.steering_ratio != null) {
        expect(r.source, rowKey(r)).toMatch(/; steering ratio [\d.]+:1: .*https?:\/\//);
      } else {
        // A null ratio says why: not curated, or a variable rack with no single figure.
        expect(r.source, rowKey(r)).toMatch(/; steering ratio: (not curated|.*no single figure)/);
      }
    }
  });

  it("carries the generations a track day actually sees", () => {
    const keys = new Set(rows.map(rowKey));
    for (const key of ["Chevrolet|Corvette|C7", "Mazda|MX-5 Miata|ND", "Subaru|BRZ|ZC6", "Porsche|911|992"]) {
      expect(keys.has(key), key).toBe(true);
    }
    // The ticket's worked example: 2710 for a C7, 16.25:1.
    const c7 = rows.find((r) => rowKey(r) === "Chevrolet|Corvette|C7");
    expect(c7.wheelbase_mm).toBe(2710);
    expect(c7.steering_ratio).toBe(16.25);
  });

  it("is what the committed migrations insert — no more, no fewer", () => {
    const sql = committedCatalogSql();
    expect(sql.length).toBeGreaterThan(0);
    const joined = sql.join("\n");
    for (const r of rows) {
      expect(joined, `${rowKey(r)} — regenerate with node seed/cars/generate.mjs`).toContain(renderInsert(r));
    }
    expect(keysInSql(sql)).toEqual(new Set(rows.map(rowKey)));
    // The first migration creates the table and the vehicles link.
    expect(sql[0]).toContain("CREATE TABLE car_catalog");
    expect(sql[0]).toContain("ALTER TABLE vehicles ADD COLUMN catalog_id INTEGER REFERENCES car_catalog(id)");
  });
});

describe("the generator's rules", () => {
  const entry = { make: "Make", model: "Model", generation: "G1", years: [2000, null] };

  it("refuses a ratio without a citation, and a null ratio without a note", () => {
    const wd = { Q1: { label: "x", wheelbase_mm: 2500 } };
    expect(() => buildRows([{ ...entry, wikidata: "Q1" }], { "Make|Model|G1": { ratio: 15 } }, wd)).toThrow(/citation/);
    expect(() => buildRows([{ ...entry, wikidata: "Q1" }], { "Make|Model|G1": { ratio: null } }, wd)).toThrow(/note/);
    expect(buildRows([{ ...entry, wikidata: "Q1" }], { "Make|Model|G1": { ratio: 15, source: "https://x" } }, wd)[0].steering_ratio).toBe(15);
  });

  it("refuses a row with no wheelbase, and a steering entry for a car not in the list", () => {
    expect(() => buildRows([entry], {}, {})).toThrow(/wikidata item or a cited wheelbase/);
    expect(() => buildRows([{ ...entry, wikidata: "Q1" }], {}, {})).toThrow(/--refresh/);
    expect(() => buildRows([{ ...entry, wikidata: "Q1" }], {}, { Q1: { label: "x", wheelbase_mm: null } })).toThrow(/no single wheelbase/);
    expect(() => buildRows([{ ...entry, wheelbase: { mm: 2500 } }], {}, {})).toThrow(/needs a source/);
    expect(() =>
      buildRows([{ ...entry, wikidata: "Q1" }], { "Other|Car|X": { ratio: 15, source: "https://x" } }, { Q1: { label: "x", wheelbase_mm: 2500 } })
    ).toThrow(/list doesn't have/);
  });

  it("converts a cited inch figure and records both in the source", () => {
    const [r] = buildRows([{ ...entry, wheelbase: { in: 90.9, source: "https://x" } }], {}, {});
    expect(r.wheelbase_mm).toBe(2309);
    expect(r.source).toContain("wheelbase 90.9 in (2309 mm): https://x");
    expect(r.source).toContain("steering ratio: not curated");
  });

  it("reads Wikidata's P3039 in whatever unit it comes, and treats two values as none", () => {
    const claim = (amount, unit) => ({ mainsnak: { datavalue: { value: { amount, unit } } } });
    const mm = "http://www.wikidata.org/entity/Q174789";
    const m = "http://www.wikidata.org/entity/Q11573";
    expect(wheelbaseFromClaims({ P3039: [claim("+2710", mm)] })).toBe(2710);
    expect(wheelbaseFromClaims({ P3039: [claim("+2.300", m)] })).toBe(2300);
    expect(wheelbaseFromClaims({ P3039: [claim("+2570", mm), claim("+2575", mm)] })).toBeNull();
    expect(wheelbaseFromClaims({ P3039: [claim("+2570", mm), claim("+2570", mm)] })).toBe(2570);
    expect(wheelbaseFromClaims({})).toBeNull();
  });

  it("round-trips a generated INSERT back to its key, quotes included", () => {
    const [r] = buildRows(
      [{ make: "O'Make", model: "Mo'del", generation: null, years: [2001, 2002], wheelbase: { mm: 2600, source: "https://x" } }],
      {},
      {}
    );
    expect(keysInSql([renderInsert(r)])).toEqual(new Set(["O'Make|Mo'del|"]));
  });
});
