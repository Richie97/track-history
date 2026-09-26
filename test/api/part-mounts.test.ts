import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInProUser } from "./helpers";

// Equip / unequip (migration 0029): a part accrues wear only while it's on the
// car, a front and a rear pair of tires are separate parts with their own
// sizes, and equipping one takes off whatever shares its place.

async function garageUser() {
  const u = await signedInProUser();
  const veh = await u.api("POST", "/vehicles", { name: "Corvette Z06" });
  return { ...u, vehicleId: veh.body.id as number };
}

// The part as /garage returns it, with the mounts' session ends (migration
// 0030) dropped where they're null, so a date-only mount reads as its dates.
type MountJson = { mounted_on: string; removed_on: string | null; mounted_session_id: number | null; removed_session_id: number | null };
const partOf = async (api: Awaited<ReturnType<typeof garageUser>>["api"], id: number) => {
  const part = (await api("GET", "/garage")).body[0].parts.find((p: { id: number }) => p.id === id);
  return part && {
    ...part,
    mounts: part.mounts.map(({ mounted_session_id, removed_session_id, ...dates }: MountJson) => ({
      ...dates,
      ...(mounted_session_id != null && { mounted_session_id }),
      ...(removed_session_id != null && { removed_session_id }),
    })),
  };
};

describe("part sizes and front / rear tires", () => {
  it("stores a size on a front and a rear pair and trims it", async () => {
    const { api, vehicleId } = await garageUser();
    const front = await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires_front", name: "Hoosier A7", size: " 285/30R18 ", installed_on: "2026-03-01",
    });
    const rear = await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires_rear", name: "Hoosier A7", size: "335/30R18", installed_on: "2026-03-01",
    });
    expect(front.status).toBe(201);
    expect(rear.status).toBe(201);
    expect((await partOf(api, front.body.id)).size).toBe("285/30R18");
    expect((await partOf(api, rear.body.id)).size).toBe("335/30R18");
    // Both on the car at once — a front and a rear pair don't swap each other.
    expect((await partOf(api, front.body.id)).equipped).toBe(true);
    expect((await partOf(api, rear.body.id)).equipped).toBe(true);

    await api("PUT", `/parts/${front.body.id}`, { size: "" });
    expect((await partOf(api, front.body.id)).size).toBeNull();
    expect((await api("PUT", `/parts/${front.body.id}`, { size: "x".repeat(41) })).status).toBe(400);
    expect((await api("PUT", `/parts/${front.body.id}`, { size: 18 })).status).toBe(400);
  });
});

