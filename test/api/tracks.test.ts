import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";

describe("POST /api/tracks", () => {
  it("creates a track", async () => {
    const { api } = await signedInUser();
    const res = await api("POST", "/tracks", { name: "Road Atlanta" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Road Atlanta");
    expect(res.body.id).toBeTypeOf("number");
  });

  it("requires a non-empty name", async () => {
    const { api } = await signedInUser();
    expect((await api("POST", "/tracks", {})).status).toBe(400);
    expect((await api("POST", "/tracks", { name: "   " })).status).toBe(400);
  });

  it("rejects duplicates per user but allows the same name for another user", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    expect((await a.api("POST", "/tracks", { name: "VIR Full" })).status).toBe(201);
    expect((await a.api("POST", "/tracks", { name: "VIR Full" })).status).toBe(409);
    expect((await b.api("POST", "/tracks", { name: "VIR Full" })).status).toBe(201);
  });
});

describe("GET /api/tracks", () => {
  it("returns per-track aggregates and a sparkline series", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "Test Ring", start_date: "2026-04-01", best_time_ms: 125000, days: 2 });
    await createEvent(api, { track_name: "Test Ring", start_date: "2026-05-01", best_time_ms: 121000 });

    const res = await api("GET", "/tracks");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const t = res.body[0];
    expect(t.name).toBe("Test Ring");
    expect(t.event_count).toBe(2);
    expect(t.track_days).toBe(3);
    expect(t.best_ms).toBe(121000);
    expect(t.last_date).toBe("2026-05-01");
    expect(t.series).toEqual([
      { date: "2026-04-01", best_ms: 125000 },
      { date: "2026-05-01", best_ms: 121000 },
    ]);
  });

  it("only returns the caller's tracks", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await a.api("POST", "/tracks", { name: "Private Ring" });
    expect((await b.api("GET", "/tracks")).body).toEqual([]);
  });
});

describe("PUT /api/tracks/:id", () => {
  it("renames and sets a goal", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "Old Name" });
    const res = await api("PUT", `/tracks/${track.id}`, { name: "New Name", goal_ms: 119500 });
    expect(res.status).toBe(200);
    const list = (await api("GET", "/tracks")).body;
    expect(list[0].name).toBe("New Name");
    expect(list[0].goal_ms).toBe(119500);
  });

  it("clears a goal with null", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "T" .repeat(3) });
    await api("PUT", `/tracks/${track.id}`, { goal_ms: 119500 });
    await api("PUT", `/tracks/${track.id}`, { goal_ms: null });
    expect((await api("GET", "/tracks")).body[0].goal_ms).toBeNull();
  });

  it("validates the goal and rejects empty updates", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "Track" });
    expect((await api("PUT", `/tracks/${track.id}`, { goal_ms: -5 })).status).toBe(400);
    expect((await api("PUT", `/tracks/${track.id}`, { goal_ms: "2:00" })).status).toBe(400);
    expect((await api("PUT", `/tracks/${track.id}`, { name: "" })).status).toBe(400);
    expect((await api("PUT", `/tracks/${track.id}`, {})).status).toBe(400);
  });

  it("cannot touch another user's track", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { body: track } = await a.api("POST", "/tracks", { name: "Mine" });
    expect((await b.api("PUT", `/tracks/${track.id}`, { name: "Stolen" })).status).toBe(404);
    expect((await a.api("GET", "/tracks")).body[0].name).toBe("Mine");
  });
});

describe("DELETE /api/tracks/:id", () => {
  it("deletes an unused track", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "Unused" });
    expect((await api("DELETE", `/tracks/${track.id}`)).status).toBe(200);
    expect((await api("GET", "/tracks")).body).toEqual([]);
  });

  it("refuses to delete a track that has events", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "Busy Ring" });
    const track = (await api("GET", "/tracks")).body[0];
    const res = await api("DELETE", `/tracks/${track.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("track has events");
  });

  it("404s on another user's track", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { body: track } = await a.api("POST", "/tracks", { name: "Mine" });
    expect((await b.api("DELETE", `/tracks/${track.id}`)).status).toBe(404);
  });
});
