import { describe, expect, it } from "vitest";
import { createEvent, signedInUser } from "./helpers";

// The garage logbook: consumable parts + wear, per-event-day setup sheets,
// and the event → vehicle link they hang off.

async function garageUser() {
  const u = await signedInUser();
  const veh = await u.api("POST", "/vehicles", { name: "Corvette Z06" });
  return { ...u, vehicleId: veh.body.id as number };
}

const PAST = "2026-05-01"; // fixed past date (tests run "today")

describe("event ↔ vehicle link", () => {
  it("matches the car text to a garage vehicle case-insensitively", async () => {
    const { api, vehicleId } = await garageUser();
    const id = await createEvent(api, { car: "corvette z06" });
    const e = (await api("GET", `/events/${id}`)).body;
    expect(e.vehicle_id).toBe(vehicleId);
  });

  it("clears the link when the car no longer names a garage vehicle", async () => {
    const { api, vehicleId } = await garageUser();
    const id = await createEvent(api, { car: "Corvette Z06" });
    await api("PUT", `/events/${id}`, { car: "Rental Miata" });
    const e = (await api("GET", `/events/${id}`)).body;
    expect(e.vehicle_id).toBeNull();
    expect(e.car).toBe("Rental Miata");
    expect(vehicleId).toBeTypeOf("number");
  });

  it("never links across users", async () => {
    const a = await garageUser();
    const b = await signedInUser();
    const id = await createEvent(b.api, { car: "Corvette Z06" });
    expect((await b.api("GET", `/events/${id}`)).body.vehicle_id).toBeNull();
  });
});

describe("event track_hours and computed hours", () => {
  it("defaults hours to 2h per day and accepts an override", async () => {
    const { api } = await signedInUser();
    const id = await createEvent(api, { start_date: PAST, days: 2 });
    expect((await api("GET", `/events/${id}`)).body.hours).toBe(4);
    await api("PUT", `/events/${id}`, { track_hours: 5.5 });
    expect((await api("GET", `/events/${id}`)).body.hours).toBe(5.5);
  });

  it("rejects implausible overrides", async () => {
    const { api } = await signedInUser();
    const id = await createEvent(api);
    expect((await api("PUT", `/events/${id}`, { track_hours: -1 })).status).toBe(400);
    expect((await api("PUT", `/events/${id}`, { track_hours: 500 })).status).toBe(400);
    expect((await api("PUT", `/events/${id}`, { track_hours: "3h" })).status).toBe(400);
  });
});

describe("parts CRUD", () => {
  it("creates, lists via /garage, updates and deletes a part", async () => {
    const { api, vehicleId } = await garageUser();
    const created = await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "pads_front",
      name: "Hawk DTC-60",
      installed_on: "2026-01-15",
      cost_cents: 38900,
      wear_limit: 3,
    });
    expect(created.status).toBe(201);

    const garage = (await api("GET", "/garage")).body;
    expect(garage).toHaveLength(1);
    const part = garage[0].parts[0];
    expect(part.name).toBe("Hawk DTC-60");
    expect(part.wear).toMatchObject({ hours: 0, events: 0 });

    expect((await api("PUT", `/parts/${part.id}`, { retired_on: "2026-06-01" })).status).toBe(200);
    expect((await api("DELETE", `/parts/${part.id}`)).status).toBe(200);
    expect((await api("GET", "/garage")).body[0].parts).toHaveLength(0);
  });

  it("validates kind, name and dates", async () => {
    const { api, vehicleId } = await garageUser();
    const post = (body: any) => api("POST", `/vehicles/${vehicleId}/parts`, body);
    expect((await post({ kind: "wing", name: "X", installed_on: PAST })).status).toBe(400);
    expect((await post({ kind: "tires", name: "  ", installed_on: PAST })).status).toBe(400);
    expect((await post({ kind: "tires", name: "RE-71RS", installed_on: "soon" })).status).toBe(400);
    expect((await post({ kind: "tires", name: "RE-71RS", installed_on: PAST, cost_cents: -5 })).status).toBe(400);
  });

  it("isolates parts between users", async () => {
    const a = await garageUser();
    const b = await signedInUser();
    await a.api("POST", `/vehicles/${a.vehicleId}/parts`, {
      kind: "tires",
      name: "Private Tires",
      installed_on: PAST,
    });
    const partId = (await a.api("GET", "/garage")).body[0].parts[0].id;
    expect((await b.api("GET", "/garage")).body).toHaveLength(0);
    expect((await b.api("PUT", `/parts/${partId}`, { name: "stolen" })).status).toBe(404);
    expect((await b.api("DELETE", `/parts/${partId}`)).status).toBe(404);
    expect((await b.api("POST", `/vehicles/${a.vehicleId}/parts`, { kind: "oil", name: "X", installed_on: PAST })).status).toBe(404);
    expect((await b.api("POST", `/parts/${partId}/measurements`, { measured_on: PAST, value: 5 })).status).toBe(404);
  });
});

