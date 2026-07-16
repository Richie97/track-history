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

describe("track configurations", () => {
  it("treats the same name with different configs as separate tracks", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "VIR", track_config: "Full", best_time_ms: 121000 });
    await createEvent(api, { track_name: "VIR", track_config: "Patriot", best_time_ms: 80000 });

    const tracks = (await api("GET", "/tracks")).body;
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t: any) => t.config).sort()).toEqual(["Full", "Patriot"]);
    // Bests must not bleed across configs
    const full = tracks.find((t: any) => t.config === "Full");
    expect(full.best_ms).toBe(121000);
  });

  it("find-or-create matches config case-insensitively", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "VIR", track_config: "Full" });
    await createEvent(api, { track_name: "vir", track_config: "FULL" });
    expect((await api("GET", "/tracks")).body).toHaveLength(1);
  });

  it("rejects duplicate (name, config) on create and update", async () => {
    const { api } = await signedInUser();
    expect((await api("POST", "/tracks", { name: "VIR", config: "Full" })).status).toBe(201);
    expect((await api("POST", "/tracks", { name: "VIR", config: "Full" })).status).toBe(409);
    const { body: patriot } = await api("POST", "/tracks", { name: "VIR", config: "Patriot" });
    expect((await api("PUT", `/tracks/${patriot.id}`, { config: "Full" })).status).toBe(409);
  });

  it("updates config and course notes", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "VIR" });
    const res = await api("PUT", `/tracks/${track.id}`, { config: "Full", notes: "T1: brake at the 300 board" });
    expect(res.status).toBe(200);
    const t = (await api("GET", "/tracks")).body[0];
    expect(t.config).toBe("Full");
    expect(t.notes).toBe("T1: brake at the 300 board");
  });

  it("clears course notes with empty/null", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "VIR" });
    await api("PUT", `/tracks/${track.id}`, { notes: "something" });
    await api("PUT", `/tracks/${track.id}`, { notes: null });
    expect((await api("GET", "/tracks")).body[0].notes).toBeNull();
  });

  it("events expose the track config", async () => {
    const { api } = await signedInUser();
    const id = await createEvent(api, { track_name: "VIR", track_config: "Full" });
    expect((await api("GET", `/events/${id}`)).body.track_config).toBe("Full");
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
    const lower = (await api("POST", "/tracks", { name: "road atlanta", config: "CCW" })).body;
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

  it("does not touch catalog_id on goal/notes/config updates", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "Road Atlanta" });
    await api("PUT", `/tracks/${track.id}`, { goal_ms: 95000, notes: "n", config: "CCW" });
    expect((await api("GET", "/tracks")).body[0].catalog_id).toBe(track.catalog_id);
  });
});
