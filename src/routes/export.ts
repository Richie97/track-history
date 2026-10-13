import { Hono } from "hono";
import type { AppContext, Ctx } from "../types";
import { eventSelect } from "../db";
import { type EventRow, withComputed } from "../lib/stats";
import {
  EXPORT_PAGE_SESSIONS,
  JsonStream,
  LAPS_CSV_COLUMNS,
  type LapExportRow,
  csvLine,
  eventsCsv,
  exportFilename,
  exportHeader,
  lapsCsvLine,
  parseStored,
} from "../lib/export";
import { parseProfile } from "../lib/profile";
import { RATE_LIMIT_RETRY_AFTER_S, withinLimit } from "../lib/ratelimit";

// Export your logbook (NS-44): two CSVs for a spreadsheet and one JSON file
// holding everything. Free and complete for every account — a free account's
// file carries its channels, garage and setup sheets, because the data is the
// driver's and the Pro line is the analysis drawn from it — so no route here is
// gated, and none ever calls stripProFields.
//
// Never reachable through the coach mount (no /export path in COACH_ROUTES) and
// never cached: sw.js skips /api/export/, and the web reaches these through
// plain download links rather than api().
export const exportRoutes = new Hono<AppContext>();

// EXPORT (wrangler.jsonc): a few downloads a minute per user. The binding's
// longest window is a minute, so this is an abuse guard — a full JSON export
// with telemetry is the heaviest read the Worker serves — not a quota.
exportRoutes.use("/export/*", async (c, next) => {
  if (!(await withinLimit(c.env.EXPORT, `user:${c.get("userId")}`))) {
    c.header("Retry-After", String(RATE_LIMIT_RETRY_AFTER_S));
    return c.json({ error: "Too many exports in a row — try again in a minute." }, 429);
  }
  await next();
});

function download(c: Ctx, body: BodyInit, type: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// One row per lap, oldest event first, with each session's best for the
// `session_best` / `clean` columns.
exportRoutes.get("/export/laps.csv", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `WITH sb AS (
       SELECT l.session_id, MIN(l.time_ms) AS sbest
       FROM laps l JOIN sessions s ON s.id = l.session_id JOIN events e ON e.id = s.event_id
       WHERE e.user_id = ?
       GROUP BY l.session_id
     )
     SELECT e.id AS event_id, e.start_date AS event_date, t.name AS track, e.club AS organizer,
            e.run_group, e.car, s.id AS session_id, s.label AS session, l.lap_num AS lap,
            l.time_ms, l.device_timed, sb.sbest AS session_best_ms
     FROM laps l
     JOIN sessions s ON s.id = l.session_id
     JOIN events e ON e.id = s.event_id
     JOIN tracks t ON t.id = e.track_id
     JOIN sb ON sb.session_id = s.id
     WHERE e.user_id = ?
     ORDER BY e.start_date, e.id, s.sort, s.id, l.lap_num`
  )
    .bind(userId, userId)
    .all<LapExportRow>();
  const body = csvLine([...LAPS_CSV_COLUMNS]) + results.map(lapsCsvLine).join("");
  return download(c, body, "text/csv; charset=utf-8", exportFilename("laps", new Date()));
});

// One row per event, newest first — the event list's own rows and figures.
exportRoutes.get("/export/events.csv", async (c) => {
  const now = new Date();
  const { results } = await c.env.DB.prepare(eventSelect("WHERE e.user_id = ?", "ORDER BY e.start_date DESC, e.id DESC"))
    .bind(c.get("userId"))
    .all<EventRow>();
  const body = eventsCsv(results.map(withComputed), now.toISOString().slice(0, 10));
  return download(c, body, "text/csv; charset=utf-8", exportFilename("events", now));
});

// ---------------------------------------------------------------------------
// The whole logbook as one JSON document, streamed.