describe("wear accrual & measurements", () => {
  it("accrues hours from the vehicle's past events inside the service window", async () => {
    const { api, vehicleId } = await garageUser();
    await createEvent(api, { start_date: "2026-02-14", days: 2, car: "Corvette Z06" });
    await createEvent(api, { start_date: "2026-04-18", days: 1, car: "Corvette Z06", track_hours: 3 });
    await createEvent(api, { start_date: "2099-01-01", days: 2, car: "Corvette Z06" }); // upcoming — no wear
    await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "pads_front",
      name: "DTC-70",
      installed_on: "2026-01-15",
      expected_hours: 10,
    });
    const part = (await api("GET", "/garage")).body[0].parts[0];
    expect(part.wear.hours).toBe(7); // 4 + 3
    expect(part.wear.events).toBe(2);
    expect(part.wear.source).toBe("expected");
    expect(part.wear.remaining_hours).toBe(3);
  });

  it("switches to a measured projection with two measurements", async () => {
    const { api, vehicleId } = await garageUser();
    await createEvent(api, { start_date: "2026-02-14", days: 2, car: "Corvette Z06" });
    await createEvent(api, { start_date: "2026-04-18", days: 2, car: "Corvette Z06" });
    await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "pads_front",
      name: "DTC-70",
      installed_on: "2026-01-15",
      wear_limit: 3,
    });
    const partId = (await api("GET", "/garage")).body[0].parts[0].id;
    expect(
      (await api("POST", `/parts/${partId}/measurements`, { measured_on: "2026-02-20", value: 16, unit: "mm" })).status
    ).toBe(201);
    await api("POST", `/parts/${partId}/measurements`, { measured_on: "2026-04-20", value: 12, unit: "mm" });
    const part = (await api("GET", "/garage")).body[0].parts[0];
    expect(part.wear.source).toBe("measured");
    expect(part.wear.wear_per_hour).toBeCloseTo(1); // 4mm over 4h
    expect(part.wear.remaining_hours).toBeCloseTo(9); // (12-3)/1
    expect(part.measurements).toHaveLength(2);
  });

  it("defaults a new part's expected life from retired lifecycles of the same kind", async () => {
    const { api, vehicleId } = await garageUser();
    await createEvent(api, { start_date: "2026-02-14", days: 2, car: "Corvette Z06" });
    await createEvent(api, { start_date: "2026-04-18", days: 2, car: "Corvette Z06" });
    await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "pads_front",
      name: "DTC-60",
      installed_on: "2026-01-01",
      retired_on: "2026-06-01", // lived through both events → 8h
    });
    await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "pads_front",
      name: "DTC-70",
      installed_on: "2026-06-02",
    });
    const parts = (await api("GET", "/garage")).body[0].parts;
    const fresh = parts.find((p: any) => p.name === "DTC-70");
    expect(fresh.expected_hours).toBe(8);
  });

  it("validates and deletes measurements", async () => {
    const { api, vehicleId } = await garageUser();
    await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "RE-71RS", installed_on: PAST });
    const partId = (await api("GET", "/garage")).body[0].parts[0].id;
    expect((await api("POST", `/parts/${partId}/measurements`, { measured_on: "later", value: 5 })).status).toBe(400);
    expect((await api("POST", `/parts/${partId}/measurements`, { measured_on: PAST, value: -1 })).status).toBe(400);
    const m = await api("POST", `/parts/${partId}/measurements`, { measured_on: PAST, value: 6, unit: "32nds" });
    expect((await api("DELETE", `/parts/${partId}/measurements/${m.body.id}`)).status).toBe(200);
    expect((await api("GET", "/garage")).body[0].parts[0].measurements).toHaveLength(0);
  });
});

