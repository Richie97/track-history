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

  it("stores a best-lap trace and returns it with the event", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    const trace = Array.from({ length: 20 }, (_, i) => [i * 10.123, i * -5, 40 + i]);
    await api("POST", `/events/${eventId}/sessions`, { label: "Imported", laps: [121000], trace });
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.sessions[0].trace).toHaveLength(20);
    expect(e.sessions[0].trace[1]).toEqual([10.1, -5, 41]); // rounded for storage
  });

  it("leaves trace null when omitted and rejects invalid traces", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, { laps: [121000] });
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.sessions[0].trace).toBeNull();
    const bad = await api("POST", `/events/${eventId}/sessions`, { laps: [121000], trace: "nope" });
    expect(bad.status).toBe(400);
  });

  it("stores per-lap channels, re-rounded, and returns them with the event", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    const arr = (v: number) => Array.from({ length: 12 }, (_, i) => v + i + 0.123);
    const channels = {
      v: 1,
      dStepM: 20,
      laps: [
        { n: 1, timeMs: 121000, speed: arr(100), rpm: arr(4000), latG: arr(0.2).map((x) => x / 100) },
        { n: 2, timeMs: 119500, speed: arr(105) },
      ],
    };
    await api("POST", `/events/${eventId}/sessions`, { label: "Imported", laps: [121000, 119500], channels });
    const e = (await api("GET", `/events/${eventId}`)).body;
    const ch = e.sessions[0].channels;
    expect(ch.dStepM).toBe(20);
    expect(ch.laps).toHaveLength(2);
    expect(ch.laps[0].speed[0]).toBe(100.1); // rounded to 0.1 km/h
    expect(ch.laps[0].rpm[0]).toBe(4000); // rounded to whole rpm
    expect(ch.laps[1].rpm).toBeUndefined();
  });

  it("leaves channels null when omitted and rejects implausible channel data", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, { laps: [121000] });
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.sessions[0].channels).toBeNull();
    const cases = [
      "nope",
      { v: 1, dStepM: 20, laps: [] },
      { v: 1, dStepM: 20, laps: [{ n: 1, timeMs: 121000 }] }, // no channel arrays
      { v: 1, dStepM: 20, laps: [{ n: 1, timeMs: 121000, speed: [1, 2] }] }, // too short
      { v: 1, dStepM: 20, laps: [{ n: 1, timeMs: 121000, speed: Array(12).fill(9999) }] }, // implausible
      { v: 1, dStepM: 20, laps: [{ n: 1, timeMs: 121000, speed: Array(12).fill(100), rpm: Array(13).fill(1) }] }, // grid mismatch
      { v: 1, dStepM: 1000, laps: [{ n: 1, timeMs: 121000, speed: Array(12).fill(100) }] }, // bad grid step
    ];
    for (const channels of cases) {
      const bad = await api("POST", `/events/${eventId}/sessions`, { laps: [121000], channels });
      expect(bad.status, JSON.stringify(channels).slice(0, 60)).toBe(400);
    }
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
