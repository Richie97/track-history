import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Validator } from "@cfworker/json-schema";
import { TOOLS, ToolError, runTool, validateArgs } from "../../src/ai/tools";
import { MAX_RESULT_CHARS } from "../../src/ai/mcp";
import { createEvent, signedInProUser, signedInUser } from "./helpers";
import { telemetrySession } from "./telemetry-fixture";

// The AI tool layer (#315), called directly — the MCP transport around it is
// test/api/mcp.test.ts. These tools read through a private copy of the /api
// router, so what is asserted here is mostly *shape* and *reach*: that each
// tool answers with the figures a model needs, never the raw channel blob,
// and never anything from another user's logbook.

type User = Awaited<ReturnType<typeof signedInProUser>>;

const asTool = (u: User) => ({ userId: u.id, entitledUntil: Number.MAX_SAFE_INTEGER });
const outputValidators = new Map(TOOLS.map((t) => [t.name, new Validator(t.outputSchema, "2020-12", false)]));
const run = async (u: User, name: string, args: unknown = {}): Promise<any> => {
  const result = await runTool(env, asTool(u), name, args);
  // Validate the wire representation, where optional undefined fields are
  // omitted. A handler returning the wrong type or a missing field fails all
  // the existing behavior tests, not just a hand-picked schema example.
  const check = outputValidators.get(name as (typeof TOOLS)[number]["name"])!.validate(JSON.parse(JSON.stringify(result)));
  expect(check.errors, `${name} outputSchema`).toEqual([]);
  return result;
};

async function logbook() {
  const user = await signedInProUser();
  await user.api("POST", "/vehicles", { name: "Corvette C7", is_default: true });
  const eventId = await createEvent(user.api, {
    track_name: "Test Ring",
    start_date: "2026-04-10",
    car: "Corvette C7",
    notes: "Brake fade late in the day.",
  });
  const s1 = await user.api("POST", `/events/${eventId}/sessions`, telemetrySession([106000, 104500, 104000, 104800]));
  expect(s1.status).toBe(201);
  // A second, hand-typed session: laps with no telemetry.
  const s2 = await user.api("POST", `/events/${eventId}/sessions`, { label: "Typed", laps: [110000, 109000] });
  expect(s2.status).toBe(201);
  const laterEvent = await createEvent(user.api, { track_name: "Test Ring", start_date: "2026-05-20", car: "Corvette C7" });
  const s3 = await user.api("POST", `/events/${laterEvent}/sessions`, telemetrySession([103900, 103500], "Morning"));
  expect(s3.status).toBe(201);
  const detail = (await user.api("GET", `/events/${eventId}`)).body;
  const later = (await user.api("GET", `/events/${laterEvent}`)).body;
  return { user, eventId, laterEvent, detail, later };
}

describe("the tool list", () => {
  it("has unique names, a description and a closed object schema for every tool", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      for (const r of t.inputSchema.required ?? []) expect(t.inputSchema.properties).toHaveProperty(r);
    }
  });

  it("imports every allow-listed public/js analysis module inside workerd", async () => {
    // The Worker bundles these (src/ai/insights.ts). A module that touched the
    // DOM at load time would take the whole Worker down; this fails first.
    for (const m of [
      "format", "lap-stats", "channel-graphs", "sectors", "gears", "limits", "grip",
      "corners", "balance", "health", "compare-laps", "garage", "units", "chart",
    ]) {
      const mod = await import(`../../public/js/${m}.js`);
      expect(Object.keys(mod).length, m).toBeGreaterThan(0);
    }
  });
});

describe("argument validation", () => {
  const schema = TOOLS.find((t) => t.name === "list_events")!.inputSchema;

  it("rejects unknown arguments, wrong types and out-of-range numbers with a readable message", () => {
    expect(() => validateArgs(schema, { nope: 1 })).toThrow(/unknown argument "nope"/);
    expect(() => validateArgs(schema, { limit: "many" })).toThrow(/must be a number/);
    expect(() => validateArgs(schema, { limit: 1000 })).toThrow(/at most 200/);
    expect(() => validateArgs(schema, { when: "yesterday" })).toThrow(/one of past, upcoming, all/);
    expect(() => validateArgs(schema, [])).toThrow(ToolError);
  });

  it("accepts numeric strings for numbers, since models send them", () => {
    expect(validateArgs(schema, { limit: "5" })).toEqual({ limit: 5 });
  });

  it("requires required arguments", async () => {
    const user = await signedInProUser();
    await expect(run(user, "get_event", {})).rejects.toThrow(/"event_id" is required/);
  });
});

