import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { requireEntitlement } from "../../src/middleware";
import { events } from "../../src/routes/events";
import { me } from "../../src/routes/me";
import { sessions } from "../../src/routes/sessions";
import { share } from "../../src/routes/share";
import { tracks } from "../../src/routes/tracks";
import { vehicles } from "../../src/routes/vehicles";
import { billing } from "../../src/routes/billing";
import { LEGACY_ENTITLED_UNTIL_MS } from "../../src/lib/entitlement";
import { apiClient, createEvent, createUser, sessionFor } from "./helpers";

// NS-32 phase D: the gates are on. This file is the enumeration the spec asks
// for — the exact set of routes behind `requireEntitlement`, checked by handler
// identity rather than by making a request, so a gate added to a fourth router
// fails here even if no test happens to call it. The list is deliberately
// short: whole routers or one field, never a per-branch tier decision.

// Every router mounted under /api (src/index.ts). Kept explicit so a new
// router has to be added here, at which point its gates are enumerated too.
const API_ROUTERS = { me, tracks, events, sessions, vehicles, share, billing };

const guardedRoutes = () =>
  Object.values(API_ROUTERS)
    .flatMap((router) => router.routes)
    .filter((r) => r.handler === requireEntitlement)
    .map((r) => `${r.method} ${r.path}`)
    .sort();

// The tier table's server-enforced rows, and nothing else.
const EXPECTED_GATES = [
  // The garage's consumables (the vehicle *list* stays free — it pre-fills the
  // event form's car field).
  "GET /garage",
  "POST /vehicles/:id/parts",
  "PUT /parts/:id",
  "POST /parts/:id/refresh",
  "DELETE /parts/:id",
  "POST /parts/:id/measurements",
  "DELETE /parts/:id/measurements/:mid",
  // The setup notebook and the track page's setup-vs-lap-times diff.
  "PUT /events/:id/setups/:day",
  "DELETE /events/:id/setups/:day",
  "GET /events/:id/setups/prefill",
  "GET /tracks/:id/setups",
].sort();

// A recording is the one irreplaceable thing in the system, and the offline
// layer *drops* a rejected write — so these can never be gated (rule 5).
const LOGBOOK_WRITE_PREFIXES = ["/events", "/sessions", "/laps", "/tracks"];

async function proUser() {
  const user = await createUser();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at)
     VALUES (?, 'legacy', 'apple-paid-app', ?, 'legacy', NULL, NULL, 'production', ?, ?)`
  )
    .bind(user.id, `gates-${user.id}-${now}`, now, now)
    .run();
  return { ...user, api: apiClient(await sessionFor(user.id)) };
}

async function freeUser() {
  const user = await createUser();
  return { ...user, api: apiClient(await sessionFor(user.id)) };
}

describe("which routes requireEntitlement guards", () => {
  it("is exactly the tier table's server-enforced rows", () => {
    expect(guardedRoutes()).toEqual(EXPECTED_GATES);
  });

  it("never guards a logbook write", () => {
    const gatedWrites = Object.values(API_ROUTERS)
      .flatMap((router) => router.routes)
      .filter(
        (r) =>
          r.handler === requireEntitlement &&
          r.method !== "GET" &&
          LOGBOOK_WRITE_PREFIXES.some((p) => r.path === p || r.path.startsWith(`${p}/`)) &&
          !r.path.includes("/setups/")
      );
    expect(gatedWrites).toEqual([]);
  });
});

describe("a free account meeting the gates", () => {
  it("gets 402 { error: 'pro required' } from every guarded route", async () => {
    const { api, id } = await freeUser();
    const eventId = await createEvent(api);
    const trackId = (await api("GET", "/tracks")).body[0].id;
    // A vehicle to aim the parts routes at — the vehicle list itself is free,
    // which is the point: a lapsed user can still pick their car.
    const vehicle = await api("POST", "/vehicles", { name: "Free Tier Car" });
    expect(vehicle.status).toBe(201);
    expect((await api("GET", "/vehicles")).status).toBe(200);

    const calls: [string, string, unknown?][] = [
      ["GET", "/garage"],
      ["POST", `/vehicles/${vehicle.body.id}/parts`, { kind: "pads_front", name: "Fronts", installed_on: "2026-01-01" }],
      ["PUT", "/parts/1", { name: "x" }],
      ["POST", "/parts/1/refresh", { installed_on: "2026-01-01" }],
      ["DELETE", "/parts/1"],
      ["POST", "/parts/1/measurements", { measured_on: "2026-01-01", value: 5 }],
      ["DELETE", "/parts/1/measurements/1"],
      ["PUT", `/events/${eventId}/setups/1`, { tp_hot: { fl: 34, fr: 34 } }],
      ["DELETE", `/events/${eventId}/setups/1`],
      ["GET", `/events/${eventId}/setups/prefill?day=1`],
      ["GET", `/tracks/${trackId}/setups`],
    ];
    for (const [method, path, body] of calls) {
      const res = await api(method, path, body);
      expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 402`);
      expect(res.body).toEqual({ error: "pro required" });
    }
    // The gate is a pure comparison — nothing was written on the way past it.
    const parts = await env.DB.prepare(
      "SELECT count(*) AS n FROM parts WHERE vehicle_id IN (SELECT id FROM vehicles WHERE user_id = ?)"
    )
      .bind(id)
      .first<{ n: number }>();
    expect(parts!.n).toBe(0);
  });

  it("keeps the whole free tier: logbook, stats, share and the vehicle list", async () => {
    const { api } = await freeUser();
    const eventId = await createEvent(api);
    expect((await api("GET", "/events")).status).toBe(200);
    expect((await api("GET", `/events/${eventId}`)).status).toBe(200);
    expect((await api("GET", "/tracks")).status).toBe(200);
    expect((await api("GET", "/catalog")).status).toBe(200);
    expect((await api("PUT", "/share", { slug: `free-${Date.now()}` })).status).toBe(200);
  });
});

