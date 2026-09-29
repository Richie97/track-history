import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sweepCoachInvites } from "../../src/routes/coaching";
import {
  COACH_CHANNEL_FIELDS,
  COACH_EVENT_FIELDS,
  COACH_FIT_FIELDS,
  COACH_META_FIELDS,
  COACH_PROFILE_FIELDS,
  COACH_LAP_FIELDS,
  COACH_SESSION_FIELDS,
  COACH_TRACK_FIELDS,
  COACH_VEHICLE_FIELDS,
} from "../../src/lib/coaching";
import { apiClient, createEvent, signedInProUser, signedInUser } from "./helpers";

// NS-38: share with a coach. The invite flow, the coach's read path under
// /api/students/:id, and the driver profile.

type Api = ReturnType<typeof apiClient>;

async function invite(student: Api) {
  const res = await student("POST", "/coaching/invites");
  expect(res.status).toBe(201);
  const token = (res.body.url as string).split("/coach/")[1];
  return { ...res.body, token } as { id: number; url: string; expires_at: number; token: string };
}

// A Pro student with a coach (free) who has accepted their invite.
async function pair() {
  const student = await signedInProUser();
  const coach = await signedInUser();
  const { token } = await invite(student.api);
  expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
  return { student, coach, as: (path: string, method = "GET", body?: unknown) =>
    coach.api(method, `/students/${student.id}${path}`, body) };
}

const N = 12;
const arr = (v: number) => Array.from({ length: N }, (_, i) => v + i);
const flat = (v: number) => Array.from({ length: N }, () => v);

// Everything a student's logbook can hold that a coach must *not* see, beside
// the lap data they must.
async function richLogbook(api: Api) {
  const eventId = await createEvent(api, {
    notes: "PRIVATE event note",
    checklist: [{ text: "PRIVATE checklist item", done: false }],
    cost_entry_cents: 45_000,
    cost_fuel_cents: 12_000,
    car: "Corvette C7",
  });
  const session = await api("POST", `/events/${eventId}/sessions`, {
    label: "Session 1",
    notes: "PRIVATE session note",
    laps: [95_000, 94_200],
    trace: Array.from({ length: N }, (_, i) => [i * 10, i * 5, 30 + i]),
    channels: {
      dStepM: 20,
      meta: { ambientC: 21, intakeC: 30, elevationM: 12, odometerKm: 48123 },
      laps: [{ n: 1, timeMs: 95_000, speed: arr(30), throttle: arr(50), brake: arr(0), rpm: arr(4000), latG: flat(0.8), oilC: 105 }],
    },
  });
  expect(session.status).toBe(201);
  expect((await api("PUT", `/events/${eventId}/setups/1`, { tp_cold: { fl: 30, fr: 30, rl: 30, rr: 30 }, notes: "PRIVATE setup" })).status).toBe(200);
  const trackId = (await api("GET", "/tracks")).body[0].id;
  expect((await api("PUT", `/tracks/${trackId}`, { notes: "PRIVATE track note" })).status).toBe(200);
  const vehicle = await api("POST", "/vehicles", { name: "Corvette C7", notes: "Pfadt coilovers, Z07 brakes" });
  expect(vehicle.status).toBe(201);
  return { eventId, trackId, vehicleId: vehicle.body.id as number };
}

const keysOk = (row: Record<string, unknown>, allowed: readonly string[], hidden: readonly string[]) =>
  Object.keys(row).filter((k) => !allowed.includes(k) && !hidden.includes(k));

