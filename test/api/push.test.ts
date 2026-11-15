import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64UrlDecode } from "../../src/lib/billing/jws";
import { notifyComment } from "../../src/push/fcm";
import type { Env } from "../../src/types";
import { apiClient, createEvent, sessionFor, signedInProUser, signedInUser } from "./helpers";

// NS-54: push notifications for coach comments. Registration runs through the
// Worker; the sender is called directly with a scripted fetch standing in for
// Google's token endpoint and FCM (the YouTube step's pattern), since the test
// pool binds no FCM_SERVICE_ACCOUNT and so the routes' own sends are no-ops.

type User = Awaited<ReturnType<typeof signedInUser>>;

const bearer = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const register = (u: User, token: string, platform = "ios") =>
  u.api("PUT", "/push/device", { platform, token }, bearer(u));

async function devices(userId?: number) {
  const q = userId == null ? "SELECT user_id, platform, token FROM push_devices ORDER BY id" : "SELECT user_id, platform, token FROM push_devices WHERE user_id = ? ORDER BY id";
  const stmt = env.DB.prepare(q);
  return (await (userId == null ? stmt : stmt.bind(userId)).all()).results as { user_id: number; platform: string; token: string }[];
}

async function grant(student: User, coach: User) {
  const res = await student.api("POST", "/coaching/invites");
  const token = (res.body.url as string).split("/coach/")[1];
  expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
}

async function pair() {
  const student = await signedInProUser();
  const coach = await signedInUser();
  await grant(student, coach);
  const eventId = await createEvent(student.api);
  await student.api("POST", `/events/${eventId}/sessions`, { label: "Session 1", laps: [95_000, 94_200] });
  const detail = (await student.api("GET", `/events/${eventId}`)).body;
  const sessionId = detail.sessions[0].id as number;
  const lapId = detail.sessions[0].laps[1].id as number;
  return {
    student, coach, eventId, sessionId, lapId,
    say: (body: string, extra: Record<string, unknown> = {}) =>
      coach.api("POST", `/coaching/students/${student.id}/sessions/${sessionId}/comments`, { body, ...extra }),
    reply: (body: string) => student.api("POST", `/sessions/${sessionId}/comments`, { coach_id: coach.id, body }),
  };
}

// The env with an FCM service account: the Play test key, which the token
// mock below never checks the signature of.
function fcmEnv(): Env {
  const play = JSON.parse((env as unknown as Env).GOOGLE_PLAY_SERVICE_ACCOUNT!);
  return { ...(env as unknown as Env), FCM_SERVICE_ACCOUNT: JSON.stringify({ ...play, project_id: "te-test" }) };
}

// A scripted Google: the token endpoint answers, and each FCM send is
// recorded and answered by `answer(token)`.
function fakeGoogle(answer: (token: string) => { status: number; body?: unknown } = () => ({ status: 200 })) {
  const sent: { url: string; auth: string | null; message: any }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body));
      const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(form.get("assertion")!.split(".")[1])));
      expect(claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
      return Response.json({ access_token: "fcm-access", expires_in: 3600 });
    }
    const { message } = JSON.parse(String(init?.body));
    sent.push({ url, auth: new Headers(init?.headers).get("Authorization"), message });
    const a = answer(message.token);
    return Response.json(a.body ?? { name: "projects/te-test/messages/1" }, { status: a.status });
  }) as typeof fetch;
  return { fetcher, sent };
}

describe("registering a phone", () => {
  it("one row per app session, replaced on re-register", async () => {
    const u = await signedInUser();
    expect((await register(u, "tok-1")).body).toEqual({ ok: true });
    expect((await register(u, "tok-2", "android")).status).toBe(200);
    expect(await devices(u.id)).toEqual([{ user_id: u.id, platform: "android", token: "tok-2" }]);

    // A second install of the same account is a second session, a second row.
    const other = { token: await sessionFor(u.id) };
    await apiClient(other.token)("PUT", "/push/device", { platform: "ios", token: "tok-3" }, bearer(other));
    expect((await devices(u.id)).map((d) => d.token)).toEqual(["tok-2", "tok-3"]);
  });

  it("a token another account holds moves to the one registering it", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await register(a, "shared-phone");
    await register(b, "shared-phone");
    expect(await devices(a.id)).toEqual([]);
    expect(await devices(b.id)).toEqual([{ user_id: b.id, platform: "ios", token: "shared-phone" }]);
  });

  it("the web can't register, and a bad body is a 400", async () => {
    const u = await signedInUser();
    expect(await u.api("PUT", "/push/device", { platform: "ios", token: "t" })).toMatchObject({
      status: 400,
      body: { error: "push needs the app" },
    });
    expect((await u.api("PUT", "/push/device", { platform: "web", token: "t" }, bearer(u))).status).toBe(400);
    expect((await apiClient()("PUT", "/push/device", { platform: "ios", token: "t" })).status).toBe(401);
  });

  it("unregistering is idempotent, and signing out unregisters", async () => {
    const u = await signedInUser();
    await register(u, "tok-out");
    expect((await u.api("DELETE", "/push/device", undefined, bearer(u))).body).toEqual({ ok: true });
    expect((await u.api("DELETE", "/push/device", undefined, bearer(u))).body).toEqual({ ok: true });
    expect(await devices(u.id)).toEqual([]);

    await register(u, "tok-out");
    expect((await SELF.fetch("https://example.com/auth/logout", { method: "POST", headers: bearer(u) })).status).toBe(200);
    expect(await devices(u.id)).toEqual([]);
  });
});

