import { describe, expect, it } from "vitest";
import { apiClient, signedInUser } from "./helpers";

// The seeded car catalog (#221) and the vehicle link into it. The catalog's
// contents are pinned by test/unit/car-catalog.test.ts against the generator;
// here it is the endpoint and the pick rule.

describe("GET /api/car-catalog", () => {
  it("returns every generation with its geometry and provenance, ordered for a picker", async () => {
    const { api } = await signedInUser();
    const res = await api("GET", "/car-catalog");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(20);
    const c7 = res.body.find((c: any) => c.make === "Chevrolet" && c.model === "Corvette" && c.generation === "C7");
    expect(c7).toMatchObject({ year_from: 2014, year_to: 2019, wheelbase_mm: 2710, steering_ratio: 16.25 });
    expect(c7.source).toMatch(/Wikidata Q1135713/);
    expect(c7.id).toBeTypeOf("number");
    // A generation with no reliable ratio carries null, never a guess.
    const p992 = res.body.find((c: any) => c.make === "Porsche" && c.generation === "992");
    expect(p992.steering_ratio).toBeNull();
    expect(p992.year_to).toBeNull();
    // Ordered by make, model, then first model year — what a search list shows.
    const keys = res.body.map((c: any) => [c.make.toLowerCase(), c.model.toLowerCase(), c.year_from]);
    const sorted = [...keys].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]);
    expect(keys).toEqual(sorted);
  });

  it("requires a session", async () => {
    expect((await apiClient()("GET", "/car-catalog")).status).toBe(401);
  });
});

describe("vehicles and the catalog", () => {
  async function catalogRow(api: any, generation: string) {
    return (await api("GET", "/car-catalog")).body.find((c: any) => c.generation === generation);
  }

  it("a pick pre-fills both numbers on create and the row reads back with its catalog_id", async () => {
    const { api } = await signedInUser();
    const c7 = await catalogRow(api, "C7");
    const res = await api("POST", "/vehicles", { name: "Betty", catalog_id: c7.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Betty", catalog_id: c7.id, wheelbase_mm: 2710, steering_ratio: 16.25 });
    const [row] = (await api("GET", "/vehicles")).body;
    expect(row).toMatchObject({ catalog_id: c7.id, wheelbase_mm: 2710, steering_ratio: 16.25 });
    // A car with no pick and no numbers reads null throughout, never 0.
    const bare = (await api("POST", "/vehicles", { name: "Miata" })).body;
    expect(bare.catalog_id).toBeNull();
    expect(bare.wheelbase_mm).toBeNull();
    expect(bare.steering_ratio).toBeNull();
  });

  it("an explicit number in the same body wins over the catalog", async () => {
    const { api } = await signedInUser();
    const c7 = await catalogRow(api, "C7");
    const res = await api("POST", "/vehicles", { name: "Betty", catalog_id: c7.id, steering_ratio: 15.9 });
    expect(res.body).toMatchObject({ wheelbase_mm: 2710, steering_ratio: 15.9 });
    const cleared = await api("POST", "/vehicles", { name: "Bare", catalog_id: c7.id, wheelbase_mm: null });
    expect(cleared.body).toMatchObject({ catalog_id: c7.id, wheelbase_mm: null, steering_ratio: 16.25 });
  });

  it("re-picking replaces both numbers, a null ratio included; unlinking keeps them", async () => {
    const { api } = await signedInUser();
    const c7 = await catalogRow(api, "C7");
    const p992 = await catalogRow(api, "992");
    const { body: v } = await api("POST", "/vehicles", { name: "Betty", catalog_id: c7.id });
    // Swapping to a car whose ratio the catalog doesn't know must not keep the C7's.
    expect((await api("PUT", `/vehicles/${v.id}`, { catalog_id: p992.id })).status).toBe(200);
    let [row] = (await api("GET", "/vehicles")).body;
    expect(row).toMatchObject({ catalog_id: p992.id, wheelbase_mm: 2450, steering_ratio: null });
    // The user corrects a number: the catalog is not consulted again.
    await api("PUT", `/vehicles/${v.id}`, { steering_ratio: 13.8 });
    await api("PUT", `/vehicles/${v.id}`, { notes: "rear steer" });
    [row] = (await api("GET", "/vehicles")).body;
    expect(row).toMatchObject({ catalog_id: p992.id, wheelbase_mm: 2450, steering_ratio: 13.8 });
    // Unlinking leaves the numbers as they are — they are the user's now.
    await api("PUT", `/vehicles/${v.id}`, { catalog_id: null });
    [row] = (await api("GET", "/vehicles")).body;
    expect(row).toMatchObject({ catalog_id: null, wheelbase_mm: 2450, steering_ratio: 13.8 });
  });

  it("rejects an unknown or malformed catalog_id", async () => {
    const { api } = await signedInUser();
    expect((await api("POST", "/vehicles", { name: "X", catalog_id: 999_999 })).status).toBe(400);
    expect((await api("POST", "/vehicles", { name: "X", catalog_id: "C7" })).status).toBe(400);
    expect((await api("POST", "/vehicles", { name: "X", catalog_id: 1.5 })).status).toBe(400);
    const { body: v } = await api("POST", "/vehicles", { name: "Y" });
    expect((await api("PUT", `/vehicles/${v.id}`, { catalog_id: 999_999 })).status).toBe(400);
    expect((await api("GET", "/vehicles")).body[0].catalog_id).toBeNull();
  });

  it("the garage carries the same three fields", async () => {
    const { signedInProUser } = await import("./helpers");
    const { api } = await signedInProUser();
    const c7 = await catalogRow(api, "C7");
    await api("POST", "/vehicles", { name: "Betty", catalog_id: c7.id });
    const [g] = (await api("GET", "/garage")).body;
    expect(g).toMatchObject({ name: "Betty", catalog_id: c7.id, wheelbase_mm: 2710, steering_ratio: 16.25 });
  });
});
