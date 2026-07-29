// Golden-JSON API contract harness (spec: docs/specs/native/NS-03-contract-harness.md).
//
// Captures real API responses into contracts/golden/ so the Swift and Kotlin
// test suites can decode them. A backend response-shape change then fails the
// native builds immediately instead of silently at runtime.
//
// Why this is a standalone Node script rather than a vitest test: test/api/
// runs inside workerd via @cloudflare/vitest-pool-workers, which has no
// filesystem access and so cannot write golden files. Here we drive the real
// Worker over HTTP from Node, where fs is available.
//
// Determinism is mandatory — regenerating without a backend change must produce
// a byte-identical tree, or the CI staleness check is worthless. Hence fixed
// fixture dates (no Date.now() in the data) and normalization of volatile
// fields. Volatile fields are REPLACED, never deleted: the point is to pin the
// shape, and deleting a field would let a nullability regression through.
//
// Run with: npm run contracts:generate

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN_DIR = path.join(ROOT, "contracts", "golden");
// Scratch D1 for this run, rebuilt every time so the fixture is reproducible
// and never inherits rows from a previous run. Gitignored.
const PERSIST = path.join(ROOT, "contracts", ".persist");

const DEV_EMAIL = "dev@example.com";

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

// Fields whose values legitimately vary run to run. Each is replaced with a
// stable placeholder of the SAME TYPE, so the goldens still pin type and
// nullability while staying byte-stable. null stays null — a nullable field
// that happened to be null in the fixture must not be forced to a value, or a
// client could model it as non-optional and be wrong.
const VOLATILE = {
  id: 1,
  event_id: 1,
  session_id: 1,
  track_id: 1,
  vehicle_id: 1,
  part_id: 1,
  catalog_id: 1,
  user_id: 1,
  created_at: 0,
  updated_at: 0,
};

function normalize(value, key) {
  if (Array.isArray(value)) return value.map((v) => normalize(v, key));
  if (value && typeof value === "object") {
    // Sort keys so output is stable and diffable by humans reviewing a PR.
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalize(value[k], k);
    return out;
  }
  if (key != null && Object.hasOwn(VOLATILE, key) && value !== null) return VOLATILE[key];
  return value;
}

// ---------------------------------------------------------------------------
// worker harness
// ---------------------------------------------------------------------------

async function startWorker() {
  rmSync(PERSIST, { recursive: true, force: true });
  mkdirSync(PERSIST, { recursive: true });

  // Apply migrations/ to the scratch D1 before the Worker starts. Wrangler owns
  // migration ordering, so shell out rather than reimplement it.
  execFileSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "track-history", "--local", "--persist-to", PERSIST],
    { cwd: ROOT, stdio: "pipe" }
  );

  // DEV_MODE only answers on local hosts (isDevLogin in src/routes/auth.ts),
  // which is exactly where this runs. The values are inert placeholders.
  const env = {
    DEV_MODE: "1",
    DEV_USER_EMAIL: DEV_EMAIL,
    DEV_USER_NAME: "Dev User",
    GOOGLE_CLIENT_ID: "contract-harness",
    GOOGLE_CLIENT_SECRET: "contract-harness",
  };

  return unstable_startWorker({
    config: path.join(ROOT, "wrangler.jsonc"),
    dev: {
      remote: false,
      persist: PERSIST,
      server: { port: 0 },
      inspector: false,
      logLevel: "error",
    },
    bindings: Object.fromEntries(
      Object.entries(env).map(([k, v]) => [k, { type: "plain_text", value: v }])
    ),
  });
}

// Sign in through the DEV_MODE bypass and keep the session cookie.
async function signIn(base) {
  const res = await fetch(new URL("/auth/login", base), { redirect: "manual" });
  const token = res.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
  if (!token) throw new Error(`DEV_MODE sign-in failed (status ${res.status})`);
  return token;
}

