import { createExecutionContext, createMessageBatch, env, getQueueResult, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { MAX_DAILY_UPLOADS_PER_USER, TEXT, decryptSecret, encryptSecret, secondsToPacificMidnight } from "../../src/lib/youtube";
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, YT_UPLOAD_URL, YT_VIDEOS_URL } from "../../src/youtube/google";
import {
  DEAD_UPLOAD_MS,
  STALE_STEP_MS,
  YOUTUBE_DLQ_NAME,
  YOUTUBE_QUEUE_NAME,
  stepUpload,
  sweepYouTube,
  youtubeQueue,
} from "../../src/youtube/step";
import { createEvent, signedInProUser, signedInUser } from "./helpers";

// NS-46: publishing a best-lap video to YouTube. Google's token and revoke
// endpoints are fetchMock interceptors (vitest.workers.config.mts) for the
// HTTP routes; the queue step and the cron take their fetch as an argument,
// and here it is `FakeYouTube` — a resumable upload server scripted per test,
// so the offsets, restarts and outages are real sequences rather than one
// canned answer.

type User = Awaited<ReturnType<typeof signedInUser>>;
type Api = User["api"];

const KEY = env.YOUTUBE_TOKEN_KEY!;
const KiB = 1024;
// The tests step in 256 KiB chunks (YouTube's multiple); production's 32 MiB
// is pinned by the unit tests.
const CHUNK = 256 * KiB;
const LAP_MS = 101_234;

const b64Url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
// Megabytes of clip, made and compared in plain loops: a callback per byte,
// or vitest's element-by-element deep equality, is what pushed the
// multi-chunk tests past 5 s on CI's slower runner.
function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}
// The index of the first byte that differs, or -1 when the two are the same.
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
// The upload steps a real clip through R2 chunk by chunk, which is seconds
// on a slow runner; well past the default 5 s, well short of a hang.
const MULTI_CHUNK_TIMEOUT_MS = 30_000;

// ---------- fixtures --------------------------------------------------------------

async function readyClip(user: User, size = 4096, track = "YouTube Raceway") {
  const eventId = await createEvent(user.api, { track_name: track, start_date: "2026-06-14", car: "Corvette C7" });
  const s = await user.api("POST", `/events/${eventId}/sessions`, { label: "Session 1", laps: [104_500, LAP_MS, 102_000] });
  expect(s.status).toBe(201);
  const created = await user.api("POST", `/sessions/${s.body.id}/clip`, {
    time_ms: LAP_MS,
    size_bytes: size,
    duration_ms: LAP_MS + 7_000,
    lap_offset_ms: 3_317,
  });
  expect(created.status).toBe(201);
  const clipId = created.body.clip_id as number;
  const put = await SELF.fetch(`https://example.com/api/clips/${clipId}/parts/1`, {
    method: "PUT",
    headers: { Cookie: `session=${user.token}`, "Content-Type": "application/octet-stream" },
    body: bytes(size),
  });
  expect(put.status).toBe(200);
  expect((await user.api("POST", `/clips/${clipId}/complete`)).status).toBe(200);
  return { eventId, sessionId: s.body.id as number, clipId, data: bytes(size) };
}

// A connection inserted directly, its tokens encrypted the way the callback
// stores them. `refresh` names how the fake token endpoint treats it.
async function connect(userId: number, { refresh = "yt-refresh-ok", accessFor = 3_600_000, status = "ok" } = {}) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO youtube_connections (user_id, google_sub, email, refresh_token_enc, access_token_enc, access_expires_at,
       status, connected_at, verified_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc,
       access_expires_at = excluded.access_expires_at, status = excluded.status`
  )
    .bind(
      userId,
      `sub-${userId}`,
      `channel${userId}@example.com`,
      await encryptSecret(KEY, refresh),
      await encryptSecret(KEY, "yt-access-stored"),
      now + accessFor,
      status,
      now,
      now,
      now
    )
    .run();
}

const meta = { title: "VIR · 1:41.234", description: "Best lap.", privacy: "unlisted" };

async function startUpload(user: User, clipId: number) {
  const res = await user.api("POST", `/clips/${clipId}/youtube`, meta);
  expect(res.status).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM youtube_uploads WHERE clip_id = ?").bind(clipId).first<{ id: number }>();
  return row!.id;
}

const uploadRow = (id: number) =>
  env.DB.prepare("SELECT * FROM youtube_uploads WHERE id = ?").bind(id).first<Record<string, any>>();

// ---------- the fake YouTube -------------------------------------------------------

type Call = { url: string; method: string; headers: Headers; body: Uint8Array | null };

class FakeYouTube {
  calls: Call[] = [];
  received: Uint8Array[] = [];
  have = 0; // bytes the current session holds
  sessions = 0;
  // Per-request overrides, consumed in order: return a Response to answer
  // with it instead, or undefined to behave normally.
  script: ((c: Call) => Response | undefined)[] = [];
  // How many bytes short of what was sent to acknowledge on the chunk with
  // this index (0-based among chunk PUTs) — YouTube may keep less than a chunk.
  shortAck = new Map<number, number>();
  refresh: "ok" | "invalid_grant" | "down" = "ok";
  videos = new Map<string, boolean>(); // video id → still on YouTube
  chunkPuts = 0;

  constructor(readonly total: number) {}

  get fetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const raw = init?.body;
      const body = raw == null ? null : new Uint8Array(await new Response(raw as BodyInit).arrayBuffer());
      const call = { url, method: init?.method ?? "GET", headers, body };
      this.calls.push(call);
      const override = this.script.shift()?.(call);
      if (override) return override;
      return this.answer(call);
    }) as typeof fetch;
  }

  private answer(c: Call): Response {
    if (c.url === GOOGLE_TOKEN_URL) {
      if (this.refresh === "invalid_grant") return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (this.refresh === "down") return new Response("", { status: 503 });
      return Response.json({ access_token: "yt-access-fresh", expires_in: 3600 });
    }
    if (c.url === GOOGLE_REVOKE_URL) return new Response("{}", { status: 200 });
    if (c.url === YT_UPLOAD_URL) {
      this.sessions++;
      this.have = 0;
      this.received = [];
      return new Response(null, { status: 200, headers: { Location: `https://upload.example/session/${this.sessions}` } });
    }
    if (c.url.startsWith(`${YT_VIDEOS_URL}?`)) {
      const id = new URL(c.url).searchParams.get("id")!;
      return Response.json({ items: this.videos.get(id) ? [{ id }] : [] });
    }
    if (c.url.startsWith("https://upload.example/session/")) {
      if (!c.url.endsWith(`/${this.sessions}`)) return new Response("", { status: 404 });
      const range = c.headers.get("Content-Range") ?? "";
      const status = /^bytes \*\/(\d+)$/.exec(range);
      if (!status) {
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)!;
        const start = Number(m[1]);
        expect(start).toBe(this.have); // never skips, never re-sends acknowledged bytes
        expect(c.body!.length).toBe(Number(m[2]) - start + 1);
        const keep = c.body!.length - (this.shortAck.get(this.chunkPuts++) ?? 0);
        this.received.push(c.body!.subarray(0, keep));
        this.have += keep;
      }
      if (this.have >= this.total)
        return Response.json({ id: "vid-123", snippet: { channelTitle: "Fast Laps" } }, { status: 200 });
      return new Response(null, { status: 308, headers: this.have ? { Range: `bytes=0-${this.have - 1}` } : {} });
    }
    throw new Error(`unexpected fetch ${c.method} ${c.url}`);
  }

  uploaded(): Uint8Array {
    const out = new Uint8Array(this.have);
    let at = 0;
    for (const p of this.received) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  get initCalls() {
    return this.calls.filter((c) => c.url === YT_UPLOAD_URL);
  }
  get chunkCalls() {
    return this.calls.filter((c) => c.url.startsWith("https://upload.example/") && c.body?.length);
  }
}