describe("equip and unequip", () => {
  it("puts a new part on the car from its install date, and wear stops while it's on the shelf", async () => {
    const { api, vehicleId } = await garageUser();
    await createEvent(api, { car: "Corvette Z06", start_date: "2026-03-10", days: 1 });
    await createEvent(api, { car: "Corvette Z06", start_date: "2026-04-10", days: 1 });
    await createEvent(api, { car: "Corvette Z06", start_date: "2026-05-10", days: 1 });
    const { body } = await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires", name: "RE-71RS", installed_on: "2026-03-01",
    });
    let p = await partOf(api, body.id);
    expect(p.equipped).toBe(true);
    expect(p.mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: null }]);
    expect(p.wear.hours).toBe(3.8); // 3 × 1.25, to 1dp

    // Off for April, back on for May.
    expect((await api("POST", `/parts/${body.id}/unequip`, { on: "2026-04-01" })).status).toBe(200);
    p = await partOf(api, body.id);
    expect(p.equipped).toBe(false);
    expect(p.wear.hours).toBe(1.3); // 1.25, to 1dp
    expect((await api("POST", `/parts/${body.id}/equip`, { on: "2026-05-01" })).status).toBe(200);
    p = await partOf(api, body.id);
    expect(p.equipped).toBe(true);
    expect(p.mounts).toEqual([
      { mounted_on: "2026-03-01", removed_on: "2026-04-01" },
      { mounted_on: "2026-05-01", removed_on: null },
    ]);
    expect(p.wear.hours).toBe(2.5);
    expect(p.wear.events).toBe(2);
  });

  it("equipping takes off what shares the part's place, and only that", async () => {
    const { api, vehicleId } = await garageUser();
    const post = async (kind: string, name: string, extra = {}) =>
      (await api("POST", `/vehicles/${vehicleId}/parts`, { kind, name, installed_on: "2026-03-01", ...extra })).body.id as number;
    const trackSet = await post("tires", "Track set");
    const streetSet = await post("tires", "Street set", { equipped: false });
    const pads = await post("pads_front", "DTC-60");
    const other = await post("other", "Camera mount");
    const other2 = await post("other", "Harness");
    expect((await partOf(api, streetSet)).equipped).toBe(false);
    expect((await partOf(api, streetSet)).mounts).toEqual([]);

    const res = await api("POST", `/parts/${streetSet}/equip`, { on: "2026-06-01" });
    expect(res.body).toEqual({ ok: true, unequipped: [trackSet] });
    expect((await partOf(api, trackSet)).equipped).toBe(false);
    expect((await partOf(api, trackSet)).mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: "2026-06-01" }]);
    expect((await partOf(api, pads)).equipped).toBe(true);
    // "other" is anything at all, so it never swaps.
    expect((await partOf(api, other)).equipped).toBe(true);
    expect((await partOf(api, other2)).equipped).toBe(true);

    // A front pair takes a full set off; a rear pair then leaves the front on.
    const fronts = await post("tires_front", "A7 fronts", { equipped: false });
    const rears = await post("tires_rear", "A7 rears", { equipped: false });
    expect((await api("POST", `/parts/${fronts}/equip`, { on: "2026-07-01" })).body.unequipped).toEqual([streetSet]);
    expect((await api("POST", `/parts/${rears}/equip`, { on: "2026-07-01" })).body.unequipped).toEqual([]);
    // And a full set takes both pairs off.
    const both = (await api("POST", `/parts/${trackSet}/equip`, { on: "2026-08-01" })).body.unequipped;
    expect([...both].sort()).toEqual([fronts, rears].sort());
  });

  it("swap on create takes the old set off as of the new one's install date", async () => {
    const { api, vehicleId } = await garageUser();
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "Old", installed_on: "2026-03-01" })).body.id;
    await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "New", installed_on: "2026-05-01", swap: true });
    const p = await partOf(api, old);
    expect(p.equipped).toBe(false);
    expect(p.retired_on).toBeNull();
    expect(p.mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: "2026-05-01" }]);
    // Without swap, adding a second one leaves the first alone (the old behaviour).
    await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_rear", name: "R1", installed_on: "2026-03-01" });
    const r2 = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_rear", name: "R2", installed_on: "2026-05-01" })).body.id;
    const garage = (await api("GET", "/garage")).body[0].parts;
    expect(garage.filter((x: { kind: string; equipped: boolean }) => x.kind === "pads_rear" && x.equipped)).toHaveLength(2);
    expect(r2).toBeTypeOf("number");
  });

  it("refuses what doesn't make sense", async () => {
    const { api, vehicleId } = await garageUser();
    const id = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "Set", installed_on: "2026-03-01" })).body.id;
    expect((await api("POST", `/parts/${id}/equip`, {})).body).toEqual({ error: "part is already equipped" });
    expect((await api("POST", `/parts/${id}/unequip`, { on: "2026-02-01" })).body).toEqual({ error: "invalid on" });
    expect((await api("POST", `/parts/${id}/unequip`, { on: "2026-04-01" })).status).toBe(200);
    expect((await api("POST", `/parts/${id}/unequip`, {})).body).toEqual({ error: "part is not equipped" });
    // Not back inside a stretch it was already on.
    expect((await api("POST", `/parts/${id}/equip`, { on: "2026-03-15" })).body).toEqual({ error: "invalid on" });
    expect((await api("POST", `/parts/${id}/equip`, { on: "soon" })).body).toEqual({ error: "invalid on" });
    expect((await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "S", installed_on: "2026-03-01", equipped: "no" })).status).toBe(400);
    await api("PUT", `/parts/${id}`, { retired_on: "2026-05-01" });
    expect((await api("POST", `/parts/${id}/equip`, {})).body).toEqual({ error: "part is retired" });
  });

  it("never reaches another user's part", async () => {
    const a = await garageUser();
    const b = await signedInProUser();
    const id = (await a.api("POST", `/vehicles/${a.vehicleId}/parts`, { kind: "tires", name: "Set", installed_on: "2026-03-01" })).body.id;
    expect((await b.api("POST", `/parts/${id}/unequip`, {})).status).toBe(404);
    expect((await b.api("POST", `/parts/${id}/equip`, {})).status).toBe(404);
    expect((await partOf(a.api, id)).equipped).toBe(true);
  });
});

