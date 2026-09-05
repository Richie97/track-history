import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";

// Per-track community leaderboards (GET /tracks/:id/leaderboard) and the
// opt-in that gates them (PUT /me/leaderboard). Cross-user by design, so the
// tests are mostly about what does NOT leak: users who never opted in, tracks
// the catalog can't identify across users — and, since NS-33, laps nobody
// measured: only device-timed laps (those with a matching entry in the
// session's channel data) rank, never a typed lap or a manual event best.

// A valid sessions.channels blob for the given lap times — the twelve-point
// arrays test/api/sessions.test.ts uses, one entry per lap. The recorder and
// every importer write this shape; hand entry never does.
function channelsFor(laps: number[]) {
  const arr = (v: number) => Array.from({ length: 12 }, (_, i) => v + i);
  return {
    v: 1,
    dStepM: 20,
    laps: laps.map((timeMs, i) => ({ n: i + 1, timeMs, speed: arr(100) })),
  };
}

describe("PUT /me/leaderboard", () => {
  it("toggles the opt-in and reports it via /me", async () => {
    const u = await signedInUser();
    expect((await u.api("GET", "/me")).body.user.leaderboard_opt_in).toBe(false);
    expect((await u.api("PUT", "/me/leaderboard", { opt_in: true })).status).toBe(200);
    expect((await u.api("GET", "/me")).body.user.leaderboard_opt_in).toBe(true);
    expect((await u.api("PUT", "/me/leaderboard", { opt_in: false })).status).toBe(200);
    expect((await u.api("GET", "/me")).body.user.leaderboard_opt_in).toBe(false);
  });

  it("rejects a non-boolean opt_in", async () => {
    const u = await signedInUser();
    expect((await u.api("PUT", "/me/leaderboard", { opt_in: "yes" })).status).toBe(400);
    expect((await u.api("PUT", "/me/leaderboard", {})).status).toBe(400);
  });
});

