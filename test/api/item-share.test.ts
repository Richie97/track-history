import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInProUser, signedInUser } from "./helpers";
import { circleTrace, telemetrySession } from "./telemetry-fixture";

// NS-48: share one event or one session. The owner's half (create, read,
// revoke), the public read and its privacy, the session narrowing, the owner's
// tier deciding the telemetry and the video, and the link-preview page.

type User = Awaited<ReturnType<typeof signedInUser>>;

async function anon(path: string) {
  const res = await SELF.fetch(`https://example.com${path}`);
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
}

// An event with private bits everywhere and two telemetry sessions.
async function dayWithTwoSessions(user: User) {
  const eventId = await createEvent(user.api, {
    track_name: "Share Raceway",
    start_date: "2026-06-14",
    notes: "secret event notes",
    best_time_ms: 99_000,
    cost_entry_cents: 45_000,
    checklist: [{ text: "secret checklist", done: false }],
    car: "Corvette C7",
  });
  const s1 = await user.api("POST", `/events/${eventId}/sessions`, {
    ...telemetrySession([104_000, 102_000, 103_000], "Session 1"),
    notes: "secret session notes",
    trace: circleTrace(),
  });
  const s2 = await user.api("POST", `/events/${eventId}/sessions`, telemetrySession([101_500, 101_000, 101_800], "Session 2"));
  expect(s1.status).toBe(201);
  expect(s2.status).toBe(201);
  return { eventId, s1: s1.body.id as number, s2: s2.body.id as number };
}

const tokenOf = (url: string) => url.split("/").pop()!;

