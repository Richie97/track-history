import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_EXPORT_KEYS } from "../../src/lib/export";
import { createEvent, mcpTokenFor, signedInProUser, signedInUser } from "./helpers";
import { circleTrace, telemetrySession } from "./telemetry-fixture";

// Export your logbook (NS-44): the three files, what the JSON holds and what it
// never holds, telemetry on request, completeness for a free account, and who
// can't reach it.

async function get(token: string, path: string) {
  return SELF.fetch(`https://example.com/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

// Every key anywhere in a parsed document, at any depth.
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

// A logbook that touches every table the export reads: two events (one
// upcoming), a telemetry session with a trace and a hand-typed one, a setup
// sheet, a car with a part, its mount and a measurement, a coach, a student,
// a connected assistant and a subscription.
async function populated() {
  const user = await signedInProUser();
  const past = await createEvent(user.api, {
    track_name: "VIR (Full)",
    start_date: "2026-05-01",
    days: 2,
    car: "Z06",
    notes: "=HYPERLINK(\"https://example.com\")",
    cost_entry_cents: 45_000,
  });
  await createEvent(user.api, { track_name: "VIR (Full)", start_date: "2099-05-01" });
  const tele = await user.api("POST", `/events/${past}/sessions`, {
    ...telemetrySession([106_000, 104_500, 104_000, 104_800]),
    trace: circleTrace(),
  });
  expect(tele.status).toBe(201);
  const typed = await user.api("POST", `/events/${past}/sessions`, { label: "Typed, by hand", laps: [110_000, 109_000] });
  expect(typed.status).toBe(201);
  expect((await user.api("PUT", `/events/${past}/setups/1`, { tp_cold: { fl: 26 }, notes: "baseline" })).status).toBe(200);

  const vehicle = await user.api("POST", "/vehicles", { name: "Z06", target_hot_psi: 34 });
  expect(vehicle.status).toBe(201);
  const part = await user.api("POST", `/vehicles/${vehicle.body.id}/parts`, {
    kind: "pads_front",
    name: "PFC 08",
    installed_on: "2026-04-01",
    cost_cents: 38_900,
  });
  expect(part.status).toBe(201);
  expect(
    (await user.api("POST", `/parts/${part.body.id}/measurements`, { measured_on: "2026-05-02", value: 12, unit: "mm" })).status
  ).toBe(201);

  const coach = await signedInUser();
  const student = await signedInUser();
  await env.DB.prepare("INSERT INTO coach_grants (student_id, coach_id, created_at) VALUES (?, ?, ?), (?, ?, ?)")
    .bind(user.id, coach.id, Date.now(), student.id, user.id, Date.now())
    .run();
  await mcpTokenFor(user.id);
  return { user, coach, past };
}

describe("export", () => {
  it("serves all three files as no-store attachments named by date", async () => {
    const { user } = await populated();
    const date = new Date().toISOString().slice(0, 10);
    for (const [path, type, name] of [
      ["/export/laps.csv", "text/csv", `track-evolution-laps-${date}.csv`],
      ["/export/events.csv", "text/csv", `track-evolution-events-${date}.csv`],
      ["/export/logbook.json", "application/json", `track-evolution-${date}.json`],
    ]) {
      const res = await get(user.token, path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type")).toContain(type);
      expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${name}"`);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      await res.arrayBuffer();
    }
  });

  it("writes a lap per row and an event per row, with a formula-looking note kept as text", async () => {
    const { user, past } = await populated();
    const laps = (await (await get(user.token, "/export/laps.csv")).text()).trim().split("\r\n");
    expect(laps[0]).toBe(
      "event_id,event_date,track,organizer,run_group,car,session_id,session,lap,lap_time_ms,lap_time,session_best,clean,device_timed"
    );
    expect(laps).toHaveLength(1 + 6);
    // The quoted label survives the comma inside it.
    expect(laps.some((l) => l.includes('"Typed, by hand"'))).toBe(true);
    // The telemetry laps are device-timed; the typed ones aren't.
    expect(laps[1].endsWith(",1")).toBe(true);
    expect(laps.at(-1)!.endsWith(",0")).toBe(true);

    const events = (await (await get(user.token, "/export/events.csv")).text()).trim().split("\r\n");
    expect(events).toHaveLength(1 + 2);
    // Newest first: the upcoming event leads, with its computed columns empty.
    expect(events[1]).toContain("2099-05-01");
    const pastRow = events.find((l) => l.startsWith(`${past},`))!;
    expect(pastRow).toContain(`"'=HYPERLINK(""https://example.com"")"`);
    expect(pastRow).toContain(",450,");
  });

  it("holds every section of the logbook, and nothing from the never list", async () => {
    const { user } = await populated();
    const doc = (await (await get(user.token, "/export/logbook.json?telemetry=1")).json()) as any;
    expect(doc.format).toBe("track-evolution-export");
    expect(doc.version).toBe(1);
    expect(doc.telemetry_included).toBe(true);
    expect(doc.units.lap_times).toMatch(/milliseconds/);
    expect(doc.error).toBeUndefined();

    expect(doc.profile.email).toBe(user.email);
    expect(doc.tracks.map((t: any) => t.name)).toEqual(["VIR (Full)"]);
    expect(doc.events).toHaveLength(2);
    const [past] = doc.events;
    expect(past.cost_entry_cents).toBe(45_000);
    expect(past.cost_cents).toBe(45_000);
    expect(past.best_ms).toBe(104_000);
    expect(typeof past.consistency).toBe("number");
    expect(past.created_at).toEqual(expect.any(Number));
    expect(past.sessions).toHaveLength(2);
    expect(past.sessions[0].laps).toHaveLength(4);
    expect(past.sessions[0].laps[0].device_timed).toBe(true);
    expect(past.sessions[0].trace).toHaveLength(300);
    expect(past.sessions[0].channels.laps).toHaveLength(4);
    expect(past.sessions[1].channels).toBeNull();
    expect(past.setups).toEqual([{ day: 1, data: { tp_cold: { fl: 26 }, notes: "baseline" }, updated_at: expect.any(Number) }]);

    const [car] = doc.garage.vehicles;
    expect(car.target_hot_psi).toBe(34);
    expect(car.parts[0].name).toBe("PFC 08");
    expect(car.parts[0].mounts[0].mounted_on).toBe("2026-04-01");
    expect(car.parts[0].measurements).toEqual([{ measured_on: "2026-05-02", value: 12, unit: "mm" }]);

    expect(doc.access.coaches).toEqual([{ name: "Test User", since: expect.any(Number), last_viewed_at: null }]);
    expect(doc.access.students).toHaveLength(1);
    expect(doc.access.assistants).toEqual([
      { client_name: "Test Assistant", connected_at: expect.any(Number), last_used_at: null },
    ]);
    expect(doc.access.subscriptions).toEqual([
      { provider: "legacy", product_id: "apple-paid-app", status: "legacy", expires_at: null },
    ]);

    const keys = allKeys(doc);
    for (const forbidden of FORBIDDEN_EXPORT_KEYS) expect(keys.has(forbidden), forbidden).toBe(false);
    expect(keys.has("user_id")).toBe(false);
  });

  it("leaves telemetry out unless asked for it", async () => {
    const { user } = await populated();
    const doc = (await (await get(user.token, "/export/logbook.json")).json()) as any;
    expect(doc.telemetry_included).toBe(false);
    expect(doc.events[0].sessions.every((s: any) => s.channels === null)).toBe(true);
    // The trace is the racing line, not telemetry: it stays.
    expect(doc.events[0].sessions[0].trace).toHaveLength(300);
  });

  it("is complete for a free account, channels included", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api);
    expect((await user.api("POST", `/events/${eventId}/sessions`, telemetrySession([105_000, 104_000]))).status).toBe(201);
    // The app strips the Pro channels on read…
    const detail = await user.api("GET", `/events/${eventId}`);
    expect(detail.body.sessions[0].channels.laps[0].rpm).toBeUndefined();
    // …the export never does.
    const doc = (await (await get(user.token, "/export/logbook.json?telemetry=1")).json()) as any;
    expect(doc.events[0].sessions[0].channels.laps[0].rpm).toEqual(expect.any(Array));
  });

  it("never carries another user's data", async () => {
    const { user } = await populated();
    const other = await signedInUser();
    const otherEvent = await createEvent(other.api, { track_name: "Somebody Else's Track" });
    await other.api("POST", `/events/${otherEvent}/sessions`, telemetrySession([99_000, 98_000]));
    const json = await (await get(user.token, "/export/logbook.json?telemetry=1")).text();
    expect(json).not.toContain("Somebody Else");
    expect(await (await get(user.token, "/export/laps.csv")).text()).not.toContain("Somebody Else");
    expect(await (await get(user.token, "/export/events.csv")).text()).not.toContain("Somebody Else");
  });

  it("streams a logbook of 200 telemetry sessions", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api);
    const first = await user.api("POST", `/events/${eventId}/sessions`, telemetrySession([105_000, 104_000, 104_500]));
    expect(first.status).toBe(201);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
       INSERT INTO sessions (event_id, label, sort, channels)
       SELECT s.event_id, 'Copy ' || n.i, n.i, s.channels FROM sessions s, n WHERE s.id = ?`
    )
      .bind(first.body.id)
      .run();
    const doc = (await (await get(user.token, "/export/logbook.json?telemetry=1")).json()) as any;
    const sessions = doc.events[0].sessions;
    expect(sessions).toHaveLength(200);
    expect(sessions.every((s: any) => s.channels?.laps?.length === 3)).toBe(true);
  });

  it("is unreachable through the coach mount and when signed out", async () => {
    const { user, coach } = await populated();
    for (const path of ["/export/laps.csv", "/export/events.csv", "/export/logbook.json"]) {
      expect((await get(coach.token, `/students/${user.id}${path}`)).status, path).toBe(404);
      expect((await SELF.fetch(`https://example.com/api${path}`)).status, path).toBe(401);
    }
  });

  it("limits a user to a few exports a minute", async () => {
    const user = await signedInUser();
    // The binding counts in fixed windows, so a run straddling one restarts the
    // count; call until the first refusal, which must come after the limit and
    // within two windows' worth (the pattern ratelimit.test.ts uses).
    let allowed = 0;
    for (; allowed <= 10; allowed++) {
      const res = await get(user.token, "/export/events.csv");
      if (res.status === 429) {
        expect(allowed).toBeGreaterThanOrEqual(5);
        expect(res.headers.get("Retry-After")).toBe("60");
        expect(((await res.json()) as any).error).toMatch(/try again in a minute/);
        return;
      }
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    throw new Error("never limited");
  });
});
