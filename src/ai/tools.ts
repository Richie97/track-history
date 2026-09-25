// The AI tool layer (#315): one definition per tool — a name, a description
// written for a model, a JSON-Schema input and a handler — shared by the MCP
// server (routes/mcp.ts) and, later, the in-app coach (#318). Neither owns a
// copy.
//
// Tools read through the API itself rather than through a second set of
// queries: `apiGet` runs a GET against a private instance of the /api router
// (src/api.ts) whose auth middleware takes the caller from the Request object,
// so a tool answers exactly what GET /api/… would — the same ownership scoping,
// the same Pro strip, the same leaderboard privacy rules. The caller map is a
// WeakMap keyed by the Request the tool itself constructed, so nothing outside
// this module can put a user on a request. Only GETs are ever issued: v1 is
// read-only by construction, not by convention.
//
// Every result is a JSON object (MCP's structuredContent must be one), bounded
// by per-tool limits, and in *stored* units — lap times in integer ms, speeds
// km/h, temperatures °C except the event's typed `temp_f`, distances metres —
// with the unit in the key. get_profile says which system the user reads in.

import { createMiddleware } from "hono/factory";
import { apiApp } from "../api";
import type { AppContext, Env } from "../types";
import { fmtMs } from "../../public/js/format.js";
import { partKindLabel, partStatus, fmtRemaining } from "../../public/js/garage.js";
import {
  type DetailSession,
  type LapSide,
  channelEntryForLap,
  channelsPresent,
  compareLapPair,
  lapStats,
  lapTelemetry,
  lapsByChannelIndex,
  sessionInsights,
} from "./insights";

export type ToolUser = { userId: number; entitledUntil: number | null };

export class ToolError extends Error {}

// ---------- reading through the API -----------------------------------------

const callers = new WeakMap<Request, ToolUser>();

const internalApi = apiApp(
  createMiddleware<AppContext>(async (c, next) => {
    const user = callers.get(c.req.raw);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", user.userId);
    c.set("entitledUntil", user.entitledUntil);
    return next();
  })
);

export async function apiGet<T = any>(env: Env, user: ToolUser, path: string): Promise<T> {
  const req = new Request(`https://internal${path}`, { method: "GET" });
  callers.set(req, user);
  const res = await internalApi.fetch(req, env);
  const body = (await res.json().catch(() => null)) as any;
  if (res.status === 404) throw new ToolError("Not found — check the id (it must be one of this user's).");
  if (res.status === 402) throw new ToolError("This needs Track Evolution Pro.");
  if (!res.ok) throw new ToolError(body?.error ?? `request failed (${res.status})`);
  return body as T;
}

// ---------- argument schemas ------------------------------------------------

type Prop =
  | { type: "integer"; description: string; minimum?: number; maximum?: number }
  | { type: "number"; description: string; minimum?: number; maximum?: number }
  | { type: "string"; description: string; enum?: string[] }
  | { type: "boolean"; description: string }
  | { type: "array"; description: string; items: { type: "string"; enum?: string[] }; maxItems?: number };

export type InputSchema = {
  type: "object";
  properties: Record<string, Prop>;
  required?: string[];
  additionalProperties: false;
};

