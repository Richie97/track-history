import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";

async function eventWithSession(api: any, laps: number[] = [123000, 121000]) {
  const eventId = await createEvent(api);
  const res = await api("POST", `/events/${eventId}/sessions`, { label: "S1", laps });
  return { eventId, sessionId: res.body.id as number };
}

describe("POST /api/events/:id/sessions", () => {
  it("creates a session with numbered laps", async () => {
    const { api } = await signedInUser();
    const { eventId } = await eventWithSession(api, [123000, 121000, 122000]);
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.sessions).toHaveLength(1);
    expect(e.sessions[0].label).toBe("S1");
    expect(e.sessions[0].laps.map((l: any) => l.lap_num)).toEqual([1, 2, 3]);
  });

  it("assigns increasing sort order to consecutive sessions", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, { label: "First" });
    await api("POST", `/events/${eventId}/sessions`, { label: "Second" });
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.sessions.map((s: any) => s.label)).toEqual(["First", "Second"]);
    expect(e.sessions[0].sort).toBeLessThan(e.sessions[1].sort);
  });

  it("filters out invalid laps and rounds to whole ms", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, { laps: [121000.4, 0, -5, null, "x"] });
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.sessions[0].laps.map((l: any) => l.time_ms)).toEqual([121000]);
  });

  it("404s on another user's event", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const eventId = await createEvent(a.api);
    const res = await b.api("POST", `/events/${eventId}/sessions`, { laps: [121000] });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/sessions/:id", () => {
  it("updates label and notes", async () => {
    const { api } = await signedInUser();
    const { eventId, sessionId } = await eventWithSession(api);
    await api("PUT", `/sessions/${sessionId}`, { label: "Renamed", notes: "wet track" });
    const s = (await api("GET", `/events/${eventId}`)).body.sessions[0];
    expect(s.label).toBe("Renamed");
    expect(s.notes).toBe("wet track");
  });

  it("404s on another user's session", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { sessionId } = await eventWithSession(a.api);
    expect((await b.api("PUT", `/sessions/${sessionId}`, { label: "x" })).status).toBe(404);
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("deletes the session and its laps", async () => {
    const { api } = await signedInUser();
    const { eventId, sessionId } = await eventWithSession(api);
    expect((await api("DELETE", `/sessions/${sessionId}`)).status).toBe(200);
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.sessions).toEqual([]);
    expect(e.lap_count).toBe(0);
  });

  it("404s on another user's session", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { sessionId } = await eventWithSession(a.api);
    expect((await b.api("DELETE", `/sessions/${sessionId}`)).status).toBe(404);
  });
});

describe("POST /api/sessions/:id/laps", () => {
  it("appends laps continuing the lap numbering", async () => {
    const { api } = await signedInUser();
    const { eventId, sessionId } = await eventWithSession(api, [123000, 121000]);
    const res = await api("POST", `/sessions/${sessionId}/laps`, { laps: [122000] });
    expect(res.status).toBe(201);
    const laps = (await api("GET", `/events/${eventId}`)).body.sessions[0].laps;
    expect(laps.map((l: any) => l.lap_num)).toEqual([1, 2, 3]);
    expect(laps[2].time_ms).toBe(122000);
  });

  it("rejects an empty or all-invalid lap list", async () => {
    const { api } = await signedInUser();
    const { sessionId } = await eventWithSession(api);
    expect((await api("POST", `/sessions/${sessionId}/laps`, { laps: [] })).status).toBe(400);
    expect((await api("POST", `/sessions/${sessionId}/laps`, { laps: [0, -1] })).status).toBe(400);
  });

  it("404s on another user's session", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { sessionId } = await eventWithSession(a.api);
    expect((await b.api("POST", `/sessions/${sessionId}/laps`, { laps: [121000] })).status).toBe(404);
  });
});

describe("DELETE /api/laps/:id", () => {
  it("deletes an owned lap", async () => {
    const { api } = await signedInUser();
    const { eventId } = await eventWithSession(api, [123000, 121000]);
    const lap = (await api("GET", `/events/${eventId}`)).body.sessions[0].laps[0];
    expect((await api("DELETE", `/laps/${lap.id}`)).status).toBe(200);
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.lap_count).toBe(1);
    expect(e.best_ms).toBe(121000);
  });

  it("404s on another user's lap", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { eventId } = await eventWithSession(a.api);
    const lap = (await a.api("GET", `/events/${eventId}`)).body.sessions[0].laps[0];
    expect((await b.api("DELETE", `/laps/${lap.id}`)).status).toBe(404);
  });
});