describe("notifyComment", () => {
  it("a coach's comment notifies the student's phones, never the coach's", async () => {
    const p = await pair();
    await register(p.student, "student-ios", "ios");
    await register({ ...p.student, token: await sessionFor(p.student.id) } as User, "student-android", "android");
    await register(p.coach, "coach-phone");
    const said = await p.say("Brake 10 m later here", { lap_id: p.lapId, dist_m: 1240 });
    expect(said.status).toBe(201);

    const g = fakeGoogle();
    expect(await notifyComment(fcmEnv(), said.body.comment.id, Date.now(), g.fetcher)).toEqual({ sent: 2, removed: 0, failed: 0 });
    expect(g.sent.map((s) => s.message.token).sort()).toEqual(["student-android", "student-ios"]);
    expect(g.sent.every((s) => s.url === "https://fcm.googleapis.com/v1/projects/te-test/messages:send")).toBe(true);
    expect(g.sent.every((s) => s.auth === "Bearer fcm-access")).toBe(true);
    const ios = g.sent.find((s) => s.message.token === "student-ios")!.message;
    expect(ios.notification).toEqual({ title: "Test User commented on Lap 2 · Test Ring", body: "Brake 10 m later here" });
    expect(ios.data).toEqual({
      kind: "comment", comment_id: String(said.body.comment.id), event_id: String(p.eventId),
      session_id: String(p.sessionId), lap_id: String(p.lapId),
    });
    expect(ios.apns.payload.aps.badge).toBe(1);
  });

  it("a reply notifies the coach, with the student's id to route by", async () => {
    const p = await pair();
    await register(p.coach, "coach-phone", "android");
    await register(p.student, "student-phone");
    await p.say("Good pace");
    const reply = await p.reply("Thanks!");
    const g = fakeGoogle();
    expect((await notifyComment(fcmEnv(), reply.body.comment.id, Date.now(), g.fetcher)).sent).toBe(1);
    expect(g.sent[0].message.token).toBe("coach-phone");
    expect(g.sent[0].message.notification.title).toMatch(/^Test User replied on Session 1 · /);
    expect(g.sent[0].message.data.student_id).toBe(String(p.student.id));
    expect(g.sent[0].message.android.notification.channel_id).toBe("coach_comments");
  });

  it("an ex-coach is not told, and a second coach never is", async () => {
    const p = await pair();
    const other = await signedInUser();
    await grant(p.student, other);
    await register(p.coach, "coach-a");
    await register(other, "coach-b");
    await p.say("hi");
    const reply = await p.reply("hello");
    expect((await p.student.api("DELETE", `/coaching/coaches/${p.coach.id}`)).status).toBe(200);
    const g = fakeGoogle();
    expect(await notifyComment(fcmEnv(), reply.body.comment.id, Date.now(), g.fetcher)).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(g.sent).toEqual([]);
  });

  it("a dead token is removed and the rest still sent; an outage keeps the row", async () => {
    const p = await pair();
    await register(p.student, "gone");
    const second = { ...p.student, token: await sessionFor(p.student.id) } as User;
    await register(second, "alive");
    const third = { ...p.student, token: await sessionFor(p.student.id) } as User;
    await register(third, "flaky");
    const said = await p.say("hi");
    const g = fakeGoogle((t) =>
      t === "gone"
        ? { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } }
        : t === "flaky"
          ? { status: 503, body: { error: { status: "UNAVAILABLE" } } }
          : { status: 200 }
    );
    expect(await notifyComment(fcmEnv(), said.body.comment.id, Date.now(), g.fetcher)).toEqual({ sent: 1, removed: 1, failed: 1 });
    expect((await devices(p.student.id)).map((d) => d.token).sort()).toEqual(["alive", "flaky"]);
  });

  it("an expired session's phone is not sent to", async () => {
    const p = await pair();
    const old = { ...p.student, token: await sessionFor(p.student.id) } as User;
    await register(old, "stale");
    await env.DB.prepare("UPDATE auth_sessions SET expires_at = 1 WHERE user_id = ? AND token IN (SELECT auth_token FROM push_devices WHERE token = 'stale')")
      .bind(p.student.id)
      .run();
    const said = await p.say("hi");
    const g = fakeGoogle();
    expect((await notifyComment(fcmEnv(), said.body.comment.id, Date.now(), g.fetcher)).sent).toBe(0);
  });

  it("ships dark: no service account, nothing sent", async () => {
    const p = await pair();
    await register(p.student, "student-phone");
    const said = await p.say("hi");
    const g = fakeGoogle();
    expect(await notifyComment(env as unknown as Env, said.body.comment.id, Date.now(), g.fetcher)).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(g.sent).toEqual([]);
  });

  it("a token exchange failure fails the sends, not the comment", async () => {
    const p = await pair();
    await register(p.student, "student-phone");
    const said = await p.say("hi");
    expect(said.status).toBe(201);
    const fetcher = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await notifyComment(fcmEnv(), said.body.comment.id, Date.now(), fetcher)).toEqual({ sent: 0, removed: 0, failed: 1 });
    expect(await devices(p.student.id)).toHaveLength(1);
  });
});
