import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";

// updated_at is maintained entirely by the triggers in
// migrations/0011_updated_at.sql; these tests drive the API and assert the
// bumps land, including the nested cascades (laps → session → event) that the
// frontend's offline cache staleness check depends on.

// Force a row's updated_at to a sentinel so a subsequent bump is detectable
// regardless of timestamp resolution.
async function backdate(table: string, id: number) {
  await env.DB.prepare(`UPDATE ${table} SET updated_at = 1 WHERE id = ?`).bind(id).run();
}
async function updatedAt(table: string, id: number) {
  const row = await env.DB.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ updated_at: number }>();
  return row!.updated_at;
}

describe("updated_at maintenance", () => {
  it("is set on insert and exposed in event list and detail responses", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    const list = (await api("GET", "/events")).body;
    expect(list[0].updated_at).toBeGreaterThan(0);
    const detail = (await api("GET", `/events/${eventId}`)).body;
    expect(detail.updated_at).toBeGreaterThan(0);
    const tracks = (await api("GET", "/tracks")).body;
    expect(tracks[0].updated_at).toBeGreaterThan(0);
  });

  it("bumps the event on PUT", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await backdate("events", eventId);
    await api("PUT", `/events/${eventId}`, { notes: "updated" });
    expect(await updatedAt("events", eventId)).toBeGreaterThan(1);
  });

  it("bumps the event when a session is added or deleted", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await backdate("events", eventId);
    const s = await api("POST", `/events/${eventId}/sessions`, { label: "S1" });
    expect(await updatedAt("events", eventId)).toBeGreaterThan(1);

    await backdate("events", eventId);
    await api("DELETE", `/sessions/${s.body.id}`);
    expect(await updatedAt("events", eventId)).toBeGreaterThan(1);
  });

  it("bumps the session and event when laps are added", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    const s = await api("POST", `/events/${eventId}/sessions`, { label: "S1" });
    await backdate("events", eventId);
    await backdate("sessions", s.body.id);
    await api("POST", `/sessions/${s.body.id}/laps`, { laps: [121000] });
    expect(await updatedAt("sessions", s.body.id)).toBeGreaterThan(1);
    expect(await updatedAt("events", eventId)).toBeGreaterThan(1);
  });

  it("bumps the event when a lap is deleted", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    const s = await api("POST", `/events/${eventId}/sessions`, { laps: [121000, 122000] });
    const detail = (await api("GET", `/events/${eventId}`)).body;
    const lapId = detail.sessions[0].laps[0].id;
    await backdate("events", eventId);
    await api("DELETE", `/laps/${lapId}`);
    expect(await updatedAt("events", eventId)).toBeGreaterThan(1);
  });

  it("bumps the track on PUT", async () => {
    const { api } = await signedInUser();
    await createEvent(api); // creates "Test Ring"
    const tracks = (await api("GET", "/tracks")).body;
    await backdate("tracks", tracks[0].id);
    await api("PUT", `/tracks/${tracks[0].id}`, { goal_ms: 119000 });
    expect(await updatedAt("tracks", tracks[0].id)).toBeGreaterThan(1);
  });
});
