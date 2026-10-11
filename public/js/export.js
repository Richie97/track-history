// Downloading a copy of the logbook (NS-44) — the pure half of Settings' *Your
// data* section. The three files come from /api/export/*, which sw.js never
// caches and api() never routes: they are downloads, not data.
//
// They are fetched rather than opened as plain download links so a refusal
// (the per-minute limit's 429, a signed-out 401) or a JSON export that stopped
// partway is said in words, instead of the browser saving the error as the file.

export const EXPORT_FILES = [
  { kind: "laps", path: "/api/export/laps.csv", label: "Laps (CSV)", fallback: "track-evolution-laps.csv" },
  { kind: "events", path: "/api/export/events.csv", label: "Events (CSV)", fallback: "track-evolution-events.csv" },
  { kind: "logbook", path: "/api/export/logbook.json", label: "Everything (JSON)", fallback: "track-evolution.json" },
];

export const EXPORT_OFFLINE = "Exporting needs a connection.";

// The URL for one file; only the JSON takes the telemetry flag.
export function exportUrl(kind, telemetry = false) {
  const file = EXPORT_FILES.find((f) => f.kind === kind);
  if (!file) throw new Error(`unknown export: ${kind}`);
  return kind === "logbook" && telemetry ? `${file.path}?telemetry=1` : file.path;
}

// The name the server gave the file, from its Content-Disposition, else the
// file's fallback.
export function exportFilename(kind, contentDisposition) {
  const match = /filename="([^"]+)"/.exec(contentDisposition ?? "");
  return match ? match[1] : EXPORT_FILES.find((f) => f.kind === kind)?.fallback ?? "track-evolution-export";
}

// A JSON export that failed after it started streaming can't change its status
// any more, so the server ends the document with an "error" member instead —
// always the last one. Reading the tail is enough to tell.
export function exportStoppedPartway(tail) {
  return /,"error":"(?:[^"\\]|\\.)*"\}\s*$/.test(tail ?? "");
}

// What to say when the server refused: its own words when it gave some.
export function exportErrorText(status, body) {
  if (body && typeof body.error === "string") return body.error;
  if (status === 401) return "Your session has ended — sign in again to export.";
  return `The export didn't download (${status}). Try again.`;
}