describe("part refresh", () => {
  const addPads = (api: any, vehicleId: number, extra: Record<string, unknown> = {}) =>
    api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "pads_front",
      name: "DTC-70",
      installed_on: "2026-01-15",
      cost_cents: 38900,
      wear_limit: 3,
      notes: "with shims",
      ...extra,
    });

  it("retires the old part and installs a same-spec successor with hours reset", async () => {
    const { api, vehicleId } = await garageUser();
    await createEvent(api, { start_date: "2026-02-14", days: 2, car: "Corvette Z06" }); // 4h
    await addPads(api, vehicleId);
    const oldId = (await api("GET", "/garage")).body[0].parts[0].id;

    const res = await api("POST", `/parts/${oldId}/refresh`, { installed_on: "2026-05-01" });
    expect(res.status).toBe(201);
    expect(res.body.retired_id).toBe(oldId);

    const parts = (await api("GET", "/garage")).body[0].parts;
    expect(parts).toHaveLength(2);
    const retired = parts.find((p: any) => p.id === oldId);
    const fresh = parts.find((p: any) => p.id === res.body.id);
    expect(retired.retired_on).toBe("2026-05-01");
    expect(fresh).toMatchObject({
      kind: "pads_front",
      name: "DTC-70",
      installed_on: "2026-05-01",
      retired_on: null,
      cost_cents: 38900,
      wear_limit: 3,
      notes: "with shims",
    });
    expect(fresh.wear.hours).toBe(0);
    expect(fresh.measurements).toHaveLength(0);
    // Expected life self-calibrates from the just-retired lifecycle (4h).
    expect(fresh.expected_hours).toBe(4);
  });

  it("defaults the swap date to today and accepts a new cost", async () => {
    const { api, vehicleId } = await garageUser();
    await addPads(api, vehicleId);
    const oldId = (await api("GET", "/garage")).body[0].parts[0].id;
    const res = await api("POST", `/parts/${oldId}/refresh`, { cost_cents: 42000 });
    expect(res.status).toBe(201);
    const today = new Date().toISOString().slice(0, 10);
    const parts = (await api("GET", "/garage")).body[0].parts;
    expect(parts.find((p: any) => p.id === oldId).retired_on).toBe(today);
    const fresh = parts.find((p: any) => p.id === res.body.id);
    expect(fresh.installed_on).toBe(today);
    expect(fresh.cost_cents).toBe(42000);
    // No driven lifecycle to average → keeps the old part's (null) expected life.
    expect(fresh.expected_hours).toBeNull();
  });

  it("rejects retired parts, bad swap dates, and foreign parts", async () => {
    const a = await garageUser();
    const b = await signedInUser();
    await addPads(a.api, a.vehicleId, { installed_on: PAST });
    const partId = (await a.api("GET", "/garage")).body[0].parts[0].id;
    expect((await b.api("POST", `/parts/${partId}/refresh`)).status).toBe(404);
    expect((await a.api("POST", `/parts/${partId}/refresh`, { installed_on: "soon" })).status).toBe(400);
    // Swap date before the part was even installed makes a negative window.
    expect((await a.api("POST", `/parts/${partId}/refresh`, { installed_on: "2026-04-01" })).status).toBe(400);
    await a.api("PUT", `/parts/${partId}`, { retired_on: "2026-06-01" });
    expect((await a.api("POST", `/parts/${partId}/refresh`)).status).toBe(400);
  });
});