describe("a Pro account meeting the same routes", () => {
  it("passes every gate", async () => {
    const { api, id } = await proUser();
    const row = await env.DB.prepare("SELECT entitled_until FROM users WHERE id = ?")
      .bind(id)
      .first<{ entitled_until: number | null }>();
    expect(row!.entitled_until).toBe(LEGACY_ENTITLED_UNTIL_MS);

    const eventId = await createEvent(api);
    const trackId = (await api("GET", "/tracks")).body[0].id;
    expect((await api("GET", "/garage")).status).toBe(200);
    expect((await api("GET", `/tracks/${trackId}/setups`)).status).toBe(200);
    expect((await api("GET", `/events/${eventId}/setups/prefill?day=1`)).status).toBe(200);
    expect((await api("PUT", `/events/${eventId}/setups/1`, { tp_hot: { fl: 34, fr: 34 } })).status).toBe(200);
    expect((await api("DELETE", `/events/${eventId}/setups/1`)).status).toBe(200);

    const vehicle = await api("POST", "/vehicles", { name: "Pro Car" });
    const part = await api("POST", `/vehicles/${vehicle.body.id}/parts`, {
      kind: "pads_front",
      name: "Fronts",
      installed_on: "2026-01-01",
    });
    expect(part.status).toBe(201);
    expect((await api("POST", `/parts/${part.body.id}/measurements`, { measured_on: "2026-02-01", value: 8 })).status).toBe(201);
  });
});

describe("stripProFields on the event detail (rule 4)", () => {
  const N = 12;
  const sessionBody = {
    label: "Imported",
    laps: [95_000, 94_200],
    trace: Array.from({ length: N }, (_, i) => [i * 10, i * 5, 30 + i]),
    channels: { dStepM: 20, laps: [{ n: 1, timeMs: 95_000, speed: Array.from({ length: N }, (_, i) => 30 + i) }] },
  };

  it("nulls channels and keeps trace and laps for a free account", async () => {
    const { api } = await freeUser();
    const eventId = await createEvent(api);
    expect((await api("POST", `/events/${eventId}/sessions`, sessionBody)).status).toBe(201);

    const detail = await api("GET", `/events/${eventId}`);
    const session = detail.body.sessions[0];
    expect(session.channels).toBeNull();
    // The track map is part of the free logbook, and the laps are the logbook.
    expect(session.trace).toHaveLength(N);
    expect(session.laps).toHaveLength(2);
  });

  it("is a pass-through for Pro, and the stored row is untouched either way", async () => {
    const { api, id } = await proUser();
    const eventId = await createEvent(api);
    const created = await api("POST", `/events/${eventId}/sessions`, sessionBody);

    const detail = await api("GET", `/events/${eventId}`);
    expect(detail.body.sessions[0].channels.laps).toHaveLength(1);

    // Lapsing hides the field; it never deletes it. Resubscribing brings the
    // imported session back exactly as it was.
    await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(id).run();
    const lapsed = await api("GET", `/events/${eventId}`);
    expect(lapsed.body.sessions[0].channels).toBeNull();
    const stored = await env.DB.prepare("SELECT channels FROM sessions WHERE id = ?")
      .bind(created.body.id)
      .first<{ channels: string | null }>();
    expect(JSON.parse(stored!.channels!).laps).toHaveLength(1);
  });
});
