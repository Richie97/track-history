import { describe, expect, it } from "vitest";
import { apiClient, signedInUser } from "./helpers";

describe("POST /api/vehicles", () => {
  it("creates a vehicle with notes", async () => {
    const { api } = await signedInUser();
    const res = await api("POST", "/vehicles", { name: "Corvette Z06", notes: "PFC08 pads" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Corvette Z06");
    expect(res.body.notes).toBe("PFC08 pads");
    expect(res.body.id).toBeTypeOf("number");
  });

  it("makes the first vehicle the default automatically", async () => {
    const { api } = await signedInUser();
    const first = await api("POST", "/vehicles", { name: "Miata" });
    expect(first.body.is_default).toBe(1);
    const second = await api("POST", "/vehicles", { name: "GT3" });
    expect(second.body.is_default).toBe(0);
  });

  it("moves the default when created with is_default", async () => {
    const { api } = await signedInUser();
    await api("POST", "/vehicles", { name: "Miata" });
    const res = await api("POST", "/vehicles", { name: "GT3", is_default: true });
    expect(res.body.is_default).toBe(1);
    const list = (await api("GET", "/vehicles")).body;
    expect(list.filter((v: any) => v.is_default).map((v: any) => v.name)).toEqual(["GT3"]);
  });

  it("requires a non-empty name and a boolean is_default", async () => {
    const { api } = await signedInUser();
    expect((await api("POST", "/vehicles", {})).status).toBe(400);
    expect((await api("POST", "/vehicles", { name: "   " })).status).toBe(400);
    expect((await api("POST", "/vehicles", { name: "M", is_default: "yes" })).status).toBe(400);
  });

  it("rejects duplicates per user but allows the same name for another user", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    expect((await a.api("POST", "/vehicles", { name: "Miata" })).status).toBe(201);
    expect((await a.api("POST", "/vehicles", { name: "Miata" })).status).toBe(409);
    expect((await b.api("POST", "/vehicles", { name: "Miata" })).status).toBe(201);
  });
});

describe("GET /api/vehicles", () => {
  it("lists the default first, then by name", async () => {
    const { api } = await signedInUser();
    await api("POST", "/vehicles", { name: "Miata" });
    await api("POST", "/vehicles", { name: "corvette" });
    await api("POST", "/vehicles", { name: "GT3", is_default: true });
    const names = (await api("GET", "/vehicles")).body.map((v: any) => v.name);
    expect(names).toEqual(["GT3", "corvette", "Miata"]);
  });

  it("only returns the caller's vehicles", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await a.api("POST", "/vehicles", { name: "Private Car" });
    expect((await b.api("GET", "/vehicles")).body).toEqual([]);
  });

  it("requires a session", async () => {
    expect((await apiClient()("GET", "/vehicles")).status).toBe(401);
  });
});

describe("PUT /api/vehicles/:id", () => {
  it("renames and updates notes", async () => {
    const { api } = await signedInUser();
    const { body: v } = await api("POST", "/vehicles", { name: "Miata", notes: "stock" });
    const res = await api("PUT", `/vehicles/${v.id}`, { name: "ND2 Miata", notes: "Öhlins DFV" });
    expect(res.status).toBe(200);
    const row = (await api("GET", "/vehicles")).body[0];
    expect(row.name).toBe("ND2 Miata");
    expect(row.notes).toBe("Öhlins DFV");
  });

  it("clears notes with empty/null", async () => {
    const { api } = await signedInUser();
    const { body: v } = await api("POST", "/vehicles", { name: "Miata", notes: "stock" });
    await api("PUT", `/vehicles/${v.id}`, { notes: null });
    expect((await api("GET", "/vehicles")).body[0].notes).toBeNull();
  });

  it("set default moves it off the previous default", async () => {
    const { api } = await signedInUser();
    await api("POST", "/vehicles", { name: "Miata" });
    const { body: gt3 } = await api("POST", "/vehicles", { name: "GT3" });
    await api("PUT", `/vehicles/${gt3.id}`, { is_default: true });
    const list = (await api("GET", "/vehicles")).body;
    expect(list.filter((v: any) => v.is_default).map((v: any) => v.name)).toEqual(["GT3"]);
  });

  it("validates inputs and rejects empty updates", async () => {
    const { api } = await signedInUser();
    const { body: v } = await api("POST", "/vehicles", { name: "Miata" });
    expect((await api("PUT", `/vehicles/${v.id}`, { name: "" })).status).toBe(400);
    expect((await api("PUT", `/vehicles/${v.id}`, { is_default: 1 })).status).toBe(400);
    expect((await api("PUT", `/vehicles/${v.id}`, {})).status).toBe(400);
  });

  it("rejects a rename that collides with another vehicle", async () => {
    const { api } = await signedInUser();
    await api("POST", "/vehicles", { name: "Miata" });
    const { body: gt3 } = await api("POST", "/vehicles", { name: "GT3" });
    expect((await api("PUT", `/vehicles/${gt3.id}`, { name: "Miata" })).status).toBe(409);
  });

  it("cannot touch another user's vehicle, including its default flag", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { body: mine } = await a.api("POST", "/vehicles", { name: "Mine" });
    expect((await b.api("PUT", `/vehicles/${mine.id}`, { name: "Stolen" })).status).toBe(404);
    expect((await b.api("PUT", `/vehicles/${mine.id}`, { is_default: true })).status).toBe(404);
    const row = (await a.api("GET", "/vehicles")).body[0];
    expect(row.name).toBe("Mine");
    expect(row.is_default).toBe(1);
  });
});

describe("DELETE /api/vehicles/:id", () => {
  it("deletes a vehicle", async () => {
    const { api } = await signedInUser();
    const { body: v } = await api("POST", "/vehicles", { name: "Sold Car" });
    expect((await api("DELETE", `/vehicles/${v.id}`)).status).toBe(200);
    expect((await api("GET", "/vehicles")).body).toEqual([]);
  });

  it("404s on another user's vehicle", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const { body: v } = await a.api("POST", "/vehicles", { name: "Mine" });
    expect((await b.api("DELETE", `/vehicles/${v.id}`)).status).toBe(404);
    expect((await a.api("GET", "/vehicles")).body).toHaveLength(1);
  });
});
