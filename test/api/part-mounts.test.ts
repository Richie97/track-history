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

// The part as /garage returns it, with the mounts' swap points (migration
// 0030) dropped where they're null, so a date-only mount reads as its dates.
type MountJson = {
  mounted_on: string;
  removed_on: string | null;
  mounted_event_id: number | null;
  mounted_after_session_id: number | null;
  removed_event_id: number | null;
  removed_after_session_id: number | null;
};
const partOf = async (api: Awaited<ReturnType<typeof garageUser>>["api"], id: number) => {
  const part = (await api("GET", "/garage")).body[0].parts.find((p: { id: number }) => p.id === id);
  return part && {
    ...part,
    mounts: part.mounts.map(
      ({ mounted_event_id, mounted_after_session_id, removed_event_id, removed_after_session_id, ...dates }: MountJson) => ({
        ...dates,
        ...(mounted_event_id != null && { mounted_event_id, mounted_after_session_id }),
        ...(removed_event_id != null && { removed_event_id, removed_after_session_id }),
      })
    ),
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

  it("takes a part with no install date as today: on the car when equipped, a spare when not", async () => {
    const { api, vehicleId } = await garageUser();
    const today = new Date().toISOString().slice(0, 10);
    const post = (extra = {}) => api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "Set", ...extra });
    const onCar = (await post()).body.id as number;
    const blank = (await post({ installed_on: "", equipped: false })).body.id as number;
    const spare = (await post({ installed_on: null, equipped: false, swap: true })).body.id as number;

    const fitted = await partOf(api, onCar);
    expect(fitted.installed_on).toBe(today);
    expect(fitted.equipped).toBe(true);
    expect(fitted.mounts).toEqual([{ mounted_on: today, removed_on: null }]);
    for (const id of [blank, spare]) {
      const p = await partOf(api, id);
      expect(p.installed_on).toBe(today);
      expect(p.equipped).toBe(false);
      expect(p.mounts).toEqual([]);
    }
    // A spare's `swap` takes nothing off: it isn't going on.
    expect((await partOf(api, onCar)).equipped).toBe(true);
    // An edit still needs a real date.
    expect((await api("PUT", `/parts/${onCar}`, { installed_on: null })).status).toBe(400);
    expect((await api("PUT", `/parts/${onCar}`, { installed_on: "" })).status).toBe(400);
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
  type Api = Awaited<ReturnType<typeof garageUser>>["api"];
  // A one-day event on the car; each session is five 2-minute laps, a tenth of
  // an event with all four sessions in (0.67 h).
  async function trackDay(api: Api, extra: Record<string, unknown> = {}) {
    const eventId = await createEvent(api, { car: "Corvette Z06", start_date: "2026-05-02", days: 1, ...extra });
    const sessions: number[] = [];
    const log = async (n: number) => {
      for (let i = 0; i < n; i++)
        sessions.push(
          (await api("POST", `/events/${eventId}/sessions`, { label: `Session ${sessions.length + 1}`, laps: Array(5).fill(120_000) })).body.id
        );
    };
    return { eventId, sessions, log };
  }
  const rawMounts = async (api: Api, id: number): Promise<MountJson[]> =>
    (await api("GET", "/garage")).body[0].parts.find((p: { id: number }) => p.id === id).mounts;
  const tires = async (api: Api, vehicleId: number) => ({
    street: (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "PS4S", installed_on: "2026-03-01" })).body.id,
    track: (await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires", name: "A7", installed_on: "2026-03-01", equipped: false,
    })).body.id,
  });

  it("equip on a track day swaps after the last session logged, and later sessions run on the new set", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(2);
    const { street, track } = await tires(api, vehicleId);

    const res = await api("POST", `/parts/${track}/equip`, { on: "2026-05-02" });
    expect(res.status).toBe(200);
    expect(res.body.unequipped).toEqual([street]);
    const at = { event: day.eventId, after: day.sessions[1] };
    expect(await rawMounts(api, street)).toEqual([
      {
        mounted_on: "2026-03-01", removed_on: "2026-05-02", mounted_event_id: null, mounted_after_session_id: null,
        removed_event_id: at.event, removed_after_session_id: at.after,
      },
    ]);
    expect(await rawMounts(api, track)).toEqual([
      {
        mounted_on: "2026-05-02", removed_on: null, mounted_event_id: at.event, mounted_after_session_id: at.after,
        removed_event_id: null, removed_after_session_id: null,
      },
    ]);
    // The afternoon's two sessions are imported that evening.
    await day.log(2);
    expect((await partOf(api, street)).wear.hours).toBe(0.3);
    expect((await partOf(api, track)).wear.hours).toBe(0.3);
  });

  it("a swap before any session is logged gives the whole day to the part that went on", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    const { street, track } = await tires(api, vehicleId);
    await api("POST", `/parts/${track}/equip`, { on: "2026-05-02" });
    expect((await rawMounts(api, track))[0]).toMatchObject({ mounted_event_id: day.eventId, mounted_after_session_id: null });
    await day.log(4);
    expect((await partOf(api, street)).wear.hours).toBe(0);
    expect((await partOf(api, track)).wear.hours).toBe(0.7);
  });

  it("a date that isn't a track day on this car keeps the date rule", async () => {
    const { api, vehicleId } = await garageUser();
    await trackDay(api);
    const { track } = await tires(api, vehicleId);
    await api("POST", `/parts/${track}/equip`, { on: "2026-05-05" });
    expect((await partOf(api, track)).mounts).toEqual([{ mounted_on: "2026-05-05", removed_on: null }]);
  });

  it("names the point explicitly: after a session, or null for the event's start", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(4);
    const pads = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    expect((await api("POST", `/parts/${pads}/unequip`, { on: "2026-05-02", after_session_id: day.sessions[0] })).status).toBe(200);
    expect((await partOf(api, pads)).wear.hours).toBe(0.2); // one session of four
    const spare = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_rear", name: "DTC-30", installed_on: "2026-03-01" })).body.id;
    await api("POST", `/parts/${spare}/unequip`, { on: "2026-05-02", after_session_id: null });
    expect((await partOf(api, spare)).wear.hours).toBe(0);
  });

  it("refresh on a track day retires the old pads and starts the new ones after the last session", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(3);
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    const res = await api("POST", `/parts/${old}/refresh`, { installed_on: "2026-05-02" });
    expect(res.status).toBe(201);
    expect((await rawMounts(api, old))[0].removed_after_session_id).toBe(day.sessions[2]);
    expect((await rawMounts(api, res.body.id))[0].mounted_after_session_id).toBe(day.sessions[2]);
    await day.log(1);
    expect((await partOf(api, old)).wear.hours).toBe(0.5); // three of four sessions
    expect((await partOf(api, res.body.id)).wear.hours).toBe(0.2);
  });

  it("adding a set with swap on a track day takes the old one off at the same point", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(2);
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "PS4S", installed_on: "2026-03-01" })).body.id;
    const fresh = await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "A7", installed_on: "2026-05-02", swap: true });
    expect(fresh.status).toBe(201);
    expect((await rawMounts(api, old))[0].removed_after_session_id).toBe(day.sessions[1]);
    expect((await rawMounts(api, fresh.body.id))[0].mounted_after_session_id).toBe(day.sessions[1]);
    // A spare added on a track day goes to the shelf, with no point to sit at.
    const spare = (await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires", name: "Rain", installed_on: "2026-05-02", equipped: false,
    })).body.id;
    expect((await partOf(api, spare)).mounts).toEqual([]);
  });

  it("refuses a session that isn't that day's on that car, or this account's", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(1);
    const pads = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    // No track day on that date.
    expect((await api("POST", `/parts/${pads}/unequip`, { on: "2026-05-03", after_session_id: day.sessions[0] })).body.error).toBe(
      "after_session_id is not on that date"
    );
    // A session of an event on no car.
    const loose = await createEvent(api, { start_date: "2026-05-02" });
    const looseSession = (await api("POST", `/events/${loose}/sessions`, { laps: [120_000] })).body.id;
    expect((await api("POST", `/parts/${pads}/unequip`, { on: "2026-05-02", after_session_id: looseSession })).status).toBe(400);
    // Someone else's.
    const other = await garageUser();
    const theirs = await trackDay(other.api);
    await theirs.log(1);
    expect((await api("POST", `/parts/${pads}/unequip`, { on: "2026-05-02", after_session_id: theirs.sessions[0] })).status).toBe(400);
    expect((await api("POST", `/parts/${pads}/unequip`, { on: "2026-05-02", after_session_id: "3" })).status).toBe(400);
    expect((await partOf(api, pads)).equipped).toBe(true);
  });

  it("a weekend swap on the second day credits the new set with the sessions it ran", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api, { days: 2 });
    await day.log(2);
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "tires", name: "PS4S", installed_on: "2026-03-01" })).body.id;
    const fresh = (await api("POST", `/vehicles/${vehicleId}/parts`, {
      kind: "tires", name: "A7", installed_on: "2026-05-03", swap: true,
    })).body.id;
    await day.log(2);
    expect((await partOf(api, old)).wear.hours).toBe(0.3);
    expect((await partOf(api, fresh)).wear.hours).toBe(0.3);
  });

  it("editing when a part went on moves the part it replaced with it", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(4);
    const { street, track } = await tires(api, vehicleId);
    await api("POST", `/parts/${track}/equip`, { on: "2026-05-02" }); // after the last session: the new set ran none
    expect((await partOf(api, track)).wear.hours).toBe(0);

    // It actually went on after the first session.
    const res = await api("PUT", `/parts/${track}/mount`, { after_session_id: day.sessions[0] });
    expect(res.status).toBe(200);
    expect(res.body.moved).toEqual([street]);
    expect((await rawMounts(api, street))[0]).toMatchObject({ removed_on: "2026-05-02", removed_after_session_id: day.sessions[0] });
    expect((await partOf(api, street)).wear.hours).toBe(0.2);
    expect((await partOf(api, track)).wear.hours).toBe(0.5);

    // Or on another day altogether: the old set comes off then too, by date.
    expect((await api("PUT", `/parts/${track}/mount`, { mounted_on: "2026-05-10" })).body.moved).toEqual([street]);
    expect((await partOf(api, street)).mounts).toEqual([{ mounted_on: "2026-03-01", removed_on: "2026-05-10" }]);
    expect((await partOf(api, track)).mounts).toEqual([{ mounted_on: "2026-05-10", removed_on: null }]);
    expect((await partOf(api, street)).wear.hours).toBe(0.7);
  });

  it("editing a refreshed part's install moves the old part's retirement with it", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(4);
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    const fresh = (await api("POST", `/parts/${old}/refresh`, { installed_on: "2026-05-02" })).body.id;
    expect((await api("PUT", `/parts/${fresh}/mount`, { mounted_on: "2026-04-20" })).body.moved).toEqual([old]);
    expect(await partOf(api, old)).toMatchObject({ retired_on: "2026-04-20", mounts: [{ mounted_on: "2026-03-01", removed_on: "2026-04-20" }] });
    // Its first mount moved, so its install date did too.
    expect((await partOf(api, fresh)).installed_on).toBe("2026-04-20");
    expect((await partOf(api, fresh)).wear.hours).toBe(0.7);
  });

  it("a part bought as a spare and fitted later keeps its install date as a floor", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(2);
    const { track } = await tires(api, vehicleId); // installed 2026-03-01, on the shelf
    await api("POST", `/parts/${track}/equip`, { on: "2026-05-02" });
    expect((await api("PUT", `/parts/${track}/mount`, { mounted_on: "2026-04-01" })).status).toBe(200);
    expect((await partOf(api, track)).installed_on).toBe("2026-03-01");
    expect((await api("PUT", `/parts/${track}/mount`, { mounted_on: "2026-02-01" })).status).toBe(400);
  });

  it("refuses an edit that would overlap the part's own history or run past today", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(1);
    const { track } = await tires(api, vehicleId);
    await api("POST", `/parts/${track}/equip`, { on: "2026-04-01" });
    await api("POST", `/parts/${track}/unequip`, { on: "2026-04-10" });
    await api("POST", `/parts/${track}/equip`, { on: "2026-05-02" });
    expect((await api("PUT", `/parts/${track}/mount`, { mounted_on: "2026-04-05" })).status).toBe(400); // inside the last stretch
    expect((await api("PUT", `/parts/${track}/mount`, { mounted_on: "2099-01-01" })).status).toBe(400);
    const never = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "oil", name: "Spare oil", installed_on: "2026-03-01", equipped: false })).body.id;
    expect((await api("PUT", `/parts/${never}/mount`, {})).body.error).toBe("part has never been on the car");
  });

  it("deleting the session a swap came after moves it back to after the one before", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(3);
    const { track } = await tires(api, vehicleId);
    await api("POST", `/parts/${track}/equip`, { on: "2026-05-02", after_session_id: day.sessions[1] });
    expect((await api("DELETE", `/sessions/${day.sessions[1]}`)).status).toBe(200);
    expect((await rawMounts(api, track))[0].mounted_after_session_id).toBe(day.sessions[0]);
    expect((await api("DELETE", `/sessions/${day.sessions[0]}`)).status).toBe(200);
    expect((await rawMounts(api, track))[0]).toMatchObject({ mounted_event_id: day.eventId, mounted_after_session_id: null });
  });

  it("un-retiring drops the point the retirement closed at", async () => {
    const { api, vehicleId } = await garageUser();
    const day = await trackDay(api);
    await day.log(2);
    const old = (await api("POST", `/vehicles/${vehicleId}/parts`, { kind: "pads_front", name: "DTC-60", installed_on: "2026-03-01" })).body.id;
    await api("POST", `/parts/${old}/refresh`, { installed_on: "2026-05-02" });
    await api("PUT", `/parts/${old}`, { retired_on: null });
    expect((await rawMounts(api, old))[0]).toMatchObject({ removed_on: null, removed_event_id: null, removed_after_session_id: null });
  });
});