type LapExportJsonRow = {
  id: number;
  session_id: number;
  lap_num: number;
  time_ms: number;
  device_timed: number;
  clip_duration_ms: number | null;
  clip_lap_offset_ms: number | null;
  clip_size_bytes: number | null;
  clip_created_at: number | null;
};

type SessionRow = {
  id: number;
  event_id: number;
  label: string | null;
  notes: string | null;
  sort: number;
  trace: string | null;
  ambient_c: number | null;
  elevation_m: number | null;
  odometer_km: number | null;
  has_channels: number;
};

exportRoutes.get("/export/logbook.json", async (c) => {
  const userId = c.get("userId");
  const telemetry = c.req.query("telemetry") === "1";
  const now = new Date();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const out = new JsonStream(writer);
  const work = writeLogbook(c.env.DB, userId, telemetry, now, out)
    .catch(async (err) => {
      try {
        if (out.depth > 0) await out.fail(err instanceof Error ? err.message : String(err));
      } catch {
        // The client went away; nothing left to tell.
      }
    })
    // Through the writer: the stream itself is locked to it.
    .finally(() => writer.close().catch(() => {}));
  // The response streams while the work runs; keep the Worker alive for it.
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (a unit harness): the promise still runs.
  }
  return download(c, readable, "application/json; charset=utf-8", exportFilename("logbook", now));
});