describe("the mount triggers keep plain PUTs meaning what they did", () => {
  it("retiring closes the mount, un-retiring reopens it, and moving either date moves it", async () => {
    const { api, vehicleId } = await garageUser();
    const id = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "oil", name: "5W-30", installed_on: "2026-03-01" })).body.id;
    await api("PUT", `/parts/${id}`, { retired_on: "2026-05-01" });
    expect((await partOf(api, id)).mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: "2026-05-01" }]);
    expect((await partOf(api, id)).equipped).toBe(false);
    await api("PUT", `/parts/${id}`, { retired_on: "2026-06-01" });
    expect((await partOf(api, id)).mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: "2026-06-01" }]);
    await api("PUT", `/parts/${id}`, { retired_on: null });
    expect((await partOf(api, id)).mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: null }]);
    expect((await partOf(api, id)).equipped).toBe(true);
    await api("PUT", `/parts/${id}`, { installed_on: "2026-02-15" });
    expect((await partOf(api, id)).mounts).toEqual([{ mounted_on: "2026-02-15", removed_on: null }]);
  });

  it("a part retired from the shelf goes back to the shelf when un-retired", async () => {
    const { api, vehicleId } = await garageUser();
    const id = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "Set", installed_on: "2026-03-01" })).body.id;
    await api("POST", `/parts/${id}/unequip`, { on: "2026-04-01" });
    await api("PUT", `/parts/${id}`, { retired_on: "2026-06-01" });
    await api("PUT", `/parts/${id}`, { retired_on: null });
    expect((await partOf(api, id)).equipped).toBe(false);
  });

  it("a part inserted straight into D1 is on the car from its install date", async () => {
    const { api, vehicleId } = await garageUser();
    const row = await env.DB.prepare(
      "INSERT INTO parts (vehicle_id, kind, name, installed_on) VALUES (?, 'tires', 'Seeded', '2026-03-01') RETURNING id"
    )
      .bind(vehicleId)
      .first<{ id: number }>();
    expect((await partOf(api, row!.id)).equipped).toBe(true);
  });

  it("refresh carries the size and keeps a shelved part's successor on the shelf", async () => {
    const { api, vehicleId } = await garageUser();
    const on = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires_front", name: "A7", size: "285/30R18", installed_on: "2026-03-01" })).body.id;
    const fresh = (await api("POST", `/parts/${on}/refresh`, { installed_on: "2026-05-01" })).body.id;
    const p = await partOf(api, fresh);
    expect(p.size).toBe("285/30R18");
    expect(p.equipped).toBe(true);
    expect((await partOf(api, on)).mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: "2026-05-01" }]);

    const spare = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires_rear", name: "Spare", installed_on: "2026-03-01", equipped: false })).body.id;
    const spareFresh = (await api("POST", `/parts/${spare}/refresh`, { size: "335/30R18" })).body.id;
    expect((await partOf(api, spareFresh)).equipped).toBe(false);
    expect((await partOf(api, spareFresh)).size).toBe("335/30R18");
  });

  it("a retired part refreshes into a new set without touching its own history", async () => {
    const { api, vehicleId } = await garageUser();
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires_front", name: "A7", size: "285/30R18", installed_on: "2026-03-01", cost_cents: 90_000, wear_limit: 2,
    })).body.id;
    await api("PUT", `/parts/${old}`, { retired_on: "2026-04-01" });
    const current = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires_front", name: "RT660", installed_on: "2026-04-01" })).body.id;

    const res = await api("POST", `/parts/${old}/refresh`, { installed_on: "2026-06-01", swap: true });
    expect(res.status).toBe(201);
    expect(res.body.retired_id).toBe(old);
    const fresh = await partOf(api, res.body.id);
    expect(fresh).toMatchObject({ kind: "tires_front", name: "A7", size: "285/30R18", installed_on: "2026-06-01", cost_cents: 90_000, wear_limit: 2, equipped: true, retired_on: null });
    // The old set stays exactly as it was retired…
    expect((await partOf(api, old)).retired_on).toBe("2026-04-01");
    expect((await partOf(api, old)).mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: "2026-04-01" }]);
    // …and swap took off what was on the car in its place.
    expect((await partOf(api, current)).equipped).toBe(false);

    // Without swap, or straight to the shelf.
    const again = (await api("POST", `/parts/${old}/refresh`, { installed_on: "2026-07-01" })).body.id;
    expect((await partOf(api, again)).equipped).toBe(true);
    expect((await partOf(api, res.body.id)).equipped).toBe(true);
    const spare = (await api("POST", `/parts/${old}/refresh`, { equipped: false })).body.id;
    expect((await partOf(api, spare)).equipped).toBe(false);
    expect((await api("POST", `/parts/${old}/refresh`, { equipped: "yes" })).status).toBe(400);
  });
});

