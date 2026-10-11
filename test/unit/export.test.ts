import { describe, expect, it } from "vitest";
import {
  EVENTS_CSV_COLUMNS,
  JsonStream,
  LAPS_CSV_COLUMNS,
  type LapExportRow,
  csvCell,
  eventsCsv,
  exportFilename,
  exportHeader,
  fmtMs,
  lapsCsv,
  parseStored,
} from "../../src/lib/export";
import { withComputed, type EventRow } from "../../src/lib/stats";
import { fmtMs as webFmtMs } from "../../public/js/format.js";

// The pure half of the logbook export (NS-44).

describe("csvCell", () => {
  it("quotes only what RFC 4180 needs quoted, doubling inner quotes", () => {
    expect(csvCell("Summit Point")).toBe("Summit Point");
    expect(csvCell("Day 1, Session 2")).toBe('"Day 1, Session 2"');
    expect(csvCell('the "Bus Stop"')).toBe('"the ""Bus Stop"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
  });

  it("guards text a spreadsheet would run as a formula, and leaves numbers alone", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1 click front")).toBe("'+1 click front");
    expect(csvCell("-3.2 camber felt better")).toBe("'-3.2 camber felt better");
    expect(csvCell("@everyone")).toBe("'@everyone");
    expect(csvCell("\tindented")).toBe("'\tindented");
    // A negative *number* is data, not a formula.
    expect(csvCell(-3.2)).toBe("-3.2");
    expect(csvCell(0)).toBe("0");
  });

  it("writes nulls as empty, booleans as 1/0, and drops non-finite numbers", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(true)).toBe("1");
    expect(csvCell(false)).toBe("0");
    expect(csvCell(Number.NaN)).toBe("");
  });
});

describe("fmtMs", () => {
  it("matches public/js/format.js exactly", () => {
    for (const ms of [null, 0, 999, 1000, 59_999, 60_000, 121_240, 128_400, 125_100, 600_001, 3_600_000, 121_239.6]) {
      expect(fmtMs(ms)).toBe(webFmtMs(ms));
    }
  });
});

const lap = (over: Partial<LapExportRow>): LapExportRow => ({
  event_id: 1,
  event_date: "2026-05-01",
  track: "VIR (Full)",
  organizer: "VIR Club",
  run_group: "High Speed",
  car: "Z06",
  session_id: 10,
  session: "Session 1",
  lap: 1,
  time_ms: 120_000,
  device_timed: 0,
  session_best_ms: 120_000,
  ...over,
});

describe("lapsCsv", () => {
  it("writes the columns in the spec's order", () => {
    const [header] = lapsCsv([]).split("\r\n");
    expect(header).toBe(LAPS_CSV_COLUMNS.join(","));
  });

  it("marks the session best, and a lap clean at exactly 107% but not beyond it", () => {
    const best = 100_000;
    const rows = lapsCsv([
      lap({ lap: 1, time_ms: 100_000, session_best_ms: best, device_timed: 1 }),
      lap({ lap: 2, time_ms: 107_000, session_best_ms: best }),
      lap({ lap: 3, time_ms: 107_001, session_best_ms: best }),
    ])
      .trim()
      .split("\r\n")
      .slice(1)
      .map((l) => l.split(","));
    const col = (name: string) => LAPS_CSV_COLUMNS.indexOf(name as (typeof LAPS_CSV_COLUMNS)[number]);
    expect(rows.map((r) => r[col("session_best")])).toEqual(["1", "0", "0"]);
    expect(rows.map((r) => r[col("clean")])).toEqual(["1", "1", "0"]);
    expect(rows.map((r) => r[col("device_timed")])).toEqual(["1", "0", "0"]);
    expect(rows[0][col("lap_time")]).toBe("1:40.0");
    expect(rows[1][col("lap_time_ms")]).toBe("107000");
  });
});

const eventRow = (over: Partial<EventRow>): EventRow => ({
  id: 1,
  track_id: 1,
  track_name: "VIR (Full)",
  start_date: "2026-05-01",
  days: 2,
  club: "VIR Club",
  run_group: null,
  car: "Z06",
  vehicle_id: null,
  notes: null,
  conditions: "dry",
  temp_f: 72,
  checklist: null,
  best_time_ms: null,
  track_hours: null,
  updated_at: 0,
  ambient_lo_c: null,
  ambient_hi_c: null,
  elevation_m: null,
  lap_best_ms: 120_000,
  lap_count: 4,
  lap_avg: 121_000,
  lap_avg_sq: 121_000 * 121_000 + 1_000_000,
  clean_count: 4,
  clean_avg: 121_000,
  clean_avg_sq: 121_000 * 121_000 + 1_000_000,
  session_count: 2,
  cost_entry_cents: 45_000,
  cost_fuel_cents: 12_050,
  cost_travel_cents: null,
  cost_misc_cents: null,
  ...over,
});