describe("setup sheets", () => {
  const SHEET = { tp_cold: { fl: 31, fr: 31, rl: 30, rr: 30 }, camber: { f: -2.5, r: -2 }, notes: "baseline" };

  it("upserts, returns in event detail, and deletes", async () => {
    const { api } = await signedInUser();
    const id = await createEvent(api, { days: 2 });
    expect((await api("PUT", `/events/${id}/setups/1`, SHEET)).status).toBe(200);
    expect((await api("PUT", `/events/${id}/setups/1`, { ...SHEET, camber: { f: -3.2, r: -2 } })).status).toBe(200);
    const e = (await api("GET", `/events/${id}`)).body;
    expect(e.setups).toHaveLength(1);
    expect(e.setups[0].day).toBe(1);
    expect(e.setups[0].data.camber.f).toBe(-3.2);
    expect((await api("DELETE", `/events/${id}/setups/1`)).status).toBe(200);
    expect((await api("GET", `/events/${id}`)).body.setups).toHaveLength(0);
  });

  it("rejects invalid sheets, days, and foreign events", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const id = await createEvent(a.api);
    expect((await a.api("PUT", `/events/${id}/setups/0`, SHEET)).status).toBe(400);
    expect((await a.api("PUT", `/events/${id}/setups/1`, { tp_cold: { fl: 900 } })).status).toBe(400);
    expect((await a.api("PUT", `/events/${id}/setups/1`, {})).status).toBe(400);
    expect((await b.api("PUT", `/events/${id}/setups/1`, SHEET)).status).toBe(404);
    expect((await b.api("DELETE", `/events/${id}/setups/1`)).status).toBe(404);
  });

  it("prefills from the previous day, then from the vehicle's last event", async () => {
    const { api } = await garageUser();
    const first = await createEvent(api, { start_date: "2026-04-18", days: 2, car: "Corvette Z06" });
    await api("PUT", `/events/${first}/setups/2`, SHEET);
    // Same event, later day → previous day's sheet.
    const sameEvent = (await api("GET", `/events/${first}/setups/prefill?day=3`)).body;
    expect(sameEvent.data.notes).toBe("baseline");
    // Next event on the same vehicle → that event's latest sheet.
    const next = await createEvent(api, { start_date: "2026-06-13", days: 2, car: "Corvette Z06" });
    const crossEvent = (await api("GET", `/events/${next}/setups/prefill?day=1`)).body;
    expect(crossEvent.data.camber).toEqual({ f: -2.5, r: -2 });
    // No vehicle link → nothing to prefill from.
    const unlinked = await createEvent(api, { start_date: "2026-06-20", car: "Rental" });
    expect((await api("GET", `/events/${unlinked}/setups/prefill?day=1`)).body.data).toBeNull();
  });

  it("lists sheets with outcome stats per track", async () => {
    const { api } = await garageUser();
    const id = await createEvent(api, {
      track_name: "Setup Ring",
      start_date: "2026-04-18",
      best_time_ms: 128600,
      car: "Corvette Z06",
    });
    await api("PUT", `/events/${id}/setups/1`, SHEET);
    const trackId = (await api("GET", `/events/${id}`)).body.track_id;
    const rows = (await api("GET", `/tracks/${trackId}/setups`)).body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: id, day: 1, best_ms: 128600 });
    expect(rows[0].data.notes).toBe("baseline");
  });
});

describe("share privacy", () => {
  it("keeps garage linkage and setups out of the public payload", async () => {
    const { api } = await garageUser();
    const id = await createEvent(api, { car: "Corvette Z06", track_hours: 5 });
    await api("PUT", `/events/${id}/setups/1`, { fuel: 12, notes: "secret damper settings" });
    await api("PUT", "/share", { slug: "garage-privacy" });
    const pub = await api("GET", "/share/garage-privacy");
    expect(pub.status).toBe(200);
    const json = JSON.stringify(pub.body);
    expect(json).not.toContain("vehicle_id");
    expect(json).not.toContain("track_hours");
    expect(json).not.toContain("secret damper settings");
    expect(json).not.toContain("setup");
  });
});