async function writeLogbook(db: D1Database, userId: number, telemetry: boolean, now: Date, out: JsonStream) {
  const today = now.toISOString().slice(0, 10);
  await out.begin(null, "{");
  for (const [key, value] of Object.entries(exportHeader(now, telemetry))) {
    await out.item(key, JSON.stringify(value));
  }

  // --- profile, tracks, and every row the events section needs but the
  //     channel blobs, in one round trip.
  const [userRes, trackRes, eventRes, createdRes, sessionRes, lapRes, setupRes] = await db.batch([
    db
      .prepare(
        `SELECT name, email, picture, created_at, units, checklist_template, share_slug,
                leaderboard_opt_in, leaderboard_share_laps, profile
         FROM users WHERE id = ?`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT t.id, t.name, t.goal_ms, t.notes, t.catalog_id, tc.name AS catalog_name, t.updated_at
         FROM tracks t LEFT JOIN track_catalog tc ON tc.id = t.catalog_id
         WHERE t.user_id = ? ORDER BY t.name COLLATE NOCASE`
      )
      .bind(userId),
    db.prepare(eventSelect("WHERE e.user_id = ?", "ORDER BY e.start_date, e.id")).bind(userId),
    db.prepare("SELECT id, created_at FROM events WHERE user_id = ?").bind(userId),
    db
      .prepare(
        `SELECT s.id, s.event_id, s.label, s.notes, s.sort, s.trace, s.ambient_c, s.elevation_m, s.odometer_km,
                (s.channels IS NOT NULL) AS has_channels
         FROM sessions s JOIN events e ON e.id = s.event_id
         WHERE e.user_id = ? ORDER BY e.start_date, e.id, s.sort, s.id`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT l.id, l.session_id, l.lap_num, l.time_ms, l.device_timed,
                k.duration_ms AS clip_duration_ms, k.lap_offset_ms AS clip_lap_offset_ms,
                k.size_bytes AS clip_size_bytes, k.created_at AS clip_created_at
         FROM laps l JOIN sessions s ON s.id = l.session_id JOIN events e ON e.id = s.event_id
         LEFT JOIN lap_clips k ON k.lap_id = l.id AND k.status = 'ready'
         WHERE e.user_id = ? ORDER BY l.session_id, l.lap_num`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT st.event_id, st.day, st.data, st.updated_at
         FROM setups st JOIN events e ON e.id = st.event_id
         WHERE e.user_id = ? ORDER BY st.event_id, st.day`
      )
      .bind(userId),
  ]);

  const user = userRes.results[0] as Record<string, unknown> | undefined;
  if (!user) throw new Error("account not found");
  await out.item(
    "profile",
    JSON.stringify({
      name: user.name,
      email: user.email,
      picture: user.picture,
      created_at: user.created_at,
      units: user.units ?? "imperial",
      checklist_template: parseStored(user.checklist_template as string | null),
      share_slug: user.share_slug,
      leaderboard_opt_in: !!user.leaderboard_opt_in,
      leaderboard_share_laps: !!user.leaderboard_share_laps,
      driver_profile: parseProfile(user.profile, today),
    })
  );
  await out.item("tracks", JSON.stringify(trackRes.results));

  // --- events, each with its sessions (and their laps) and setup sheets.
  const createdAt = new Map((createdRes.results as { id: number; created_at: number }[]).map((r) => [r.id, r.created_at]));
  const sessionsByEvent = groupBy(sessionRes.results as SessionRow[], (s) => s.event_id);
  const lapsBySession = groupBy(
    lapRes.results as LapExportJsonRow[],
    (l) => l.session_id
  );
  const setupsByEvent = groupBy(
    setupRes.results as { event_id: number; day: number; data: string; updated_at: number }[],
    (s) => s.event_id
  );
  // The channel blobs, read EXPORT_PAGE_SESSIONS at a time in the order the
  // sessions are written, each page dropped once its sessions are out.
  const channelIds = telemetry
    ? (sessionRes.results as SessionRow[]).filter((s) => s.has_channels).map((s) => s.id)
    : [];
  let page = new Map<number, string>();
  let nextPage = 0;
  const channelsFor = async (id: number): Promise<string | null> => {
    if (!telemetry) return null;
    while (!page.has(id) && nextPage < channelIds.length) {
      const ids = channelIds.slice(nextPage, nextPage + EXPORT_PAGE_SESSIONS);
      nextPage += ids.length;
      const { results } = await db
        .prepare(`SELECT id, channels FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all<{ id: number; channels: string | null }>();
      page = new Map(results.filter((r) => r.channels != null).map((r) => [r.id, r.channels as string]));
    }
    return page.get(id) ?? null;
  };

  await out.begin("events", "[");
  for (const row of eventRes.results as EventRow[]) {
    const event = withComputed(row);
    const { session_count, ...fields } = event;
    const head = JSON.stringify({ ...fields, created_at: createdAt.get(event.id) ?? null, session_count });
    await out.begin(null, "{");
    // The event's own members, written as one piece without their braces.
    await out.item(null, head.slice(1, -1));
    await out.begin("sessions", "[");
    for (const s of sessionsByEvent.get(event.id) ?? []) {
      const { has_channels, event_id, trace, ...sessionFields } = s;
      // A lap's best-lap video (NS-45) as metadata only: the file itself is the
      // lap page's *Download video*, since video in a JSON stream would make
      // the export unusable.
      const laps = (lapsBySession.get(s.id) ?? []).map(
        ({ session_id, device_timed, clip_duration_ms, clip_lap_offset_ms, clip_size_bytes, clip_created_at, ...l }) => ({
          ...l,
          device_timed: !!device_timed,
          clip:
            clip_duration_ms == null
              ? null
              : {
                  duration_ms: clip_duration_ms,
                  lap_offset_ms: clip_lap_offset_ms,
                  size_bytes: clip_size_bytes,
                  created_at: clip_created_at,
                },
        })
      );
      const json = JSON.stringify({ ...sessionFields, trace: parseStored(trace), laps });
      // The blob is spliced in as stored — already valid JSON, sanitized on the
      // way in — rather than parsed and re-serialized, so a megabyte of arrays
      // is held once, as a string, and only until it is written.
      const channels = has_channels ? await channelsFor(s.id) : null;
      await out.item(null, `${json.slice(0, -1)},"channels":${channels ?? "null"}}`);
    }
    await out.end();
    await out.item(
      "setups",
      JSON.stringify(
        (setupsByEvent.get(event.id) ?? []).map((st) => ({ day: st.day, data: parseStored(st.data), updated_at: st.updated_at }))
      )
    );
    await out.end();
  }
  await out.end();

  // --- the garage: vehicles, their parts, each part's mounts and measurements.
  const [vehicleRes, partRes, mountRes, measurementRes] = await db.batch([
    db
      .prepare(
        `SELECT v.id, v.name, v.notes, v.is_default, v.target_hot_psi, v.wheelbase_mm, v.steering_ratio,
                v.catalog_id, TRIM(cc.make || ' ' || cc.model || COALESCE(' ' || cc.generation, '')) AS catalog_name,
                v.created_at, v.updated_at
         FROM vehicles v LEFT JOIN car_catalog cc ON cc.id = v.catalog_id
         WHERE v.user_id = ? ORDER BY v.id`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT p.id, p.vehicle_id, p.kind, p.name, p.size, p.installed_on, p.retired_on, p.cost_cents,
                p.expected_hours, p.wear_limit, p.notes, p.updated_at
         FROM parts p JOIN vehicles v ON v.id = p.vehicle_id
         WHERE v.user_id = ? ORDER BY p.vehicle_id, p.installed_on, p.id`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT m.part_id, m.mounted_on, m.removed_on, m.mounted_event_id, m.mounted_after_session_id,
                m.removed_event_id, m.removed_after_session_id
         FROM part_mounts m JOIN parts p ON p.id = m.part_id JOIN vehicles v ON v.id = p.vehicle_id
         WHERE v.user_id = ? ORDER BY m.part_id, m.mounted_on, m.id`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT pm.part_id, pm.measured_on, pm.value, pm.unit
         FROM part_measurements pm JOIN parts p ON p.id = pm.part_id JOIN vehicles v ON v.id = p.vehicle_id
         WHERE v.user_id = ? ORDER BY pm.part_id, pm.measured_on, pm.id`
      )
      .bind(userId),
  ]);
  const mountsByPart = groupBy(mountRes.results as { part_id: number }[], (m) => m.part_id);
  const measurementsByPart = groupBy(measurementRes.results as { part_id: number }[], (m) => m.part_id);
  const partsByVehicle = groupBy(partRes.results as { id: number; vehicle_id: number }[], (p) => p.vehicle_id);
  const vehicles = (vehicleRes.results as { id: number; is_default: number }[]).map((v) => ({
    ...v,
    is_default: !!v.is_default,
    parts: (partsByVehicle.get(v.id) ?? []).map(({ vehicle_id, ...p }) => ({
      ...p,
      mounts: (mountsByPart.get(p.id) ?? []).map(({ part_id, ...m }) => m),
      measurements: (measurementsByPart.get(p.id) ?? []).map(({ part_id, ...m }) => m),
    })),
  }));
  await out.item("garage", JSON.stringify({ vehicles }));

  // --- who has access: coaches and students by name, connected assistants by
  //     name, and the subscription by its state — never an id, token or store
  //     identifier.
  const [coachRes, studentRes, assistantRes, subscriptionRes] = await db.batch([
    db
      .prepare(
        `SELECT u.name, g.created_at AS since, g.last_viewed_at
         FROM coach_grants g JOIN users u ON u.id = g.coach_id
         WHERE g.student_id = ? ORDER BY g.created_at`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT u.name, g.created_at AS since
         FROM coach_grants g JOIN users u ON u.id = g.student_id
         WHERE g.coach_id = ? ORDER BY g.created_at`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT c.name AS client_name, g.created_at AS connected_at, g.last_used_at
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
         WHERE g.user_id = ? ORDER BY g.created_at`
      )
      .bind(userId),
    db
      .prepare(
        "SELECT provider, product_id, status, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at"
      )
      .bind(userId),
  ]);
  await out.item(
    "access",
    JSON.stringify({
      coaches: coachRes.results,
      students: studentRes.results,
      assistants: assistantRes.results,
      subscriptions: subscriptionRes.results,
    })
  );
  await out.end();
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