describe("tools", () => {
  it("get_profile names the unit system and totals", async () => {
    const { user } = await logbook();
    await user.api("PUT", "/me/units", { units: "metric" });
    const p = await run(user, "get_profile");
    expect(p.units).toBe("metric");
    expect(p.totals).toEqual({ events: 2, track_days: 2 });
    expect(p).not.toHaveProperty("email");
  });

  it("list_tracks and list_events answer with formatted bests and filter", async () => {
    const { user } = await logbook();
    await createEvent(user.api, { track_name: "Other Park", start_date: "2099-01-01" });
    const tracks = await run(user, "list_tracks");
    const ring = tracks.tracks.find((t: any) => t.name === "Test Ring");
    expect(ring.best_ms).toBe(103500);
    expect(ring.best).toBe("1:43.5"); // fmtMs, the app's own format

    const past = await run(user, "list_events");
    expect(past.events.map((e: any) => e.track_name)).toEqual(["Test Ring", "Test Ring"]);
    expect(past.events[0]).not.toHaveProperty("notes");
    const upcoming = await run(user, "list_events", { when: "upcoming" });
    expect(upcoming.events.map((e: any) => e.track_name)).toEqual(["Other Park"]);
    const y = await run(user, "list_events", { year: 2026, limit: 1, include_notes: true });
    expect(y.total).toBe(2);
    expect(y.truncated).toBe(true);
    expect(y.events[0]).toHaveProperty("notes");
  });

  it("get_event carries sessions, lap ids and which laps have telemetry — never the channel blob", async () => {
    const { user, eventId } = await logbook();
    const e = await run(user, "get_event", { event_id: eventId });
    expect(e.notes).toBe("Brake fade late in the day.");
    expect(e.sessions).toHaveLength(2);
    const [tele, typed] = e.sessions;
    expect(tele.telemetry_channels).toContain("speed");
    expect(tele.laps.every((l: any) => l.has_telemetry)).toBe(true);
    expect(typed.laps.every((l: any) => !l.has_telemetry)).toBe(true);
    expect(tele.lap_stats.best_ms).toBe(104000);
    expect(JSON.stringify(e)).not.toContain('"channels"');
    expect(JSON.stringify(e)).not.toContain('"trace"');
  });

  it("get_session_insights reduces a telemetry session to every analysis", async () => {
    const { user, detail } = await logbook();
    const r = await run(user, "get_session_insights", { session_id: detail.sessions[0].id });
    expect(r.event.track_name).toBe("Test Ring");
    expect(r.lap_stats.lap_count).toBe(4);
    const t = r.telemetry;
    expect(t.grid_step_m).toBe(20);
    expect(t.sectors.sector_count).toBe(3);
    expect(t.sectors.theoretical_best_ms).toBeLessThanOrEqual(t.sectors.best_lap_ms);
    expect(t.sectors.laps[0].sectors_ms.reduce((a: number, b: number) => a + b, 0)).toBe(106000);
    expect(t.shifts.upshift_rpm_by_gear.length).toBeGreaterThan(0);
    expect(t.limits.summary).toMatch(/ABS in 1 place/);
    expect(t.limits.summary).toMatch(/wheelspin/);
    expect(t.grip.peak_combined_g).toBeGreaterThan(1);
    expect(t.corners.map((c: any) => c.corner)).toEqual(["T1", "T2", "T3"]);
    expect(t.balance.corners.find((c: any) => c.corner === "T2").reading).toMatch(/understeer/);
    expect(t.balance.corners.find((c: any) => c.corner === "T3").reading).toMatch(/oversteer/);
    expect(t.health.columns.find((c: any) => c.key === "oilC").session_value).toBe(114);
    expect(t.health.fuel.lapsRemaining).toBeGreaterThan(0);
  });

  it("get_session_insights on a typed session answers lap stats and no telemetry", async () => {
    const { user, detail } = await logbook();
    const r = await run(user, "get_session_insights", { session_id: detail.sessions[1].id });
    expect(r.telemetry).toBeNull();
    expect(r.lap_stats.best).toBe("1:49.0");
  });

  it("compare_laps says where the time went, B minus A, across events", async () => {
    const { user, detail, later } = await logbook();
    const slow = detail.sessions[0].laps[0].id; // lap 1: slower through every corner
    const best = later.sessions[0].laps[1].id;
    const r = await run(user, "compare_laps", { lap_a_id: best, lap_b_id: slow });
    expect(r.a.time_ms).toBe(103500);
    expect(r.b.time_ms).toBe(106000);
    expect(r.b_minus_a_ms).toBe(2500);
    expect(r.by_corner).toHaveLength(3);
    for (const c of r.by_corner) expect(c.b_min_speed_kph).toBeLessThan(c.a_min_speed_kph);
    expect(r.by_tenth_of_lap).toHaveLength(10);
    expect(r.a.sectors_ms).toHaveLength(3);
    expect(r.track_warning).toBeUndefined();
    expect(r.a.start_date).toBe("2026-05-20");
  });

  it("compare_laps refuses a lap without telemetry, and says so", async () => {
    const { user, detail } = await logbook();
    await expect(
      run(user, "compare_laps", { lap_a_id: detail.sessions[0].laps[0].id, lap_b_id: detail.sessions[1].laps[0].id })
    ).rejects.toThrow(/has no telemetry/);
  });

  it("get_lap_telemetry thins to the step, derives elapsed time and bounds the response", async () => {
    const { user, detail } = await logbook();
    const lapId = detail.sessions[0].laps[2].id;
    const r = await run(user, "get_lap_telemetry", { lap_id: lapId, step_m: 100 });
    expect(r.step_m).toBe(100);
    expect(Object.keys(r.channels)).toEqual(["speed", "throttle", "brake", "elapsed_s"]);
    expect(r.distance_m[1]).toBe(100);
    expect(r.channels.elapsed_s.at(-1)).toBeCloseTo(104, 0);
    const all = await run(user, "get_lap_telemetry", {
      lap_id: lapId,
      step_m: 5,
      channels: ["speed", "rpm", "latG", "throttle", "brake", "steering", "longG", "yaw", "gear", "wheelSlip", "flags", "elapsed_s"],
    });
    expect(all.step_m).toBe(20);
    expect(all.missing).toEqual([]);
    await expect(run(user, "get_lap_telemetry", { lap_id: lapId, channels: ["oilC"] })).rejects.toThrow(/allowed/);
  });

  it("get_track_history lists visits oldest first and the fastest laps with telemetry flags", async () => {
    const { user, detail } = await logbook();
    const trackId = detail.track_id;
    const r = await run(user, "get_track_history", { track_id: trackId });
    expect(r.visits.map((v: any) => v.start_date)).toEqual(["2026-04-10", "2026-05-20"]);
    expect(r.fastest_laps[0].time_ms).toBe(103500);
    expect(r.fastest_laps[0].has_telemetry).toBe(true);
    const typed = r.fastest_laps.find((l: any) => l.time_ms === 109000);
    expect(typed.has_telemetry).toBe(false);
  });

  it("get_garage, get_setup_vs_lap_times, get_leaderboard and get_season_summary read through the API", async () => {
    const { user, eventId, detail } = await logbook();
    const garage = await run(user, "get_garage");
    expect(garage.vehicles[0].name).toBe("Corvette C7");

    expect((await user.api("PUT", `/events/${eventId}/setups/1`, { tp_cold: { fl: 30 } })).status).toBeLessThan(300);
    const setups = await run(user, "get_setup_vs_lap_times", { track_id: detail.track_id });
    expect(setups.setups).toHaveLength(1);
    expect(setups.setups[0]).toMatchObject({ event_id: eventId, data: { tp_cold: { fl: 30 } }, best: "1:44.0" });

    const board = await run(user, "get_leaderboard", { track_id: detail.track_id });
    expect(board.available).toBe(false); // "Test Ring" isn't in the catalog

    const season = await run(user, "get_season_summary", { year: 2026 });
    expect(season.year).toBe(2026);
    await expect(run(user, "get_season_summary", { year: 2001 })).rejects.toThrow(/No past events in 2001/);
  });

  it("get_leaderboard never carries a lap id", async () => {
    const user = await signedInProUser();
    await user.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
    const eventId = await createEvent(user.api, { track_name: "Virginia International Raceway (Full)", start_date: "2026-04-10" });
    await user.api("POST", `/events/${eventId}/sessions`, telemetrySession([120000]));
    const tracks = await run(user, "list_tracks");
    const vir = tracks.tracks.find((t: any) => t.has_leaderboard);
    const board = await run(user, "get_leaderboard", { track_id: vir.track_id });
    expect(board.available).toBe(true);
    expect(board.entries[0]).toMatchObject({ rank: 1, best_ms: 120000, you: true });
    expect(board.entries[0]).not.toHaveProperty("lap_id");
  });

  it("keeps every result well under the size bound for a long telemetry session", async () => {
    const user = await signedInProUser();
    const eventId = await createEvent(user.api, { track_name: "Long Day", start_date: "2026-04-10" });
    const times = Array.from({ length: 30 }, (_, i) => 104000 + i * 97);
    const s = await user.api("POST", `/events/${eventId}/sessions`, telemetrySession(times));
    expect(s.status).toBe(201);
    const detail = (await user.api("GET", `/events/${eventId}`)).body;
    const lapIds = detail.sessions[0].laps.map((l: any) => l.id);
    const results = [
      await run(user, "get_event", { event_id: eventId }),
      await run(user, "get_session_insights", { session_id: detail.sessions[0].id }),
      await run(user, "compare_laps", { lap_a_id: lapIds[0], lap_b_id: lapIds[29] }),
      await run(user, "get_lap_telemetry", {
        lap_id: lapIds[0],
        step_m: 20,
        channels: ["speed", "rpm", "latG", "throttle", "brake", "steering", "longG", "yaw", "gear", "wheelSlip", "flags", "elapsed_s"],
      }),
    ];
    for (const r of results) expect(JSON.stringify(r).length).toBeLessThan(MAX_RESULT_CHARS / 2);
  });
});

