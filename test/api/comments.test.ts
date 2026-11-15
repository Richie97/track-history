import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_THREAD_COMMENTS } from "../../src/lib/comments";
import { apiClient, createEvent, signedInProUser, signedInUser } from "./helpers";

// NS-52: coach comments on sessions and laps. A coach with a grant (NS-38)
// writes into a private thread on a student's session, lap or place on a lap;
// the student replies.

type Api = ReturnType<typeof apiClient>;
type User = Awaited<ReturnType<typeof signedInUser>>;

async function grant(student: User, coach: User) {
  const res = await student.api("POST", "/coaching/invites");
  expect(res.status).toBe(201);
  const token = (res.body.url as string).split("/coach/")[1];
  expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
}

// A student with an event, one session of two laps, and a coach.
async function pair() {
  const student = await signedInProUser();
  const coach = await signedInUser();
  await grant(student, coach);
  const eventId = await createEvent(student.api);
  const session = await student.api("POST", `/events/${eventId}/sessions`, { label: "Session 1", laps: [95_000, 94_200] });
  expect(session.status).toBe(201);
  const detail = (await student.api("GET", `/events/${eventId}`)).body;
  const sessionId = detail.sessions[0].id as number;
  const lapIds = detail.sessions[0].laps.map((l: { id: number }) => l.id) as number[];
  const base = `/coaching/students/${student.id}`;
  return {
    student,
    coach,
    eventId,
    sessionId,
    lapIds,
    base,
    say: (body: string, extra: Record<string, unknown> = {}) =>
      coach.api("POST", `${base}/sessions/${sessionId}/comments`, { body, ...extra }),
    reply: (body: string, extra: Record<string, unknown> = {}) =>
      student.api("POST", `/sessions/${sessionId}/comments`, { coach_id: coach.id, body, ...extra }),
    coachReads: () => coach.api("GET", `${base}/events/${eventId}/comments`),
    studentReads: () => student.api("GET", `/events/${eventId}/comments`),
  };
}

describe("a coach comments, the student replies", () => {
  it("on a session, a lap and a place on a lap", async () => {
    const p = await pair();
    const onSession = await p.say("  Good pace all session.  ");
    const onLap = await p.say("Tidy lap", { lap_id: p.lapIds[1] });
    const placed = await p.say("Brake 10 m later here", { lap_id: p.lapIds[1], dist_m: 1240 });
    for (const r of [onSession, onLap, placed]) expect(r.status).toBe(201);
    expect(onSession.body.comment).toMatchObject({
      coach_id: p.coach.id, session_id: p.sessionId, lap_id: null, dist_m: null, body: "Good pace all session.",
      mine: true, seen: false, edited_at: null, author: { id: p.coach.id },
    });
    expect(placed.body.comment).toMatchObject({ lap_id: p.lapIds[1], dist_m: 1240 });

    const read = await p.studentReads();
    expect(read.status).toBe(200);
    expect(read.body.comments.map((c: any) => c.body)).toEqual(["Good pace all session.", "Tidy lap", "Brake 10 m later here"]);
    expect(read.body.comments.every((c: any) => c.mine === false && c.seen === false)).toBe(true);
    expect(read.body.coaches).toEqual([{ id: p.coach.id, name: "Test User", picture: null, active: true }]);

    const answer = await p.reply("Tried it, the rear stepped out", { lap_id: p.lapIds[1], dist_m: 1240 });
    expect(answer.status).toBe(201);
    expect(answer.body.comment).toMatchObject({ coach_id: p.coach.id, mine: true, author: { id: p.student.id } });
    const coachSees = (await p.coachReads()).body.comments;
    expect(coachSees).toHaveLength(4);
    expect(coachSees[3]).toMatchObject({ body: "Tried it, the rear stepped out", mine: false, seen: false });
  });

  it("never answers an email, and never takes the thread's ids from the body", async () => {
    const p = await pair();
    const other = await signedInUser();
    const res = await p.say("x", { coach_id: other.id, author_id: other.id, student_id: other.id, event_id: 999 });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT * FROM coach_comments WHERE id = ?").bind(res.body.comment.id).first<any>();
    expect(row).toMatchObject({ student_id: p.student.id, coach_id: p.coach.id, author_id: p.coach.id, event_id: p.eventId });
    const text = JSON.stringify([(await p.studentReads()).body, (await p.coachReads()).body, (await p.student.api("GET", "/coaching/comments")).body]);
    expect(text).not.toContain("@example.com");
  });

  it("validates the body", async () => {
    const p = await pair();
    expect((await p.say("   ")).status).toBe(400);
    expect((await p.say("x".repeat(1001))).status).toBe(400);
    expect((await p.say("x", { dist_m: 50 })).status).toBe(400);
    expect((await p.student.api("POST", `/sessions/${p.sessionId}/comments`, { body: "no coach named" })).status).toBe(400);
  });

  it("is free on both sides", async () => {
    const student = await signedInUser();
    const coach = await signedInUser();
    // A grant made while the student had Pro survives a lapse; made directly here.
    await env.DB.prepare("INSERT INTO coach_grants (student_id, coach_id, created_at) VALUES (?, ?, ?)").bind(student.id, coach.id, Date.now()).run();
    const eventId = await createEvent(student.api);
    const sessionId = (await student.api("POST", `/events/${eventId}/sessions`, { laps: [90_000] })).body.id;
    expect((await coach.api("POST", `/coaching/students/${student.id}/sessions/${sessionId}/comments`, { body: "hi" })).status).toBe(201);
    expect((await student.api("POST", `/sessions/${sessionId}/comments`, { coach_id: coach.id, body: "hello" })).status).toBe(201);
  });
});