describe("GET /tracks/:id/leaderboard", () => {
  // Each user's own track row for the same catalog entry — created via an
  // event so resolveTrack runs the catalog match, then laps (device-timed when
  // `timed` lists them, i.e. the session carries channel entries for them),
  // or a manual best. Returns the track id and the session id.
  async function trackDay(
    u: Awaited<ReturnType<typeof signedInUser>>,
    trackName: string,
    { laps, timed, best }: { laps?: number[]; timed?: number[]; best?: number }
  ) {
    const eventId = await createEvent(u.api, {
      track_name: trackName,
      start_date: "2026-04-10",
      ...(best ? { best_time_ms: best } : {}),
    });
    let sessionId: number | null = null;
    if (laps) {
      const res = await u.api("POST", `/events/${eventId}/sessions`, {
        laps,
        ...(timed?.length ? { channels: channelsFor(timed) } : {}),
      });
      expect(res.status).toBe(201);
      sessionId = res.body.id;
    }
    const tracks = (await u.api("GET", "/tracks")).body as Array<{ id: number; name: string }>;
    return { trackId: tracks.find((t) => t.name.toLowerCase() === trackName.toLowerCase())!.id, sessionId };
  }

  it("ranks opted-in users' best device-timed laps across accounts, hiding everyone else", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const ghost = await signedInUser(); // fastest of all, but never opted in

    await a.api("PUT", "/me/leaderboard", { opt_in: true });
    await b.api("PUT", "/me/leaderboard", { opt_in: true });

    // Same physical track: catalog matching is case-insensitive.
    const { trackId } = await trackDay(a, "Road Atlanta", { laps: [95000, 93211], timed: [95000, 93211] });
    await trackDay(b, "road atlanta", { laps: [91000], timed: [91000] });
    await trackDay(ghost, "Road Atlanta", { laps: [88000], timed: [88000] });

    const res = await a.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.body.opted_in).toBe(true);
    expect(res.body.catalog_id).not.toBeNull();
    expect(res.body.entries).toEqual([
      { name: "Test User", best_ms: 91000, date: "2026-04-10", you: false },
      { name: "Test User", best_ms: 93211, date: "2026-04-10", you: true },
    ]);
  });

  it("never ranks a manual event best, even when it beats every lap", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    const { trackId } = await trackDay(u, "Sebring International Raceway", {
      laps: [125000],
      timed: [125000],
      best: 121500,
    });
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.body.entries).toEqual([
      { name: "Test User", best_ms: 125000, date: "2026-04-10", you: true },
    ]);
    // The logbook itself keeps the MIN(manual, laps) rule — only the ranking changed.
    const events = (await u.api("GET", `/events?track_id=${trackId}`)).body;
    expect(events[0].best_ms).toBe(121500);
  });

  it("leaves a hand-entered session off the board", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    const { trackId } = await trackDay(u, "Road America", { laps: [150000, 148000], best: 140000 });
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.body.opted_in).toBe(true);
    expect(res.body.entries).toEqual([]);
  });

  it("ranks only the laps the channel data covers within one session", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    // Two laps, channel entry for the slower one only — the faster was typed.
    const { trackId } = await trackDay(u, "Barber Motorsports Park", { laps: [95000, 93211], timed: [95000] });
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.body.entries).toEqual([
      { name: "Test User", best_ms: 95000, date: "2026-04-10", you: true },
    ]);
  });

  it("ignores laps added afterwards to a recorded session", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    const { trackId, sessionId } = await trackDay(u, "Mid-Ohio Sports Car Course", {
      laps: [100000],
      timed: [100000],
    });
    expect((await u.api("POST", `/sessions/${sessionId}/laps`, { laps: [90000] })).status).toBe(201);
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.body.entries).toEqual([
      { name: "Test User", best_ms: 100000, date: "2026-04-10", you: true },
    ]);
  });

  it("maintains laps.device_timed by trigger, not by route code", async () => {
    // Insert straight into D1, the way a support script would, and read the
    // column back: the rule has to hold without any route's cooperation.
    const u = await signedInUser();
    const { sessionId: recorded } = await trackDay(u, "Laguna Seca", { laps: [98000, 97500], timed: [98000, 97500] });
    const { sessionId: manual } = await trackDay(u, "Laguna Seca", { laps: [96000] });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO laps (session_id, lap_num, time_ms) VALUES (?, 3, 97500)").bind(recorded),
      env.DB.prepare("INSERT INTO laps (session_id, lap_num, time_ms) VALUES (?, 4, 91000)").bind(recorded),
      env.DB.prepare("INSERT INTO laps (session_id, lap_num, time_ms) VALUES (?, 2, 95000)").bind(manual),
    ]);
    const rows = await env.DB.prepare(
      "SELECT session_id, time_ms, device_timed FROM laps WHERE session_id IN (?, ?) ORDER BY session_id, lap_num"
    )
      .bind(recorded, manual)
      .all<{ session_id: number; time_ms: number; device_timed: number }>();
    expect(rows.results).toEqual([
      { session_id: recorded, time_ms: 98000, device_timed: 1 },
      { session_id: recorded, time_ms: 97500, device_timed: 1 },
      { session_id: recorded, time_ms: 97500, device_timed: 1 }, // same time as an entry: matches
      { session_id: recorded, time_ms: 91000, device_timed: 0 }, // no entry: typed
      { session_id: manual, time_ms: 96000, device_timed: 0 },
      { session_id: manual, time_ms: 95000, device_timed: 0 },
    ]);

    // Rewriting the channels re-derives every lap of that session.
    await env.DB.prepare("UPDATE sessions SET channels = ? WHERE id = ?")
      .bind(JSON.stringify(channelsFor([91000])), recorded)
      .run();
    const after = await env.DB.prepare("SELECT time_ms, device_timed FROM laps WHERE session_id = ? ORDER BY lap_num")
      .bind(recorded)
      .all<{ time_ms: number; device_timed: number }>();
    expect(after.results.map((r) => r.device_timed)).toEqual([0, 0, 0, 1]);
  });

  it("leaves a viewer who hasn't opted in off their own leaderboard", async () => {
    const u = await signedInUser();
    const { trackId } = await trackDay(u, "Road America", { laps: [150000], timed: [150000] });
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.body.opted_in).toBe(false);
    expect(res.body.entries).toEqual([]);
  });

  it("has no leaderboard for a track the catalog doesn't know", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    const { trackId } = await trackDay(u, "My Backyard Kart Track", { laps: [45000], timed: [45000] });
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ catalog_id: null, opted_in: true, entries: [] });
  });

  it("404s for another user's track id and for anonymous requests", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { trackId } = await trackDay(a, "Watkins Glen International", { laps: [130000], timed: [130000] });
    expect((await b.api("GET", `/tracks/${trackId}/leaderboard`)).status).toBe(404);
    const anon = await fetch_(`/tracks/${trackId}/leaderboard`);
    expect(anon).toBe(401);
  });
});

async function fetch_(path: string) {
  const { SELF } = await import("cloudflare:test");
  const res = await SELF.fetch(`https://example.com/api${path}`);
  return res.status;
}
