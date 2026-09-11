import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiClient, createEvent, signedInProUser, signedInUser } from "./helpers";

// A minimal but valid channel blob carrying session meta (#191). One lap, one
// channel — sanitizeChannels only wants a plausible shape.
function channels(meta: Record<string, number>) {
  return {
    v: 1,
    dStepM: 20,
    meta,
    laps: [{ n: 1, timeMs: 121000, speed: Array.from({ length: 12 }, (_, i) => 100 + i) }],
  };
}

describe("session conditions (#191)", () => {
  it("derives ambient and elevation from the channel meta on insert", async () => {
    const { api } = await signedInProUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, {
      laps: [121000],
      channels: channels({ ambientC: 21.4, elevationM: 38.4, intakeC: 44, odometerKm: 71087 }),
    });
    const s = (await api("GET", `/events/${eventId}`)).body.sessions[0];
    // The stored blob rounds to the meta spec; the columns follow it.
    expect(s.ambient_c).toBe(21.4);
    expect(s.elevation_m).toBe(38);
  });

  it("leaves a hand-entered or recorded session with no conditions", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, { label: "Typed", laps: [121000] });
    const s = (await api("GET", `/events/${eventId}`)).body.sessions[0];
    expect(s.ambient_c).toBeNull();
    expect(s.elevation_m).toBeNull();
  });

  it("shows a free account the conditions even though the channels are stripped", async () => {
    // The temperature is context for a lap time, not analysis of it: the Pro
    // gate is on `channels`, and these columns are deliberately outside it.
    const pro = await signedInProUser();
    const eventId = await createEvent(pro.api);
    await pro.api("POST", `/events/${eventId}/sessions`, {
      laps: [121000],
      channels: channels({ ambientC: 31.5, elevationM: 12 }),
    });
    await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(pro.id).run();
    const s = (await apiClient(pro.token)("GET", `/events/${eventId}`)).body.sessions[0];
    expect(s.channels).toBeNull();
    expect(s.ambient_c).toBe(31.5);
    expect(s.elevation_m).toBe(12);
  });

  it("carries the event's ambient range and elevation on the event list", async () => {
    const { api } = await signedInProUser();
    const eventId = await createEvent(api);
    // A cool morning session with many laps and a hot afternoon one with a
    // single lap: MIN/MAX must not come out weighted by the laps join.
    await api("POST", `/events/${eventId}/sessions`, {
      label: "Morning",
      laps: [121000, 121500, 122000, 121200],
      channels: channels({ ambientC: 14.2, elevationM: 38 }),
    });
    await api("POST", `/events/${eventId}/sessions`, {
      label: "Afternoon",
      laps: [120500],
      channels: channels({ ambientC: 31.8, elevationM: 41 }),
    });
    const [listed] = (await api("GET", "/events")).body;
    expect(listed.ambient_lo_c).toBe(14.2);
    expect(listed.ambient_hi_c).toBe(31.8);
    expect(listed.elevation_m).toBe(41);
    // The detail view agrees with the list — same eventSelect.
    const detail = (await api("GET", `/events/${eventId}`)).body;
    expect(detail.ambient_lo_c).toBe(14.2);
    expect(detail.ambient_hi_c).toBe(31.8);
  });

  it("nulls the event aggregates when no session recorded conditions", async () => {
    const { api } = await signedInUser();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, { laps: [121000] });
    const [listed] = (await api("GET", "/events")).body;
    expect(listed.ambient_lo_c).toBeNull();
    expect(listed.ambient_hi_c).toBeNull();
    expect(listed.elevation_m).toBeNull();
  });

  it("keeps the manual temp_f untouched — the two never overwrite each other", async () => {
    const { api } = await signedInProUser();
    const eventId = await createEvent(api, { temp_f: 61 });
    await api("POST", `/events/${eventId}/sessions`, {
      laps: [121000],
      channels: channels({ ambientC: 31.8 }),
    });
    const e = (await api("GET", `/events/${eventId}`)).body;
    expect(e.temp_f).toBe(61);
    expect(e.ambient_hi_c).toBe(31.8);
  });

  it("shares the conditions on the public share payload", async () => {
    const { api, id } = await signedInProUser();
    await env.DB.prepare("UPDATE users SET share_slug = ? WHERE id = ?").bind(`cond${id}`, id).run();
    const eventId = await createEvent(api);
    await api("POST", `/events/${eventId}/sessions`, {
      laps: [121000],
      channels: channels({ ambientC: 24.5, elevationM: 40 }),
    });
    const pub = (await apiClient()("GET", `/share/cond${id}`)).body;
    expect(pub.events[0].ambient_hi_c).toBe(24.5);
    expect(pub.events[0].elevation_m).toBe(40);
  });
});
