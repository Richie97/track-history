import { describe, expect, it } from "vitest";
import { apiClient, createEvent, signedInUser } from "./helpers";

const isoInDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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

  it("excludes upcoming events from aggregates and the sparkline series", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "Test Ring", start_date: "2026-05-01", best_time_ms: 121000, days: 2 });
    await createEvent(api, { track_name: "Test Ring", start_date: isoInDays(30), best_time_ms: 119000, days: 3 });

    const t = (await api("GET", "/tracks")).body[0];
    expect(t.event_count).toBe(1);
    expect(t.track_days).toBe(2);
    expect(t.best_ms).toBe(121000);
    expect(t.last_date).toBe("2026-05-01");
    expect(t.series).toEqual([{ date: "2026-05-01", best_ms: 121000 }]);
  });

  it("shows zero-event aggregates for a track with only upcoming events", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "Future Ring", start_date: isoInDays(14) });
    const t = (await api("GET", "/tracks")).body[0];
    expect(t.event_count).toBe(0);
    expect(t.track_days).toBe(0);
    expect(t.best_ms).toBeNull();
    expect(t.last_date).toBeNull();
    expect(t.series).toEqual([]);
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

describe("track identity by name", () => {
  it("treats different layout names as separate tracks", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "VIR Full", best_time_ms: 121000 });
    await createEvent(api, { track_name: "VIR Patriot", best_time_ms: 80000 });

    const tracks = (await api("GET", "/tracks")).body;
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t: any) => t.name).sort()).toEqual(["VIR Full", "VIR Patriot"]);
    // Bests must not bleed across layouts
    const full = tracks.find((t: any) => t.name === "VIR Full");
    expect(full.best_ms).toBe(121000);
  });

  it("find-or-create matches names case-insensitively", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "VIR Full" });
    await createEvent(api, { track_name: "vir full" });
    expect((await api("GET", "/tracks")).body).toHaveLength(1);
  });

  it("rejects a rename that collides with another track", async () => {
    const { api } = await signedInUser();
    await api("POST", "/tracks", { name: "VIR Full" });
    const { body: patriot } = await api("POST", "/tracks", { name: "VIR Patriot" });
    expect((await api("PUT", `/tracks/${patriot.id}`, { name: "VIR Full" })).status).toBe(409);
  });

  it("updates course notes", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "VIR Full" });
    const res = await api("PUT", `/tracks/${track.id}`, { notes: "T1: brake at the 300 board" });
    expect(res.status).toBe(200);
    expect((await api("GET", "/tracks")).body[0].notes).toBe("T1: brake at the 300 board");
  });

  it("clears course notes with empty/null", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "VIR Full" });
    await api("PUT", `/tracks/${track.id}`, { notes: "something" });
    await api("PUT", `/tracks/${track.id}`, { notes: null });
    expect((await api("GET", "/tracks")).body[0].notes).toBeNull();
  });

  it("events expose the track name", async () => {
    const { api } = await signedInUser();
    const id = await createEvent(api, { track_name: "VIR Full" });
    expect((await api("GET", `/events/${id}`)).body.track_name).toBe("VIR Full");
  });
});

describe("track catalog", () => {
  it("links a created track to its catalog entry by name", async () => {
    const { api } = await signedInUser();
    const { body } = await api("POST", "/tracks", { name: "Road Atlanta" });
    expect(body.catalog_id).toBeTypeOf("number");
  });

  it("matches catalog names case-insensitively", async () => {
    const { api } = await signedInUser();
    const exact = (await api("POST", "/tracks", { name: "Road Atlanta" })).body;
    const lower = (await api("POST", "/tracks", { name: "ROAD ATLANTA" })).body;
    expect(lower.catalog_id).toBe(exact.catalog_id);
  });

  it("leaves catalog_id null for tracks the catalog does not know", async () => {
    const { api } = await signedInUser();
    const { body } = await api("POST", "/tracks", { name: "My Backyard Kart Track" });
    expect(body.catalog_id).toBeNull();
  });

  it("links tracks find-or-created through events", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "Watkins Glen International" });
    await createEvent(api, { track_name: "Test Ring" });
    const tracks = (await api("GET", "/tracks")).body;
    const glen = tracks.find((t: any) => t.name === "Watkins Glen International");
    const ring = tracks.find((t: any) => t.name === "Test Ring");
    expect(glen.catalog_id).toBeTypeOf("number");
    expect(ring.catalog_id).toBeNull();
  });

  it("gives the same catalog_id to different users' copies of a track", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const ta = (await a.api("POST", "/tracks", { name: "Sonoma Raceway" })).body;
    const tb = (await b.api("POST", "/tracks", { name: "Sonoma Raceway" })).body;
    expect(ta.id).not.toBe(tb.id);
    expect(ta.catalog_id).toBe(tb.catalog_id);
  });

  it("re-matches the catalog when a track is renamed", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "Rd Atlanta" });
    expect(track.catalog_id).toBeNull();

    await api("PUT", `/tracks/${track.id}`, { name: "Road Atlanta" });
    expect((await api("GET", "/tracks")).body[0].catalog_id).toBeTypeOf("number");

    await api("PUT", `/tracks/${track.id}`, { name: "Rd Atlanta again" });
    expect((await api("GET", "/tracks")).body[0].catalog_id).toBeNull();
  });

  it("does not touch catalog_id on goal/notes updates", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "Road Atlanta" });
    await api("PUT", `/tracks/${track.id}`, { goal_ms: 95000, notes: "n" });
    expect((await api("GET", "/tracks")).body[0].catalog_id).toBe(track.catalog_id);
  });
});

describe("GET /api/catalog", () => {
  it("returns the seeded catalog for the track-name suggestions", async () => {
    const { api } = await signedInUser();
    const res = await api("GET", "/catalog");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(50);
    expect(res.body.map((t: any) => t.name)).toContain("Road Atlanta");
    expect(res.body[0].id).toBeTypeOf("number");
    // Layout entries are spelled out, not abbreviated (renamed in 0009).
    const names = res.body.map((t: any) => t.name);
    expect(names).toContain("Virginia International Raceway (Full)");
    expect(names).toContain("Virginia International Raceway (North)");
    expect(names).toContain("Virginia International Raceway (South)");
    expect(names).not.toContain("VIR Full");
  });

  it("requires a session", async () => {
    const res = await apiClient()("GET", "/catalog");
    expect(res.status).toBe(401);
  });
});
