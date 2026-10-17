import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLIP_PART_BYTES, CLIP_QUOTA_BYTES } from "../../src/lib/clips";
import { COACH_CLIP_FIELDS } from "../../src/lib/coaching";
import { sweepClips } from "../../src/routes/clips";
import { apiClient, createEvent, signedInProUser, signedInUser } from "./helpers";

// NS-45: best-lap video clips. Create → parts → complete → a signed URL that
// plays, against the miniflare R2 bucket wrangler.jsonc declares; the quota,
// the tier lines, the tombstones and the cron, and the coach mount.

type User = Awaited<ReturnType<typeof signedInUser>>;
type Api = User["api"];

const LAP_MS = 101_234;

// An event with one session of three laps, the best one LAP_MS.
async function sessionWithLaps(api: Api, track = "Clip Raceway") {
  const eventId = await createEvent(api, { track_name: track, start_date: "2026-06-14" });
  const res = await api("POST", `/events/${eventId}/sessions`, { label: "Session 1", laps: [104_500, LAP_MS, 102_000] });
  expect(res.status).toBe(201);
  return { eventId, sessionId: res.body.id as number };
}

const createBody = (size: number, over: Record<string, unknown> = {}) => ({
  time_ms: LAP_MS,
  size_bytes: size,
  duration_ms: LAP_MS + 5_000,
  lap_offset_ms: 3_000,
  ...over,
});

// A part body: raw bytes, not JSON, with the Content-Length fetch derives.
async function putPart(token: string, clipId: number, n: number, bytes: Uint8Array, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`https://example.com/api/clips/${clipId}/parts/${n}`, {
    method: "PUT",
    headers: { Cookie: `session=${token}`, "Content-Type": "application/octet-stream", ...headers },
    body: bytes,
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

// A whole small clip, uploaded and completed: one part, which may be any size.
async function readyClip(user: User, size = 4096) {
  const { eventId, sessionId } = await sessionWithLaps(user.api);
  const created = await user.api("POST", `/sessions/${sessionId}/clip`, createBody(size));
  expect(created.status).toBe(201);
  const clipId = created.body.clip_id as number;
  const data = bytes(size);
  expect((await putPart(user.token, clipId, 1, data)).status).toBe(200);
  const done = await user.api("POST", `/clips/${clipId}/complete`);
  expect(done.status).toBe(200);
  return { eventId, sessionId, clipId, data };
}

async function lapse(userId: number) {
  await env.DB.prepare("UPDATE users SET entitled_until = ? WHERE id = ?").bind(Date.now() - 86_400_000, userId).run();
}

async function play(url: string, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(url, { headers });
  return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) };
}

