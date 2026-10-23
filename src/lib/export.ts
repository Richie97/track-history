// Exporting a logbook (NS-44, docs/specs/native/NS-44-web-export.md): the pure
// half — CSV quoting, the two CSV files' rows, and the JSON export's fixed
// opening. The route (routes/export.ts) reads D1 and streams; everything here
// is testable without it.
//
// Every export is **complete for every account**: the Pro line is the analysis
// the app draws, never the data the driver put in, so a free account's export
// carries its channels, garage and setup sheets like a Pro one's.

import type { ComputedEvent } from "./stats";
import { CLEAN_FACTOR } from "./stats";

export const EXPORT_FORMAT = "track-evolution-export";
// Bumped only when a field changes meaning or disappears — a future importer
// reads it to know what it holds. Adding a field is not a new version.
export const EXPORT_VERSION = 1;

// Sessions whose channel blobs the JSON export reads per D1 round trip. Each
// blob is written and released before the next page, so a logbook of hundreds
// of telemetry sessions never sits in the Worker's memory at once.
export const EXPORT_PAGE_SESSIONS = 10;

// What each unit-bearing field holds. The export is in **stored units with the
// API's own names**, like the MCP tools: converting to the account's display
// preference would make the file depend on a setting and break an import.
export const UNITS_LEGEND = {
  lap_times: "milliseconds (time_ms, best_ms, goal_ms, best_time_ms)",
  temp_f: "degrees Fahrenheit, whole (an event's typed temperature)",
  ambient_c: "degrees Celsius (recorded by a session's telemetry)",
  elevation_m: "metres (the elevation range a session's recording spanned)",
  odometer_km: "kilometres (the car's own odometer at the end of a session)",
  hours: "hours on track",
  costs: "whole cents (cost_*_cents, cost_cents)",
  setup_pressures: "psi (setup sheets' tp_cold / tp_hot)",
  setup_fuel: "US gallons (setup sheets' fuel)",
  target_hot_psi: "psi",
  wheelbase_mm: "millimetres",
  channels:
    "per-lap traces on a driven-distance grid every dStepM metres: speed km/h, rpm, latG/longG in g, throttle/brake %, steering degrees, yaw °/s",
  dates: "ISO yyyy-mm-dd; *_at timestamps are milliseconds since the epoch",
} as const;

// Keys that must never appear anywhere in a JSON export: credentials and their
// hashes, store identifiers and payloads, provider subjects. The route never
// selects these; the API test walks the whole file for them.
export const FORBIDDEN_EXPORT_KEYS = [
  "token",
  "token_hash",
  "code",
  "code_hash",
  "external_id",
  "purchase_token",
  "jws",
  "raw",
  "signed_date",
  "google_sub",
  "apple_sub",
  "entitled_until",
  "stripe_customer_id",
  "redirect_uris",
  "metadata_document",
] as const;

// The JSON export's opening fields, before the first section.
export function exportHeader(now: Date, telemetry: boolean) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: now.toISOString(),
    telemetry_included: telemetry,
    units: UNITS_LEGEND,
  };
}

// "track-evolution-laps-2026-10-11.csv". The server's UTC date.
export function exportFilename(kind: "laps" | "events" | "logbook", now: Date): string {
  const date = now.toISOString().slice(0, 10);
  if (kind === "logbook") return `track-evolution-${date}.json`;
  return `track-evolution-${kind}-${date}.csv`;
}

// ---------------------------------------------------------------------------
// CSV

// One RFC 4180 cell. Text that a spreadsheet would read as a formula — it
// starts with =, +, -, @, a tab or a CR — is prefixed with an apostrophe, so a
// note typed as "=HYPERLINK(…)" opens as text. Numbers are never guarded or
// quoted, so a camber of -3.2 stays a number.
export function csvCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "1" : "0";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}

// A server copy of fmtMs in public/js/format.js — the backend and frontend
// share no code outside src/ai/ — pinned to it by test/unit/export.test.ts.
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const total = Math.round(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  let frac = String(total % 1000).padStart(3, "0").replace(/0+$/, "");
  if (!frac) frac = "0";
  return `${m}:${String(s).padStart(2, "0")}.${frac}`;
}

// One lap as the laps CSV query returns it, with its session's best.
export type LapExportRow = {
  event_id: number;
  event_date: string;
  track: string;
  organizer: string | null;
  run_group: string | null;
  car: string | null;
  session_id: number;
  session: string | null;
  lap: number;
  time_ms: number;
  device_timed: number;
  session_best_ms: number;
};

export const LAPS_CSV_COLUMNS = [
  "event_id",
  "event_date",
  "track",
  "organizer",
  "run_group",
  "car",
  "session_id",
  "session",
  "lap",
  "lap_time_ms",
  "lap_time",
  "session_best",
  "clean",
  "device_timed",
] as const;

