import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// NS-49: migration 0034 over a database that already has subscribers.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

// The migration rebuilds `subscriptions` (SQLite can't alter a CHECK), so it is
// run here over a database that already holds rows from every provider — the
// API tests only ever see it applied to an empty one.
describe("migration 0034 over existing rows", () => {
  const require = createRequire(import.meta.url);
  // Through require so Vite leaves the builtin alone.
  const { DatabaseSync } = require("node:sqlite");
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  it("keeps every row and every user's entitlement, and the triggers still recompute", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const f of files.filter((f) => f < "0034")) db.exec(readFileSync(path.join(dir, f), "utf8"));
    db.exec("INSERT INTO users (id, email, name) VALUES (1, 'a@x', 'A'), (2, 'b@x', 'B'), (3, 'c@x', 'C')");
    const insert = db.prepare(
      `INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, signed_date, raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2)`
    );
    insert.run(1, "apple", "pro.monthly", "orig-1", "active", NOW, 1, "production", NOW - 5, '{"a":1}');
    insert.run(2, "google", "pro.yearly", "token-2", "expired", NOW - DAY, 0, "production", null, null);
    insert.run(3, "legacy", "apple-paid-app", "apple:3", "legacy", null, null, "production", NOW - 9, null);
    const before = db.prepare("SELECT * FROM subscriptions ORDER BY id").all();
    const tiers = db.prepare("SELECT id, entitled_until FROM users ORDER BY id").all();

    db.exec(readFileSync(path.join(dir, files.find((f) => f.startsWith("0034"))), "utf8"));

    expect(db.prepare("SELECT * FROM subscriptions ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT id, entitled_until FROM users ORDER BY id").all()).toEqual(tiers);
    // A new row still recomputes, and still gets the next id.
    insert.run(2, "stripe", "price_y", "sub_2", "active", NOW + DAY, 1, "live", null, null);
    expect((db.prepare("SELECT entitled_until FROM users WHERE id = 2").get()).entitled_until).toBe(NOW + DAY + 3 * DAY);
    expect((db.prepare("SELECT MAX(id) AS id FROM subscriptions").get()).id).toBe(4);
    expect(() => insert.run(1, "paypal", null, "x", "active", NOW, 1, null, null, null)).toThrow(/CHECK/);
    // Deleting a user still takes their rows with them.
    db.exec("DELETE FROM users WHERE id = 1");
    expect((db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = 1").get()).n).toBe(0);
  });
});