describe("the owner's share routes", () => {
  it("mints one link per event, answers it again, and revokes it", async () => {
    const user = await signedInUser();
    const { eventId } = await dayWithTwoSessions(user);

    expect((await user.api("GET", `/events/${eventId}/share`)).status).toBe(404);
    const first = await user.api("POST", `/events/${eventId}/share`);
    expect(first.status).toBe(201);
    expect(first.body.kind).toBe("event");
    expect(first.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.body.url).toBe(`https://example.com/share/e/${first.body.token}`);

    const again = await user.api("POST", `/events/${eventId}/share`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect((await user.api("GET", `/events/${eventId}/share`)).body).toEqual(first.body);

    expect((await user.api("DELETE", `/events/${eventId}/share`)).body).toEqual({ ok: true });
    expect((await anon(`/api/share/e/${first.body.token}`)).status).toBe(404);
    expect((await user.api("DELETE", `/events/${eventId}/share`)).status).toBe(404);
    // A new Share after stopping is a new link: the old one stays dead.
    const fresh = await user.api("POST", `/events/${eventId}/share`);
    expect(fresh.status).toBe(201);
    expect(fresh.body.token).not.toBe(first.body.token);
  });

  it("keeps an event's link and its sessions' links apart", async () => {
    const user = await signedInUser();
    const { eventId, s1, s2 } = await dayWithTwoSessions(user);
    const ev = await user.api("POST", `/events/${eventId}/share`);
    const a = await user.api("POST", `/sessions/${s1}/share`);
    const b = await user.api("POST", `/sessions/${s2}/share`);
    expect(a.body.kind).toBe("session");
    expect(a.body.url).toContain("/share/s/");
    expect(new Set([ev.body.token, a.body.token, b.body.token]).size).toBe(3);
    await user.api("DELETE", `/sessions/${s1}/share`);
    expect((await anon(`/api/share/s/${b.body.token}`)).status).toBe(200);
    expect((await anon(`/api/share/e/${ev.body.token}`)).status).toBe(200);
  });

  it("never touches another driver's events or sessions", async () => {
    const owner = await signedInUser();
    const other = await signedInUser();
    const { eventId, s1 } = await dayWithTwoSessions(owner);
    await owner.api("POST", `/events/${eventId}/share`);
    for (const path of [`/events/${eventId}/share`, `/sessions/${s1}/share`]) {
      expect((await other.api("POST", path)).status, path).toBe(404);
      expect((await other.api("GET", path)).status, path).toBe(404);
      expect((await other.api("DELETE", path)).status, path).toBe(404);
    }
    expect((await owner.api("GET", `/events/${eventId}/share`)).status).toBe(200);
  });

  it("goes when the item goes", async () => {
    const user = await signedInUser();
    const { eventId, s1 } = await dayWithTwoSessions(user);
    const s = await user.api("POST", `/sessions/${s1}/share`);
    const e = await user.api("POST", `/events/${eventId}/share`);
    await user.api("DELETE", `/sessions/${s1}`);
    expect((await anon(`/api/share/s/${s.body.token}`)).status).toBe(404);
    await user.api("DELETE", `/events/${eventId}`);
    expect((await anon(`/api/share/e/${e.body.token}`)).status).toBe(404);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM item_shares WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

describe("GET /api/share/(e|s)/:token (public)", () => {
  it("serves the event's laps, line and telemetry — and none of its private fields", async () => {
    const user = await signedInProUser();
    const { eventId } = await dayWithTwoSessions(user);
    const { body: link } = await user.api("POST", `/events/${eventId}/share`);

    const res = await anon(`/api/share/e/${link.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { kind, name, pro, session_id, event } = res.body;
    expect(kind).toBe("event");
    expect(name).toBe("Test User");
    expect(pro).toBe(true);
    expect(session_id).toBeNull();
    expect(event.track_name).toBe("Share Raceway");
    expect(event.car).toBe("Corvette C7");
    expect(event.sessions).toHaveLength(2);
    expect(event.sessions[0].laps).toHaveLength(3);
    expect(event.sessions[0].trace.length).toBeGreaterThan(10);
    expect(event.sessions[0].channels.laps[0].rpm).toBeDefined();

    // Hidden-but-placed fields are null / [] so the native models decode it.
    expect(event.notes).toBeNull();
    expect(event.checklist).toBeNull();
    expect(event.cost_entry_cents).toBeNull();
    expect(event.cost_cents).toBeNull();
    expect(event.vehicle_id).toBeNull();
    expect(event.track_hours).toBeNull();
    expect(event.setups).toEqual([]);
    expect(event.sessions[0].notes).toBeNull();
    const raw = JSON.stringify(res.body);
    for (const secret of ["secret event notes", "secret session notes", "secret checklist", user.email]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("a session link carries that session alone, with the header worked out from it", async () => {
    const user = await signedInProUser();
    const { s1, s2 } = await dayWithTwoSessions(user);
    const { body: link } = await user.api("POST", `/sessions/${s1}/share`);

    const { status, body } = await anon(`/api/share/s/${link.token}`);
    expect(status).toBe(200);
    expect(body.kind).toBe("session");
    expect(body.session_id).toBe(s1);
    expect(body.event.sessions.map((s: any) => s.id)).toEqual([s1]);
    // Session 2's 1:41.0 and the event's typed 1:39.0 are not this session's.
    expect(body.event.best_ms).toBe(102_000);
    expect(body.event.best_time_ms).toBeNull();
    expect(body.event.lap_count).toBe(3);
    expect(body.event.session_count).toBe(1);
    expect(body.event.ambient_lo_c).toBe(24);
    for (const l of body.event.sessions[0].laps) expect(l.session_id).not.toBe(s2);
  });

  it("answers 404 for an unknown token, a revoked one, or the wrong prefix", async () => {
    const user = await signedInUser();
    const { eventId, s1 } = await dayWithTwoSessions(user);
    const ev = (await user.api("POST", `/events/${eventId}/share`)).body;
    const ss = (await user.api("POST", `/sessions/${s1}/share`)).body;
    expect((await anon(`/api/share/s/${ev.token}`)).status).toBe(404);
    expect((await anon(`/api/share/e/${ss.token}`)).status).toBe(404);
    expect((await anon(`/api/share/e/${"A".repeat(22)}`)).status).toBe(404);
    expect((await anon(`/api/share/e/short`)).status).toBe(404);
  });

  it("shows a free owner's free half of the telemetry, and no video", async () => {
    const user = await signedInUser();
    const { eventId } = await dayWithTwoSessions(user);
    // A clip row on a lap, made ready directly: a free account can't create one.
    const lap = await env.DB.prepare(
      "SELECT l.id FROM laps l JOIN sessions s ON s.id = l.session_id WHERE s.event_id = ? LIMIT 1"
    )
      .bind(eventId)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO lap_clips (user_id, lap_id, status, r2_key, size_bytes, duration_ms, lap_offset_ms, created_at, updated_at)
       VALUES (?, ?, 'ready', 'clips/x.mp4', 10, 1000, 0, ?, ?)`
    )
      .bind(user.id, lap!.id, Date.now(), Date.now())
      .run();
    // The owner still sees it (the locked player is their offer).
    const own = (await user.api("GET", `/events/${eventId}`)).body;
    expect(own.sessions.flatMap((s: any) => s.laps).some((l: any) => l.clip)).toBe(true);
    const { body: link } = await user.api("POST", `/events/${eventId}/share`);
    const { body } = await anon(`/api/share/e/${link.token}`);
    expect(body.pro).toBe(false);
    const ch = body.event.sessions[0].channels.laps[0];
    expect(ch.speed).toBeDefined();
    expect(ch.rpm).toBeUndefined();
    for (const s of body.event.sessions) for (const l of s.laps) expect(l.clip ?? null).toBeNull();
  });
});

describe("the shared best-lap video", () => {
  it("signs a URL for a clip on a shared lap, and only for those", async () => {
    const user = await signedInProUser();
    const { eventId, s1, s2 } = await dayWithTwoSessions(user);
    const detail = (await user.api("GET", `/events/${eventId}`)).body;
    const lapIn = (sid: number) => detail.sessions.find((s: any) => s.id === sid).laps[0];
    const clipFor = async (sid: number) => {
      const lap = lapIn(sid);
      const created = await user.api("POST", `/sessions/${sid}/clip`, {
        time_ms: lap.time_ms,
        size_bytes: 64,
        duration_ms: lap.time_ms + 5_000,
        lap_offset_ms: 3_000,
      });
      expect(created.status).toBe(201);
      const id = created.body.clip_id as number;
      const part = await SELF.fetch(`https://example.com/api/clips/${id}/parts/1`, {
        method: "PUT",
        headers: { Cookie: `session=${user.token}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(64),
      });
      expect(part.status).toBe(200);
      expect((await user.api("POST", `/clips/${id}/complete`)).status).toBe(200);
      return id;
    };
    const c1 = await clipFor(s1);
    const c2 = await clipFor(s2);
    const { body: link } = await user.api("POST", `/sessions/${s1}/share`);

    const shared = (await anon(`/api/share/s/${link.token}`)).body;
    expect(shared.event.sessions[0].laps.find((l: any) => l.clip)?.clip).toEqual({
      id: c1,
      duration_ms: expect.any(Number),
      lap_offset_ms: 3_000,
    });

    const ok = await anon(`/api/share/s/${link.token}/clips/${c1}/url`);
    expect(ok.status).toBe(200);
    expect(ok.body.url).toMatch(new RegExp(`/clips/${c1}\\.mp4\\?exp=\\d+&sig=`));
    const played = await SELF.fetch(ok.body.url);
    expect(played.status).toBe(200);

    // Session 2's clip is the owner's, but not on this link.
    expect((await anon(`/api/share/s/${link.token}/clips/${c2}/url`)).status).toBe(404);
    await user.api("DELETE", `/sessions/${s1}/share`);
    expect((await anon(`/api/share/s/${link.token}/clips/${c1}/url`)).status).toBe(404);
  });
});

describe("GET /share/(e|s)/:token (the page)", () => {
  it("previews as the driver's day at the track", async () => {
    const user = await signedInUser();
    const { eventId, s1 } = await dayWithTwoSessions(user);
    const ev = (await user.api("POST", `/events/${eventId}/share`)).body;
    const ss = (await user.api("POST", `/sessions/${s1}/share`)).body;

    const page = await (await SELF.fetch(ev.url)).text();
    expect(page).toContain(`<title>Test User&#39;s track day at Share Raceway</title>`);
    expect(page).toContain(`content="https://example.com/share/e/${tokenOf(ev.url)}"`);
    expect(page).toContain("Jun 14, 2026 · best 1:39.0 · 6 laps · 2 sessions");
    expect(page).not.toContain("secret");

    const spage = await (await SELF.fetch(ss.url)).text();
    expect(spage).toContain("session at Share Raceway");
    expect(spage).toContain("best 1:42.0 · 3 laps");
  });

  it("serves the stock shell for a link that doesn't resolve", async () => {
    const res = await SELF.fetch(`https://example.com/share/e/${"B".repeat(22)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("track day at");
  });
});