function apiClient(base, token) {
  return async (method, apiPath, body) => {
    const res = await fetch(new URL(`/api${apiPath}`, base), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Cookie: `session=${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

// ---------------------------------------------------------------------------
// captures
// ---------------------------------------------------------------------------

const captures = [];

function record(name, method, pathTemplate, description, source, result) {
  captures.push({
    name,
    method,
    path: pathTemplate,
    status: result.status,
    description,
    source,
    body: normalize(result.body),
  });
  return result;
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

// Every date is fixed. Nothing here may derive from the current time, or the
// goldens churn on every run and the staleness check becomes noise.
const FIXTURE = {
  // Event with laps across multiple sessions — populates best_ms, consistency
  // (needs 3+ laps) and hours.
  richEvent: { track_name: "Virginia International Raceway (Full)", start_date: "2026-04-10", days: 2 },
  // Second layout of the same circuit. Track names carry the layout, and are
  // matched COLLATE NOCASE, so these must stay two distinct tracks.
  patriotEvent: { track_name: "Virginia International Raceway (Patriot)", start_date: "2026-05-01" },
  // Event with no laps at all — best_ms and consistency must be null.
  bareEvent: { track_name: "Summit Point", start_date: "2026-06-01" },
};

async function build(api) {
  // --- tracks -------------------------------------------------------------
  // Created via an event so resolveTrack's find-or-create path is exercised and
  // catalog_id gets matched by name where the catalog has an entry.
  const rich = await api("POST", "/events", {
    ...FIXTURE.richEvent,
    club: "Chin Track Days",
    run_group: "Advanced",
    car: "Corvette C7",
    notes: "Cool morning, damp session 1.",
    conditions: "dry",
    temp_f: 62,
    best_time_ms: 121_500,
    checklist: [
      { text: "Torque wheels", done: true },
      { text: "Check pad thickness", done: false },
    ],
  });

  // track_hours overrides the estimate; the bare event leaves it null so both
  // branches of eventHours are captured.
  const patriot = await api("POST", "/events", { ...FIXTURE.patriotEvent, track_hours: 3.5 });
  const bare = await api("POST", "/events", FIXTURE.bareEvent);

  // --- sessions and laps --------------------------------------------------
  // 4 laps: enough for consistency (needs 3+).
  const s1 = await api("POST", `/events/${rich.body.id}/sessions`, {
    label: "Session 1",
    notes: "Learning the line.",
    laps: [128_400, 125_100, 123_800, 124_200],
  });

  // 2 laps: below the 3-lap threshold. Captured so a client can see that a
  // session can exist without enough data to compute consistency.
  await api("POST", `/events/${rich.body.id}/sessions`, {
    label: "Session 2",
    laps: [122_900, 121_500],
  });

  // A session with a stored best-lap trace and per-lap channels, so the
  // sanitizeTrace / sanitizeChannels shapes are pinned. Values are synthetic
  // but structurally identical to what an import produces: sanitizeTrace wants
  // 10-600 [x, y, speed] points, and sanitizeChannels wants
  // { dStepM, laps: [{ n, timeMs, speed?/rpm?/latG? }] } with 10-800 samples
  // per channel, all channels on the same grid length.
  const N = 12;
  const ring = (i) => {
    const a = (i / N) * 2 * Math.PI;
    return [Math.round(Math.cos(a) * 4000) / 10, Math.round(Math.sin(a) * 4000) / 10];
  };
  await api("POST", `/events/${rich.body.id}/sessions`, {
    label: "Session 3",
    laps: [121_900],
    trace: Array.from({ length: N }, (_, i) => [...ring(i), 30 + i * 2]),
    channels: {
      dStepM: 20,
      laps: [
        {
          n: 1,
          timeMs: 121_900,
          speed: Array.from({ length: N }, (_, i) => 30 + i * 2),
          rpm: Array.from({ length: N }, (_, i) => 3000 + i * 150),
          latG: Array.from({ length: N }, (_, i) => Math.round((i % 4) * 0.4 * 1000) / 1000),
        },
      ],
    },
  });

  // Session on the second layout, so per-track aggregation has something to
  // separate. If these two ever merge into one track, the fixture will show it.
  await api("POST", `/events/${patriot.body.id}/sessions`, { label: "Session 1", laps: [78_200, 77_900, 77_400] });

  // --- setup sheets -------------------------------------------------------
  await api("PUT", `/events/${rich.body.id}/setups/1`, {
    tp_cold: { fl: 26, fr: 26, rl: 24, rr: 24 },
    camber: { f: -3.2, r: -2.1 },
    rebound: { f: 8, r: 6 },
  });
  await api("PUT", `/events/${rich.body.id}/setups/2`, {
    tp_cold: { fl: 25, fr: 25, rl: 24, rr: 24 },
    camber: { f: -3.5, r: -2.1 },
    rebound: { f: 10, r: 6 },
  });

  // --- garage -------------------------------------------------------------
  // Vehicle name matches the rich event's `car` so vehicleIdForCar links them.
  const vehicle = await api("POST", "/vehicles", { name: "Corvette C7", notes: "Track car." });
  // A bare vehicle with no parts — the empty branch of the garage response.
  await api("POST", "/vehicles", { name: "Miata", is_default: false });

  const pads = await api("POST", `/vehicles/${vehicle.body.id}/parts`, {
    kind: "pads_front",
    name: "Carbotech XP12",
    installed_on: "2026-03-01",
    expected_hours: 24,
    wear_limit: 3,
    cost_cents: 32_000,
  });
  // A part with no expected_hours and no measurements — wear falls back to the
  // prior, and remaining-life projection has nothing to regress on.
  await api("POST", `/vehicles/${vehicle.body.id}/parts`, {
    kind: "tires",
    name: "Falken RT660",
    installed_on: "2026-03-15",
  });

  // Two measurements: enough for the least-squares projection path.
  await api("POST", `/parts/${pads.body.id}/measurements`, { measured_on: "2026-04-12", value: 9.5, unit: "mm" });
  await api("POST", `/parts/${pads.body.id}/measurements`, { measured_on: "2026-05-02", value: 7.8, unit: "mm" });

  // --- share --------------------------------------------------------------
  await api("PUT", "/share", { slug: "contract-fixture" });

  // POST /events returns only { id }, so resolve the track id we need for the
  // track-scoped captures from the list.
  const tracks = (await api("GET", "/tracks")).body ?? [];
  const trackId = tracks.find((t) => t.name === FIXTURE.richEvent.track_name)?.id;
  if (!trackId) throw new Error("fixture track not found — did resolveTrack change?");

  return { rich, patriot, bare, s1, vehicle, pads, trackId, slug: "contract-fixture" };
}

// ---------------------------------------------------------------------------
// capture pass
// ---------------------------------------------------------------------------

async function captureAll(api, anon, f) {
  const ev = f.rich.body.id;
  const bare = f.bare.body.id;
  const sess = f.s1.body.id;
  const veh = f.vehicle.body.id;
  const part = f.pads.body.id;
  const track = f.trackId;

  // --- reads --------------------------------------------------------------
  record("me", "GET", "/me", "The signed-in user.", "src/routes/me.ts", await api("GET", "/me"));

  record("events-list", "GET", "/events",
    "All events with lap aggregates and computed stats (withComputed).",
    "src/routes/events.ts", await api("GET", "/events"));

  record("event-detail", "GET", "/events/:id",
    "One event with its sessions, laps and setup sheets. Populated stats branch.",
    "src/routes/events.ts", await api("GET", `/events/${ev}`));

  record("event-detail-no-laps", "GET", "/events/:id",
    "Event with no laps: best_ms and consistency are both null.",
    "src/routes/events.ts", await api("GET", `/events/${bare}`));

  record("event-setups-prefill", "GET", "/events/:id/setups/prefill",
    "Copy-forward prefill for a blank setup form.",
    "src/routes/events.ts", await api("GET", `/events/${ev}/setups/prefill`));

  record("tracks-list", "GET", "/tracks",
    "Tracks with per-track aggregates and the best-per-event sparkline series.",
    "src/routes/tracks.ts", await api("GET", "/tracks"));

  record("track-setups", "GET", "/tracks/:id/setups",
    "Setup-vs-lap-times rows for a track.",
    "src/routes/tracks.ts", await api("GET", `/tracks/${track}/setups`));

  record("catalog", "GET", "/catalog",
    "Seeded canonical track catalog backing event-form suggestions.",
    "src/routes/tracks.ts", await api("GET", "/catalog"));

  record("vehicles-list", "GET", "/vehicles",
    "The user's garage vehicles.",
    "src/routes/vehicles.ts", await api("GET", "/vehicles"));

  record("garage", "GET", "/garage",
    "Every vehicle with accrued hours, parts, measurements and computed wear.",
    "src/routes/vehicles.ts", await api("GET", "/garage"));

  // --- public share (unauthenticated) -------------------------------------
  record("share-public", "GET", "/share/:slug",
    "Public share page data. Deliberately reduced: no notes, email, per-lap data or garage/setup linkage.",
    "src/routes/share.ts", await anon("GET", `/share/${f.slug}`));

  // --- writes -------------------------------------------------------------
  record("event-create", "POST", "/events", "Create an event.", "src/routes/events.ts",
    await api("POST", "/events", { track_name: "Watkins Glen", start_date: "2026-07-04" }));

  record("event-update", "PUT", "/events/:id", "Update an event.", "src/routes/events.ts",
    await api("PUT", `/events/${bare}`, { start_date: "2026-06-02", days: 2, club: "NASA" }));

  record("session-create", "POST", "/events/:id/sessions", "Create a session with laps.",
    "src/routes/sessions.ts",
    await api("POST", `/events/${bare}/sessions`, { label: "Session 1", laps: [95_000] }));

  record("session-update", "PUT", "/sessions/:id", "Update a session.", "src/routes/sessions.ts",
    await api("PUT", `/sessions/${sess}`, { label: "Session 1 (renamed)" }));

  record("laps-append", "POST", "/sessions/:id/laps", "Append laps to a session.",
    "src/routes/sessions.ts", await api("POST", `/sessions/${sess}/laps`, { laps: [123_000] }));

  record("track-create", "POST", "/tracks", "Create a track directly.", "src/routes/tracks.ts",
    await api("POST", "/tracks", { name: "Road Atlanta" }));

  record("vehicle-create", "POST", "/vehicles", "Create a garage vehicle.", "src/routes/vehicles.ts",
    await api("POST", "/vehicles", { name: "BRZ" }));

  record("vehicle-update", "PUT", "/vehicles/:id", "Update a vehicle.", "src/routes/vehicles.ts",
    await api("PUT", `/vehicles/${veh}`, { name: "Corvette C7", notes: "Track car, updated." }));

  record("part-create", "POST", "/vehicles/:id/parts", "Add a consumable part.",
    "src/routes/vehicles.ts",
    await api("POST", `/vehicles/${veh}/parts`, { kind: "oil", name: "Motul 300V", installed_on: "2026-04-01" }));

  record("part-update", "PUT", "/parts/:id", "Update a part.", "src/routes/vehicles.ts",
    await api("PUT", `/parts/${part}`, { kind: "pads_front", name: "Carbotech XP12", installed_on: "2026-03-01", wear_limit: 3.5 }));

  record("part-refresh", "POST", "/parts/:id/refresh",
    "One-tap replacement: retires the part and inserts a same-spec successor.",
    "src/routes/vehicles.ts", await api("POST", `/parts/${part}/refresh`, { installed_on: "2026-06-01" }));

  record("measurement-create", "POST", "/parts/:id/measurements", "Log a wear measurement.",
    "src/routes/vehicles.ts",
    await api("POST", `/parts/${part}/measurements`, { measured_on: "2026-05-20", value: 6.9, unit: "mm" }));

  record("setup-upsert", "PUT", "/events/:id/setups/:day", "Upsert a day's setup sheet.",
    "src/routes/events.ts",
    await api("PUT", `/events/${ev}/setups/3`, { tp_cold: { fl: 25, fr: 25 } }));

  record("share-set", "PUT", "/share", "Claim a share slug.", "src/routes/share.ts",
    await api("PUT", "/share", { slug: "contract-fixture" }));

  // --- deletes (last, so they don't disturb the reads above) --------------
  record("setup-delete", "DELETE", "/events/:id/setups/:day", "Delete a setup sheet.",
    "src/routes/events.ts", await api("DELETE", `/events/${ev}/setups/3`));

  const lapsNow = (await api("GET", `/events/${ev}`)).body?.sessions?.[0]?.laps ?? [];
  if (lapsNow.length) {
    record("lap-delete", "DELETE", "/laps/:id", "Delete a single lap.", "src/routes/sessions.ts",
      await api("DELETE", `/laps/${lapsNow[lapsNow.length - 1].id}`));
  }

  record("session-delete", "DELETE", "/sessions/:id", "Delete a session.", "src/routes/sessions.ts",
    await api("DELETE", `/sessions/${sess}`));

  record("measurement-delete", "DELETE", "/parts/:id/measurements/:mid", "Delete a measurement.",
    "src/routes/vehicles.ts", await api("DELETE", `/parts/${part}/measurements/1`));

  record("part-delete", "DELETE", "/parts/:id", "Delete a part.", "src/routes/vehicles.ts",
    await api("DELETE", `/parts/${part}`));

  record("vehicle-delete", "DELETE", "/vehicles/:id", "Delete a vehicle.", "src/routes/vehicles.ts",
    await api("DELETE", `/vehicles/${veh}`));

  record("track-update", "PUT", "/tracks/:id", "Update a track (name / goal time).",
    "src/routes/tracks.ts", await api("PUT", `/tracks/${track}`, { goal_ms: 120_000 }));

  record("track-delete", "DELETE", "/tracks/:id", "Delete a track.", "src/routes/tracks.ts",
    await api("DELETE", "/tracks/99999"));

  record("event-delete", "DELETE", "/events/:id", "Delete an event.", "src/routes/events.ts",
    await api("DELETE", `/events/${bare}`));

  record("share-clear", "DELETE", "/share", "Disable sharing.", "src/routes/share.ts",
    await api("DELETE", "/share"));

  // --- errors -------------------------------------------------------------
  // Every client surfaces err.message from these, so the { error: string }
  // shape is part of the contract.
  record("error-400", "POST", "/events", "400: missing required field.", "src/routes/events.ts",
    await api("POST", "/events", {}));

  record("error-401", "GET", "/events", "401: no session.", "src/middleware.ts",
    await anon("GET", "/events"));

  record("error-404", "GET", "/events/:id", "404: not found, or owned by another user.",
    "src/routes/events.ts", await api("GET", "/events/99999"));
}

// ---------------------------------------------------------------------------
// coverage check
// ---------------------------------------------------------------------------

// Every route registered under /api must appear in the manifest. A silently
// uncovered endpoint is a silently unprotected client.
const EXPECTED_ROUTES = [
  "GET /me",
  "GET /events", "POST /events", "GET /events/:id", "PUT /events/:id", "DELETE /events/:id",
  "PUT /events/:id/setups/:day", "DELETE /events/:id/setups/:day", "GET /events/:id/setups/prefill",
  "POST /events/:id/sessions", "PUT /sessions/:id", "DELETE /sessions/:id",
  "POST /sessions/:id/laps", "DELETE /laps/:id",
  "GET /tracks", "POST /tracks", "PUT /tracks/:id", "DELETE /tracks/:id",
  "GET /tracks/:id/setups", "GET /catalog",
  "GET /vehicles", "POST /vehicles", "PUT /vehicles/:id", "DELETE /vehicles/:id",
  "GET /garage",
  "POST /vehicles/:id/parts", "PUT /parts/:id", "DELETE /parts/:id", "POST /parts/:id/refresh",
  "POST /parts/:id/measurements", "DELETE /parts/:id/measurements/:mid",
  "PUT /share", "DELETE /share", "GET /share/:slug",
];

function checkCoverage() {
  const seen = new Set(captures.map((c) => `${c.method} ${c.path}`));
  const missing = EXPECTED_ROUTES.filter((r) => !seen.has(r));
  if (missing.length) {
    throw new Error(`Uncovered API routes:\n  ${missing.join("\n  ")}`);
  }
  // PUT /vehicles/:id is exercised only if a capture exists; keep the check
  // symmetrical so a stale EXPECTED_ROUTES entry is also caught.
  const extra = [...seen].filter((r) => !EXPECTED_ROUTES.includes(r));
  if (extra.length) {
    throw new Error(`Captured routes missing from EXPECTED_ROUTES:\n  ${extra.join("\n  ")}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const worker = await startWorker();
try {
  const base = String(await worker.url);
  const token = await signIn(base);
  const api = apiClient(base, token);
  const anon = apiClient(base, null);

  const fixture = await build(api);
  await captureAll(api, anon, fixture);
  checkCoverage();

  rmSync(GOLDEN_DIR, { recursive: true, force: true });
  mkdirSync(GOLDEN_DIR, { recursive: true });

  for (const c of captures) {
    writeFileSync(
      path.join(GOLDEN_DIR, `${c.name}.json`),
      JSON.stringify({ method: c.method, path: c.path, status: c.status, body: c.body }, null, 2) + "\n"
    );
  }

  writeFileSync(
    path.join(GOLDEN_DIR, "manifest.json"),
    JSON.stringify(
      {
        description:
          "Captured API responses. Regenerate with `npm run contracts:generate`. " +
          "The Swift and Kotlin test suites decode every entry; a failing decode means the " +
          "backend response shape changed.",
        entries: captures.map(({ name, method, path: p, status, description, source }) => ({
          name, file: `${name}.json`, method, path: p, status, description, source,
        })),
      },
      null,
      2
    ) + "\n"
  );

  console.log(`Wrote ${captures.length} golden files to contracts/golden/`);
} finally {
  await worker.dispose();
  rmSync(PERSIST, { recursive: true, force: true });
}