// One CSV line per lap, in the order the rows came (event date, session, lap).
// `clean` is NS-42's rule — within CLEAN_FACTOR of the session's own best,
// inclusive, compared in doubles as eventSelect does — so a spreadsheet can
// reproduce an event's consistency figure from this file alone.
export function lapsCsvLine(r: LapExportRow): string {
  return csvLine([
    r.event_id,
    r.event_date,
    r.track,
    r.organizer,
    r.run_group,
    r.car,
    r.session_id,
    r.session,
    r.lap,
    r.time_ms,
    fmtMs(r.time_ms),
    r.time_ms === r.session_best_ms,
    r.time_ms <= r.session_best_ms * CLEAN_FACTOR,
    !!r.device_timed,
  ]);
}

export function lapsCsv(rows: LapExportRow[]): string {
  return csvLine([...LAPS_CSV_COLUMNS]) + rows.map(lapsCsvLine).join("");
}

export const EVENTS_CSV_COLUMNS = [
  "event_id",
  "start_date",
  "days",
  "track",
  "organizer",
  "run_group",
  "car",
  "conditions",
  "temp_f",
  "ambient_lo_c",
  "ambient_hi_c",
  "sessions",
  "laps",
  "best_lap_ms",
  "best_lap",
  "consistency_pct",
  "hours",
  "cost_entry",
  "cost_fuel",
  "cost_travel",
  "cost_misc",
  "cost_total",
  "notes",
] as const;

// Whole cents as dollars to two places — a number cell, so a spreadsheet sums
// it — or empty when nothing was entered.
function dollars(cents: number | null | undefined): number | string {
  return cents == null ? "" : Number((cents / 100).toFixed(2));
}

// One CSV line per event. An upcoming event (starting after `today`) has its
// computed columns — best, consistency, hours — empty: it hasn't happened, and
// the hours estimate would otherwise invent a day's seat time for it.
export function eventsCsvLine(e: ComputedEvent, today: string): string {
  const upcoming = e.start_date > today;
  return csvLine([
    e.id,
    e.start_date,
    e.days,
    e.track_name,
    e.club,
    e.run_group,
    e.car,
    e.conditions,
    e.temp_f,
    e.ambient_lo_c,
    e.ambient_hi_c,
    e.session_count,
    e.lap_count,
    upcoming ? null : e.best_ms,
    upcoming || e.best_ms == null ? "" : fmtMs(e.best_ms),
    upcoming || e.consistency == null ? null : Math.round(e.consistency * 10000) / 100,
    upcoming ? null : e.hours,
    dollars(e.cost_entry_cents),
    dollars(e.cost_fuel_cents),
    dollars(e.cost_travel_cents),
    dollars(e.cost_misc_cents),
    dollars(e.cost_cents),
    e.notes,
  ]);
}

// Newest first, as the rows came.
export function eventsCsv(events: ComputedEvent[], today: string): string {
  return csvLine([...EVENTS_CSV_COLUMNS]) + events.map((e) => eventsCsvLine(e, today)).join("");
}

// JSON.parse that answers null rather than throwing on a malformed stored
// value: an export must not fail over one bad cell.
export function parseStored(raw: string | null | undefined): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Streaming

// Writes a JSON document in pieces, remembering what is still open, so a
// failure partway can close every open array and object and still end with a
// parseable file that says it failed. Each `item` is written whole — the
// comma before it included — so between writes the document is always one
// closer away from valid.
export class JsonStream {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  // The closers of what is open, innermost last, and whether each has had an
  // item yet (so the next one knows to lead with a comma).
  private readonly open: { closer: string; filled: boolean }[] = [];

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.writer = writer;
  }

  async raw(s: string) {
    await this.writer.write(this.encoder.encode(s));
  }

  // Opens a container — `{"events":[` style — as the next item of the current
  // one. `key` is for an object member, absent for an array element.
  async begin(key: string | null, opener: "{" | "[") {
    const parent = this.open[this.open.length - 1];
    const comma = parent?.filled ? "," : "";
    if (parent) parent.filled = true;
    await this.raw(`${comma}${key == null ? "" : `${JSON.stringify(key)}:`}${opener}`);
    this.open.push({ closer: opener === "{" ? "}" : "]", filled: false });
  }

  async end() {
    const top = this.open.pop();
    if (top) await this.raw(top.closer);
  }

  // One complete member (`key`) or element: `json` is already serialized.
  async item(key: string | null, json: string) {
    const parent = this.open[this.open.length - 1];
    const comma = parent?.filled ? "," : "";
    if (parent) parent.filled = true;
    await this.raw(`${comma}${key == null ? "" : `${JSON.stringify(key)}:`}${json}`);
  }

  // A failure partway: close everything but the document itself, then end
  // the document with the error so a reader knows the file is incomplete.
  async fail(message: string) {
    while (this.open.length > 1) await this.end();
    await this.item("error", JSON.stringify(message));
    await this.end();
  }

  get depth() {
    return this.open.length;
  }
}
