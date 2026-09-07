import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInProUser, signedInUser } from "./helpers";

// NS-35: opening a leaderboard lap.
//
// The second consent (`leaderboard_share_laps`) and the route it unlocks,
// GET /tracks/:id/leaderboard/laps/:lapId. Same emphasis as leaderboard.test.ts:
// these are mostly tests about what does NOT leak — the rest of a stranger's
// logbook, the fields nobody consented to publish, and the whole feature for a
// driver who only ever agreed to the original two-field share.

// A channel blob carrying every stored shape — gridded traces, per-lap scalars
// and session meta — so the publishing rule is tested against data that
// actually has something to withhold.
function richChannels(timeMs: number) {
  const arr = (v: number) => Array.from({ length: 12 }, (_, i) => v + i);
  return {
    v: 1,
    dStepM: 20,
    meta: { ambientC: 21.5, intakeC: 44, elevationM: 320, odometerKm: 41234 },
    laps: [
      {
        n: 1,
        timeMs,
        speed: arr(100),
        throttle: arr(10),
        brake: arr(0),
        // per-lap scalars: the car's condition, never published
        oilC: 118.5,
        fuelPct: 42.5,
        tyreKpaLF: 210,
        battV: 13.9,
      },
    ],
  };
}

// A best-lap racing line in the stored [x_m, y_m, v] local-meter shape
// (migration 0005). sanitizeTrace wants at least 10 points.
const TRACE: [number, number, number][] = Array.from({ length: 12 }, (_, i) => [i * 10, i * 5, 40 + i]);

type User = Awaited<ReturnType<typeof signedInUser>>;

// Owner sets a lap at `trackName` and (optionally) publishes it.
async function publish(
  owner: User,
  trackName: string,
  timeMs: number,
  { share = true, trace = true }: { share?: boolean; trace?: boolean } = {}
) {
  await owner.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: share });
  const eventId = await createEvent(owner.api, { track_name: trackName, start_date: "2026-04-10" });
  const res = await owner.api("POST", `/events/${eventId}/sessions`, {
    laps: [timeMs],
    channels: richChannels(timeMs),
    ...(trace ? { trace: TRACE } : {}),
  });
  expect(res.status).toBe(201);
}

// The viewer needs their own track row for the same catalog entry — a lap is
// only ever reachable from a track the viewer actually has.
async function viewerTrack(viewer: User, trackName: string, timeMs: number) {
  await viewer.api("PUT", "/me/leaderboard", { opt_in: true });
  const eventId = await createEvent(viewer.api, { track_name: trackName, start_date: "2026-04-11" });
  await viewer.api("POST", `/events/${eventId}/sessions`, {
    laps: [timeMs],
    channels: richChannels(timeMs),
  });
  const tracks = (await viewer.api("GET", "/tracks")).body as Array<{ id: number; name: string }>;
  return tracks.find((t) => t.name.toLowerCase() === trackName.toLowerCase())!.id;
}

async function entries(viewer: User, trackId: number) {
  const res = await viewer.api("GET", `/tracks/${trackId}/leaderboard`);
  expect(res.status).toBe(200);
  return res.body.entries as Array<{ name: string; best_ms: number; you: boolean; lap_id: number | null }>;
}

async function anonStatus(path: string) {
  const { SELF } = await import("cloudflare:test");
  return (await SELF.fetch(`https://example.com/api${path}`)).status;
}

describe("PUT /me/leaderboard share_laps", () => {
  it("is off by default and toggles independently of opt_in", async () => {
    const u = await signedInUser();
    expect((await u.api("GET", "/me")).body.user.leaderboard_share_laps).toBe(false);
    await u.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
    expect((await u.api("GET", "/me")).body.user.leaderboard_share_laps).toBe(true);
    await u.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: false });
    expect((await u.api("GET", "/me")).body.user.leaderboard_share_laps).toBe(false);
  });

  // A shipped older client sends `{ opt_in }` and knows nothing about the
  // second flag. Its request must not clear a consent given elsewhere.
  it("leaves the stored value alone when the key is absent", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    expect((await u.api("GET", "/me")).body.user.leaderboard_share_laps).toBe(true);
  });

  // Leaving the board must not leave a flag armed to re-publish telemetry the
  // moment the driver rejoins.
  it("clears share_laps when the user opts out", async () => {
    const u = await signedInUser();
    await u.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
    await u.api("PUT", "/me/leaderboard", { opt_in: false });
    expect((await u.api("GET", "/me")).body.user.leaderboard_share_laps).toBe(false);
    await u.api("PUT", "/me/leaderboard", { opt_in: true });
    expect((await u.api("GET", "/me")).body.user.leaderboard_share_laps).toBe(false);
  });

  it("rejects a non-boolean share_laps", async () => {
    const u = await signedInUser();
    expect((await u.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: "yes" })).status).toBe(400);
  });
});