describe("ownership", () => {
  it("never reaches another user's logbook through any id-taking tool", async () => {
    const { detail, eventId } = await logbook();
    const stranger = await signedInProUser();
    const sessionId = detail.sessions[0].id;
    const lapId = detail.sessions[0].laps[0].id;
    const calls: [string, Record<string, number>][] = [
      ["get_event", { event_id: eventId }],
      ["get_session_insights", { session_id: sessionId }],
      ["compare_laps", { lap_a_id: lapId, lap_b_id: lapId }],
      ["get_lap_telemetry", { lap_id: lapId }],
      ["get_track_history", { track_id: detail.track_id }],
      ["get_setup_vs_lap_times", { track_id: detail.track_id }],
      ["get_leaderboard", { track_id: detail.track_id }],
    ];
    for (const [name, args] of calls) {
      const outcome = await run(stranger, name, args).then(
        (r) => r,
        (e) => e
      );
      if (name === "get_setup_vs_lap_times") {
        // Scoped by user in SQL: an unowned track id is simply an empty table.
        expect(outcome.setups, name).toEqual([]);
      } else {
        expect(outcome, name).toBeInstanceOf(ToolError);
      }
    }
    expect((await run(stranger, "list_events")).events).toEqual([]);
  });

  it("answers a free account's garage as Pro-only, the API's own 402", async () => {
    const free = await signedInUser();
    await expect(runTool(env, { userId: free.id, entitledUntil: null }, "get_garage", {})).rejects.toThrow(/Pro/);
  });
});

