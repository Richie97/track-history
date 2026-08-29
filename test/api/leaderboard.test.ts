import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";

// Per-track community leaderboards (GET /tracks/:id/leaderboard) and the
// opt-in that gates them (PUT /me/leaderboard). Cross-user by design, so the
// tests are mostly about what does NOT leak: users who never opted in, and
// tracks the catalog can't identify across users.

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
  // event so resolveTrack runs the catalog match, then laps or a manual best.
  async function trackDay(
    u: Awaited<ReturnType<typeof signedInUser>>,
    trackName: string,
    { laps, best }: { laps?: number[]; best?: number }
  ) {
    const eventId = await createEvent(u.api, {
      track_name: trackName,
      start_date: "2026-04-10",
      ...(best ? { best_time_ms: best } : {}),
    });
    if (laps) {
      const res = await u.api("POST", `/events/${eventId}/sessions`, { laps });
      expect(res.status).toBe(201);
    }
    const tracks = (await u.api("GET", "/tracks")).body as Array<{ id: number; name: string }>;
    return tracks.find((t) => t.name.toLowerCase() === trackName.toLowerCase())!.id;
  }

  it("ranks opted-in users' bests across accounts, hiding everyone else", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const ghost = await signedInUser(); // fastest of all, but never opted in

    await a.api("PUT", "/me/leaderboard", { opt_in: true });
    await b.api("PUT", "/me/leaderboard", { opt_in: true });

    // Same physical track: catalog matching is case-insensitive.
    const trackA = await trackDay(a, "Road Atlanta", { laps: [95000, 93211] });
    await trackDay(b, "road atlanta", { best: 91000 });
    await trackDay(ghost, "Road Atlanta", { laps: [88000] });

    const res = await a.api("GET", `/tracks/${trackA}/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.body.opted_in).toBe(true);
    expect(res.body.catalog_id).not.toBeNull();
    expect(res.body.entries).toEqual([
      { name: "Test User", best_ms: 91000, date: "2026-04-10", you: false },
      { name: "Test User", best_ms: 93211, date: "2026-04-10", you: true },
    ]);
  });

  it("takes the better of a manual best and logged laps for one user", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    // Manual best beats the laps here — the same MIN rule as withComputed.
    const trackId = await trackDay(u, "Sebring International Raceway", { laps: [125000], best: 121500 });
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.body.entries).toEqual([
      { name: "Test User", best_ms: 121500, date: "2026-04-10", you: true },
    ]);
  });

  it("leaves a viewer who hasn't opted in off their own leaderboard", async () => {
    const u = await signedInUser();
    const trackId = await trackDay(u, "Road America", { laps: [150000] });
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.body.opted_in).toBe(false);
    expect(res.body.entries).toEqual([]);
  });

  it("has no leaderboard for a track the catalog doesn't know", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    const trackId = await trackDay(u, "My Backyard Kart Track", { laps: [45000] });
    const res = await u.api("GET", `/tracks/${trackId}/leaderboard`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ catalog_id: null, opted_in: true, entries: [] });
  });

  it("404s for another user's track id and for anonymous requests", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const trackId = await trackDay(a, "Watkins Glen International", { laps: [130000] });
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