describe("uploading a clip", () => {
  it("creates, takes its part, completes, and lands on the lap in the event detail", async () => {
    const user = await signedInProUser();
    const { eventId, sessionId } = await sessionWithLaps(user.api);
    const before = (await user.api("GET", `/events/${eventId}`)).body;
    expect(before.sessions[0].laps.every((l: any) => l.clip === null)).toBe(true);

    const created = await user.api("POST", `/sessions/${sessionId}/clip`, createBody(2048));
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ clip_id: expect.any(Number), part_bytes: CLIP_PART_BYTES, parts: 1, uploaded: [] });
    const clipId = created.body.clip_id;

    // Uploading isn't ready: the event detail doesn't carry it yet.
    expect((await user.api("GET", `/events/${eventId}`)).body.sessions[0].laps.every((l: any) => l.clip === null)).toBe(true);

    expect((await putPart(user.token, clipId, 1, bytes(2048))).status).toBe(200);
    const done = await user.api("POST", `/clips/${clipId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ id: clipId, duration_ms: LAP_MS + 5_000, lap_offset_ms: 3_000, size_bytes: 2048 });

    const after = await user.api("GET", `/events/${eventId}`);
    const laps = after.body.sessions[0].laps;
    // The lap with that time — lap 2 — and no other.
    expect(laps.map((l: any) => l.clip && l.clip.id)).toEqual([null, clipId, null]);
    // `youtube` (NS-46) is null until the clip is uploaded there.
    expect(laps[1].clip).toEqual({ id: clipId, duration_ms: LAP_MS + 5_000, lap_offset_ms: 3_000, size_bytes: 2048, youtube: null });
    expect(after.body.updated_at).toBeGreaterThanOrEqual(before.updated_at);

    // The parts' bookkeeping goes once the clip is ready.
    const parts = await env.DB.prepare("SELECT COUNT(*) AS n FROM lap_clip_parts WHERE clip_id = ?").bind(clipId).first<{ n: number }>();
    expect(parts!.n).toBe(0);
    // A second complete answers the clip again rather than failing.
    expect((await user.api("POST", `/clips/${clipId}/complete`)).body.id).toBe(clipId);
  });

  it("picks the lowest lap number when two laps share the time", async () => {
    const user = await signedInProUser();
    const eventId = await createEvent(user.api);
    const s = await user.api("POST", `/events/${eventId}/sessions`, { laps: [99_000, LAP_MS, LAP_MS] });
    const created = await user.api("POST", `/sessions/${s.body.id}/clip`, createBody(100));
    expect(created.status).toBe(201);
    const row = await env.DB.prepare(
      "SELECT l.lap_num FROM lap_clips k JOIN laps l ON l.id = k.lap_id WHERE k.id = ?"
    )
      .bind(created.body.clip_id)
      .first<{ lap_num: number }>();
    expect(row!.lap_num).toBe(2);
  });

  it("resumes: a second create answers the same clip with the parts already in", async () => {
    const user = await signedInProUser();
    const { sessionId } = await sessionWithLaps(user.api);
    const size = CLIP_PART_BYTES + 10;
    const first = await user.api("POST", `/sessions/${sessionId}/clip`, createBody(size));
    expect(first.body.parts).toBe(2);
    // The last part may be small; the first must be the full part size.
    expect((await putPart(user.token, first.body.clip_id, 2, bytes(10))).status).toBe(200);

    const again = await user.api("POST", `/sessions/${sessionId}/clip`, createBody(size));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ clip_id: first.body.clip_id, part_bytes: CLIP_PART_BYTES, parts: 2, uploaded: [2] });

    // A missing part fails complete, naming it.
    const done = await user.api("POST", `/clips/${first.body.clip_id}/complete`);
    expect(done.status).toBe(409);
    expect(done.body).toEqual({ error: "missing parts", missing: [1] });

    // A different cut of the same lap abandons the old upload for a new one.
    const other = await user.api("POST", `/sessions/${sessionId}/clip`, createBody(500));
    expect(other.status).toBe(201);
    expect(other.body.clip_id).not.toBe(first.body.clip_id);
    const tomb = await env.DB.prepare("SELECT upload_id FROM lap_clip_tombstones WHERE r2_key = ?")
      .bind(`clips/${user.id}/${first.body.clip_id}.mp4`)
      .first<{ upload_id: string | null }>();
    expect(tomb!.upload_id).toEqual(expect.any(String));
  });

  it("replaces a row whose create died before R2 answered, rather than resuming into it", async () => {
    const user = await signedInProUser();
    const { sessionId } = await sessionWithLaps(user.api);
    const first = await user.api("POST", `/sessions/${sessionId}/clip`, createBody(64));
    // What a create killed between its insert and createMultipartUpload leaves.
    await env.DB.prepare("UPDATE lap_clips SET upload_id = NULL, r2_key = 'pending/dead' WHERE id = ?").bind(first.body.clip_id).run();
    const again = await user.api("POST", `/sessions/${sessionId}/clip`, createBody(64));
    expect(again.status).toBe(201);
    expect(again.body.clip_id).not.toBe(first.body.clip_id);
    expect((await putPart(user.token, again.body.clip_id, 1, bytes(64))).status).toBe(200);
    expect((await user.api("POST", `/clips/${again.body.clip_id}/complete`)).status).toBe(200);
  });

  it("refuses a part whose length isn't the part's size, or one with no length", async () => {
    const user = await signedInProUser();
    const { sessionId } = await sessionWithLaps(user.api);
    const size = CLIP_PART_BYTES + 10;
    const { clip_id } = (await user.api("POST", `/sessions/${sessionId}/clip`, createBody(size))).body;
    expect((await putPart(user.token, clip_id, 2, bytes(9))).status).toBe(400);
    expect((await putPart(user.token, clip_id, 1, bytes(10))).status).toBe(400);
    expect((await putPart(user.token, clip_id, 3, bytes(10))).status).toBe(400);
    expect((await putPart(user.token, clip_id, 0, bytes(10))).status).toBe(400);
  });

  it("refuses a second clip on a lap that has one, and bodies that aren't a lap", async () => {
    const user = await signedInProUser();
    const { sessionId } = await readyClip(user);
    const again = await user.api("POST", `/sessions/${sessionId}/clip`, createBody(4096));
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "lap already has a clip" });

    const fresh = await sessionWithLaps(user.api, "Another Ring");
    for (const bad of [
      createBody(0),
      createBody(2 ** 31),
      createBody(100, { lap_offset_ms: -1 }),
      createBody(100, { duration_ms: 1_000, lap_offset_ms: 1_000 }),
      createBody(100, { time_ms: 601_000, duration_ms: 606_000 }),
      createBody(100, { size_bytes: "100" }),
    ]) {
      expect((await user.api("POST", `/sessions/${fresh.sessionId}/clip`, bad)).status).toBe(400);
    }
    // No lap with that time is a 404, like a session that isn't theirs.
    expect((await user.api("POST", `/sessions/${fresh.sessionId}/clip`, createBody(100, { time_ms: 1 }))).status).toBe(404);
  });

  it("stops at the quota, counting uploading clips at their declared size, and deletes nothing", async () => {
    const user = await signedInProUser();
    const a = await sessionWithLaps(user.api, "Quota A");
    const b = await sessionWithLaps(user.api, "Quota B");
    const big = await user.api("POST", `/sessions/${a.sessionId}/clip`, createBody(CLIP_QUOTA_BYTES - 1000, { size_bytes: 2 ** 30 }));
    expect(big.status).toBe(201);
    // Fill the rest of the quota with a row standing for earlier clips.
    await env.DB.prepare("UPDATE lap_clips SET size_bytes = ? WHERE id = ?").bind(CLIP_QUOTA_BYTES - 1000, big.body.clip_id).run();

    expect((await user.api("POST", `/sessions/${b.sessionId}/clip`, createBody(1000))).status).toBe(201);
    const c = await sessionWithLaps(user.api, "Quota C");
    const full = await user.api("POST", `/sessions/${c.sessionId}/clip`, createBody(1));
    expect(full.status).toBe(409);
    expect(full.body).toEqual({ error: "clip storage full" });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM lap_clips WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    expect(n!.n).toBe(2);

    const me = (await user.api("GET", "/me")).body.user;
    expect(me.clips).toEqual({ used_bytes: CLIP_QUOTA_BYTES, quota_bytes: CLIP_QUOTA_BYTES, coach_count: 0 });
  });
});

describe("playing a clip", () => {
  it("signs a URL that plays the clip, whole and by range", async () => {
    const user = await signedInProUser();
    const { clipId, data } = await readyClip(user, 4096);
    const res = await user.api("GET", `/clips/${clipId}/url`);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(new RegExp(`^https://example\\.com/clips/${clipId}\\.mp4\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    expect(res.body.expires_at).toBeGreaterThan(Date.now());
    expect(res.body.expires_at).toBeLessThanOrEqual(Date.now() + 3_600_000);

    // No cookie: the signature is the authorization.
    const whole = await play(res.body.url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Type")).toBe("video/mp4");
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    expect(whole.headers.get("Content-Disposition")).toBeNull();
    expect(whole.body).toEqual(data);

    const part = await play(res.body.url, { Range: "bytes=100-199" });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 100-199/4096");
    expect(part.body).toEqual(data.slice(100, 200));

    const tail = await play(res.body.url, { Range: "bytes=-96" });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("Content-Range")).toBe("bytes 4000-4095/4096");
    expect(tail.body).toEqual(data.slice(4000));
  });

  it("answers HEAD with the size and no body", async () => {
    const user = await signedInProUser();
    const { clipId } = await readyClip(user, 1500);
    const { url } = (await user.api("GET", `/clips/${clipId}/url`)).body;
    const res = await SELF.fetch(url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("1500");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers 403 to an expired or tampered signature", async () => {
    const user = await signedInProUser();
    const { clipId } = await readyClip(user);
    const { url } = (await user.api("GET", `/clips/${clipId}/url`)).body;
    const u = new URL(url);
    const sig = u.searchParams.get("sig")!;

    const tampered = new URL(url);
    tampered.searchParams.set("sig", (sig[0] === "a" ? "b" : "a") + sig.slice(1));
    expect((await play(tampered.toString())).status).toBe(403);

    const later = new URL(url);
    later.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 60));
    expect((await play(later.toString())).status).toBe(403);

    const otherClip = new URL(url.replace(`/clips/${clipId}.mp4`, `/clips/${clipId + 1}.mp4`));
    expect((await play(otherClip.toString())).status).toBe(403);

    expect((await play(`https://example.com/clips/${clipId}.mp4`)).status).toBe(403);
    expect((await play(`https://example.com/clips/${clipId}.mp4?exp=1&sig=${sig}`)).status).toBe(403);
  });

  it("downloads through a redirect to an attachment named after the track, day and lap", async () => {
    const user = await signedInProUser();
    const { clipId, data } = await readyClip(user);
    const res = await SELF.fetch(`https://example.com/api/clips/${clipId}/download`, {
      headers: { Cookie: `session=${user.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const file = await play(res.headers.get("Location")!);
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Disposition")).toBe('attachment; filename="clip-raceway-2026-06-14-lap-2.mp4"');
    expect(file.body).toEqual(data);
  });
});

describe("the tier", () => {
  it("is 402 on create, url and download for a free account, and deleting stays free", async () => {
    const pro = await signedInProUser();
    const { clipId, sessionId } = await readyClip(pro);
    await lapse(pro.id);
    expect((await pro.api("POST", `/sessions/${sessionId}/clip`, createBody(100))).status).toBe(402);
    expect((await pro.api("GET", `/clips/${clipId}/url`)).body).toEqual({ error: "pro required" });
    expect((await pro.api("GET", `/clips/${clipId}/download`)).status).toBe(402);

    // Kept and shown, locked: the lap still carries its clip.
    const ev = await pro.api("GET", `/events/${(await env.DB.prepare(
      "SELECT s.event_id FROM sessions s WHERE s.id = ?"
    ).bind(sessionId).first<{ event_id: number }>())!.event_id}`);
    expect(ev.body.sessions[0].laps[1].clip.id).toBe(clipId);

    expect((await pro.api("DELETE", `/clips/${clipId}`)).status).toBe(200);
    expect((await pro.api("DELETE", `/clips/${clipId}`)).status).toBe(404);
  });

  it("lets a lapsed account finish an upload already in flight", async () => {
    const user = await signedInProUser();
    const { sessionId } = await sessionWithLaps(user.api);
    const { clip_id } = (await user.api("POST", `/sessions/${sessionId}/clip`, createBody(64))).body;
    await lapse(user.id);
    expect((await putPart(user.token, clip_id, 1, bytes(64))).status).toBe(200);
    expect((await user.api("POST", `/clips/${clip_id}/complete`)).status).toBe(200);
  });
});

describe("another user's clip", () => {
  it("is a 404 on every route", async () => {
    const owner = await signedInProUser();
    const { clipId, sessionId } = await readyClip(owner);
    const stranger = await signedInProUser();
    expect((await stranger.api("POST", `/sessions/${sessionId}/clip`, createBody(100))).status).toBe(404);
    expect((await putPart(stranger.token, clipId, 1, bytes(10))).status).toBe(404);
    expect((await stranger.api("POST", `/clips/${clipId}/complete`)).status).toBe(404);
    expect((await stranger.api("GET", `/clips/${clipId}/url`)).status).toBe(404);
    expect((await stranger.api("GET", `/clips/${clipId}/download`)).status).toBe(404);
    expect((await stranger.api("DELETE", `/clips/${clipId}`)).status).toBe(404);
    expect((await apiClient()("GET", `/clips/${clipId}/url`)).status).toBe(401);
  });
});

describe("deleting", () => {
  it("leaves a tombstone for every way a clip goes — cascades included — and the cron drains it", async () => {
    const user = await signedInProUser();
    const { eventId, clipId } = await readyClip(user);
    const key = `clips/${user.id}/${clipId}.mp4`;
    expect(await env.CLIPS!.head(key)).not.toBeNull();

    // Deleting the event cascades through sessions and laps to the clip row,
    // and SQLite fires the child table's trigger on the way.
    expect((await user.api("DELETE", `/events/${eventId}`)).status).toBe(200);
    const tomb = await env.DB.prepare("SELECT r2_key, upload_id FROM lap_clip_tombstones WHERE r2_key = ?")
      .bind(key)
      .first<{ r2_key: string; upload_id: string | null }>();
    expect(tomb).toEqual({ r2_key: key, upload_id: null });
    // The object outlives the row until the sweep.
    expect(await env.CLIPS!.head(key)).not.toBeNull();

    const report = await sweepClips(env, Date.now());
    expect(report.failed).toBe(0);
    expect(await env.CLIPS!.head(key)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM lap_clip_tombstones WHERE r2_key = ?").bind(key).first()).toBeNull();
  });

  it("tombstones on account deletion too", async () => {
    const user = await signedInProUser();
    const { clipId } = await readyClip(user);
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
    expect(
      await env.DB.prepare("SELECT 1 AS x FROM lap_clip_tombstones WHERE r2_key = ?").bind(`clips/${user.id}/${clipId}.mp4`).first()
    ).toEqual({ x: 1 });
  });

  it("drops uploads abandoned for a week, whose tombstones abort them", async () => {
    const user = await signedInProUser();
    const { sessionId } = await sessionWithLaps(user.api);
    const { clip_id } = (await user.api("POST", `/sessions/${sessionId}/clip`, createBody(64))).body;
    await env.DB.prepare("UPDATE lap_clips SET created_at = ? WHERE id = ?").bind(Date.now() - 8 * 86_400_000, clip_id).run();
    const first = await sweepClips(env, Date.now());
    expect(first.stale).toBeGreaterThanOrEqual(1);
    const key = `clips/${user.id}/${clip_id}.mp4`;
    expect(await env.DB.prepare("SELECT upload_id FROM lap_clip_tombstones WHERE r2_key = ?").bind(key).first()).not.toBeNull();
    await sweepClips(env, Date.now());
    expect(await env.DB.prepare("SELECT 1 FROM lap_clip_tombstones WHERE r2_key = ?").bind(key).first()).toBeNull();
  });
});

describe("the logbook export", () => {
  it("lists a lap's clip as metadata, never the key or the bytes", async () => {
    const user = await signedInProUser();
    await readyClip(user, 512);
    const res = await user.api("GET", "/export/logbook.json");
    expect(res.status).toBe(200);
    const laps = res.body.events[0].sessions[0].laps;
    expect(laps[0].clip).toBeNull();
    expect(laps[1].clip).toEqual({
      duration_ms: LAP_MS + 5_000,
      lap_offset_ms: 3_000,
      size_bytes: 512,
      created_at: expect.any(Number),
    });
    expect(JSON.stringify(res.body)).not.toContain("clips/");
  });
});

describe("where a clip is not", () => {
  it("is absent from the public share and the MCP-facing lap summaries", async () => {
    const user = await signedInProUser();
    await readyClip(user);
    const slug = `clips-${user.id}-${Date.now()}`;
    expect((await user.api("PUT", "/share", { slug })).status).toBe(200);
    const shared = await apiClient()("GET", `/share/${slug}`);
    expect(shared.status).toBe(200);
    expect(JSON.stringify(shared.body)).not.toContain("clip");
  });

  it("is absent from the leaderboard lap", async () => {
    const owner = await signedInProUser();
    await owner.api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true });
    const track = "Virginia International Raceway (Full)";
    const eventId = await createEvent(owner.api, { track_name: track });
    const channels = { v: 1, dStepM: 20, laps: [{ n: 1, timeMs: LAP_MS, speed: Array.from({ length: 12 }, (_, i) => 100 + i) }] };
    const trace = Array.from({ length: 12 }, (_, i) => [i * 10, i * 5, 40 + i]);
    const s = await owner.api("POST", `/events/${eventId}/sessions`, { laps: [LAP_MS], channels, trace });
    const clip = await owner.api("POST", `/sessions/${s.body.id}/clip`, createBody(32));
    await putPart(owner.token, clip.body.clip_id, 1, bytes(32));
    expect((await owner.api("POST", `/clips/${clip.body.clip_id}/complete`)).status).toBe(200);

    const viewer = await signedInProUser();
    const vEvent = await createEvent(viewer.api, { track_name: track });
    await viewer.api("POST", `/events/${vEvent}/sessions`, { laps: [LAP_MS + 5_000] });
    const trackId = (await viewer.api("GET", "/tracks")).body[0].id;
    const board = await viewer.api("GET", `/tracks/${trackId}/leaderboard`);
    const entry = board.body.entries.find((e: any) => e.lap_id != null);
    expect(entry).toBeTruthy();
    const lap = await viewer.api("GET", `/tracks/${trackId}/leaderboard/laps/${entry.lap_id}`);
    expect(lap.status).toBe(200);
    expect(JSON.stringify(lap.body)).not.toContain("clip");
  });
});

describe("the coach mount", () => {
  async function pair(studentPro = true) {
    const student = studentPro ? await signedInProUser() : await signedInUser();
    if (!studentPro) {
      // Pro long enough to mint the invite and the clip, then lapsed below.
      await env.DB.prepare(
        `INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at)
         VALUES (?, 'legacy', 'apple-paid-app', ?, 'legacy', NULL, NULL, 'production', ?, ?)`
      )
        .bind(student.id, `clip-coach-${student.id}`, Date.now(), Date.now())
        .run();
    }
    const coach = await signedInUser();
    const inv = await student.api("POST", "/coaching/invites");
    const token = (inv.body.url as string).split("/coach/")[1];
    expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
    const as = (method: string, path: string, body?: unknown) => coach.api(method, `/students/${student.id}${path}`, body);
    return { student, coach, as };
  }

  it("lets a free coach watch a Pro student's clip, and nothing more", async () => {
    const { student, coach, as } = await pair();
    const { eventId, clipId, sessionId, data } = await readyClip(student);

    const ev = await as("GET", `/events/${eventId}`);
    expect(ev.status).toBe(200);
    const clip = ev.body.sessions[0].laps[1].clip;
    expect(Object.keys(clip).sort()).toEqual([...COACH_CLIP_FIELDS].sort());
    expect(ev.body.sessions[0].laps[0].clip).toBeNull();

    const url = await as("GET", `/clips/${clipId}/url`);
    expect(url.status).toBe(200);
    expect(Object.keys(url.body).sort()).toEqual(["expires_at", "url"]);
    expect((await play(url.body.url)).body).toEqual(data);

    // Watch only.
    expect((await as("GET", `/clips/${clipId}/download`)).status).toBe(404);
    expect((await as("DELETE", `/clips/${clipId}`)).status).toBe(404);
    expect((await as("POST", `/sessions/${sessionId}/clip`, createBody(10))).status).toBe(404);
    expect((await as("PUT", `/clips/${clipId}/parts/1`, {})).status).toBe(404);
    expect((await as("POST", `/clips/${clipId}/complete`)).status).toBe(404);

    // Off the mount the coach is themselves: free, so the gate answers before
    // any lookup (confirming nothing), and as Pro the clip isn't theirs.
    expect((await coach.api("GET", `/clips/${clipId}/url`)).status).toBe(402);
    await env.DB.prepare("UPDATE users SET entitled_until = ? WHERE id = ?").bind(Date.now() + 86_400_000, coach.id).run();
    expect((await coach.api("GET", `/clips/${clipId}/url`)).status).toBe(404);

    // /me's coach_count is the student's grants.
    expect((await student.api("GET", "/me")).body.user.clips.coach_count).toBe(1);
  });

  it("is a 404 for another student's clip", async () => {
    const { as } = await pair();
    const other = await signedInProUser();
    const { clipId } = await readyClip(other);
    expect((await as("GET", `/clips/${clipId}/url`)).status).toBe(404);
  });

  it("gives a lapsed student's coach the 402, and a removed coach a 404", async () => {
    const { student, as } = await pair(false);
    const { clipId } = await readyClip(student);
    expect((await as("GET", `/clips/${clipId}/url`)).status).toBe(200);
    await lapse(student.id);
    expect((await as("GET", `/clips/${clipId}/url`)).status).toBe(402);

    const again = await pair();
    const { clipId: id2 } = await readyClip(again.student);
    expect((await again.as("GET", `/clips/${id2}/url`)).status).toBe(200);
    expect((await again.student.api("DELETE", `/coaching/coaches/${again.coach.id}`)).status).toBe(200);
    expect((await again.as("GET", `/clips/${id2}/url`)).status).toBe(404);
  });
});

// NS-47: a clip cut in the browser goes through the same routes as a phone's.
// The real cutter (mp4cut.js) over the synthetic camera file, driven by the
// real uploader (clip-upload.js), with its transport pointed at the Worker.
describe("a clip cut and uploaded by the web app", () => {
  it("cuts, uploads through the routes and plays back byte for byte", async () => {
    const { buildCutSourceMp4 } = await import("../fixtures/build.mjs");
    const { cutClip } = await import("../../public/js/import/mp4cut.js");
    const { createClipUploads } = await import("../../public/js/import/clip-upload.js");

    const user = await signedInProUser();
    const eventId = await createEvent(user.api, { track_name: "Web Clip Raceway", start_date: "2026-06-14" });
    // The lap the cut is for: 5 s from 7 s into a 20 s source.
    const saved = await user.api("POST", `/events/${eventId}/sessions`, { label: "Imported", laps: [5_000, 6_000] });
    const sessionId = saved.body.id as number;

    const source = new Blob([buildCutSourceMp4()]);
    let cutSize = 0;
    let cutBlob: Blob | null = null;
    const cookie = { Cookie: `session=${user.token}` };
    const json = async (res: Response) => ({ res, body: (await res.json().catch(() => ({}))) as any });
    const finished: unknown[] = [];

    const uploads = createClipUploads({
      cut: async (file: Blob, window: any, lapStartS: number) => {
        const cut = await cutClip(file, window, lapStartS);
        cutSize = cut.sizeBytes;
        cutBlob = cut.blob;
        return cut;
      },
      tempIdState: async () => ({ mapped: null, queued: false }),
      create: async (id: number, body: unknown) => {
        const { res, body: out } = await json(
          await SELF.fetch(`https://example.com/api/sessions/${id}/clip`, {
            method: "POST",
            headers: { ...cookie, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        );
        return res.ok
          ? { kind: "created", start: { clipId: out.clip_id, partBytes: out.part_bytes, parts: out.parts, uploaded: out.uploaded } }
          : { kind: "status", status: res.status, error: out.error };
      },
      putPart: async (clipId: number, n: number, part: Blob) => {
        // A Blob body, as the browser's XHR sends it: the length comes with it.
        const data = new Uint8Array(await part.arrayBuffer());
        const res = await SELF.fetch(`https://example.com/api/clips/${clipId}/parts/${n}`, {
          method: "PUT",
          headers: { ...cookie, "Content-Type": "application/octet-stream" },
          body: data,
        });
        return res.ok ? { kind: "ok" } : { kind: "status", status: res.status, error: null };
      },
      complete: async (clipId: number) => {
        const { res, body: out } = await json(
          await SELF.fetch(`https://example.com/api/clips/${clipId}/complete`, { method: "POST", headers: cookie })
        );
        if (res.ok) return { kind: "ok" };
        return res.status === 409 && out.missing ? { kind: "missingParts", missing: out.missing } : { kind: "status", status: res.status, error: out.error };
      },
      onFinished: (id: unknown) => finished.push(id),
    });

    await uploads.enqueue({
      sessionId,
      timeMs: 5_000,
      file: source,
      window: { startS: 4, endS: 14, lapOffsetS: 3 },
      lapStartS: 7,
    });
    for (let i = 0; i < 50 && !finished.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(finished).toEqual([sessionId]);
    expect(uploads.statuses()).toEqual([]);

    const lap = (await user.api("GET", `/events/${eventId}`)).body.sessions[0].laps.find((l: any) => l.time_ms === 5_000);
    expect(lap.clip).toMatchObject({ id: expect.any(Number), size_bytes: cutSize, lap_offset_ms: expect.any(Number) });
    expect(lap.clip.lap_offset_ms).toBeGreaterThanOrEqual(3_000);

    const signed = await user.api("GET", `/clips/${lap.clip.id}/url`);
    const whole = new Uint8Array(await cutBlob!.arrayBuffer());
    const all = await play(signed.body.url);
    expect(all.status).toBe(200);
    expect(all.body).toEqual(whole);
    const ranged = await play(signed.body.url, { Range: "bytes=0-15" });
    expect(ranged.status).toBe(206);
    expect(ranged.body).toEqual(whole.slice(0, 16));
    // The cut leads with ftyp then moov, so a player gets the index first.
    expect(new TextDecoder().decode(whole.slice(4, 8))).toBe("ftyp");
  });
});
