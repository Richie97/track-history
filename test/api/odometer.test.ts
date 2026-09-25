import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInProUser } from "./helpers";

// The car's own odometer in the garage (#192): `sessions.odometer_km` derived
// from the channel meta (migration 0027), read back through GET /garage.

function channels(meta: Record<string, number>) {
  return {
    v: 1,
    dStepM: 20,
    meta,
    laps: [{ n: 1, timeMs: 121000, speed: Array.from({ length: 12 }, (_, i) => 100 + i) }],
  };
}

async function garageWithCar() {
  const u = await signedInProUser();
  const veh = await u.api("POST", "/vehicles", { name: "Corvette C7" });
  return { ...u, vehicleId: veh.body.id as number };
}

const session = (api: Awaited<ReturnType<typeof garageWithCar>>["api"], eventId: number, meta?: Record<string, number>) =>
  api("POST", `/events/${eventId}/sessions`, meta ? { laps: [121000], channels: channels(meta) } : { laps: [121000] });

describe("session odometer column (#192)", () => {
  it("is derived from the channel meta on insert, and null without one", async () => {
    const { api, id } = await garageWithCar();
    const eventId = await createEvent(api, { car: "Corvette C7" });
    await session(api, eventId, { odometerKm: 71087 });
    await session(api, eventId);
    const rows = (
      await env.DB.prepare(
        "SELECT s.odometer_km FROM sessions s JOIN events e ON e.id = s.event_id WHERE e.user_id = ? ORDER BY s.id"
      )
        .bind(id)
        .all<{ odometer_km: number | null }>()
    ).results;
    expect(rows.map((r) => r.odometer_km)).toEqual([71087, null]);
  });

  it("follows a rewrite of the channels blob", async () => {
    const { api } = await garageWithCar();
    const eventId = await createEvent(api, { car: "Corvette C7" });
    const s = await session(api, eventId, { odometerKm: 1000 });
    await env.DB.prepare("UPDATE sessions SET channels = ? WHERE id = ?")
      .bind(JSON.stringify(channels({ odometerKm: 1200 })), s.body.id)
      .run();
    const row = await env.DB.prepare("SELECT odometer_km FROM sessions WHERE id = ?").bind(s.body.id).first();
    expect(row!.odometer_km).toBe(1200);
  });

  it("is not added to the event detail's sessions", async () => {
    const { api } = await garageWithCar();
    const eventId = await createEvent(api);
    await session(api, eventId, { odometerKm: 71087 });
    const s = (await api("GET", `/events/${eventId}`)).body.sessions[0];
    expect("odometer_km" in s).toBe(false);
  });
});

describe("GET /garage odometer (#192)", () => {
  it("is null on a car with no recorded reading", async () => {
    const { api, vehicleId } = await garageWithCar();
    const eventId = await createEvent(api, { car: "Corvette C7" });
    await session(api, eventId);
    const v = (await api("GET", "/garage")).body.find((x: { id: number }) => x.id === vehicleId);
    expect(v.odometer).toBeNull();
  });

  it("reports the car's last reading and each part's recorded span beside its hours", async () => {
    const { api, vehicleId } = await garageWithCar();
    const pads = await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "pads_front",
      name: "XP12",
      installed_on: "2026-03-01",
      expected_hours: 24,
    });
    const tires = await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "RT660", installed_on: "2026-04-15" });
    const march = await createEvent(api, { car: "Corvette C7", start_date: "2026-03-10" });
    const april = await createEvent(api, { car: "Corvette C7", start_date: "2026-04-20" });
    // A borrowed car's recording, mislinked by name: lower, so skipped.
    const borrowed = await createEvent(api, { car: "Corvette C7", start_date: "2026-04-01" });
    // An unlinked event's reading never reaches the car at all.
    const other = await createEvent(api, { car: "Rental Miata", start_date: "2026-04-02" });
    // Sessions posted out of running order within the day.
    await session(api, march, { odometerKm: 70090 });
    await session(api, march, { odometerKm: 70000 });
    await session(api, borrowed, { odometerKm: 21000 });
    await session(api, other, { odometerKm: 99000 });
    await session(api, april, { odometerKm: 70800 });

    const v = (await api("GET", "/garage")).body.find((x: { id: number }) => x.id === vehicleId);
    expect(v.odometer).toEqual({ km: 70800, on: "2026-04-20", readings: 3, other_car: 1 });
    const byId = Object.fromEntries(v.parts.map((p: { id: number }) => [p.id, p]));
    expect(byId[pads.body.id].odometer).toEqual({ km: 800, from: "2026-03-10", to: "2026-04-20", readings: 3 });
    // One reading in the tires' window is not a distance.
    expect(byId[tires.body.id].odometer).toBeNull();
    // The hours estimate is untouched by any of it: three linked days at 2 h,
    // the borrowed-car day included — the odometer never feeds wear.ts.
    expect(byId[pads.body.id].wear.hours).toBe(6);
  });
});
