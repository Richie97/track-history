import { describe, expect, it } from "vitest";
import { COACH_ROUTES, coachRoute } from "../../src/lib/coaching";
import { ageOn, parseProfile, sanitizeProfile } from "../../src/lib/profile";

describe("coachRoute", () => {
  it("allows exactly the read routes on the table, GET only", () => {
    for (const path of ["/me/profile", "/events", "/events/12", "/tracks", "/vehicles", "/vehicles/3/steering-fit", "/catalog", "/car-catalog"]) {
      expect(coachRoute("GET", path), path).not.toBeNull();
      for (const m of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) expect(coachRoute(m, path), `${m} ${path}`).toBeNull();
    }
    for (const path of [
      "/me", "/me/connections", "/garage", "/coaching", "/share", "/wrapped/2026", "/events/1/setups/prefill",
      "/tracks/1/setups", "/tracks/1/leaderboard", "/tracks/1/leaderboard/laps/2", "/events/abc", "/events/1/", "/billing/apple",
    ]) {
      expect(coachRoute("GET", path), path).toBeNull();
    }
    expect(COACH_ROUTES).toHaveLength(8);
  });

  it("copies the allowed fields, empties the hidden ones, and drops anything else", () => {
    const view = coachRoute("GET", "/events/1")!;
    const out = view({
      id: 1,
      best_ms: 90_000,
      notes: "private",
      checklist: [{ text: "x", done: true }],
      cost_cents: 100,
      a_future_column: "secret",
      setups: [{ day: 1, data: {} }],
      sessions: [{ id: 2, notes: "private", laps: [{ id: 3, session_id: 2, lap_num: 1, time_ms: 90_000, extra: 1 }], channels: null }],
    });
    expect(out).toEqual({
      id: 1,
      best_ms: 90_000,
      notes: null,
      checklist: null,
      cost_cents: null,
      setups: [],
      sessions: [{ id: 2, notes: null, channels: null, laps: [{ id: 3, session_id: 2, lap_num: 1, time_ms: 90_000 }] }],
    });
  });

  it("keeps a vehicle's notes — that is where the modifications live", () => {
    const out = coachRoute("GET", "/vehicles")!([{ id: 1, name: "C7", notes: "coilovers", owner_email: "x" }]);
    expect(out).toEqual([{ id: 1, name: "C7", notes: "coilovers" }]);
  });

  it("answers a list view's non-list with an empty list", () => {
    expect(coachRoute("GET", "/tracks")!({ error: "?" })).toEqual([]);
  });
});

describe("ageOn", () => {
  it("counts a birthday once it has happened", () => {
    expect(ageOn("1990-06-15", "2026-06-14")).toBe(35);
    expect(ageOn("1990-06-15", "2026-06-15")).toBe(36);
  });

  it("brings a leap-day birthday round on 1 March in a common year", () => {
    expect(ageOn("2012-02-29", "2025-02-28")).toBe(12);
    expect(ageOn("2012-02-29", "2025-03-01")).toBe(13);
    expect(ageOn("2012-02-29", "2024-02-29")).toBe(12);
  });
});

describe("sanitizeProfile", () => {
  const today = "2026-09-28";

  it("clears on null or an all-empty profile", () => {
    expect(sanitizeProfile(null, today)).toEqual({ profile: null });
    expect(sanitizeProfile({ occupation: " ", date_of_birth: "", gloves: null }, today)).toEqual({ profile: null });
  });

  it("allows a 13th birthday and refuses the day before", () => {
    expect(sanitizeProfile({ date_of_birth: "2013-09-28" }, today)).toEqual({ profile: { date_of_birth: "2013-09-28" } });
    const r = sanitizeProfile({ date_of_birth: "2013-09-29" }, today);
    expect("error" in r && r.error).toContain("under 13");
  });

  it("refuses impossible dates, not just badly formatted ones", () => {
    for (const d of ["1990-02-30", "1990-13-01", "90-01-01", "2027-01-01", "1890-01-01"]) {
      expect("error" in sanitizeProfile({ date_of_birth: d }, today), d).toBe(true);
    }
  });

  it("bounds the first track year by this one", () => {
    expect(sanitizeProfile({ first_track_year: 2026 }, today)).toEqual({ profile: { first_track_year: 2026 } });
    expect("error" in sanitizeProfile({ first_track_year: 2027 }, today)).toBe(true);
    expect("error" in sanitizeProfile({ first_track_year: 2019.5 }, today)).toBe(true);
  });

  it("caps text at its length", () => {
    expect("error" in sanitizeProfile({ occupation: "x".repeat(201) }, today)).toBe(true);
    expect("error" in sanitizeProfile({ goals: "x".repeat(1001) }, today)).toBe(true);
    expect(sanitizeProfile({ goals: "x".repeat(1000) }, today)).toEqual({ profile: { goals: "x".repeat(1000) } });
  });

  it("parses a stored row, and degrades a bad one to null", () => {
    expect(parseProfile('{"goals":"Brake later"}', today)).toEqual({ goals: "Brake later" });
    expect(parseProfile("{not json", today)).toBeNull();
    expect(parseProfile('{"gloves":"yes"}', today)).toBeNull();
    expect(parseProfile(null, today)).toBeNull();
  });
});
