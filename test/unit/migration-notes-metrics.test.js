import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Migration 0042 rewrites free text, so it is run here over the notes it must
// change and, more to the point, the ones it must leave alone.
describe("migration 0042 over stored session notes", () => {
  const require = createRequire(import.meta.url);
  // Through require so Vite leaves the builtin alone.
  const { DatabaseSync } = require("node:sqlite");
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const CAVEAT = "lap times derived from GPS start/finish crossings (~±0.1–0.3s)";
  const cases = [
    // [stored, after]
    ["Imported from a.mp4 — top speed 121 mph · max 6,703 rpm · 1.43 G lateral", "Imported from a.mp4"],
    ["Imported from a.mp4 — top speed 195 km/h · max 6.703 rpm · 1.43 G lateral", "Imported from a.mp4"],
    ["Imported from a.mp4 — top speed 89 mph — " + CAVEAT, "Imported from a.mp4 — " + CAVEAT],
    ["Imported from S.MOV — top speed 140 mph · max 7,100 rpm", "Imported from S.MOV"],
    ["Imported from a.mp4 — max 6,703 rpm · 1.43 G lateral", "Imported from a.mp4"],
    ["Imported from a.mp4 — 1.43 G lateral", "Imported from a.mp4"],
    ["Recorded with the in-app lap timer — top speed 101 mph — " + CAVEAT, "Recorded with the in-app lap timer — " + CAVEAT],
    // What the driver added after the caveat stays.
    ["Imported from a.mp4 — top speed 89 mph — " + CAVEAT + "\nNew pads.", "Imported from a.mp4 — " + CAVEAT + "\nNew pads."],
    // Left alone: nothing to remove, or no longer the importer's own line.
    ["Imported from a.mp4", null],
    ["Imported from a.vbo — " + CAVEAT, null],
    ["Recorded with the in-app lap timer", null],
    ["Imported from a.mp4 — top speed 121 mph · 1.43 G lateral. Felt loose in T3", null],
    ["Imported from a.mp4 — top speed 121 mph\nNew pads.", null],
    ["Imported from a.mp4 — top speed felt low today", null],
    ["Great day — top speed 121 mph", null],
    ["top speed 121 mph", null],
  ];

  it("removes the import's metrics and nothing else", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const f of files.filter((f) => f < "0042")) db.exec(readFileSync(path.join(dir, f), "utf8"));
    db.exec("INSERT INTO users (id, email, name) VALUES (1, 'a@x', 'A')");
    db.exec("INSERT INTO tracks (id, user_id, name) VALUES (1, 1, 'T')");
    db.exec("INSERT INTO events (id, user_id, track_id, start_date) VALUES (1, 1, 1, '2026-06-01')");
    const insert = db.prepare("INSERT INTO sessions (id, event_id, notes) VALUES (?, 1, ?)");
    cases.forEach(([stored], i) => insert.run(i + 1, stored));
    insert.run(100, null);

    db.exec(readFileSync(path.join(dir, files.find((f) => f.startsWith("0042"))), "utf8"));

    const after = db.prepare("SELECT notes FROM sessions WHERE id < 100 ORDER BY id").all().map((r) => r.notes);
    expect(after).toEqual(cases.map(([stored, expected]) => expected ?? stored));
    expect(db.prepare("SELECT notes FROM sessions WHERE id = 100").get().notes).toBeNull();
  });
});
