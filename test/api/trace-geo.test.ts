import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { KX, KY } from "../../src/lib/geo";
import { createEvent, signedInProUser, signedInUser } from "./helpers";
import { circleTrace, telemetrySession } from "./telemetry-fixture";

// NS-53: where a session's best-lap trace lies on Earth.
//
// `trace_geo` is stored beside the trace, lent to older sessions at the same
// track, shown to the owner, a coach and on a leaderboard lap — and kept off
// every link a stranger can open.

type User = Awaited<ReturnType<typeof signedInUser>>;
const VIR = { lat: 36.5607, lon: -79.2064 };
const anon = async (path: string) => {
  const res = await SELF.fetch(`https://example.com${path}`);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

async function session(user: User, eventId: number, extra: Record<string, unknown> = {}) {
  const res = await user.api("POST", `/events/${eventId}/sessions`, {
    laps: [101_000, 100_200],
    trace: circleTrace(),
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}
const detail = async (user: User, eventId: number) => (await user.api("GET", `/events/${eventId}`)).body;

describe("saving a session's anchor", () => {
  it("stores it and returns it on the event detail", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api);
    await session(user, eventId, { trace_geo: { lat: 36.56071234567, lon: -79.2064, approx: true, junk: 1 } });
    const [s] = (await detail(user, eventId)).sessions;
    expect(s.trace_geo).toEqual({ lat: 36.5607123, lon: -79.2064 });
  });

  it.each([
    ["nothing", undefined],
    ["null island", { lat: 0, lon: 0 }],
    ["a latitude off the map", { lat: 120, lon: 5 }],
    ["text", "36.5,-79.2"],
    ["an array", [36.5, -79.2]],
  ])("saves the session with a 201 and no anchor when sent %s", async (_, trace_geo) => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api);
    const res = await user.api("POST", `/events/${eventId}/sessions`, { laps: [99_000], trace: circleTrace(), trace_geo });
    expect(res.status).toBe(201);
    const [s] = (await detail(user, eventId)).sessions;
    expect(s.trace).toHaveLength(300);
    expect(s.trace_geo).toBeNull();
  });

  it("keeps no anchor for a session without a trace", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api);
    const res = await user.api("POST", `/events/${eventId}/sessions`, { laps: [99_000], trace_geo: VIR });
    expect(res.status).toBe(201);
    expect((await detail(user, eventId)).sessions[0].trace_geo).toBeNull();
    const row = await env.DB.prepare("SELECT trace_geo FROM sessions WHERE id = ?").bind(res.body.id).first<{ trace_geo: string | null }>();
    expect(row!.trace_geo).toBeNull();
  });

  it("is free: a free account's session carries it", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api);
    await session(user, eventId, { trace_geo: VIR });
    expect((await detail(user, eventId)).sessions[0].trace_geo).toEqual(VIR);
  });
});

describe("an older session borrows its place", () => {
  it("from the newest anchored session at the same track, marked approx", async () => {
    const user = await signedInUser();
    const old = await createEvent(user.api, { track_name: "Borrow Raceway", start_date: "2025-05-01" });
    const fresh = await createEvent(user.api, { track_name: "Borrow Raceway", start_date: "2026-05-01" });
    // The same lap, projected from an origin 500 m west and 120 m north.
    const moved = circleTrace().map(([x, y, v]) => [x + 500, y - 120, v]);
    await session(user, old, { trace: moved });
    await session(user, fresh, { trace_geo: VIR });

    const [s] = (await detail(user, old)).sessions;
    expect(s.trace_geo.approx).toBe(true);
    // Its origin is where the donor's would be, shifted back by the offset.
    expect((s.trace_geo.lat - VIR.lat) * KY).toBeCloseTo(120, 0);
    expect((s.trace_geo.lon - VIR.lon) * KX(VIR.lat)).toBeCloseTo(-500, 0);
    // The donor itself is not an estimate.
    expect((await detail(user, fresh)).sessions[0].trace_geo).toEqual(VIR);
  });

  it("within the same event too, and only for sessions that have a trace", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api);
    await session(user, eventId);
    await user.api("POST", `/events/${eventId}/sessions`, { laps: [98_000] });
    await session(user, eventId, { trace_geo: VIR });
    const sessions = (await detail(user, eventId)).sessions;
    expect(sessions[0].trace_geo).toMatchObject({ approx: true });
    expect(sessions[1].trace_geo).toBeNull();
    expect(sessions[2].trace_geo).toEqual(VIR);
  });

  it("not from another track, a different outline, or another account", async () => {
    const user = await signedInUser();
    const other = await signedInUser();
    const here = await createEvent(user.api, { track_name: "Lonely Raceway" });
    await session(user, here);
    // Another track of the user's own.
    await session(user, await createEvent(user.api, { track_name: "Elsewhere Raceway" }), { trace_geo: VIR });
    // Someone else's anchored session at a track of the same name.
    await session(other, await createEvent(other.api, { track_name: "Lonely Raceway" }), { trace_geo: VIR });
    expect((await detail(user, here)).sessions[0].trace_geo).toBeNull();

    // An anchored session here, but of a much shorter lap: not this layout.
    await session(user, await createEvent(user.api, { track_name: "Lonely Raceway", start_date: "2026-09-01" }), {
      trace: circleTrace(1500),
      trace_geo: VIR,
    });
    expect((await detail(user, here)).sessions[0].trace_geo).toBeNull();
  });
});