// A deliberately small validator for the shapes above — enough to turn a
// model's malformed call into a message it can correct, which is what a tool
// error is for.
export function validateArgs(schema: InputSchema, raw: unknown): Record<string, any> {
  if (raw == null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ToolError("arguments must be an object");
  const args = raw as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) throw new ToolError(`unknown argument "${key}"`);
  }
  for (const key of schema.required ?? []) {
    if (args[key] == null) throw new ToolError(`"${key}" is required`);
  }
  const out: Record<string, any> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v == null) continue;
    switch (prop.type) {
      case "integer":
      case "number": {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolError(`"${key}" must be a number`);
        if (prop.type === "integer" && !Number.isInteger(n)) throw new ToolError(`"${key}" must be an integer`);
        if (prop.minimum != null && n < prop.minimum) throw new ToolError(`"${key}" must be at least ${prop.minimum}`);
        if (prop.maximum != null && n > prop.maximum) throw new ToolError(`"${key}" must be at most ${prop.maximum}`);
        out[key] = n;
        break;
      }
      case "string":
        if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
        if (prop.enum && !prop.enum.includes(v)) throw new ToolError(`"${key}" must be one of ${prop.enum.join(", ")}`);
        out[key] = v;
        break;
      case "boolean":
        if (typeof v !== "boolean") throw new ToolError(`"${key}" must be true or false`);
        out[key] = v;
        break;
      case "array":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
          throw new ToolError(`"${key}" must be an array of strings`);
        if (prop.maxItems != null && v.length > prop.maxItems) throw new ToolError(`"${key}" allows at most ${prop.maxItems} items`);
        if (prop.items.enum) {
          const bad = v.find((x) => !prop.items.enum!.includes(x));
          if (bad != null) throw new ToolError(`"${key}" contains "${bad}"; allowed: ${prop.items.enum.join(", ")}`);
        }
        out[key] = v;
        break;
    }
  }
  return out;
}

// ---------- the tools --------------------------------------------------------

export type ToolContext = { env: Env; user: ToolUser; today: string };

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  handler: (ctx: ToolContext, args: Record<string, any>) => Promise<Record<string, unknown>>;
};

const id = (description: string): Prop => ({ type: "integer", description, minimum: 1 });
const noArgs: InputSchema = { type: "object", properties: {}, additionalProperties: false };
const time = (ms: number | null | undefined) => (ms == null ? null : fmtMs(ms));
const todayISO = () => new Date().toISOString().slice(0, 10);

// The event row as a model needs it: the stats, not the plumbing.
function eventRow(e: any, includeNotes = false) {
  return {
    event_id: e.id,
    track_id: e.track_id,
    track_name: e.track_name,
    start_date: e.start_date,
    days: e.days,
    car: e.car,
    vehicle_id: e.vehicle_id,
    club: e.club,
    run_group: e.run_group,
    conditions: e.conditions,
    temp_f: e.temp_f,
    ambient_lo_c: e.ambient_lo_c,
    ambient_hi_c: e.ambient_hi_c,
    best_ms: e.best_ms,
    best: time(e.best_ms),
    lap_count: e.lap_count,
    session_count: e.session_count,
    consistency_cv_pct: e.consistency == null ? null : Math.round(e.consistency * 1000) / 10,
    on_track_hours: e.hours,
    cost_cents: e.cost_cents,
    ...(includeNotes ? { notes: e.notes } : {}),
  };
}

// The event detail (GET /events/:id) and the one session in it, for the tools
// that start from a session or a lap id. Ownership is the API's: the event
// fetch 404s for another user's id, so the lookups below only need to find
// which event a session or lap belongs to.
async function eventForSession(ctx: ToolContext, sessionId: number) {
  const row = await ctx.env.DB.prepare(
    "SELECT s.event_id FROM sessions s JOIN events e ON e.id = s.event_id WHERE s.id = ? AND e.user_id = ?"
  )
    .bind(sessionId, ctx.user.userId)
    .first<{ event_id: number }>();
  if (!row) throw new ToolError(`No session ${sessionId} in this logbook.`);
  const event = await apiGet(ctx.env, ctx.user, `/events/${row.event_id}`);
  const session = (event.sessions as DetailSession[]).find((s) => s.id === sessionId)!;
  return { event, session };
}

async function lapSide(ctx: ToolContext, lapId: number, label: string): Promise<LapSide & { event: any }> {
  const row = await ctx.env.DB.prepare(
    "SELECT l.session_id FROM laps l JOIN sessions s ON s.id = l.session_id JOIN events e ON e.id = s.event_id WHERE l.id = ? AND e.user_id = ?"
  )
    .bind(lapId, ctx.user.userId)
    .first<{ session_id: number }>();
  if (!row) throw new ToolError(`No lap ${lapId} in this logbook.`);
  const { event, session } = await eventForSession(ctx, row.session_id);
  const lap = session.laps.find((l) => l.id === lapId)!;
  const entry = channelEntryForLap(session, lapId);
  if (!entry || !session.channels)
    throw new ToolError(
      `Lap ${lapId} has no telemetry (it was typed in, or its session was imported without channel data). Pick a lap whose has_telemetry is true.`
    );
  return { lap, entry, dStepM: session.channels.dStepM, label, event };
}