describe("unread", () => {
  it("counts what was said to you, and clears when the event's comments are seen", async () => {
    const p = await pair();
    await p.say("One");
    await p.say("Two", { lap_id: p.lapIds[0] });

    expect((await p.student.api("GET", "/me")).body.user.comments_unread).toBe(2);
    expect((await p.coach.api("GET", "/me")).body.user.comments_unread).toBe(0);
    expect((await p.student.api("GET", "/coaching")).body.coaches[0].unread).toBe(2);

    const feed = (await p.student.api("GET", "/coaching/comments")).body;
    expect(feed.unread).toBe(2);
    expect(feed.comments.map((c: any) => c.body)).toEqual(["Two", "One"]);
    expect(feed.comments[0]).toMatchObject({
      student: null, event_id: p.eventId, track_name: "Test Ring", start_date: "2026-05-01", session_label: "Session 1", lap_num: 1, seen: false,
    });
    expect(feed.comments[1].lap_num).toBeNull();

    expect((await p.student.api("POST", `/events/${p.eventId}/comments/seen`)).body).toEqual({ ok: true, seen: 2 });
    expect((await p.student.api("GET", "/me")).body.user.comments_unread).toBe(0);
    // The coach's own rows now carry the read receipt.
    expect((await p.coachReads()).body.comments.every((c: any) => c.seen)).toBe(true);

    await p.reply("Thanks");
    expect((await p.coach.api("GET", "/me")).body.user.comments_unread).toBe(1);
    expect((await p.coach.api("GET", "/coaching")).body.students[0].unread).toBe(1);
    const coachFeed = (await p.coach.api("GET", "/coaching/comments")).body;
    expect(coachFeed.comments).toHaveLength(1);
    expect(coachFeed.comments[0].student).toEqual({ id: p.student.id, name: "Test User" });
    // Seeing as the coach clears the reply, not the student's own unread state.
    expect((await p.coach.api("POST", `${p.base}/events/${p.eventId}/comments/seen`)).body).toEqual({ ok: true, seen: 1 });
    expect((await p.coach.api("GET", "/me")).body.user.comments_unread).toBe(0);
  });
});