describe("swaps between sessions (migration 0030)", () => {
  // A one-day event on the car with four sessions of five 2-minute laps: 40
  // minutes of laps, so the event's hours are 0.67 and each session is a quarter.
  async function trackDay(api: Awaited<ReturnType<typeof garageUser>>["api"], extra: Record<string, unknown> = {}) {
    const eventId = await createEvent(api, { car: "Corvette Z06", start_date: "2026-05-02", days: 1, ...extra });
    const sessions: number[] = [];
    for (let i = 1; i <= 4; i++)
      sessions.push((await api("POST", `/events/${eventId}/sessions`, { label: `Session ${i}`, laps: Array(5).fill(120_000) })).body.id);
    return { eventId, sessions };
  }
  const rawMounts = async (api: Awaited<ReturnType<typeof garageUser>>["api"], id: number): Promise<MountJson[]> =>
    (await api("GET", "/garage")).body[0].parts.find((p: { id: number }) => p.id === id).mounts;

  it("equipping at a session splits the day's hours between the set that came off and the one that went on", async () => {
    const { api, vehicleId } = await garageUser();
    const { sessions } = await trackDay(api);
    const street = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "PS4S", installed_on: "2026-03-01" })).body.id;
    const track = (await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires", name: "A7", installed_on: "2026-03-01", equipped: false,
    })).body.id;

    const res = await api("POST", `/parts/${track}/equip`, { on: "2026-05-02", session_id: sessions[2] });
    expect(res.status).toBe(200);
    expect(res.body.unequipped).toEqual([street]);
    expect(await rawMounts(api, street)).toEqual([
      { mounted_on: "2026-03-01", removed_on: "2026-05-02", mounted_session_id: null, removed_session_id: sessions[2] },
    ]);
    expect(await rawMounts(api, track)).toEqual([
      { mounted_on: "2026-05-02", removed_on: null, mounted_session_id: sessions[2], removed_session_id: null },
    ]);
    // Two sessions each, of an event worth 40 minutes.
    expect((await partOf(api, street)).wear.hours).toBe(0.3);
    expect((await partOf(api, track)).wear.hours).toBe(0.3);
  });

  it("a session with no date dates the swap its event's first day", async () => {
    const { api, vehicleId } = await garageUser();
    const { sessions } = await trackDay(api);
    const pads = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    expect((await api("POST", `/parts/${pads}/unequip`, { session_id: sessions[1] })).status).toBe(200);
    expect(await rawMounts(api, pads)).toEqual([
      { mounted_on: "2026-03-01", removed_on: "2026-05-02", mounted_session_id: null, removed_session_id: sessions[1] },
    ]);
    expect((await partOf(api, pads)).wear.hours).toBe(0.2); // one session of four
  });

  it("refresh at a session retires the old pads there and starts the new ones there", async () => {
    const { api, vehicleId } = await garageUser();
    const { sessions } = await trackDay(api);
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    const res = await api("POST", `/parts/${old}/refresh`, { installed_on: "2026-05-02", session_id: sessions[3] });
    expect(res.status).toBe(201);
    expect((await rawMounts(api, old))[0].removed_session_id).toBe(sessions[3]);
    expect((await rawMounts(api, res.body.id))[0].mounted_session_id).toBe(sessions[3]);
    expect((await partOf(api, old)).wear.hours).toBe(0.5); // three of four sessions
    expect((await partOf(api, res.body.id)).wear.hours).toBe(0.2);
  });

  it("creating a set with swap at a session takes the old one off there", async () => {
    const { api, vehicleId } = await garageUser();
    const { sessions } = await trackDay(api);
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "PS4S", installed_on: "2026-03-01" })).body.id;
    const fresh = await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires", name: "A7", installed_on: "2026-05-02", swap: true, session_id: sessions[2],
    });
    expect(fresh.status).toBe(201);
    expect((await rawMounts(api, old))[0].removed_session_id).toBe(sessions[2]);
    expect((await rawMounts(api, fresh.body.id))[0].mounted_session_id).toBe(sessions[2]);
    expect((await partOf(api, fresh.body.id)).wear.hours).toBe(0.3);
  });

  it("refuses a session that isn't on that car, that date, or this account", async () => {
    const { api, vehicleId } = await garageUser();
    const { sessions } = await trackDay(api);
    const pads = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    // Another date than the session's event.
    expect((await api("POST", `/parts/${pads}/unequip`, { on: "2026-05-03", session_id: sessions[0] })).body.error).toBe(
      "session_id is not on that date"
    );
    // A session of an event on no car.
    const loose = await createEvent(api, { start_date: "2026-05-02" });
    const looseSession = (await api("POST", `/events/${loose}/sessions`, { laps: [120_000] })).body.id;
    expect((await api("POST", `/parts/${pads}/unequip`, { session_id: looseSession })).status).toBe(400);
    // Someone else's.
    const other = await garageUser();
    const theirs = (await trackDay(other.api)).sessions[0];
    expect((await api("POST", `/parts/${pads}/unequip`, { session_id: theirs })).status).toBe(400);
    // Not a session id at all, or a spare that never goes on the car.
    expect((await api("POST", `/parts/${pads}/unequip`, { session_id: "3" })).status).toBe(400);
    expect(
      (await api("POST", `/vehicles/${vehicleId}/parts`, {
        kind: "tires", name: "Spare", installed_on: "2026-05-02", equipped: false, session_id: sessions[0],
      })).status
    ).toBe(400);
    // Nothing changed.
    expect((await partOf(api, pads)).equipped).toBe(true);
  });

  it("a weekend swap on the second day credits the new set with the sessions it ran", async () => {
    const { api, vehicleId } = await garageUser();
    const { sessions } = await trackDay(api, { days: 2 });
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "PS4S", installed_on: "2026-03-01" })).body.id;
    const fresh = (await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires", name: "A7", installed_on: "2026-05-03", swap: true, session_id: sessions[2],
    })).body.id;
    expect((await partOf(api, old)).wear.hours).toBe(0.3);
    expect((await partOf(api, fresh)).wear.hours).toBe(0.3);
  });

  it("moving the date a session was set on drops the session, and deleting the session falls back to dates", async () => {
    const { api, vehicleId } = await garageUser();
    const { sessions } = await trackDay(api);
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    const fresh = (await api("POST", `/parts/${old}/refresh`, { installed_on: "2026-05-02", session_id: sessions[2] })).body.id;

    // Un-retiring reopens the mount: it no longer ends at that session.
    await api("PUT", `/parts/${old}`, { retired_on: null });
    expect((await rawMounts(api, old))[0]).toMatchObject({ removed_on: null, removed_session_id: null });

    // Deleting the session the new set started at leaves its mount on the date.
    expect((await api("DELETE", `/sessions/${sessions[2]}`)).status).toBe(200);
    expect((await rawMounts(api, fresh))[0]).toMatchObject({ mounted_on: "2026-05-02", mounted_session_id: null });
  });
});