describe("eventsCsv", () => {
  const today = "2026-07-01";
  const parse = (csv: string) =>
    csv
      .trim()
      .split("\r\n")
      .slice(1)
      .map((l) => l.split(","));
  const col = (name: string) => EVENTS_CSV_COLUMNS.indexOf(name as (typeof EVENTS_CSV_COLUMNS)[number]);

  it("writes the columns in the spec's order, with costs in dollars and consistency as a percentage", () => {
    const csv = eventsCsv([withComputed(eventRow({}))], today);
    expect(csv.split("\r\n")[0]).toBe(EVENTS_CSV_COLUMNS.join(","));
    const [row] = parse(csv);
    expect(row[col("best_lap_ms")]).toBe("120000");
    expect(row[col("best_lap")]).toBe("2:00.0");
    // sqrt(1e6) / 121000 = 0.826…%
    expect(row[col("consistency_pct")]).toBe("0.83");
    expect(row[col("cost_entry")]).toBe("450");
    expect(row[col("cost_fuel")]).toBe("120.5");
    expect(row[col("cost_travel")]).toBe("");
    expect(row[col("cost_total")]).toBe("570.5");
    expect(row[col("sessions")]).toBe("2");
  });

  it("leaves an upcoming event's computed columns empty but keeps what was entered", () => {
    const upcoming = withComputed(
      eventRow({ start_date: "2026-09-01", lap_best_ms: null, lap_count: 0, lap_avg: null, clean_count: 0 })
    );
    const [row] = parse(eventsCsv([upcoming], today));
    expect(row[col("best_lap_ms")]).toBe("");
    expect(row[col("best_lap")]).toBe("");
    expect(row[col("consistency_pct")]).toBe("");
    expect(row[col("hours")]).toBe("");
    expect(row[col("cost_entry")]).toBe("450");
  });

  it("keeps a formula-looking note as text", () => {
    const csv = eventsCsv([withComputed(eventRow({ notes: "=SUM(A1:A9)" }))], today);
    expect(csv).toContain("'=SUM(A1:A9)");
  });
});

describe("the JSON header", () => {
  it("leads with the format, version and a units legend", () => {
    const header = exportHeader(new Date("2026-10-11T12:00:00Z"), true);
    expect(Object.keys(header)).toEqual(["format", "version", "exported_at", "telemetry_included", "units"]);
    expect(header.format).toBe("track-evolution-export");
    expect(header.version).toBe(1);
    expect(header.exported_at).toBe("2026-10-11T12:00:00.000Z");
    expect(header.units.lap_times).toMatch(/milliseconds/);
  });

  it("names the files by kind and UTC date", () => {
    const now = new Date("2026-10-11T23:30:00-05:00");
    expect(exportFilename("laps", now)).toBe("track-evolution-laps-2026-10-12.csv");
    expect(exportFilename("events", now)).toBe("track-evolution-events-2026-10-12.csv");
    expect(exportFilename("logbook", now)).toBe("track-evolution-2026-10-12.json");
  });

  it("reads a malformed stored value as null rather than failing the export", () => {
    expect(parseStored("{bad")).toBeNull();
    expect(parseStored(null)).toBeNull();
    expect(parseStored('["a"]')).toEqual(["a"]);
  });
});

describe("JsonStream", () => {
  async function written(fn: (out: JsonStream) => Promise<void>) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const out = new JsonStream(writer);
    const text = new Response(readable).text();
    await fn(out);
    await writer.close();
    return text;
  }

  it("writes a document piece by piece with the commas in place", async () => {
    const doc = await written(async (out) => {
      await out.begin(null, "{");
      await out.item("a", "1");
      await out.begin("list", "[");
      await out.item(null, '{"x":1}');
      await out.item(null, '{"x":2}');
      await out.end();
      await out.item("b", '"two"');
      await out.end();
    });
    expect(JSON.parse(doc)).toEqual({ a: 1, list: [{ x: 1 }, { x: 2 }], b: "two" });
  });

  it("closes everything still open and ends with the error when a write fails partway", async () => {
    const doc = await written(async (out) => {
      await out.begin(null, "{");
      await out.item("format", '"track-evolution-export"');
      await out.begin("events", "[");
      await out.begin(null, "{");
      await out.item("id", "1");
      await out.begin("sessions", "[");
      await out.item(null, '{"id":9}');
      await out.fail("D1 went away");
    });
    expect(JSON.parse(doc)).toEqual({
      format: "track-evolution-export",
      events: [{ id: 1, sessions: [{ id: 9 }] }],
      error: "D1 went away",
    });
  });
});