// Step until the message would be acked, the way the queue would deliver them.
async function drive(id: number, fake: FakeYouTube, { now = Date.now(), max = 30 } = {}) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const r = await stepUpload(env, id, { fetch: fake.fetch, now, chunkBytes: CHUNK });
    results.push(r.action);
    if (r.action !== "next") return { last: r, results };
  }
  throw new Error("never finished");
}

// ---------- connecting ---------------------------------------------------------------

async function startConnect(path: string, cookie?: string) {
  const res = await SELF.fetch(`https://example.com${path}`, {
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });
  return res;
}

function flowCookie(res: Response): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  const m = /yt_connect=([^;]+)/.exec(set);
  expect(m, set).not.toBeNull();
  return `yt_connect=${m![1]}`;
}

const codeFor = (claims: Record<string, unknown>) => b64Url(JSON.stringify(claims));

async function callback(cookie: string, state: string, query: string) {
  return SELF.fetch(`https://example.com/youtube/callback?state=${state}&${query}`, {
    redirect: "manual",
    headers: { Cookie: cookie },
  });
}

describe("connecting YouTube", () => {
  it("goes through Google with the cookie session and comes back to Settings, upload scope only", async () => {
    const user = await signedInUser();
    const start = await startConnect("/youtube/connect", `session=${user.token}`);
    expect(start.status).toBe(302);
    const google = new URL(start.headers.get("Location")!);
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("client_id")).toBe("test-youtube-client-id");
    expect(google.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/youtube.upload");
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("prompt")).toBe("consent");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
    expect(google.searchParams.get("redirect_uri")).toBe("https://example.com/youtube/callback");
    const cookie = flowCookie(start);
    expect(start.headers.get("Set-Cookie")).toMatch(/HttpOnly/i);
    expect(start.headers.get("Set-Cookie")).toMatch(/SameSite=Lax/i);

    const back = await callback(cookie, google.searchParams.get("state")!, `code=${codeFor({ sub: "g-1", email: "me@channel.example" })}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("Location")).toBe("/#/settings?youtube=connected");

    const me = await user.api("GET", "/me");
    expect(me.body.user.youtube).toEqual({ available: true, connected: true, account: "me@channel.example", channel_title: null });
    const row = await env.DB.prepare("SELECT * FROM youtube_connections WHERE user_id = ?").bind(user.id).first<any>();
    expect(await decryptSecret(KEY, row.refresh_token_enc)).toBe("yt-refresh-g-1");
    expect(row.google_sub).toBe("g-1");
  });

  it("returns a web connect to the page it started from, and only to a hash route", async () => {
    const user = await signedInUser();
    const start = await startConnect(`/youtube/connect?next=${encodeURIComponent("#/event/12")}`, `session=${user.token}`);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const back = await callback(flowCookie(start), state, `code=${codeFor({ sub: "g-2", email: "a@b.example" })}`);
    expect(back.headers.get("Location")).toBe("/#/event/12?youtube=connected");

    const evil = await startConnect(`/youtube/connect?next=${encodeURIComponent("//evil.example")}`, `session=${user.token}`);
    const s2 = new URL(evil.headers.get("Location")!).searchParams.get("state")!;
    const back2 = await callback(flowCookie(evil), s2, `code=${codeFor({ sub: "g-2", email: "a@b.example" })}`);
    expect(back2.headers.get("Location")).toBe("/#/settings?youtube=connected");
  });

  it("goes through a single-use ticket for the phones, and back to the app's scheme", async () => {
    const user = await signedInUser();
    const minted = await user.api("POST", "/youtube/connect");
    expect(minted.status).toBe(200);
    const url = new URL(minted.body.url);
    expect(url.pathname).toBe("/youtube/connect");
    const ticket = url.searchParams.get("ticket")!;
    // Stored hashed.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM youtube_connect_tickets WHERE token_hash = ?").bind(ticket).first("n")).toBe(0);

    // No cookie: the ticket is who you are.
    const start = await startConnect(`/youtube/connect?ticket=${ticket}`);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const back = await callback(flowCookie(start), state, `code=${codeFor({ sub: "g-3", email: "phone@example.com" })}`);
    expect(back.headers.get("Location")).toBe("trackevolution://youtube?result=connected");
    expect((await user.api("GET", "/me")).body.user.youtube.connected).toBe(true);

    // Once only.
    const again = await startConnect(`/youtube/connect?ticket=${ticket}`);
    expect(again.headers.get("Location")).toBe("trackevolution://youtube?result=error");
  });

  it("refuses an expired ticket", async () => {
    const user = await signedInUser();
    const minted = await user.api("POST", "/youtube/connect");
    const ticket = new URL(minted.body.url).searchParams.get("ticket")!;
    await env.DB.prepare("UPDATE youtube_connect_tickets SET expires_at = ? WHERE user_id = ?").bind(Date.now() - 1, user.id).run();
    const start = await startConnect(`/youtube/connect?ticket=${ticket}`);
    expect(start.headers.get("Location")).toBe("trackevolution://youtube?result=error");
  });

  it("sends a signed-out browser to sign in first, and back", async () => {
    const res = await startConnect("/youtube/connect");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!, "https://example.com");
    expect(loc.pathname).toBe("/auth/login");
    expect(loc.searchParams.get("next")).toBe("/youtube/connect?next=%23%2Fsettings");
  });

  it("says denied for a declined consent, and for a grant without the upload scope", async () => {
    const user = await signedInUser();
    const start = await startConnect("/youtube/connect", `session=${user.token}`);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const declined = await callback(flowCookie(start), state, "error=access_denied");
    expect(declined.headers.get("Location")).toBe("/#/settings?youtube=denied");

    const start2 = await startConnect("/youtube/connect", `session=${user.token}`);
    const state2 = new URL(start2.headers.get("Location")!).searchParams.get("state")!;
    const unticked = await callback(
      flowCookie(start2),
      state2,
      `code=${codeFor({ sub: "g-4", email: "x@example.com", scope: "openid email" })}`
    );
    expect(unticked.headers.get("Location")).toBe("/#/settings?youtube=denied");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM youtube_connections WHERE user_id = ?").bind(user.id).first("n")).toBe(0);
  });

  it("refuses a callback whose state doesn't match, or with no flow cookie", async () => {
    const user = await signedInUser();
    const start = await startConnect("/youtube/connect", `session=${user.token}`);
    const bad = await callback(flowCookie(start), "not-the-state", `code=${codeFor({ sub: "g-5", email: "x@example.com" })}`);
    expect(bad.headers.get("Location")).toBe("/#/settings?youtube=error");
    const none = await SELF.fetch("https://example.com/youtube/callback?state=x&code=y", { redirect: "manual" });
    expect(none.headers.get("Location")).toBe("/#/settings?youtube=error");
    const failed = await (async () => {
      const s = await startConnect("/youtube/connect", `session=${user.token}`);
      return callback(flowCookie(s), new URL(s.headers.get("Location")!).searchParams.get("state")!, "code=yt-bad");
    })();
    expect(failed.headers.get("Location")).toBe("/#/settings?youtube=error");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM youtube_connections WHERE user_id = ?").bind(user.id).first("n")).toBe(0);
  });

  it("stores no usable credential in plaintext anywhere in D1", async () => {
    const user = await signedInProUser();
    const minted = await user.api("POST", "/youtube/connect");
    const ticket = new URL(minted.body.url).searchParams.get("ticket")!;
    const start = await startConnect(`/youtube/connect?ticket=${ticket}`);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    await callback(flowCookie(start), state, `code=${codeFor({ sub: "plain-check", email: "p@example.com" })}`);
    // A second ticket left unused, and an upload with a live session URL.
    const unused = new URL((await user.api("POST", "/youtube/connect")).body.url).searchParams.get("ticket")!;
    const { clipId } = await readyClip(user, 1000);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(1000);
    await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK });
    expect((await uploadRow(id))!.session_url_enc).toBeTruthy();

    const secrets = ["yt-refresh-plain-check", "yt-access-plain-check", "yt-access-fresh", ticket, unused, "upload.example"];
    const { results: tables } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'"
    ).all<{ name: string }>();
    for (const { name } of tables) {
      const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      const text = JSON.stringify(results);
      for (const s of secrets) expect(text.includes(s), `${s} in ${name}`).toBe(false);
    }
  });

  it("replaces a different Google account's grant and queues the old one's revocation, but not the same account's", async () => {
    const user = await signedInUser();
    const run = async (sub: string) => {
      const s = await startConnect("/youtube/connect", `session=${user.token}`);
      await callback(flowCookie(s), new URL(s.headers.get("Location")!).searchParams.get("state")!, `code=${codeFor({ sub, email: `${sub}@example.com` })}`);
    };
    const revocations = async () =>
      (await env.DB.prepare("SELECT refresh_token_enc FROM youtube_revocations").all<{ refresh_token_enc: string }>()).results;
    const before = (await revocations()).length;
    await run("acct-a");
    await run("acct-a");
    expect((await revocations()).length).toBe(before);
    await run("acct-b");
    const after = await revocations();
    expect(after.length).toBe(before + 1);
    const tokens = await Promise.all(after.map((r) => decryptSecret(KEY, r.refresh_token_enc)));
    expect(tokens).toContain("yt-refresh-acct-a");
  });
});

describe("disconnecting", () => {
  it("revokes at Google, deletes the grant, fails what was on its way — free, always", async () => {
    const user = await signedInProUser();
    await connect(user.id, { refresh: `yt-refresh-disconnect-${user.id}` });
    const { clipId } = await readyClip(user);
    const id = await startUpload(user, clipId);
    // Lapsed: disconnecting is never gated.
    await env.DB.prepare("UPDATE users SET entitled_until = ? WHERE id = ?").bind(Date.now() - 86_400_000, user.id).run();

    const res = await user.api("DELETE", "/youtube");
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM youtube_connections WHERE user_id = ?").bind(user.id).first("n")).toBe(0);
    // Revoked synchronously, so nothing waits for the cron.
    const left = (await env.DB.prepare("SELECT refresh_token_enc FROM youtube_revocations").all<{ refresh_token_enc: string }>()).results;
    for (const r of left) expect(await decryptSecret(KEY, r.refresh_token_enc)).not.toBe(`yt-refresh-disconnect-${user.id}`);
    const row = await uploadRow(id);
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe(TEXT.disconnected);
    expect((await user.api("GET", "/me")).body.user.youtube.connected).toBe(false);
    expect((await user.api("DELETE", "/youtube")).status).toBe(200);
  });
});

// ---------- draft and create ----------------------------------------------------------

describe("drafting and starting an upload", () => {
  it("drafts from the clip's own lap, session, track and car", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user);
    const res = await user.api("GET", `/clips/${clipId}/youtube/draft`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: "YouTube Raceway · 1:41.234 · Corvette C7",
      description:
        "Best lap of Session 1 at YouTube Raceway, 14 June 2026.\nLap starts at 0:03.\n\nLogged with Track Evolution — https://trackevolution.app",
      privacy: "unlisted",
      account: `channel${user.id}@example.com`,
    });
  });

  it("is Pro to draft and to upload, and 404 on another user's clip", async () => {
    const owner = await signedInProUser();
    await connect(owner.id);
    const { clipId } = await readyClip(owner);
    const free = await signedInUser();
    expect((await free.api("GET", `/clips/${clipId}/youtube/draft`)).status).toBe(402);
    expect((await free.api("POST", `/clips/${clipId}/youtube`, meta)).status).toBe(402);
    const other = await signedInProUser();
    await connect(other.id);
    expect((await other.api("GET", `/clips/${clipId}/youtube/draft`)).status).toBe(404);
    expect((await other.api("POST", `/clips/${clipId}/youtube`, meta)).status).toBe(404);
    expect((await other.api("GET", `/clips/${clipId}/youtube`)).status).toBe(404);
  });

  it("refuses without a connection, on a revoked one, and on a clip still uploading", async () => {
    const user = await signedInProUser();
    const { clipId } = await readyClip(user);
    expect(await user.api("POST", `/clips/${clipId}/youtube`, meta)).toMatchObject({
      status: 409,
      body: { error: "youtube not connected" },
    });
    await connect(user.id, { status: "revoked" });
    expect((await user.api("POST", `/clips/${clipId}/youtube`, meta)).status).toBe(409);

    await connect(user.id);
    const eventId = await createEvent(user.api, { track_name: "Half Raceway", start_date: "2026-06-15" });
    const s = await user.api("POST", `/events/${eventId}/sessions`, { laps: [LAP_MS] });
    const pending = await user.api("POST", `/sessions/${s.body.id}/clip`, {
      time_ms: LAP_MS,
      size_bytes: 100,
      duration_ms: LAP_MS,
      lap_offset_ms: 0,
    });
    expect(await user.api("POST", `/clips/${pending.body.clip_id}/youtube`, meta)).toMatchObject({
      status: 409,
      body: { error: "clip not ready" },
    });
    expect((await user.api("GET", `/clips/${pending.body.clip_id}/youtube/draft`)).status).toBe(409);
  });

  it("names each metadata rule it refuses", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user);
    for (const [body, error] of [
      [{ ...meta, title: "" }, "title is required"],
      [{ ...meta, title: "x".repeat(101) }, "title must be at most 100 characters"],
      [{ ...meta, description: "é".repeat(2501) }, "description must be at most 5000 bytes"],
      [{ ...meta, title: "<b>fast</b>" }, "title and description can't contain < or >"],
      [{ ...meta, privacy: "friends" }, "privacy must be private, unlisted or public"],
    ] as const) {
      expect(await user.api("POST", `/clips/${clipId}/youtube`, body)).toMatchObject({ status: 400, body: { error } });
    }
  });

  it("queues one upload per clip, answers its status, and never a second while one is on its way or done", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId, eventId } = await readyClip(user);
    const res = await user.api("POST", `/clips/${clipId}/youtube`, meta);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "queued", progress: 0, privacy: "unlisted", url: null, error: null });
    expect((await user.api("GET", `/clips/${clipId}/youtube`)).body).toEqual(res.body);
    expect(await user.api("POST", `/clips/${clipId}/youtube`, meta)).toMatchObject({
      status: 409,
      body: { error: "youtube upload in progress" },
    });
    const clip = (await user.api("GET", `/events/${eventId}`)).body.sessions[0].laps[1].clip;
    expect(clip.youtube).toEqual({ status: "queued", video_id: null, url: null, privacy: "unlisted" });

    await env.DB.prepare("UPDATE youtube_uploads SET status = 'done', video_id = 'abc' WHERE clip_id = ?").bind(clipId).run();
    expect(await user.api("POST", `/clips/${clipId}/youtube`, meta)).toMatchObject({
      status: 409,
      body: { error: "already on youtube" },
    });
  });

  it("retries a failed upload on the same row, with the new words", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user);
    const id = await startUpload(user, clipId);
    await env.DB.prepare("UPDATE youtube_uploads SET status = 'failed', error = 'x', bytes_sent = 99, restarts = 2 WHERE id = ?")
      .bind(id)
      .run();
    const again = await user.api("POST", `/clips/${clipId}/youtube`, { ...meta, privacy: "public", title: "Again" });
    expect(again.status).toBe(202);
    const row = await uploadRow(id);
    expect(row).toMatchObject({ status: "queued", title: "Again", privacy: "public", error: null, bytes_sent: 0, restarts: 0 });
  });

  it(`allows ${MAX_DAILY_UPLOADS_PER_USER} uploads a day and says so at the next`, async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const clips = [];
    for (let i = 0; i <= MAX_DAILY_UPLOADS_PER_USER; i++) clips.push((await readyClip(user, 100, `Limit Raceway ${i}`)).clipId);
    for (const id of clips.slice(0, MAX_DAILY_UPLOADS_PER_USER))
      expect((await user.api("POST", `/clips/${id}/youtube`, meta)).status).toBe(202);
    expect(await user.api("POST", `/clips/${clips.at(-1)}/youtube`, meta)).toMatchObject({
      status: 429,
      body: { error: "youtube upload limit" },
    });
    // A day later, it goes.
    await env.DB.prepare("UPDATE youtube_uploads SET created_at = created_at - 86400001 WHERE user_id = ?").bind(user.id).run();
    expect((await user.api("POST", `/clips/${clips.at(-1)}/youtube`, meta)).status).toBe(202);
  });
});

// ---------- the queue step ------------------------------------------------------------

describe("the upload, step by step", () => {
  it("mints a session, sends each chunk from where YouTube says it is, and lands on the lap", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const size = 1_200_000; // four 256 KiB chunks and a short fifth
    const { clipId, eventId, data } = await readyClip(user, size);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(size);
    // YouTube keeps 256 KiB less than the second chunk: the third must start
    // there, not where our own sum would put it.
    fake.shortAck.set(1, CHUNK);

    const { last, results } = await drive(id, fake);
    expect(last).toEqual({ action: "ack" });
    expect(results[0]).toBe("next"); // init
    expect(fake.initCalls).toHaveLength(1);
    const init = fake.initCalls[0];
    expect(init.headers.get("X-Upload-Content-Length")).toBe(String(size));
    expect(init.headers.get("X-Upload-Content-Type")).toBe("video/mp4");
    expect(init.headers.get("Authorization")).toBe("Bearer yt-access-stored");
    const resource = JSON.parse(new TextDecoder().decode(init.body!));
    expect(resource).toEqual({
      snippet: {
        title: meta.title,
        description: meta.description,
        categoryId: "2",
        tags: ["track day", "HPDE", "YouTube Raceway", "Corvette C7"],
      },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
    });
    expect(JSON.stringify(resource)).not.toMatch(/recordingDetails|location/i);

    expect(fake.chunkCalls.map((c) => c.headers.get("Content-Range"))).toEqual([
      `bytes 0-${CHUNK - 1}/${size}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${size}`,
      // The short ack: the third chunk re-sends from 256 KiB in.
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${size}`,
      `bytes ${2 * CHUNK}-${3 * CHUNK - 1}/${size}`,
      `bytes ${3 * CHUNK}-${4 * CHUNK - 1}/${size}`,
      `bytes ${4 * CHUNK}-${size - 1}/${size}`,
    ]);
    expect(firstDifference(fake.uploaded(), data)).toBe(-1);

    const row = await uploadRow(id);
    expect(row).toMatchObject({ status: "done", video_id: "vid-123", session_url_enc: null, error: null, lease_until: null });
    const conn = await env.DB.prepare("SELECT channel_title FROM youtube_connections WHERE user_id = ?").bind(user.id).first();
    expect(conn).toEqual({ channel_title: "Fast Laps" });
    const clip = (await user.api("GET", `/events/${eventId}`)).body.sessions[0].laps[1].clip;
    expect(clip.youtube).toEqual({ status: "done", video_id: "vid-123", url: "https://youtu.be/vid-123", privacy: "unlisted" });
    expect((await user.api("GET", `/clips/${clipId}/youtube`)).body).toEqual({
      status: "done",
      progress: 1,
      privacy: "unlisted",
      url: "https://youtu.be/vid-123",
      error: null,
    });
    // A lapsed owner keeps the link.
    await env.DB.prepare("UPDATE users SET entitled_until = ? WHERE id = ?").bind(Date.now() - 86_400_000, user.id).run();
    expect((await user.api("GET", `/clips/${clipId}/youtube`)).body.url).toBe("https://youtu.be/vid-123");
    expect((await user.api("GET", `/events/${eventId}`)).body.sessions[0].laps[1].clip.youtube.status).toBe("done");
    expect((await user.api("GET", "/me")).body.user.youtube.channel_title).toBe("Fast Laps");
  }, MULTI_CHUNK_TIMEOUT_MS);

  it("reports progress as YouTube acknowledges it", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user, 4 * CHUNK);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(4 * CHUNK);
    await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK });
    await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK });
    expect((await user.api("GET", `/clips/${clipId}/youtube`)).body).toMatchObject({ status: "uploading", progress: 0.25 });
  });

  it("acks a duplicate delivery without sending anything", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user, 1000);
    const id = await startUpload(user, clipId);
    await env.DB.prepare("UPDATE youtube_uploads SET lease_until = ? WHERE id = ?").bind(Date.now() + 60_000, id).run();
    const fake = new FakeYouTube(1000);
    expect(await stepUpload(env, id, { fetch: fake.fetch, now: Date.now() })).toEqual({ action: "ack" });
    expect(fake.calls).toHaveLength(0);
    // …and a message for a row that is gone.
    expect(await stepUpload(env, 987654, { fetch: fake.fetch, now: Date.now() })).toEqual({ action: "ack" });
  });

  it("restarts a session YouTube has forgotten, at most twice", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId, data } = await readyClip(user, 3 * CHUNK);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(3 * CHUNK);
    // Init, one chunk, then the session is gone.
    await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK });
    await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK });
    fake.script.push(() => new Response("", { status: 404 }));
    expect(await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK })).toEqual({ action: "next" });
    expect(await uploadRow(id)).toMatchObject({ status: "queued", bytes_sent: 0, restarts: 1, session_url_enc: null });
    const { last } = await drive(id, fake);
    expect(last.action).toBe("ack");
    expect(fake.initCalls).toHaveLength(2);
    expect(firstDifference(fake.uploaded(), data)).toBe(-1);
    expect((await uploadRow(id))!.status).toBe("done");

    // A row already restarted twice fails instead.
    const { clipId: c2 } = await readyClip(user, 2 * CHUNK, "Restart Raceway");
    const id2 = await startUpload(user, c2);
    const fake2 = new FakeYouTube(2 * CHUNK);
    await stepUpload(env, id2, { fetch: fake2.fetch, now: Date.now(), chunkBytes: CHUNK });
    await env.DB.prepare("UPDATE youtube_uploads SET restarts = 2 WHERE id = ?").bind(id2).run();
    fake2.script.push(() => new Response("", { status: 410 }));
    expect(await stepUpload(env, id2, { fetch: fake2.fetch, now: Date.now(), chunkBytes: CHUNK })).toEqual({ action: "ack" });
    expect(await uploadRow(id2)).toMatchObject({ status: "failed", error: TEXT.restarts });
  }, MULTI_CHUNK_TIMEOUT_MS);

  it("asks where YouTube got to after a 5xx or a dropped connection, then retries with backoff", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId, data } = await readyClip(user, 2 * CHUNK);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(2 * CHUNK);
    await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK });

    // YouTube took the chunk but answered 503: the probe learns it has it.
    fake.script.push((c) => {
      (fake as any).answer(c); // keep the bytes
      return new Response("", { status: 503 });
    });
    const r = await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK, attempt: 3 });
    expect(r).toEqual({ action: "next" });
    const probe = fake.calls.at(-1)!;
    expect(probe.headers.get("Content-Range")).toBe(`bytes */${2 * CHUNK}`);
    expect((await uploadRow(id))!.bytes_sent).toBe(CHUNK);

    // A transport failure whose probe gets nothing either: retry, with the
    // attempt's backoff.
    fake.script.push(() => {
      throw new TypeError("network");
    });
    fake.script.push(() => {
      throw new TypeError("network");
    });
    expect(await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK, attempt: 3 })).toEqual({
      action: "retry",
      delaySeconds: 120,
    });
    expect((await uploadRow(id))!.lease_until).toBeNull();
    const { last } = await drive(id, fake);
    expect(last.action).toBe("ack");
    expect(firstDifference(fake.uploaded(), data)).toBe(-1);
  }, MULTI_CHUNK_TIMEOUT_MS);

  it("waits for Pacific midnight on YouTube's quotaExceeded, and on a spent project budget", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user, 1000);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(1000);
    fake.script.push(() =>
      Response.json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 })
    );
    const now = Date.parse("2026-06-15T06:00:00Z"); // 23:00 Pacific
    expect(await stepUpload(env, id, { fetch: fake.fetch, now })).toEqual({ action: "later", delaySeconds: 3600 });
    expect(await uploadRow(id)).toMatchObject({ status: "queued", error: TEXT.waitingQuota });
    expect((await user.api("GET", `/clips/${clipId}/youtube`)).body.error).toBe(TEXT.waitingQuota);
  });

  it("counts the project budget per Pacific day", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user, 1000, "Budget Raceway");
    const id = await startUpload(user, clipId);
    const now = Date.parse("2026-07-01T19:00:00Z");
    const budgeted = { ...env, YOUTUBE_DAILY_BUDGET: "1" };
    await env.DB.prepare("INSERT OR REPLACE INTO youtube_daily (day, uploads) VALUES ('2026-07-01', 1)").run();
    const fake = new FakeYouTube(1000);
    expect(await stepUpload(budgeted, id, { fetch: fake.fetch, now })).toEqual({
      action: "later",
      delaySeconds: secondsToPacificMidnight(now),
    });
    expect(fake.initCalls).toHaveLength(0);
    // Tomorrow it goes, and the new day is counted.
    const tomorrow = now + 86_400_000;
    expect(await stepUpload(budgeted, id, { fetch: fake.fetch, now: tomorrow })).toEqual({ action: "next" });
    expect(await env.DB.prepare("SELECT uploads FROM youtube_daily WHERE day = '2026-07-02'").first("uploads")).toBe(1);
    expect((await uploadRow(id))!.error).toBeNull();
  });

  it("fails in words when the grant is gone, and marks the connection", async () => {
    const user = await signedInProUser();
    await connect(user.id, { accessFor: 0 });
    const { clipId } = await readyClip(user, 1000);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(1000);
    fake.refresh = "invalid_grant";
    expect(await stepUpload(env, id, { fetch: fake.fetch, now: Date.now() })).toEqual({ action: "ack" });
    expect(await uploadRow(id)).toMatchObject({ status: "failed", error: TEXT.revoked });
    expect((await user.api("GET", "/me")).body.user.youtube).toMatchObject({ connected: false, account: `channel${user.id}@example.com` });
  });

  it("refreshes an access token about to expire, and stores the new one encrypted", async () => {
    const user = await signedInProUser();
    await connect(user.id, { accessFor: 60_000 });
    const { clipId } = await readyClip(user, 1000);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(1000);
    await stepUpload(env, id, { fetch: fake.fetch, now: Date.now() });
    expect(fake.initCalls[0].headers.get("Authorization")).toBe("Bearer yt-access-fresh");
    const row = await env.DB.prepare("SELECT access_token_enc FROM youtube_connections WHERE user_id = ?").bind(user.id).first<any>();
    expect(await decryptSecret(KEY, row.access_token_enc)).toBe("yt-access-fresh");
  });

  it("fails on a rejected title in our words", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user, 1000);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(1000);
    fake.script.push(() => Response.json({ error: { errors: [{ reason: "invalidTitle" }] } }, { status: 400 }));
    expect(await stepUpload(env, id, { fetch: fake.fetch, now: Date.now() })).toEqual({ action: "ack" });
    expect(await uploadRow(id)).toMatchObject({ status: "failed", error: "YouTube didn't accept the title. Edit it and try again." });
  });

  it("acks once the clip is deleted mid-upload, and the row goes with it", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user, 2 * CHUNK);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(2 * CHUNK);
    await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK });
    expect((await user.api("DELETE", `/clips/${clipId}`)).status).toBe(200);
    expect(await uploadRow(id)).toBeNull();
    const before = fake.calls.length;
    expect(await stepUpload(env, id, { fetch: fake.fetch, now: Date.now(), chunkBytes: CHUNK })).toEqual({ action: "ack" });
    expect(fake.calls.length).toBe(before);
  });
});

