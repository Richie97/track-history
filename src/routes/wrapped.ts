import { Hono } from "hono";
import type { AppContext } from "../types";
import { eventSelect } from "../db";
import { type EventRow, withComputed } from "../lib/stats";
import { seasonWrapped, type WrappedInputs } from "../lib/wrapped";

// Season Wrapped (NS-36): the season's numbers, computed once on the server so
// the web story, the public share (ticket 3) and a future native screen all
// read the same thing. The pure half is lib/wrapped.ts; this is the fetch.
export const wrapped = new Hono<AppContext>();

// Everything seasonWrapped needs for one user, in one batched round trip. The
// telemetry statements are narrowed to the year's tracks that the catalog has
// no length for, since those are the only ones whose length is derived — and
// they read one number per lap out of the channel blob in SQL (json_each), so
// no blob ever crosses into the Worker.
export async function wrappedInputs(db: D1Database, userId: number, year: number, today: string) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const needsLength = `
    SELECT t.id FROM tracks t
    LEFT JOIN track_catalog c ON c.id = t.catalog_id
    WHERE t.user_id = ?1 AND c.length_m IS NULL
      AND t.id IN (SELECT track_id FROM events WHERE user_id = ?1 AND start_date BETWEEN ?2 AND ?3 AND start_date <= ?4)`;
  const [userRes, eventsRes, catalogRes, channelRes, traceRes] = await db.batch([
    db.prepare("SELECT name FROM users WHERE id = ?").bind(userId),
    db.prepare(eventSelect("WHERE e.user_id = ? AND e.start_date <= ?", "ORDER BY e.start_date ASC")).bind(userId, today),
    db
      .prepare(
        "SELECT t.id AS track_id, c.length_m FROM tracks t LEFT JOIN track_catalog c ON c.id = t.catalog_id WHERE t.user_id = ?"
      )
      .bind(userId),
    db
      .prepare(
        `SELECT e.track_id, json_extract(s.channels, '$.dStepM') * json_array_length(j.value, '$.speed') AS length_m
         FROM sessions s JOIN events e ON e.id = s.event_id, json_each(s.channels, '$.laps') j
         WHERE s.channels IS NOT NULL AND e.track_id IN (${needsLength})
           AND json_array_length(j.value, '$.speed') IS NOT NULL`
      )
      .bind(userId, from, to, today),
    db
      .prepare(
        `SELECT e.track_id, s.trace FROM sessions s JOIN events e ON e.id = s.event_id
         WHERE s.trace IS NOT NULL AND e.track_id IN (${needsLength})`
      )
      .bind(userId, from, to, today),
  ]);
  const inputs: WrappedInputs = {
    name: (userRes.results[0] as { name: string | null } | undefined)?.name ?? null,
    events: (eventsRes.results as EventRow[]).map(withComputed),
    catalogLengths: catalogRes.results as WrappedInputs["catalogLengths"],
    channelLaps: channelRes.results as WrappedInputs["channelLaps"],
    traces: traceRes.results as WrappedInputs["traces"],
  };
  return inputs;
}

wrapped.get("/wrapped/:year", async (c) => {
  const raw = c.req.param("year");
  if (!/^\d{4}$/.test(raw)) return c.json({ error: "year must be four digits" }, 400);
  const year = Number(raw);
  const today = new Date().toISOString().slice(0, 10);
  const inputs = await wrappedInputs(c.env.DB, c.get("userId"), year, today);
  const season = seasonWrapped(inputs, year, today);
  if (!season) return c.json({ error: `no events in ${year}` }, 404);
  // `pro` is the one tier-dependent field (NS-36 requirement 1): the favourite
  // tyre and top speed cards, null for everyone until ticket 4 fills it.
  return c.json({ ...season, pro: null });
});