describe("one private thread per coach", () => {
  it("a second coach can't read, count, edit, delete or infer the first's thread", async () => {
    const p = await pair();
    const b = await signedInUser();
    await env.DB.prepare("UPDATE users SET name = 'Coach Bee' WHERE id = ?").bind(b.id).run();
    await env.DB.prepare("UPDATE users SET name = 'Coach Aye' WHERE id = ?").bind(p.coach.id).run();
    await grant(p.student, b);
    const first = (await p.say("From A", { lap_id: p.lapIds[0], dist_m: 300 })).body.comment;
    await p.reply("To A");

    const bRead = await b.api("GET", `${p.base}/events/${p.eventId}/comments`);
    expect(bRead.status).toBe(200);
    expect(bRead.body).toEqual({ comments: [] });
    const bFeed = (await b.api("GET", "/coaching/comments")).body;
    expect(bFeed).toEqual({ unread: 0, comments: [] });
    expect((await b.api("GET", "/me")).body.user.comments_unread).toBe(0);
    expect((await b.api("GET", "/coaching")).body.students[0].unread).toBe(0);
    expect((await b.api("PUT", `/comments/${first.id}`, { body: "hijacked" })).status).toBe(404);
    expect((await b.api("DELETE", `/comments/${first.id}`)).status).toBe(404);
    expect((await b.api("POST", `${p.base}/events/${p.eventId}/comments/seen`)).body.seen).toBe(0);

    // B's own thread is separate, and nothing B is sent names A.
    await b.api("POST", `${p.base}/sessions/${p.sessionId}/comments`, { body: "From B" });
    await p.student.api("POST", `/sessions/${p.sessionId}/comments`, { coach_id: b.id, body: "To B" });
    const everything = JSON.stringify([
      (await b.api("GET", `${p.base}/events/${p.eventId}/comments`)).body,
      (await b.api("GET", "/coaching/comments")).body,
      (await b.api("GET", "/coaching")).body,
    ]);
    expect(everything).toContain("To B");
    expect(everything).not.toContain("Coach Aye");
    expect(everything).not.toContain("From A");
    expect(everything).not.toContain("To A");
    expect(everything).not.toContain(`"coach_id":${p.coach.id}`);

    // The student sees both threads, each under its coach.
    const all = (await p.studentReads()).body;
    expect(all.comments.map((c: any) => [c.coach_id, c.body])).toEqual([
      [p.coach.id, "From A"], [p.coach.id, "To A"], [b.id, "From B"], [b.id, "To B"],
    ]);
    expect(all.coaches.map((c: any) => c.name)).toEqual(["Coach Aye", "Coach Bee"]);
  });
});