describe("output schema variants", () => {
  it("accepts empty collections, an untimed event and a session with no laps", async () => {
    const user = await signedInProUser();
    expect((await run(user, "list_tracks")).tracks).toEqual([]);
    expect((await run(user, "list_events")).events).toEqual([]);
    expect((await run(user, "get_garage")).vehicles).toEqual([]);
    const eventId = await createEvent(user.api, { track_name: "Empty Ring", start_date: "2026-04-10" });
    const saved = await user.api("POST", `/events/${eventId}/sessions`, {});
    expect(saved.status).toBe(201);
    const detail = await run(user, "get_event", { event_id: eventId });
    expect(detail.best_ms).toBeNull();
    expect(detail.sessions[0].lap_stats).toBeNull();
    const insight = await run(user, "get_session_insights", { session_id: saved.body.id });
    expect(insight.telemetry).toBeNull();
    expect(insight.lap_stats).toBeNull();
    const season = await run(user, "get_season_summary", { year: 2026 });
    expect(season.fastest).toBeNull();
    expect(season.pro).toEqual({ tire: null, top_speed: null });
  });

  it("accepts partial telemetry, missing channels and comparison warnings", async () => {
    const { user, detail } = await logbook();
    const eventId = await createEvent(user.api, { track_name: "Different Ring", start_date: "2026-06-01" });
    const saved = await user.api("POST", `/events/${eventId}/sessions`, {
      laps: [120000],
      channels: { v: 1, dStepM: 20, laps: [{
        n: 1, timeMs: 120000,
        speed: Array(800).fill(100), throttle: Array(800).fill(50), brake: Array(800).fill(0),
      }] },
    });
    expect(saved.status).toBe(201);
    const event = await run(user, "get_event", { event_id: eventId });
    const lapId = event.sessions[0].laps[0].lap_id;
    const insight = await run(user, "get_session_insights", { session_id: saved.body.id });
    expect(insight.telemetry).toMatchObject({ shifts: null, grip: null, corners: null, balance: null, health: null });
    const missing = await run(user, "get_lap_telemetry", { lap_id: lapId, channels: ["boost"] });
    expect(missing.missing).toEqual(["boost"]);
    expect(missing.channels).toEqual({});
    const compared = await run(user, "compare_laps", { lap_a_id: detail.sessions[0].laps[0].id, lap_b_id: lapId });
    expect(compared.warning).toMatch(/distances differ/);
    expect(compared.track_warning).toMatch(/different tracks/);
  });

  it("accepts populated setup, checklist, garage measurements and Pro season cards", async () => {
    const { user, eventId } = await logbook();
    const [vehicle] = (await run(user, "get_garage")).vehicles;
    const tire = await user.api("POST", `/vehicles/${vehicle.vehicle_id}/parts`, {
      kind: "tires", name: "Test tires", installed_on: "2026-01-01", expected_hours: 20,
      cost_cents: 100000, wear_limit: 2, size: "275/35R18",
    });
    expect(tire.status).toBe(201);
    expect((await user.api("POST", `/parts/${tire.body.id}/measurements`, {
      measured_on: "2026-04-10", value: 7, unit: "mm",
    })).status).toBe(201);
    const retired = await user.api("POST", `/vehicles/${vehicle.vehicle_id}/parts`, {
      kind: "pads_front", name: "Old pads", installed_on: "2026-01-01", retired_on: "2026-02-01",
    });
    expect(retired.status).toBe(201);
    expect((await user.api("PUT", `/events/${eventId}`, {
      checklist: [{ text: "Check wheel torque", done: true }], cost_entry_cents: 25000,
    })).status).toBe(200);
    expect((await user.api("PUT", `/events/${eventId}/setups/1`, {
      tp_hot: { fl: 35 }, camber: { f: -3 }, fuel: 10, tires_id: tire.body.id, notes: "Baseline",
    })).status).toBe(200);
    const event = await run(user, "get_event", { event_id: eventId });
    expect(event.checklist).toHaveLength(1);
    expect(event.costs_cents.total).toBe(25000);
    expect(event.setups[0].data.tires_id).toBe(tire.body.id);
    const garage = await run(user, "get_garage", { include_retired: true });
    expect(garage.vehicles[0].parts).toHaveLength(2);
    expect(garage.vehicles[0].parts.find((p: any) => p.part_id === tire.body.id).measurements).toHaveLength(1);
    const season = await run(user, "get_season_summary", { year: 2026 });
    expect(season.pro.tire.part_id).toBe(tire.body.id);
    expect(season.pro.top_speed.kph).toBeGreaterThan(0);
  });

  it("describes widened raw telemetry when the sample budget is exceeded", async () => {
    const user = await signedInProUser();
    const eventId = await createEvent(user.api);
    const body = telemetrySession([120000]);
    // The storage limit is 800 points per channel. Many channels at that
    // length exceed the tool's smaller 6000-value response budget.
    for (const [key, values] of Object.entries(body.channels.laps[0])) {
      if (Array.isArray(values)) Object.assign(body.channels.laps[0], {
        [key]: Array.from({ length: 800 }, (_, i) => values[i % values.length]),
      });
    }
    expect((await user.api("POST", `/events/${eventId}/sessions`, body)).status).toBe(201);
    const event = await run(user, "get_event", { event_id: eventId });
    const raw = await run(user, "get_lap_telemetry", {
      lap_id: event.sessions[0].laps[0].lap_id, step_m: 5,
      channels: ["speed", "rpm", "latG", "throttle", "brake", "steering", "longG", "yaw", "gear", "wheelSlip", "flags", "elapsed_s"],
    });
    expect(raw.step_note).toMatch(/Widened/);
    expect(raw.step_m).toBeGreaterThan(20);
  });
});