describe("the queue handler", () => {
  it("sends the next step, acks a finished one, and the dead-letter queue fails the row", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const { clipId } = await readyClip(user, 1000);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(1000);

    const batch = createMessageBatch<{ upload_id: number }>(YOUTUBE_QUEUE_NAME, [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { upload_id: id } },
    ]);
    const ctx = createExecutionContext();
    await youtubeQueue(batch, env, { fetch: fake.fetch });
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["m1"]);
    expect(result.retryMessages).toEqual([]);
    expect((await uploadRow(id))!.status).toBe("uploading");

    // Through the Worker's own export, a message for nothing acks.
    const gone = createMessageBatch<{ upload_id: number }>(YOUTUBE_QUEUE_NAME, [
      { id: "m2", timestamp: new Date(), attempts: 1, body: { upload_id: 99999999 } },
    ]);
    const ctx2 = createExecutionContext();
    await worker.queue!(gone as MessageBatch<{ upload_id: number }>, env);
    expect((await getQueueResult(gone, ctx2)).explicitAcks).toEqual(["m2"]);

    const dead = createMessageBatch<{ upload_id: number }>(YOUTUBE_DLQ_NAME, [
      { id: "m3", timestamp: new Date(), attempts: 1, body: { upload_id: id } },
    ]);
    const ctx3 = createExecutionContext();
    await worker.queue!(dead as MessageBatch<{ upload_id: number }>, env);
    expect((await getQueueResult(dead, ctx3)).explicitAcks).toEqual(["m3"]);
    expect(await uploadRow(id)).toMatchObject({ status: "failed", error: TEXT.deadLetter });
  });

  it("retries a message whose step reports an outage", async () => {
    const user = await signedInProUser();
    await connect(user.id, { accessFor: 0 });
    const { clipId } = await readyClip(user, 1000);
    const id = await startUpload(user, clipId);
    const fake = new FakeYouTube(1000);
    fake.refresh = "down";
    const batch = createMessageBatch<{ upload_id: number }>(YOUTUBE_QUEUE_NAME, [
      { id: "m4", timestamp: new Date(), attempts: 2, body: { upload_id: id } },
    ]);
    const ctx = createExecutionContext();
    await youtubeQueue(batch, env, { fetch: fake.fetch });
    const result = await getQueueResult(batch, ctx);
    // getQueueResult doesn't report the delay; the step's backoff is pinned
    // above ("asks where YouTube got to…").
    expect(result.retryMessages.map((m: { msgId: string }) => m.msgId)).toEqual(["m4"]);
    expect((await uploadRow(id))!.status).toBe("queued");
  });
});