describe("who may write", () => {
  it("refuses everyone without a grant, identically", async () => {
    const p = await pair();
    const stranger = await signedInUser();
    const comment = (await p.say("Mine")).body.comment;
    const otherStudent = await signedInUser();
    const otherEvent = await createEvent(otherStudent.api);
    const otherSession = (await otherStudent.api("POST", `/events/${otherEvent}/sessions`, { laps: [80_000] })).body.id;
    const otherLap = (await otherStudent.api("GET", `/events/${otherEvent}`)).body.sessions[0].laps[0].id;

    const refusals = [
      await stranger.api("GET", `${p.base}/events/${p.eventId}/comments`),
      await stranger.api("POST", `${p.base}/sessions/${p.sessionId}/comments`, { body: "x" }),
      await stranger.api("POST", `${p.base}/events/${p.eventId}/comments/seen`),
      await stranger.api("GET", `/events/${p.eventId}/comments`),
      await stranger.api("POST", `/sessions/${p.sessionId}/comments`, { coach_id: p.coach.id, body: "x" }),
      await stranger.api("PUT", `/comments/${comment.id}`, { body: "x" }),
      await stranger.api("DELETE", `/comments/${comment.id}`),
      // The coach, aiming at a session or a lap that isn't this student's.
      await p.coach.api("POST", `${p.base}/sessions/${otherSession}/comments`, { body: "x" }),
      await p.say("x", { lap_id: otherLap }),
      await p.coach.api("GET", `${p.base}/events/${otherEvent}/comments`),
      await p.coach.api("GET", `/coaching/students/${otherStudent.id}/events/${otherEvent}/comments`),
      // The student, replying to someone who isn't their coach, or editing the coach's words.
      await p.student.api("POST", `/sessions/${p.sessionId}/comments`, { coach_id: stranger.id, body: "x" }),
      await p.student.api("PUT", `/comments/${comment.id}`, { body: "x" }),
      await p.coach.api("PUT", "/comments/999999", { body: "x" }),
      await p.coach.api("GET", `${p.base}/events/abc/comments`),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "not found" });
    }
    expect((await p.studentReads()).body.comments).toHaveLength(1);
  });

  it("is not reachable through the read-only coach mount", async () => {
    const p = await pair();
    const mount = `/students/${p.student.id}`;
    expect((await p.coach.api("GET", `${mount}/events/${p.eventId}/comments`)).status).toBe(404);
    expect((await p.coach.api("POST", `${mount}/sessions/${p.sessionId}/comments`, { coach_id: p.coach.id, body: "x" })).status).toBe(404);
    expect((await p.coach.api("GET", `${mount}/coaching/comments`)).status).toBe(404);
  });

  it("lets the author edit and delete, and the owner delete anything", async () => {
    const p = await pair();
    const mine = (await p.say("Brake latr")).body.comment;
    const edited = await p.coach.api("PUT", `/comments/${mine.id}`, { body: "Brake later" });
    expect(edited.status).toBe(200);
    expect(edited.body.comment.body).toBe("Brake later");
    expect(edited.body.comment.edited_at).toBeGreaterThan(0);
    expect((await p.coach.api("PUT", `/comments/${mine.id}`, { body: " " })).status).toBe(400);

    const theirs = (await p.reply("OK")).body.comment;
    // A coach can't delete the student's reply…
    expect((await p.coach.api("DELETE", `/comments/${theirs.id}`)).status).toBe(404);
    // …the student can delete their own and the coach's.
    expect((await p.student.api("DELETE", `/comments/${theirs.id}`)).status).toBe(200);
    expect((await p.student.api("DELETE", `/comments/${mine.id}`)).status).toBe(200);
    expect((await p.studentReads()).body).toEqual({ comments: [], coaches: [] });
    const again = (await p.say("Again")).body.comment;
    expect((await p.coach.api("DELETE", `/comments/${again.id}`)).status).toBe(200);
  });

  it("caps a thread", async () => {
    const p = await pair();
    const now = Date.now();
    const stmt = env.DB.prepare(
      "INSERT INTO coach_comments (student_id, coach_id, author_id, event_id, session_id, body, created_at) VALUES (?, ?, ?, ?, ?, 'x', ?)"
    );
    await env.DB.batch(
      Array.from({ length: MAX_THREAD_COMMENTS }, (_, i) => stmt.bind(p.student.id, p.coach.id, p.coach.id, p.eventId, p.sessionId, now + i))
    );
    const full = await p.say("one too many");
    expect(full.status).toBe(409);
    expect(full.body).toEqual({ error: "too many comments on this session" });
    expect((await p.reply("nor a reply")).status).toBe(409);
  });
});

describe("when the grant ends", () => {
  it("the coach reaches nothing, the student keeps a closed thread, and a new grant reopens it", async () => {
    const p = await pair();
    const theirs = (await p.say("Keep your eyes up")).body.comment;
    const own = (await p.reply("Will do")).body.comment;
    expect((await p.student.api("DELETE", `/coaching/coaches/${p.coach.id}`)).status).toBe(200);

    for (const r of [
      await p.coachReads(),
      await p.say("still here?"),
      await p.coach.api("PUT", `/comments/${theirs.id}`, { body: "edit" }),
      await p.coach.api("DELETE", `/comments/${theirs.id}`),
      await p.coach.api("POST", `${p.base}/events/${p.eventId}/comments/seen`),
    ])
      expect(r.status).toBe(404);
    expect((await p.coach.api("GET", "/coaching/comments")).body).toEqual({ unread: 0, comments: [] });
    expect((await p.coach.api("GET", "/me")).body.user.comments_unread).toBe(0);

    const kept = (await p.studentReads()).body;
    expect(kept.comments.map((c: any) => c.body)).toEqual(["Keep your eyes up", "Will do"]);
    expect(kept.coaches[0]).toMatchObject({ id: p.coach.id, active: false });
    expect((await p.reply("anyone?")).status).toBe(404);
    // The student's own words are still theirs to edit; anything is theirs to delete.
    expect((await p.student.api("PUT", `/comments/${own.id}`, { body: "Will do." })).status).toBe(200);

    await grant(p.student, p.coach);
    expect((await p.coachReads()).body.comments).toHaveLength(2);
    expect((await p.say("Back again")).status).toBe(201);
    expect((await p.studentReads()).body.coaches[0].active).toBe(true);
  });
});

