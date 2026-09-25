import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInProUser } from "./helpers";

// Equip / unequip (migration 0029): a part accrues wear only while it's on the
// car, a front and a rear pair of tyres are separate parts with their own
// sizes, and equipping one takes off whatever shares its place.

async function garageUser() {
  const u = await signedInProUser();
  const veh = await u.api("POST", "/vehicles", { name: "Corvette Z06" });
  return { ...u, vehicleId: veh.body.id as number };
}

const partOf = async (api: Awaited<ReturnType<typeof garageUser>>["api"], id: number) =>
  (await api("GET", "/garage")).body[0].parts.find((p: { id: number }) => p.id === id);

describe("part sizes and front / rear tyres", () => {
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
    expect(p.wear.hours).toBe(6);

    // Off for April, back on for May.
    expect((await api("POST", `/parts/${body.id}/unequip`, { on: "2026-04-01" })).status).toBe(200);
    p = await partOf(api, body.id);
    expect(p.equipped).toBe(false);
    expect(p.wear.hours).toBe(2);
    expect((await api("POST", `/parts/${body.id}/equip`, { on: "2026-05-01" })).status).toBe(200);
    p = await partOf(api, body.id);
    expect(p.equipped).toBe(true);
    expect(p.mounts).toEqual([
      { mounted_on: "2026-03-01", removed_on: "2026-04-01" },
      { mounted_on: "2026-05-01", removed_on: null },
    ]);
    expect(p.wear.hours).toBe(4);
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
});
