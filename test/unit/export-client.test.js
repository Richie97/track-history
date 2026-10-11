import { describe, expect, it } from "vitest";
import {
  EXPORT_FILES,
  exportErrorText,
  exportFilename,
  exportStoppedPartway,
  exportUrl,
} from "../../public/js/export.js";

// Settings' *Your data* section (NS-44): which URL each button fetches, what
// the saved file is called, and how a refusal or a partial JSON is worded.

describe("export client", () => {
  it("offers the three files, with telemetry only on the JSON", () => {
    expect(EXPORT_FILES.map((f) => f.kind)).toEqual(["laps", "events", "logbook"]);
    expect(exportUrl("laps", true)).toBe("/api/export/laps.csv");
    expect(exportUrl("logbook")).toBe("/api/export/logbook.json");
    expect(exportUrl("logbook", true)).toBe("/api/export/logbook.json?telemetry=1");
    expect(() => exportUrl("garage")).toThrow();
  });

  it("names the file as the server did, else by kind", () => {
    expect(exportFilename("laps", 'attachment; filename="track-evolution-laps-2026-10-11.csv"')).toBe(
      "track-evolution-laps-2026-10-11.csv"
    );
    expect(exportFilename("logbook", null)).toBe("track-evolution.json");
  });

  it("spots a JSON export that stopped partway, and only that", () => {
    expect(exportStoppedPartway('{"format":"x","events":[]}')).toBe(false);
    expect(exportStoppedPartway('{"format":"x","events":[{"id":1}],"error":"D1 went \\"away\\""}')).toBe(true);
    // A note that merely mentions an error is not a failed export.
    expect(exportStoppedPartway('{"events":[{"notes":"\\"error\\": none"}],"access":{}}')).toBe(false);
  });

  it("says the server's own words when it gave some", () => {
    expect(exportErrorText(429, { error: "Too many exports in a row — try again in a minute." })).toMatch(/minute/);
    expect(exportErrorText(401, null)).toMatch(/sign in/);
    expect(exportErrorText(500, null)).toMatch(/500/);
  });
});