export const TOOLS: Tool[] = [
  {
    name: "get_profile",
    title: "Profile",
    description:
      "The driver's profile: name, preferred unit system (imperial or metric — present numbers in it), lifetime totals, and leaderboard settings. Call this first.",
    inputSchema: noArgs,
    async handler(ctx) {
      const me = await apiGet(ctx.env, ctx.user, "/me");
      return {
        name: me.user?.name ?? null,
        units: me.user?.units ?? "imperial",
        totals: { events: me.totals?.events ?? 0, track_days: me.totals?.track_days ?? 0 },
        leaderboard_opt_in: Boolean(me.user?.leaderboard_opt_in),
        today: ctx.today,
      };
    },
  },
  {
    name: "list_tracks",
    title: "Tracks",
    description:
      "Every track in the logbook with its all-time best lap, goal, event and track-day counts and last visit. A track's name includes its layout, e.g. \"Virginia International Raceway (Full)\"; different layouts are different tracks.",
    inputSchema: noArgs,
    async handler(ctx) {
      const tracks = await apiGet<any[]>(ctx.env, ctx.user, "/tracks");
      return {
        tracks: tracks.map((t) => ({
          track_id: t.id,
          name: t.name,
          best_ms: t.best_ms,
          best: time(t.best_ms),
          goal_ms: t.goal_ms,
          goal: time(t.goal_ms),
          event_count: t.event_count,
          track_days: t.track_days,
          last_date: t.last_date,
          notes: t.notes,
          has_leaderboard: t.catalog_id != null,
        })),
      };
    },
  },
  {
    name: "list_events",
    title: "Events",
    description:
      "Track-day events, newest first, with each one's best lap, lap and session counts, consistency (coefficient of variation of lap times), conditions and on-track hours. Filter by track, car or year. An event's best is the lower of its fastest logged lap and a manually entered best.",
    inputSchema: {
      type: "object",
      properties: {
        track_id: id("Only events at this track (from list_tracks)."),
        vehicle_id: id("Only events in this garage vehicle."),
        year: { type: "integer", description: "Only events starting in this calendar year.", minimum: 1990, maximum: 2100 },
        when: { type: "string", enum: ["past", "upcoming", "all"], description: "Past (default), upcoming, or all events." },
        include_notes: { type: "boolean", description: "Include each event's free-text notes." },
        limit: { type: "integer", description: "Maximum rows (default 50, max 200).", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const path = args.track_id ? `/events?track_id=${args.track_id}` : "/events";
      let rows = await apiGet<any[]>(ctx.env, ctx.user, path);
      const when = args.when ?? "past";
      if (when === "past") rows = rows.filter((e) => e.start_date <= ctx.today);
      if (when === "upcoming") rows = rows.filter((e) => e.start_date > ctx.today);
      if (args.vehicle_id) rows = rows.filter((e) => e.vehicle_id === args.vehicle_id);
      if (args.year) rows = rows.filter((e) => e.start_date.startsWith(`${args.year}-`));
      const limit = args.limit ?? 50;
      return {
        total: rows.length,
        truncated: rows.length > limit,
        events: rows.slice(0, limit).map((e) => eventRow(e, args.include_notes)),
      };
    },
  },
  {
    name: "get_event",
    title: "Event detail",
    description:
      "One event in full: its stats, notes, checklist, costs, per-day setup sheets, and every session with its laps (lap ids, lap numbers, times) and which laps carry telemetry. Use the lap and session ids with get_session_insights, compare_laps and get_lap_telemetry.",
    inputSchema: {
      type: "object",
      properties: { event_id: id("The event (from list_events).") },
      required: ["event_id"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const e = await apiGet(ctx.env, ctx.user, `/events/${args.event_id}`);
      return {
        ...eventRow(e, true),
        checklist: e.checklist,
        costs_cents: {
          entry: e.cost_entry_cents,
          fuel: e.cost_fuel_cents,
          travel: e.cost_travel_cents,
          misc: e.cost_misc_cents,
          total: e.cost_cents,
        },
        setups: e.setups,
        setup_units: "pressures psi, fuel US gallons, as stored",
        sessions: (e.sessions as DetailSession[]).map((s) => {
          const withChannels = new Set([...lapsByChannelIndex(s.laps, s.channels).values()].map((l) => l.id));
          return {
            session_id: s.id,
            label: s.label,
            notes: s.notes,
            ambient_c: s.ambient_c,
            elevation_m: s.elevation_m,
            telemetry_channels: channelsPresent(s.channels),
            lap_stats: lapStats(s.laps),
            laps: s.laps.map((l) => ({
              lap_id: l.id,
              lap_num: l.lap_num,
              time_ms: l.time_ms,
              time: time(l.time_ms),
              has_telemetry: withChannels.has(l.id),
            })),
          };
        }),
      };
    },
  },
  {
    name: "get_session_insights",
    title: "Session insights",
    description:
      "One session analysed the way the app's channel panel does: lap statistics (best, best-3 average, pace trend, warm-up), and — when the session has telemetry — sector splits and the theoretical best lap, upshift points per gear, ABS/traction/stability interventions and wheelspin/lockup, friction-circle usage (trail braking and power-down shares), corners with peak lateral G, understeer/oversteer per corner, and car health (temperatures, pressures, fuel). Facts only; interpret them for the driver.",
    inputSchema: {
      type: "object",
      properties: { session_id: id("The session (from get_event).") },
      required: ["session_id"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const { event, session } = await eventForSession(ctx, args.session_id);
      return {
        event: { event_id: event.id, track_name: event.track_name, start_date: event.start_date, car: event.car },
        ...sessionInsights(session),
      };
    },
  },
  {
    name: "compare_laps",
    title: "Compare two laps",
    description:
      "Two laps with telemetry head to head — from the same session or from different events at the same track: times, sector splits, speeds, full-throttle and braking shares, and where time was gained or lost, by corner (with minimum speed through each) and by tenth of the lap. Lap A is the reference; deltas are B minus A.",
    inputSchema: {
      type: "object",
      properties: {
        lap_a_id: id("The reference lap (lap_id from get_event or get_track_history)."),
        lap_b_id: id("The lap to compare against it."),
      },
      required: ["lap_a_id", "lap_b_id"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const a = await lapSide(ctx, args.lap_a_id, "A");
      const b = await lapSide(ctx, args.lap_b_id, "B");
      const result = compareLapPair(a, b);
      const where = (s: typeof a) => ({ event_id: s.event.id, track_name: s.event.track_name, start_date: s.event.start_date });
      return {
        ...result,
        a: { ...result.a, ...where(a) },
        b: { ...result.b, ...where(b) },
        ...(a.event.track_id !== b.event.track_id
          ? { track_warning: "These laps are at different tracks; the comparison is not meaningful." }
          : {}),
      };
    },
  },
  {
    name: "get_lap_telemetry",
    title: "Lap telemetry",
    description:
      "One lap's raw traces against driven distance from the start/finish line, thinned to a step (default 40 m). Channels: speed (km/h), throttle and brake (%), steering (degrees), rpm, gear, latG and longG (G; latG is a magnitude, longG negative under braking), yaw (°/s), wheelSlip (%), boost (kPa), flags (bits ABS=1, TC=2, stability=4), and elapsed_s derived from speed. Prefer get_session_insights or compare_laps; use this for questions they don't answer.",
    inputSchema: {
      type: "object",
      properties: {
        lap_id: id("The lap (must have telemetry)."),
        channels: {
          type: "array",
          description: "Channels to return (default speed, throttle, brake, elapsed_s).",
          items: {
            type: "string",
            enum: ["speed", "rpm", "latG", "throttle", "brake", "steering", "longG", "yaw", "gear", "wheelSlip", "boost", "flags", "elapsed_s"],
          },
          maxItems: 13,
        },
        step_m: { type: "number", description: "Distance between returned samples in metres (default 40).", minimum: 5, maximum: 500 },
      },
      required: ["lap_id"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const side = await lapSide(ctx, args.lap_id, "lap");
      const channels = args.channels?.length ? args.channels : ["speed", "throttle", "brake", "elapsed_s"];
      return {
        lap_id: side.lap.id,
        lap_num: side.lap.lap_num,
        time_ms: side.lap.time_ms,
        time: time(side.lap.time_ms),
        ...lapTelemetry(side.entry, side.dStepM, channels, args.step_m ?? 40),
      };
    },
  },
  {
    name: "get_track_history",
    title: "Track history",
    description:
      "Everything at one track over time: each visit's best, lap count, car and conditions (oldest first), plus the fastest individual laps ever logged there with their lap ids and whether each has telemetry — the natural starting point for compare_laps.",
    inputSchema: {
      type: "object",
      properties: { track_id: id("The track (from list_tracks).") },
      required: ["track_id"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const tracks = await apiGet<any[]>(ctx.env, ctx.user, "/tracks");
      const track = tracks.find((t) => t.id === args.track_id);
      if (!track) throw new ToolError(`No track ${args.track_id} in this logbook.`);
      const events = await apiGet<any[]>(ctx.env, ctx.user, `/events?track_id=${args.track_id}`);
      const fastest = await ctx.env.DB.prepare(
        `SELECT l.id AS lap_id, l.lap_num, l.time_ms, l.device_timed, s.id AS session_id, s.label, e.id AS event_id, e.start_date
           FROM laps l JOIN sessions s ON s.id = l.session_id JOIN events e ON e.id = s.event_id
          WHERE e.user_id = ? AND e.track_id = ?
          ORDER BY l.time_ms ASC LIMIT 15`
      )
        .bind(ctx.user.userId, args.track_id)
        .all<any>();
      return {
        track: { track_id: track.id, name: track.name, best_ms: track.best_ms, best: time(track.best_ms), goal_ms: track.goal_ms, notes: track.notes },
        visits: events
          .filter((e) => e.start_date <= ctx.today)
          .reverse()
          .map((e) => eventRow(e)),
        fastest_laps: fastest.results.map((l) => ({
          lap_id: l.lap_id,
          time_ms: l.time_ms,
          time: time(l.time_ms),
          lap_num: l.lap_num,
          session_id: l.session_id,
          session_label: l.label,
          event_id: l.event_id,
          start_date: l.start_date,
          // laps.device_timed (migration 0018) is set exactly when the
          // session's channel blob carries an entry at this lap's time.
          has_telemetry: Boolean(l.device_timed),
        })),
      };
    },
  },
  {
    name: "get_setup_vs_lap_times",
    title: "Setups vs lap times",
    description:
      "Every setup sheet recorded at a track (tyre pressures, alignment, dampers, aero, fuel… per event day) beside that event's best lap, consistency and conditions — for questions like \"which setup was fastest here\". Pressures are psi and fuel US gallons, as stored.",
    inputSchema: {
      type: "object",
      properties: { track_id: id("The track (from list_tracks).") },
      required: ["track_id"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const rows = await apiGet<any[]>(ctx.env, ctx.user, `/tracks/${args.track_id}/setups`);
      return { setups: rows.map((r) => ({ ...r, best: time(r.best_ms) })) };
    },
  },
  {
    name: "get_garage",
    title: "Garage",
    description:
      "The driver's cars and their consumables (pads, tyres — a full set or separate front and rear pairs, each with its size — rotors, fluids…): whether each is on the car now or on the shelf as a spare, accrued on-track hours (counted only while it was on the car), wear measurements, estimated life remaining and a status (ok / low / due), what each car's track days and parts have cost, and the car's own odometer where recorded.",
    inputSchema: {
      type: "object",
      properties: { include_retired: { type: "boolean", description: "Include parts already replaced (default false)." } },
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const garage = await apiGet<any[]>(ctx.env, ctx.user, "/garage");
      return {
        vehicles: garage.map((v) => ({
          vehicle_id: v.id,
          name: v.name,
          notes: v.notes,
          is_default: Boolean(v.is_default),
          on_track_hours: v.hours,
          event_count: v.event_count,
          track_days: v.event_days,
          event_cost_cents: v.event_cost_cents,
          parts_cost_cents: v.parts_cost_cents,
          odometer_km: v.odometer?.km ?? null,
          target_hot_psi: v.target_hot_psi,
          wheelbase_mm: v.wheelbase_mm,
          steering_ratio: v.steering_ratio,
          parts: (v.parts as any[])
            .filter((p) => args.include_retired || !p.retired_on)
            .map((p) => ({
              part_id: p.id,
              kind: partKindLabel(p.kind),
              name: p.name,
              size: p.size ?? null,
              // On the car now; false and not retired means a spare on the shelf.
              equipped: Boolean(p.equipped),
              installed_on: p.installed_on,
              retired_on: p.retired_on,
              cost_cents: p.cost_cents,
              expected_hours: p.expected_hours,
              wear_limit: p.wear_limit,
              notes: p.notes,
              hours: p.wear?.hours ?? null,
              heat_cycles: p.wear?.cycles ?? null,
              remaining_hours: p.wear?.remaining_hours ?? null,
              remaining: fmtRemaining(p.wear),
              status: partStatus(p.wear),
              measurements: (p.measurements as any[]).map((m) => ({ on: m.measured_on, value: m.value, unit: m.unit })),
            })),
        })),
      };
    },
  },
  {
    name: "get_leaderboard",
    title: "Track leaderboard",
    description:
      "The community leaderboard at a track: opted-in drivers' best device-timed laps (GPS recorder or telemetry import — typed-in times never rank), with name, time and date only. `you` marks the driver's own row, present only if they opted in.",
    inputSchema: {
      type: "object",
      properties: { track_id: id("The track (from list_tracks); must have has_leaderboard true.") },
      required: ["track_id"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const board = await apiGet(ctx.env, ctx.user, `/tracks/${args.track_id}/leaderboard`);
      if (board.catalog_id == null)
        return { available: false, note: "This track isn't in the shared track catalog, so it has no leaderboard." };
      return {
        available: true,
        you_opted_in: board.opted_in,
        entries: (board.entries as any[]).map((e, i) => ({
          rank: i + 1,
          name: e.name,
          best_ms: e.best_ms,
          best: time(e.best_ms),
          date: e.date,
          you: e.you,
        })),
      };
    },
  },
  {
    name: "get_season_summary",
    title: "Season summary",
    description:
      "One calendar year in numbers (the app's Season Wrapped): track days, events, laps, hours, track miles, most-driven track, biggest improvement, fastest lap, hottest day, and — for Pro — favourite tyre and top speed.",
    inputSchema: {
      type: "object",
      properties: { year: { type: "integer", description: "The calendar year.", minimum: 1990, maximum: 2100 } },
      required: ["year"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      try {
        return await apiGet(ctx.env, ctx.user, `/wrapped/${args.year}`);
      } catch (err) {
        if (err instanceof ToolError && err.message.startsWith("Not found"))
          throw new ToolError(`No past events in ${args.year}.`);
        throw err;
      }
    },
  },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name) ?? null;

// Runs one tool for one user. Throws ToolError for anything the model should
// be told (a bad id, a lap without telemetry, a malformed argument).
export async function runTool(env: Env, user: ToolUser, name: string, rawArgs: unknown) {
  const tool = toolByName(name);
  if (!tool) throw new ToolError(`unknown tool "${name}"`);
  const args = validateArgs(tool.inputSchema, rawArgs);
  return tool.handler({ env, user, today: todayISO() }, args);
}
