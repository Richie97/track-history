import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createEvent, signedInProUser, signedInUser } from "./helpers";
import { circleTrace } from "./telemetry-fixture";

// NS-57: where a track is. The catalog carries a coordinate per layout, and
// the owner's own tracks carry `geo` — the place of their newest anchored
// session — so an import can recognise where a file was driven. A track's
// place goes to its owner and to nobody else.

const VIR = { lat: 36.5607, lon: -79.2064 };

describe("the catalog", () => {
  it("carries a place and a length for an import to match against", async () => {
    const user = await signedInUser();
    const rows = (await user.api("GET", "/catalog")).body as any[];
    const vir = rows.find((r) => r.name === "Virginia International Raceway (Full)");
    expect(vir).toMatchObject({ lat: 36.5617, lon: -79.2047, length_m: 5262 });
    expect(rows.every((r) => typeof r.lat === "number" && typeof r.lon === "number")).toBe(true);
    expect(Object.keys(vir).sort()).toEqual(["id", "lat", "length_m", "lon", "name"]);
  });
});

describe("a track's own place", () => {
  it("is null until a session there kept its anchor, then the lap's centre and length", async () => {
    const user = await signedInUser();
    const eventId = await createEvent(user.api);
    await user.api("POST", `/events/${eventId}/sessions`, { laps: [100_000], trace: circleTrace() });
    expect((await user.api("GET", "/tracks")).body[0].geo).toBeNull();

    await user.api("POST", `/events/${eventId}/sessions`, { laps: [99_000], trace: circleTrace(), trace_geo: VIR });
    const [track] = (await user.api("GET", "/tracks")).body;
    // circleTrace is a 2,980 m circle whose centre sits (250, r − 80) m from its origin.
    const r = 2980 / (2 * Math.PI);
    expect(track.geo.length_m).toBeGreaterThan(2960);
    expect(track.geo.length_m).toBeLessThanOrEqual(2980);
    expect(track.geo.lat).toBeCloseTo(VIR.lat + (r - 80) / 110540, 5);
    expect(track.geo.lon).toBeCloseTo(VIR.lon + 250 / (111320 * Math.cos((VIR.lat * Math.PI) / 180)), 5);
  });

  it("comes from the newest anchored session and is kept per track", async () => {
    const user = await signedInUser();
    const old = await createEvent(user.api, { start_date: "2025-05-01" });
    const recent = await createEvent(user.api, { start_date: "2026-05-01" });
    const other = await createEvent(user.api, { track_name: "Elsewhere" });
    await user.api("POST", `/events/${old}/sessions`, { laps: [1], trace: circleTrace(), trace_geo: { lat: 10, lon: 10 } });
    await user.api("POST", `/events/${recent}/sessions`, { laps: [1], trace: circleTrace(), trace_geo: VIR });
    await user.api("POST", `/events/${other}/sessions`, { laps: [1], trace: circleTrace(4000) });
    const tracks = (await user.api("GET", "/tracks")).body as any[];
    expect(Math.round(tracks.find((t) => t.name === "Test Ring").geo.lat)).toBe(37);
    expect(tracks.find((t) => t.name === "Elsewhere").geo).toBeNull();
  });

  it("is never another account's, a coach's or a share page's", async () => {
    const student = await signedInProUser();
    const coach = await signedInUser();
    const eventId = await createEvent(student.api);
    await student.api("POST", `/events/${eventId}/sessions`, { laps: [99_000], trace: circleTrace(), trace_geo: VIR });
    expect((await student.api("GET", "/tracks")).body[0].geo).not.toBeNull();

    const inv = await student.api("POST", "/coaching/invites");
    const token = (inv.body.url as string).split("/").pop()!;
    expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
    const seen = await coach.api("GET", `/students/${student.id}/tracks`);
    expect(seen.status).toBe(200);
    expect(seen.body).toHaveLength(1);
    expect("geo" in seen.body[0]).toBe(false);
    expect((await coach.api("GET", "/tracks")).body).toEqual([]);

    expect((await student.api("PUT", "/share", { slug: "placed-laps" })).status).toBe(200);
    const shared = await SELF.fetch("https://example.com/api/share/placed-laps");
    expect(shared.status).toBe(200);
    expect(JSON.stringify(await shared.json())).not.toMatch(/"geo"|36\.56/);
  });
});