describe("who is told where the trace lies", () => {
  async function coached() {
    const student = await signedInProUser();
    const coach = await signedInUser();
    const inv = await student.api("POST", "/coaching/invites");
    const token = (inv.body.url as string).split("/").pop()!;
    expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
    return { student, coach };
  }

  it("a coach is", async () => {
    const { student, coach } = await coached();
    const eventId = await createEvent(student.api);
    await session(student, eventId, { trace_geo: VIR });
    const res = await coach.api("GET", `/students/${student.id}/events/${eventId}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions[0].trace_geo).toEqual(VIR);
  });

  it("a shared event or session link is not — the line, never its coordinates", async () => {
    const user = await signedInProUser();
    const eventId = await createEvent(user.api);
    const sessionId = await session(user, eventId, { ...telemetrySession([104_000, 102_000]), trace: circleTrace(), trace_geo: VIR });
    const e = await user.api("POST", `/events/${eventId}/share`);
    const s = await user.api("POST", `/sessions/${sessionId}/share`);
    for (const path of [`/api/share/e/${e.body.token}`, `/api/share/s/${s.body.token}`]) {
      const res = await anon(path);
      expect(res.status).toBe(200);
      expect(res.body.event.sessions[0].trace.length).toBeGreaterThan(10);
      expect(res.body.event.sessions[0].trace_geo).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("36.5607");
    }
  });

  it("the public logbook share is not", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api, { start_date: "2026-03-01" });
    await session(user, eventId, { trace_geo: VIR });
    expect((await user.api("PUT", "/share", { slug: "geo-share-test" })).status).toBe(200);
    const res = await anon("/api/share/geo-share-test");
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("trace_geo");
    expect(text).not.toContain("36.5607");
  });

  it("the logbook export carries the stored anchor, and never a borrowed one", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api, { start_date: "2026-03-01" });
    await session(user, eventId);
    await session(user, eventId, { trace_geo: VIR });
    const res = await user.api("GET", "/export/logbook.json");
    expect(res.status).toBe(200);
    const sessions = res.body.events[0].sessions;
    expect(sessions[0].trace_geo).toBeNull();
    expect(sessions[1].trace_geo).toEqual(VIR);
  });
});

describe("a leaderboard lap's anchor", () => {
  // A catalog track per test: the leaderboard spans accounts, and the D1 is
  // the file's, so each test ranks its drivers somewhere of its own.
  const channels = (timeMs: number) => ({
    v: 1,
    dStepM: 20,
    laps: [{ n: 1, timeMs, speed: Array.from({ length: 12 }, (_, i) => 100 + i) }],
  });
  async function ranked(TRACK: string, owner: User, timeMs: number, date: string, extra: Record<string, unknown>) {
    await owner.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
    const eventId = await createEvent(owner.api, { track_name: TRACK, start_date: date });
    const res = await owner.api("POST", `/events/${eventId}/sessions`, { laps: [timeMs], channels: channels(timeMs), trace: circleTrace(), ...extra });
    expect(res.status).toBe(201);
  }
  async function open(TRACK: string, viewer: User) {
    await viewer.api("PUT", "/me/leaderboard", { opt_in: true });
    const eventId = await createEvent(viewer.api, { track_name: TRACK, start_date: "2026-04-11" });
    await viewer.api("POST", `/events/${eventId}/sessions`, { laps: [130_000], channels: channels(130_000), trace: circleTrace(), trace_geo: { lat: 1.5, lon: 2.5 } });
    const trackId = (await viewer.api("GET", "/tracks")).body[0].id;
    const board = await viewer.api("GET", `/tracks/${trackId}/leaderboard`);
    const row = board.body.entries.find((r: { you: boolean; lap_id: number | null }) => !r.you && r.lap_id != null);
    return viewer.api("GET", `/tracks/${trackId}/leaderboard/laps/${row.lap_id}`);
  }

  it("is the lap's own when it has one", async () => {
    const owner = await signedInUser();
    await ranked("Barber Motorsports Park", owner, 121_000, "2026-04-10", { trace_geo: VIR });
    const res = await open("Barber Motorsports Park", await signedInUser());
    expect(res.status).toBe(200);
    expect(res.body.trace_geo).toEqual(VIR);
  });

  it("is borrowed from its owner's sessions — never the viewer's — when it has none", async () => {
    const owner = await signedInUser();
    await ranked("Blackhawk Farms Raceway", owner, 121_000, "2026-04-10", {});
    await ranked("Blackhawk Farms Raceway", owner, 125_000, "2026-05-10", { trace_geo: VIR });
    const res = await open("Blackhawk Farms Raceway", await signedInUser());
    expect(res.status).toBe(200);
    expect(res.body.trace_geo).toMatchObject({ approx: true });
    expect(res.body.trace_geo.lat).toBeCloseTo(VIR.lat, 3);
  });

  it("is null when its owner has nothing to lend, whatever the viewer has", async () => {
    const owner = await signedInUser();
    await ranked("Atlanta Motorsports Park", owner, 121_000, "2026-04-10", {});
    const res = await open("Atlanta Motorsports Park", await signedInUser());
    expect(res.status).toBe(200);
    expect(res.body.trace_geo).toBeNull();
  });
});