// ---------- coaches, sharing --------------------------------------------------------

describe("what others see", () => {
  it("gives a coach a 404 on every route here, and no youtube on the clip", async () => {
    const student = await signedInProUser();
    await connect(student.id);
    const { clipId, eventId } = await readyClip(student);
    await startUpload(student, clipId);
    const coach = await signedInProUser();
    await env.DB.prepare("INSERT INTO coach_grants (student_id, coach_id, created_at) VALUES (?, ?, ?)")
      .bind(student.id, coach.id, Date.now())
      .run();
    const as = (method: string, path: string, body?: unknown) => coach.api(method, `/students/${student.id}${path}`, body);
    for (const [method, path, body] of [
      ["GET", `/clips/${clipId}/youtube`],
      ["GET", `/clips/${clipId}/youtube/draft`],
      ["POST", `/clips/${clipId}/youtube`, meta],
      ["POST", "/youtube/connect"],
      ["DELETE", "/youtube"],
    ] as const) {
      expect((await as(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    const ev = await as("GET", `/events/${eventId}`);
    expect(ev.status).toBe(200);
    const clip = ev.body.sessions[0].laps[1].clip;
    expect(clip).not.toBeNull();
    expect("youtube" in clip).toBe(false);
  });

  it("carries no youtube on a shared event or the public share page", async () => {
    const owner = await signedInProUser();
    await connect(owner.id);
    const { clipId, eventId } = await readyClip(owner);
    await startUpload(owner, clipId);
    await env.DB.prepare("UPDATE youtube_uploads SET status = 'done', video_id = 'shared-vid' WHERE clip_id = ?").bind(clipId).run();
    const link = await owner.api("POST", `/events/${eventId}/share`);
    const shared = await SELF.fetch(`https://example.com/api/share/e/${link.body.token}`);
    const text = await shared.text();
    expect(shared.status).toBe(200);
    expect(text).not.toContain("shared-vid");
    expect(text).not.toContain("youtube");

    expect((await owner.api("PUT", "/share", { slug: `yt-${owner.id}` })).status).toBe(200);
    const page = await SELF.fetch(`https://example.com/api/share/yt-${owner.id}`);
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).not.toContain("shared-vid");
    expect(pageText).not.toContain("youtube");
  });
});

// ---------- revocations and the cron --------------------------------------------------

describe("the daily sweep", () => {
  it("revokes a deleted account's grant: the cascade leaves the tombstone, the cron sends it", async () => {
    const user = await signedInUser();
    await connect(user.id, { refresh: `yt-refresh-account-${user.id}` });
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
    const rows = (await env.DB.prepare("SELECT refresh_token_enc FROM youtube_revocations").all<{ refresh_token_enc: string }>()).results;
    const mine = [];
    for (const r of rows) if ((await decryptSecret(KEY, r.refresh_token_enc)) === `yt-refresh-account-${user.id}`) mine.push(r);
    expect(mine).toHaveLength(1);

    const fake = new FakeYouTube(0);
    // One revoke Google answers with invalid_token (already forgotten) and
    // one outage: the first counts as done, the outage waits for tomorrow.
    let first = true;
    fake.script = [];
    const f: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === GOOGLE_REVOKE_URL) {
        const token = new URLSearchParams(String(init?.body)).get("token")!;
        if (token === `yt-refresh-account-${user.id}`) return new Response("{}", { status: 200 });
        if (first) {
          first = false;
          return Response.json({ error: "invalid_token" }, { status: 400 });
        }
        return new Response("", { status: 503 });
      }
      return fake.fetch(input, init);
    };
    await sweepYouTube(env, Date.now(), f);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM youtube_revocations WHERE refresh_token_enc = ?")
        .bind(mine[0].refresh_token_enc)
        .first("n")
    ).toBe(0);
  });

  it("deletes a done upload whose video is gone, keeps one that is there, and re-checks the grant", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const a = await readyClip(user, 100, "Gone Raceway");
    const b = await readyClip(user, 100, "There Raceway");
    const old = Date.now() - 26 * 86_400_000;
    for (const [clip, vid] of [[a.clipId, "gone-vid"], [b.clipId, "there-vid"]] as const) {
      await env.DB.prepare(
        `INSERT INTO youtube_uploads (user_id, clip_id, status, title, description, privacy, video_id, created_at, verified_at, updated_at)
         VALUES (?, ?, 'done', 't', 'd', 'unlisted', ?, ?, ?, ?)`
      )
        .bind(user.id, clip, vid, old, old, old)
        .run();
    }
    await env.DB.prepare("UPDATE youtube_connections SET verified_at = ? WHERE user_id = ?").bind(old, user.id).run();
    const fake = new FakeYouTube(0);
    fake.videos.set("there-vid", true);
    const now = Date.now();
    await sweepYouTube(env, now, fake.fetch);
    expect(await env.DB.prepare("SELECT clip_id FROM youtube_uploads WHERE user_id = ?").bind(user.id).all()).toMatchObject({
      results: [{ clip_id: b.clipId }],
    });
    expect(await env.DB.prepare("SELECT verified_at FROM youtube_uploads WHERE clip_id = ?").bind(b.clipId).first("verified_at")).toBe(now);
    expect(await env.DB.prepare("SELECT verified_at FROM youtube_connections WHERE user_id = ?").bind(user.id).first("verified_at")).toBe(now);
    // The lap offers the upload again.
    expect((await user.api("GET", `/events/${a.eventId}`)).body.sessions[0].laps[1].clip.youtube).toBeNull();
  });

  it("deletes a done upload with no usable grant behind it, and a connection revoked long ago", async () => {
    const user = await signedInProUser();
    await connect(user.id, { status: "revoked" });
    const { clipId } = await readyClip(user, 100, "Orphan Raceway");
    const old = Date.now() - 26 * 86_400_000;
    await env.DB.prepare(
      `INSERT INTO youtube_uploads (user_id, clip_id, status, title, description, privacy, video_id, created_at, verified_at, updated_at)
       VALUES (?, ?, 'done', 't', 'd', 'unlisted', 'v', ?, ?, ?)`
    )
      .bind(user.id, clipId, old, old, old)
      .run();
    await env.DB.prepare("UPDATE youtube_connections SET updated_at = ? WHERE user_id = ?").bind(old, user.id).run();
    await sweepYouTube(env, Date.now(), new FakeYouTube(0).fetch);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM youtube_uploads WHERE clip_id = ?").bind(clipId).first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM youtube_connections WHERE user_id = ?").bind(user.id).first("n")).toBe(0);
  });

  it("marks a grant revoked when the re-check finds it gone", async () => {
    const user = await signedInUser();
    await connect(user.id);
    await env.DB.prepare("UPDATE youtube_connections SET verified_at = ? WHERE user_id = ?").bind(Date.now() - 26 * 86_400_000, user.id).run();
    const fake = new FakeYouTube(0);
    fake.refresh = "invalid_grant";
    await sweepYouTube(env, Date.now(), fake.fetch);
    expect(await env.DB.prepare("SELECT status FROM youtube_connections WHERE user_id = ?").bind(user.id).first("status")).toBe("revoked");
  });

  it("re-enqueues a queued upload that lost its message, and fails one stuck uploading for two days", async () => {
    const user = await signedInProUser();
    await connect(user.id);
    const a = await readyClip(user, 100, "Lost Raceway");
    const b = await readyClip(user, 100, "Stuck Raceway");
    const lost = await startUpload(user, a.clipId);
    const stuck = await startUpload(user, b.clipId);
    const now = Date.now();
    await env.DB.prepare("UPDATE youtube_uploads SET updated_at = ? WHERE id = ?").bind(now - STALE_STEP_MS - 1, lost).run();
    await env.DB.prepare("UPDATE youtube_uploads SET status = 'uploading', updated_at = ? WHERE id = ?")
      .bind(now - DEAD_UPLOAD_MS - 1, stuck)
      .run();
    const report = await sweepYouTube(env, now, new FakeYouTube(0).fetch);
    expect(report.requeued).toBeGreaterThanOrEqual(1);
    expect(await uploadRow(lost)).toMatchObject({ status: "queued", updated_at: now });
    expect(await uploadRow(stuck)).toMatchObject({ status: "failed", error: TEXT.stalled });
  });

  it("drops expired connect tickets", async () => {
    const user = await signedInUser();
    await user.api("POST", "/youtube/connect");
    await env.DB.prepare("UPDATE youtube_connect_tickets SET expires_at = 1 WHERE user_id = ?").bind(user.id).run();
    await sweepYouTube(env, Date.now(), new FakeYouTube(0).fetch);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM youtube_connect_tickets WHERE user_id = ?").bind(user.id).first("n")).toBe(0);
  });
});