describe("GET /tracks/:id/leaderboard/laps/:lapId", () => {
  it("publishes a shared lap's traces, and nothing user-entered or private", async () => {
    const owner = await signedInUser();
    const viewer = await signedInProUser();
    await publish(owner, "Sonoma Raceway", 101000);
    const trackId = await viewerTrack(viewer, "Sonoma Raceway", 105000);

    const theirs = (await entries(viewer, trackId)).find((e) => !e.you)!;
    expect(theirs.lap_id).toEqual(expect.any(Number));

    const res = await viewer.api("GET", `/tracks/${trackId}/leaderboard/laps/${theirs.lap_id}`);
    expect(res.status).toBe(200);
    expect(res.body.time_ms).toBe(101000);
    expect(res.body.date).toBe("2026-04-10");
    expect(res.body.you).toBe(false);
    // Device-measured context rides along (migration 0020); the typed temp_f
    // and every other user-entered field does not.
    expect(res.body.ambient_c).toBe(21.5);
    expect(res.body.elevation_m).toBe(320);
    expect(res.body.trace).toEqual(TRACE);
    // The channel blob is rebuilt by allow-list: gridded traces only, one lap.
    expect(res.body.channels.dStepM).toBe(20);
    expect(res.body.channels.laps).toHaveLength(1);
    const entry = res.body.channels.laps[0];
    expect(entry.timeMs).toBe(101000);
    expect(entry.speed).toHaveLength(12);
    expect(Object.keys(entry).sort()).toEqual(["brake", "n", "speed", "throttle", "timeMs"]);
    // The car's condition and its lifetime odometer stay in the owner's logbook.
    expect(res.body.channels.meta).toBeUndefined();
    for (const k of ["oilC", "fuelPct", "tyreKpaLF", "battV"]) expect(entry[k]).toBeUndefined();
    // Nothing about the session, the event or the car is published.
    for (const k of ["label", "notes", "car", "conditions", "temp_f", "club", "event_id", "session_id"])
      expect(res.body[k]).toBeUndefined();
  });

  it("withholds the lap id, and 404s the lap, when its owner hasn't shared", async () => {
    const owner = await signedInUser();
    const viewer = await signedInProUser();
    await publish(owner, "Circuit of the Americas", 128000, { share: false });
    const trackId = await viewerTrack(viewer, "Circuit of the Americas", 131000);

    const theirs = (await entries(viewer, trackId)).find((e) => !e.you)!;
    expect(theirs.best_ms).toBe(128000);
    expect(theirs.lap_id).toBeNull();

    // …and knowing the id anyway doesn't help: lap ids are small integers.
    const guessed = await env.DB.prepare("SELECT id FROM laps WHERE time_ms = 128000").first<{ id: number }>();
    expect((await viewer.api("GET", `/tracks/${trackId}/leaderboard/laps/${guessed!.id}`)).status).toBe(404);
  });

  // The condition that keeps this from becoming a read handle on a stranger's
  // logbook: only the lap the board already names is reachable.
  it("404s a shared user's other laps — only the ranked one is published", async () => {
    const owner = await signedInUser();
    const viewer = await signedInProUser();
    await owner.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
    const eventId = await createEvent(owner.api, {
      track_name: "Lime Rock Park",
      start_date: "2026-04-10",
    });
    await owner.api("POST", `/events/${eventId}/sessions`, {
      laps: [58000, 55000],
      channels: {
        v: 1,
        dStepM: 20,
        laps: [58000, 55000].map((t, i) => ({
          n: i + 1,
          timeMs: t,
          speed: Array.from({ length: 12 }, (_, k) => 100 + k),
        })),
      },
    });
    const trackId = await viewerTrack(viewer, "Lime Rock Park", 60000);

    const theirs = (await entries(viewer, trackId)).find((e) => !e.you)!;
    expect(theirs.best_ms).toBe(55000);
    // The ranked lap opens.
    expect((await viewer.api("GET", `/tracks/${trackId}/leaderboard/laps/${theirs.lap_id}`)).status).toBe(200);
    // Their slower lap in the same session does not.
    const slower = await env.DB.prepare("SELECT id FROM laps WHERE time_ms = 58000").first<{ id: number }>();
    expect((await viewer.api("GET", `/tracks/${trackId}/leaderboard/laps/${slower!.id}`)).status).toBe(404);
  });

  it("404s a lap at a different track, an unknown id and an anonymous request", async () => {
    const owner = await signedInUser();
    const viewer = await signedInProUser();
    await publish(owner, "Watkins Glen International", 122000);
    const glen = await viewerTrack(viewer, "Watkins Glen International", 126000);
    const other = await viewerTrack(viewer, "Road America", 150000);

    const theirs = (await entries(viewer, glen)).find((e) => !e.you)!;
    // Right lap, wrong track: the catalog identity has to match.
    expect((await viewer.api("GET", `/tracks/${other}/leaderboard/laps/${theirs.lap_id}`)).status).toBe(404);
    expect((await viewer.api("GET", `/tracks/${glen}/leaderboard/laps/999999`)).status).toBe(404);
    expect((await viewer.api("GET", `/tracks/${glen}/leaderboard/laps/nonsense`)).status).toBe(404);
    expect(await anonStatus(`/tracks/${glen}/leaderboard/laps/${theirs.lap_id}`)).toBe(401);
  });

  // Leaderboards are Free (NS-32), and so is the racing line — `channels` is
  // the one Pro field, stripped exactly as it is on the event detail.
  it("strips channels for a free account and keeps the trace and the times", async () => {
    const owner = await signedInUser();
    const free = await signedInUser();
    await publish(owner, "Virginia International Raceway (Full)", 121900);
    const trackId = await viewerTrack(free, "Virginia International Raceway (Full)", 130000);

    const theirs = (await entries(free, trackId)).find((e) => !e.you)!;
    const res = await free.api("GET", `/tracks/${trackId}/leaderboard/laps/${theirs.lap_id}`);
    expect(res.status).toBe(200);
    expect(res.body.channels).toBeNull();
    expect(res.body.time_ms).toBe(121900);
    expect(res.body.trace).toHaveLength(12);
  });

  // Your own lap opens whatever your setting: seeing what the board would
  // publish, before publishing it, is the point of the control.
  it("opens the viewer's own ranked lap even when they haven't shared", async () => {
    const driver = await signedInProUser();
    await publish(driver, "Thunderhill Raceway (3-Mile)", 118000, { share: false });
    const tracks = (await driver.api("GET", "/tracks")).body as Array<{ id: number }>;
    const trackId = tracks[0].id;
    const mine = (await entries(driver, trackId)).find((e) => e.you)!;
    expect(mine.lap_id).toEqual(expect.any(Number));
    const res = await driver.api("GET", `/tracks/${trackId}/leaderboard/laps/${mine.lap_id}`);
    expect(res.status).toBe(200);
    expect(res.body.you).toBe(true);
  });

  it("serves a lap with no stored trace as null rather than failing", async () => {
    const owner = await signedInUser();
    const viewer = await signedInProUser();
    await publish(owner, "Willow Springs (Big Willow)", 84000, { trace: false });
    const trackId = await viewerTrack(viewer, "Willow Springs (Big Willow)", 90000);
    const theirs = (await entries(viewer, trackId)).find((e) => !e.you)!;
    const res = await viewer.api("GET", `/tracks/${trackId}/leaderboard/laps/${theirs.lap_id}`);
    expect(res.status).toBe(200);
    expect(res.body.trace).toBeNull();
    expect(res.body.channels.laps).toHaveLength(1);
  });
});
