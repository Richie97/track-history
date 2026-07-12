import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";

describe("POST /api/events", () => {
  it("creates an event, find-or-creating its track by name", async () => {
    const { api } = await signedInUser();
    const res = await api("POST", "/events", {
      track_name: "New Ring",
      start_date: "2026-05-01",
      days: 2,
      club: "VIR Club",
      best_time_ms: 121000,
    });
    expect(res.status).toBe(201);
    const tracks = (await api("GET", "/tracks")).body;
    expect(tracks).toHaveLength(1);
    expect(tracks[0].name).toBe("New Ring");
  });

  it("reuses an existing track case-insensitively", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "Test Ring" });
    await createEvent(api, { track_name: "test ring" });
    expect((await api("GET", "/tracks")).body).toHaveLength(1);
  });

  it("accepts an explicit track_id", async () => {
    const { api } = await signedInUser();
    const { body: track } = await api("POST", "/tracks", { name: "By Id" });
    const res = await api("POST", "/events", { track_id: track.id, start_date: "2026-05-01" });
    expect(res.status).toBe(201);
  });

  it("requires start_date and a track", async () => {
    const { api } = await signedInUser();
    expect((await api("POST", "/events", { track_name: "X" })).status).toBe(400);
    expect((await api("POST", "/events", { start_date: "2026-05-01" })).status).toBe(400);
    expect((await api("POST", "/events", { start_date: "2026-05-01", track_name: "  " })).status).toBe(400);
  });

  it("rejects another user's track_id", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { body: track } = await a.api("POST", "/tracks", { name: "Mine" });
    const res = await b.api("POST", "/events", { track_id: track.id, start_date: "2026-05-01" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/events", () => {
  it("lists newest first and filters by track_id", async () => {
    const { api } = await signedInUser();
    await createEvent(api, { track_name: "A Ring", start_date: "2026-03-01" });
    await createEvent(api, { track_name: "B Ring", start_date: "2026-05-01" });
    const all = (await api("GET", "/events")).body;
    expect(all.map((e: any) => e.start_date)).toEqual(["2026-05-01", "2026-03-01"]);

    const tracks = (await api("GET", "/tracks")).body;
    const aRing = tracks.find((t: any) => t.name === "A Ring");
    const filtered = (await api("GET", `/events?track_id=${aRing.id}`)).body;
    expect(filtered).toHaveLength(1);
    expect(filtered[0].track_name).toBe("A Ring");
  });

  it("does not leak other users' events", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await createEvent(a.api);
    expect((await b.api("GET", "/events")).body).toEqual([]);
  });
});

describe("GET /api/events/:id", () => {
  it("returns sessions with laps and the computed fields", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api, { best_time_ms: 125000 });
    await api("POST", `/events/${eventId}/sessions`, {
      label: "S1",
      laps: [123000, 121000, 122000],
    });

    const res = await api("GET", `/events/${eventId}`);
    expect(res.status).toBe(200);
    expect(res.body.best_ms).toBe(121000); // min(manual 125000, best lap 121000)
    expect(res.body.lap_count).toBe(3);
    expect(res.body.consistency).toBeCloseTo(0.006693, 5);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].laps.map((l: any) => l.time_ms)).toEqual([123000, 121000, 122000]);
    expect(res.body.sessions[0].laps.map((l: any) => l.lap_num)).toEqual([1, 2, 3]);
  });

  it("computes consistency as null with fewer than 3 laps", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, { laps: [121000, 122000] });
    expect((await api("GET", `/events/${eventId}`)).body.consistency).toBeNull();
  });

  it("404s for another user's event", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const eventId = await createEvent(a.api);
    expect((await b.api("GET", `/events/${eventId}`)).status).toBe(404);
  });
});

describe("PUT /api/events/:id", () => {
  it("updates only the provided fields", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api, { club: "Old Club", notes: "keep me" });
    const res = await api("PUT", `/events/${eventId}`, { club: "New Club" });
    expect(res.status).toBe(200);
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.club).toBe("New Club");
    expect(e.notes).toBe("keep me");
  });

  it("can move the event to a new track by name", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api, { track_name: "Old Ring" });
    await api("PUT", `/events/${eventId}`, { track_name: "New Ring" });
    expect((await api("GET", `/events/${eventId}`)).body.track_name).toBe("New Ring");
  });

  it("404s for another user's event and leaves it untouched", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const eventId = await createEvent(a.api, { club: "Original" });
    expect((await b.api("PUT", `/events/${eventId}`, { club: "Hacked" })).status).toBe(404);
    expect((await a.api("GET", `/events/${eventId}`)).body.club).toBe("Original");
  });
});

describe("DELETE /api/events/:id", () => {
  it("deletes the event and cascades to sessions and laps", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, { laps: [121000] });
    expect((await api("DELETE", `/events/${eventId}`)).status).toBe(200);
    expect((await api("GET", `/events/${eventId}`)).status).toBe(404);
    expect((await api("GET", "/events")).body).toEqual([]);
  });

  it("404s for another user's event", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const eventId = await createEvent(a.api);
    expect((await b.api("DELETE", `/events/${eventId}`)).status).toBe(404);
    expect((await a.api("GET", `/events/${eventId}`)).status).toBe(200);
  });
});