describe("deleting what a comment hangs off", () => {
  // Scoped to the pair: the tests in this file share one database.
  const countFor = (studentId: number, coachId: number) => async () =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM coach_comments WHERE student_id = ? AND coach_id = ?")
      .bind(studentId, coachId)
      .first<{ n: number }>())!.n;

  it("a lap, a session and an event take their comments with them", async () => {
    const p = await pair();
    const count = countFor(p.student.id, p.coach.id);
    await p.say("session");
    await p.say("lap 1", { lap_id: p.lapIds[0] });
    await p.say("lap 2", { lap_id: p.lapIds[1] });
    expect(await count()).toBe(3);
    expect((await p.student.api("DELETE", `/laps/${p.lapIds[0]}`)).status).toBe(200);
    expect(await count()).toBe(2);
    expect((await p.student.api("DELETE", `/sessions/${p.sessionId}`)).status).toBe(200);
    expect(await count()).toBe(0);

    const s2 = (await p.student.api("POST", `/events/${p.eventId}/sessions`, { laps: [91_000] })).body.id;
    expect((await p.coach.api("POST", `${p.base}/sessions/${s2}/comments`, { body: "again" })).status).toBe(201);
    expect((await p.student.api("DELETE", `/events/${p.eventId}`)).status).toBe(200);
    expect(await count()).toBe(0);
  });

  it("either account takes what it wrote or received", async () => {
    for (const who of ["student", "coach"] as const) {
      const p = await pair();
      const count = countFor(p.student.id, p.coach.id);
      await p.say("from the coach");
      await p.reply("from the student");
      expect(await count()).toBe(2);
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(p[who].id).run();
      expect(await count()).toBe(0);
    }
  });
});

describe("where comments never appear", () => {
  it("leaves the event detail, the coach's view of it and the share pages as they were", async () => {
    const p = await pair();
    await p.student.api("PUT", "/me/share", { slug: `driver-${p.student.id}` });
    const link = (await p.student.api("POST", `/events/${p.eventId}/share`)).body;
    const anon = apiClient();
    const read = async () => ({
      detail: (await p.student.api("GET", `/events/${p.eventId}`)).body,
      events: (await p.student.api("GET", "/events")).body,
      coach: (await p.coach.api("GET", `/students/${p.student.id}/events/${p.eventId}`)).body,
      share: (await anon("GET", `/share/driver-${p.student.id}`)).body,
      item: (await anon("GET", `/share/e/${link.token}`)).body,
    });
    const before = await read();
    await p.say("SECRET coach words", { lap_id: p.lapIds[0], dist_m: 500 });
    await p.reply("SECRET student words");
    const after = await read();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("SECRET");
  });
});

describe("the logbook export", () => {
  it("carries the comments on your sessions, and the ones you wrote as a coach", async () => {
    const p = await pair();
    await p.say("Brake later here", { lap_id: p.lapIds[1], dist_m: 1240 });
    await p.reply("Will try");
    const fetchDoc = async (token: string) =>
      (await (
        await SELF.fetch("https://example.com/api/export/logbook.json", { headers: { Cookie: `session=${token}` } })
      ).json()) as any;

    const mine = await fetchDoc(p.student.token);
    const session = mine.events.flatMap((e: any) => e.sessions).find((s: any) => s.id === p.sessionId);
    expect(session.comments).toEqual([
      { lap_id: p.lapIds[1], dist_m: 1240, body: "Brake later here", created_at: expect.any(Number), edited_at: null, author: "Test User", by_you: false },
      { lap_id: null, dist_m: null, body: "Will try", created_at: expect.any(Number), edited_at: null, author: "Test User", by_you: true },
    ]);
    expect(mine.comments_written).toEqual([]);

    const theirs = await fetchDoc(p.coach.token);
    expect(theirs.comments_written).toEqual([
      {
        student: "Test User", track_name: "Test Ring", start_date: "2026-05-01", session_label: "Session 1", lap_num: 2,
        dist_m: 1240, body: "Brake later here", created_at: expect.any(Number), edited_at: null,
      },
    ]);
    // The coach's file holds their own words, never the student's reply.
    expect(JSON.stringify(theirs)).not.toContain("Will try");
  });
});