describe("invites", () => {
  it("are Pro to create: a free account gets the paywall", async () => {
    const { api } = await signedInUser();
    const res = await api("POST", "/coaching/invites");
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "pro required" });
  });

  it("hand back a single-use link once, and list only the expiry afterwards", async () => {
    const { api } = await signedInProUser();
    const before = Date.now();
    const inv = await invite(api);
    expect(inv.url).toMatch(/^https:\/\/example\.com\/coach\/[0-9a-f]{64}$/);
    expect(inv.expires_at).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    const list = await api("GET", "/coaching");
    expect(list.body).toEqual({
      coaches: [],
      students: [],
      invites: [{ id: inv.id, created_at: expect.any(Number), expires_at: inv.expires_at }],
    });
    // Only the hash is stored.
    const row = await env.DB.prepare("SELECT token_hash FROM coach_invites WHERE id = ?").bind(inv.id).first<{ token_hash: string }>();
    expect(row!.token_hash).not.toBe(inv.token);
  });

  it("preview the student for whoever opens them, and say when it's your own", async () => {
    const student = await signedInProUser();
    const coach = await signedInUser();
    const { token } = await invite(student.api);
    const seen = await coach.api("GET", `/coaching/invites/${token}`);
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual({
      student: { id: student.id, name: "Test User", picture: null },
      expires_at: expect.any(Number),
      own: false,
      already_coach: false,
    });
    expect((await student.api("GET", `/coaching/invites/${token}`)).body.own).toBe(true);
    expect((await coach.api("GET", "/coaching/invites/nope")).status).toBe(404);
  });

  it("can't be accepted by their own author, and that doesn't burn them", async () => {
    const student = await signedInProUser();
    const coach = await signedInUser();
    const { token } = await invite(student.api);
    expect((await student.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(400);
    expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
  });

  it("are single use", async () => {
    const student = await signedInProUser();
    const a = await signedInUser();
    const b = await signedInUser();
    const { token } = await invite(student.api);
    const ok = await a.api("POST", `/coaching/invites/${token}/accept`);
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ student: { id: student.id, name: "Test User", picture: null } });
    expect((await b.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(404);
  });

  it("aren't burned by someone who is already a coach", async () => {
    const { student, coach } = await pair();
    const { token } = await invite(student.api);
    expect((await coach.api("GET", `/coaching/invites/${token}`)).body.already_coach).toBe(true);
    expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(409);
    const other = await signedInUser();
    expect((await other.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
  });

  it("expire", async () => {
    const student = await signedInProUser();
    const coach = await signedInUser();
    const inv = await invite(student.api);
    await env.DB.prepare("UPDATE coach_invites SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, inv.id).run();
    expect((await coach.api("GET", `/coaching/invites/${inv.token}`)).status).toBe(404);
    expect((await coach.api("POST", `/coaching/invites/${inv.token}/accept`)).status).toBe(404);
    expect((await student.api("GET", "/coaching")).body.invites).toEqual([]);
    await sweepCoachInvites(env.DB, Date.now());
    expect(await env.DB.prepare("SELECT 1 FROM coach_invites WHERE id = ?").bind(inv.id).first()).toBeNull();
  });

  it("can be withdrawn by their author only", async () => {
    const student = await signedInProUser();
    const other = await signedInUser();
    const inv = await invite(student.api);
    expect((await other.api("DELETE", `/coaching/invites/${inv.id}`)).status).toBe(404);
    expect((await student.api("DELETE", `/coaching/invites/${inv.id}`)).status).toBe(200);
    expect((await other.api("POST", `/coaching/invites/${inv.token}/accept`)).status).toBe(404);
  });

  it("go to exactly one of two people accepting the same link at once", async () => {
    const student = await signedInProUser();
    const a = await signedInUser();
    const b = await signedInUser();
    const { token } = await invite(student.api);
    const results = await Promise.all([
      a.api("POST", `/coaching/invites/${token}/accept`),
      b.api("POST", `/coaching/invites/${token}/accept`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM coach_grants WHERE student_id = ?")
      .bind(student.id)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("can't take a student past ten coaches, even accepted at once, and a refusal doesn't burn the link", async () => {
    const student = await signedInProUser();
    for (let i = 0; i < 9; i++) {
      const coach = await signedInUser();
      const { token } = await invite(student.api);
      expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
    }
    const [x, y] = [await signedInUser(), await signedInUser()];
    const [ix, iy] = [await invite(student.api), await invite(student.api)];
    const results = await Promise.all([
      x.api("POST", `/coaching/invites/${ix.token}/accept`),
      y.api("POST", `/coaching/invites/${iy.token}/accept`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM coach_grants WHERE student_id = ?")
      .bind(student.id)
      .first<{ n: number }>();
    expect(n!.n).toBe(10);
    // The refused link is still there for when a place frees up.
    expect((await student.api("GET", "/coaching")).body.invites).toHaveLength(1);
  });

  it("are capped at ten open at once", async () => {
    const { api } = await signedInProUser();
    for (let i = 0; i < 10; i++) await invite(api);
    const res = await api("POST", "/coaching/invites");
    expect(res.status).toBe(409);
  });
});

describe("GET /coaching", () => {
  it("lists the grant from both sides", async () => {
    const { student, coach } = await pair();
    await createEvent(student.api, { start_date: "2026-04-01" });
    await createEvent(student.api, { start_date: "2999-01-01" }); // upcoming: not counted
    const mine = await student.api("GET", "/coaching");
    expect(mine.body.coaches).toEqual([
      { id: coach.id, name: "Test User", picture: null, since: expect.any(Number), last_viewed_at: null },
    ]);
    expect(mine.body.students).toEqual([]);
    const theirs = await coach.api("GET", "/coaching");
    expect(theirs.body.students).toEqual([
      { id: student.id, name: "Test User", picture: null, since: expect.any(Number), event_count: 1, last_event_date: "2026-04-01" },
    ]);
    expect(theirs.body.coaches).toEqual([]);
  });
});

describe("a coach reading a student's logbook", () => {
  it("sees the lap data, the full channel panel under the student's Pro, and the car with its mods", async () => {
    const { student, coach, as } = await pair();
    const { eventId, vehicleId } = await richLogbook(student.api);

    const detail = await as(`/events/${eventId}`);
    expect(detail.status).toBe(200);
    const s = detail.body.sessions[0];
    expect(s.laps.map((l: { time_ms: number }) => l.time_ms)).toEqual([95_000, 94_200]);
    expect(s.trace).toHaveLength(N);
    // The coach is free; the student pays — so the Pro half rides along.
    expect(s.channels.laps[0].rpm).toEqual(arr(4000));
    expect(s.channels.laps[0].oilC).toBe(105);
    expect(detail.body.best_ms).toBe(94_200);
    expect(detail.body.car).toBe("Corvette C7");

    const vehicles = await as("/vehicles");
    expect(vehicles.body).toEqual([
      expect.objectContaining({ id: vehicleId, name: "Corvette C7", notes: "Pfadt coilovers, Z07 brakes" }),
    ]);

    // The coach's own logbook is still their own.
    expect((await coach.api("GET", "/events")).body).toEqual([]);
  });

  it("never sees notes, the checklist, costs, setups, email or anything off the allow-list", async () => {
    const { student, as } = await pair();
    const { eventId } = await richLogbook(student.api);

    const list = await as("/events");
    const detail = await as(`/events/${eventId}`);
    const tracks = await as("/tracks");
    const vehicles = await as("/vehicles");
    const profile = await as("/me/profile");

    const everything = JSON.stringify([list.body, detail.body, tracks.body, vehicles.body, profile.body]);
    expect(everything).not.toContain("PRIVATE");
    expect(everything).not.toContain(student.email);

    const eventHidden = ["notes", "checklist", "cost_entry_cents", "cost_fuel_cents", "cost_travel_cents", "cost_misc_cents", "cost_cents"];
    for (const e of list.body) expect(keysOk(e, COACH_EVENT_FIELDS, eventHidden)).toEqual([]);
    expect(keysOk(detail.body, COACH_EVENT_FIELDS, [...eventHidden, "sessions", "setups"])).toEqual([]);
    for (const k of eventHidden) expect(detail.body[k]).toBeNull();
    expect(detail.body.setups).toEqual([]);
    for (const s of detail.body.sessions) {
      expect(keysOk(s, COACH_SESSION_FIELDS, ["notes", "laps"])).toEqual([]);
      expect(s.notes).toBeNull();
      // The recording's meta is the weather only — never the car's odometer.
      expect(keysOk(s.channels, COACH_CHANNEL_FIELDS, ["meta"])).toEqual([]);
      expect(s.channels.meta).toEqual({ ambientC: 21, elevationM: 12 });
      for (const l of s.laps) expect(keysOk(l, COACH_LAP_FIELDS, [])).toEqual([]);
    }
    for (const t of tracks.body) {
      expect(keysOk(t, COACH_TRACK_FIELDS, ["notes"])).toEqual([]);
      expect(t.notes).toBeNull();
    }
    for (const v of vehicles.body) expect(keysOk(v, COACH_VEHICLE_FIELDS, [])).toEqual([]);
    expect(keysOk(profile.body, COACH_PROFILE_FIELDS, [])).toEqual([]);
    expect(everything).not.toContain("48123");
    expect(COACH_META_FIELDS).not.toContain("odometerKm");
    const fits = await as(`/vehicles/${vehicles.body[0].id}/steering-fit`);
    expect(fits.status).toBe(200);
    expect(Object.keys(fits.body)).toEqual(["fits"]);
    for (const f of fits.body.fits) expect(keysOk(f, COACH_FIT_FIELDS, [])).toEqual([]);
  });

  it("drops to the free half of the panel when the student lapses", async () => {
    const { student, as } = await pair();
    const { eventId } = await richLogbook(student.api);
    await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(student.id).run();
    const entry = (await as(`/events/${eventId}`)).body.sessions[0].channels.laps[0];
    expect(entry.speed).toEqual(arr(30));
    expect(entry.rpm).toBeUndefined();
    expect((await as("/me/profile")).body.pro).toBe(false);
    // Access itself survives the lapse.
    expect((await as("/events")).status).toBe(200);
  });

  it("gets a 404 from every route off the allow-list", async () => {
    const { student, as } = await pair();
    const { eventId, trackId, vehicleId } = await richLogbook(student.api);
    for (const path of [
      "/me",
      "/me/connections",
      "/coaching",
      "/garage",
      `/tracks/${trackId}/setups`,
      `/tracks/${trackId}/leaderboard`,
      `/events/${eventId}/setups/prefill?day=1`,
      "/wrapped/2026",
      "/nothing-here",
    ]) {
      const res = await as(path);
      expect(`${path} → ${res.status}`).toBe(`${path} → 404`);
    }
    // The steering fit is allowed, and answers under the student's tier.
    expect((await as(`/vehicles/${vehicleId}/steering-fit`)).status).toBe(200);
  });

  it("can't write anything", async () => {
    const { student, as } = await pair();
    const { eventId, trackId, vehicleId } = await richLogbook(student.api);
    const before = await student.api("GET", `/events/${eventId}`);
    const writes: [string, string, unknown?][] = [
      ["POST", "/events", { track_name: "Coach Ring", start_date: "2026-06-01" }],
      ["PUT", `/events/${eventId}`, { notes: "coach was here" }],
      ["DELETE", `/events/${eventId}`],
      ["POST", `/events/${eventId}/sessions`, { laps: [90_000] }],
      ["PUT", `/tracks/${trackId}`, { notes: "coach was here" }],
      ["DELETE", `/vehicles/${vehicleId}`],
      ["PUT", "/me/profile", { profile: { goals: "coach was here" } }],
      ["PUT", "/me/units", { units: "metric" }],
      ["POST", "/coaching/invites"],
    ];
    for (const [method, path, body] of writes) {
      const res = await as(path, method, body);
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 404`);
    }
    expect((await student.api("GET", `/events/${eventId}`)).body).toEqual(before.body);
    expect((await student.api("GET", "/events")).body).toHaveLength(1);
  });

  it("marks the grant viewed", async () => {
    const { student, as } = await pair();
    await as("/events");
    const coaches = (await student.api("GET", "/coaching")).body.coaches;
    expect(coaches[0].last_viewed_at).toEqual(expect.any(Number));
  });
});

describe("without a grant", () => {
  it("is a 404 for another account's logbook, and a 401 signed out", async () => {
    const student = await signedInProUser();
    await richLogbook(student.api);
    const stranger = await signedInUser();
    expect((await stranger.api("GET", `/students/${student.id}/events`)).status).toBe(404);
    expect((await stranger.api("GET", `/students/999999/events`)).status).toBe(404);
    expect((await apiClient()("GET", `/students/${student.id}/events`)).status).toBe(401);
    // Your own id is not a grant either.
    expect((await student.api("GET", `/students/${student.id}/events`)).status).toBe(404);
  });

  it("stops on the request after the student revokes", async () => {
    const { student, coach, as } = await pair();
    expect((await as("/events")).status).toBe(200);
    expect((await student.api("DELETE", `/coaching/coaches/${coach.id}`)).status).toBe(200);
    expect((await as("/events")).status).toBe(404);
    expect((await student.api("DELETE", `/coaching/coaches/${coach.id}`)).status).toBe(404);
  });

  it("stops when the coach leaves", async () => {
    const { student, coach, as } = await pair();
    expect((await coach.api("DELETE", `/coaching/students/${student.id}`)).status).toBe(200);
    expect((await as("/events")).status).toBe(404);
    expect((await student.api("GET", "/coaching")).body.coaches).toEqual([]);
  });

  it("goes with either account", async () => {
    const { student, coach } = await pair();
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(coach.id).run();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM coach_grants WHERE student_id = ?")
      .bind(student.id)
      .first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("the driver profile", () => {
  const full = {
    occupation: "  Surgeon ",
    first_track_year: 2019,
    experience: "Autocross since 2015",
    license: "NASA HPDE4",
    instruction: "Two Skip Barber schools",
    helmet: "Bell GP3",
    helmet_rating: "SA2020",
    head_neck: "hans",
    suit: "Single-layer SFI 3.2A/1",
    gloves: true,
    shoes: false,
    gear_notes: "Wears glasses",
    goals: "Trail braking into T1",
    for_instructor: "Old left-wrist injury",
    unknown_key: "dropped",
  };

  it("round-trips, trimmed, with unknown keys dropped", async () => {
    const { api, id } = await signedInUser();
    const empty = await api("GET", "/me/profile");
    expect(empty.body).toEqual({ id, name: "Test User", picture: null, pro: false, profile: null });

    const put = await api("PUT", "/me/profile", { profile: full });
    expect(put.status).toBe(200);
    const { unknown_key: _, ...expected } = { ...full, occupation: "Surgeon" };
    expect(put.body).toEqual({ ok: true, profile: expected });
    expect((await api("GET", "/me/profile")).body.profile).toEqual(expected);

    expect((await api("PUT", "/me/profile", { profile: { goals: "  " } })).body.profile).toBeNull();
    expect((await api("GET", "/me/profile")).body.profile).toBeNull();
  });

  it("refuses a bad field, saying which", async () => {
    const { api } = await signedInUser();
    const year = new Date().getUTCFullYear();
    const future = await api("PUT", "/me/profile", { profile: { first_track_year: year + 1 } });
    expect(future.status).toBe(400);
    expect(future.body.error).toContain("first_track_year");
    expect((await api("PUT", "/me/profile", { profile: { helmet_rating: "SA2010" } })).status).toBe(400);
    expect((await api("PUT", "/me/profile", { profile: { gloves: "yes" } })).status).toBe(400);
    expect((await api("PUT", "/me/profile", { profile: { goals: "x".repeat(1001) } })).status).toBe(400);
    expect((await api("PUT", "/me/profile", {})).status).toBe(400);
  });

  it("keeps no birth date or emergency contact, even when sent one", async () => {
    const { api } = await signedInUser();
    const res = await api("PUT", "/me/profile", {
      profile: { date_of_birth: "1985-06-15", emergency_name: "Jamie", emergency_phone: "+1 555 0100", goals: "Trail braking" },
    });
    expect(res.body.profile).toEqual({ goals: "Trail braking" });
  });

  it("is what a coach sees at /me/profile, with the student's tier", async () => {
    const { student, as } = await pair();
    await student.api("PUT", "/me/profile", { profile: { goals: "Trail braking", head_neck: "hans" } });
    expect((await as("/me/profile")).body).toEqual({
      id: student.id,
      name: "Test User",
      picture: null,
      pro: true,
      profile: { goals: "Trail braking", head_neck: "hans" },
    });
  });

  it("never reaches the public share page", async () => {
    const { api } = await signedInUser();
    await api("PUT", "/me/profile", { profile: { occupation: "PRIVATE occupation" } });
    const slug = `profile-${Date.now()}`;
    await api("PUT", "/share", { slug });
    const res = await SELF.fetch(`https://example.com/api/share/${slug}`);
    expect(await res.text()).not.toContain("PRIVATE");
  });
});
