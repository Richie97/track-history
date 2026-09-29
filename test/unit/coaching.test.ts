import { describe, expect, it } from "vitest";
import { COACH_ROUTES, coachRoute } from "../../src/lib/coaching";
import { parseProfile, sanitizeProfile } from "../../src/lib/profile";

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

describe("sanitizeProfile", () => {
  const today = "2026-09-28";

  it("clears on null or an all-empty profile", () => {
    expect(sanitizeProfile(null, today)).toEqual({ profile: null });
    expect(sanitizeProfile({ occupation: " ", helmet_rating: "", gloves: null }, today)).toEqual({ profile: null });
  });

  it("drops keys it doesn't hold — a birth date or an emergency contact included", () => {
    expect(sanitizeProfile({ date_of_birth: "1985-06-15", emergency_phone: "555", goals: "Brake later" }, today)).toEqual({
      profile: { goals: "Brake later" },
    });
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
