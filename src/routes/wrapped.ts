import { Hono } from "hono";
import type { AppContext } from "../types";
import { eventSelect, vehicleHoursEventsStmt } from "../db";
import { isEntitled } from "../lib/entitlement";
import { type EventRow, withComputed } from "../lib/stats";
import {
  seasonWrapped, wrappedPro, type TirePart, type TopSpeedRow, type VehicleEvent, type WrappedInputs,
} from "../lib/wrapped";

// Season Wrapped (NS-36): the season's numbers, computed once on the server so
// the web story, the public share (ticket 3) and a future native screen all
// read the same thing. The pure half is lib/wrapped.ts; this is the fetch.
export const wrapped = new Hono<AppContext>();

// Everything seasonWrapped needs for one user, in one batched round trip. The
// telemetry statements are narrowed to the year's tracks that the catalog has
// no length for, since those are the only ones whose length is derived — and
// they read one number per lap out of the channel blob in SQL (json_each), so
// no blob ever crosses into the Worker.
//
// `withPro` appends the Pro cards' three statements to the same batch — the
// tyre parts, the vehicle-linked events their window runs over, and the year's
// top speed — and is only ever set for an entitled account; the public share
// never sets it.
export async function wrappedInputs(
  db: D1Database,
  userId: number,
  year: number,
  today: string,
  { withPro = false } = {}
) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const needsLength = `
    SELECT t.id FROM tracks t
    LEFT JOIN track_catalog c ON c.id = t.catalog_id
    WHERE t.user_id = ?1 AND c.length_m IS NULL
      AND t.id IN (SELECT track_id FROM events WHERE user_id = ?1 AND start_date BETWEEN ?2 AND ?3 AND start_date <= ?4)`;
  const proStmts = withPro
    ? [
        db
          .prepare(
            // Full sets and front / rear pairs alike; the mounts ride along
            // as JSON so a set that sat on the shelf isn't credited with the
            // days it missed (migration 0029).
            `SELECT p.id, p.vehicle_id, v.name AS vehicle_name, p.name, p.installed_on, p.retired_on,
                    (SELECT json_group_array(json_object('mounted_on', m.mounted_on, 'removed_on', m.removed_on))
                     FROM part_mounts m WHERE m.part_id = p.id) AS mounts
             FROM parts p JOIN vehicles v ON v.id = p.vehicle_id
             WHERE v.user_id = ? AND p.kind IN ('tires', 'tires_front', 'tires_rear')`
          )
          .bind(userId),
        vehicleHoursEventsStmt(db, userId),
        // Once a year per user is not a hot path, so this walks every speed
        // sample of the year's sessions in SQL rather than keeping a
        // trigger-maintained column for one card.
        db
          .prepare(
            `SELECT MAX(sp.value) AS kph, e.track_id, t.name AS track_name, e.id AS event_id, e.start_date AS date
             FROM sessions s JOIN events e ON e.id = s.event_id JOIN tracks t ON t.id = e.track_id,
               json_each(s.channels, '$.laps') l, json_each(l.value, '$.speed') sp
             WHERE e.user_id = ? AND s.channels IS NOT NULL
               AND e.start_date BETWEEN ? AND ? AND e.start_date <= ?
             GROUP BY e.id ORDER BY kph DESC, e.start_date ASC, e.id ASC LIMIT 1`
          )
          .bind(userId, from, to, today),
      ]
    : [];
  const [userRes, eventsRes, catalogRes, channelRes, traceRes, ...proRes] = await db.batch([
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
    ...proStmts,
  ]);
  const inputs: WrappedInputs = {
    name: (userRes.results[0] as { name: string | null } | undefined)?.name ?? null,
    events: (eventsRes.results as EventRow[]).map(withComputed),
    catalogLengths: catalogRes.results as WrappedInputs["catalogLengths"],
    channelLaps: channelRes.results as WrappedInputs["channelLaps"],
    traces: traceRes.results as WrappedInputs["traces"],
  };
  const pro = withPro
    ? {
        tireParts: (proRes[0].results as (Omit<TirePart, "mounts"> & { mounts: string })[]).map((p) => ({
          ...p,
          mounts: JSON.parse(p.mounts) as TirePart["mounts"],
        })),
        vehicleEvents: proRes[1].results as VehicleEvent[],
        topSpeed: (proRes[2].results[0] as TopSpeedRow | undefined) ?? null,
      }
    : null;
  return { inputs, pro };
}

wrapped.get("/wrapped/:year", async (c) => {
  const raw = c.req.param("year");
  if (!/^\d{4}$/.test(raw)) return c.json({ error: "year must be four digits" }, 400);
  const year = Number(raw);
  const today = new Date().toISOString().slice(0, 10);
  // `pro` is the one tier-dependent field (NS-36 requirement 1), decided from
  // entitledUntil the way stripProFields decides `channels`: a per-field strip
  // on a read, never a 402 — the story itself is free. Null for a free
  // account (the client draws the two cards locked); for Pro, an object whose
  // cards are null when there is no data, so locked and empty stay distinct.
  const entitled = isEntitled(c.get("entitledUntil"), Date.now());
  const { inputs, pro } = await wrappedInputs(c.env.DB, c.get("userId"), year, today, { withPro: entitled });
  const season = seasonWrapped(inputs, year, today);
  if (!season) return c.json({ error: `no events in ${year}` }, 404);
  return c.json({ ...season, pro: pro ? wrappedPro(pro, year, today) : null });
});
