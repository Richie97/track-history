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
  lap_id: 1,
  student_id: 1,
  created_at: 0,
  updated_at: 0,
  // Coaching (NS-38): an invite's expiry is minted from the clock, and a
  // grant's times from when the harness ran.
  expires_at: 0,
  since: 0,
  last_viewed_at: 0,
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
  // Wrapped's `through` is today while the fixture's year is running and null
  // once it has ended, so the raw value changes every day and then flips
  // type on 1 January. It is the one volatile field pinned as always-set:
  // every client models it as optional, and the null branch is the route
  // tests' to pin.
  if (key === "through") return "2026-01-01";
  // A one-item share link (NS-48) carries a fresh random token and the
  // harness's port.
  if (key === "token" && typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value)) return "AAAAAAAAAAAAAAAAAAAAAA";
  if (key === "url" && typeof value === "string" && /\/share\/[es]\//.test(value)) {
    return value.replace(/^https?:\/\/[^/]+(\/share\/[es]\/).*$/, "https://trackevolution.app$1AAAAAAAAAAAAAAAAAAAAAA");
  }
  // A coach invite link carries a fresh random token and the harness's port.
  if (key === "url" && typeof value === "string" && value.includes("/coach/")) {
    return "https://trackevolution.app/coach/0000000000000000000000000000000000000000000000000000000000000000";
  }
  return value;
}

// ---------------------------------------------------------------------------
// worker harness
// ---------------------------------------------------------------------------

// `email` is the account the DEV_MODE bypass signs in as. The coaching
// captures need a second account, so the harness restarts the Worker as a
// coach over the *same* scratch D1 (`fresh: false`) — the first account's
// session cookie is a row in that database, so it keeps working across the
// restart and both accounts can be driven side by side.
async function startWorker({ email = DEV_EMAIL, name = "Dev User", fresh = true } = {}) {
  if (fresh) {
    rmSync(PERSIST, { recursive: true, force: true });
    mkdirSync(PERSIST, { recursive: true });
  }

  // Apply migrations/ to the scratch D1 before the Worker starts. Wrangler owns
  // migration ordering, so shell out rather than reimplement it — to the
  // installed wrangler's entry point directly, via this Node, rather than
  // through `npx`: on Windows that is npx.cmd, which can't be spawned without a
  // shell, and a shell would need every path quoted.
  if (fresh) execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
      "d1", "migrations", "apply", "track-history", "--local", "--persist-to", PERSIST,
    ],
    { cwd: ROOT, stdio: "pipe" }
  );

  // DEV_MODE only answers on local hosts (isDevLogin in src/routes/auth.ts),
  // which is exactly where this runs. The values are inert placeholders.
  const env = {
    DEV_MODE: "1",
    DEV_USER_EMAIL: email,
    DEV_USER_NAME: name,
    GOOGLE_CLIENT_ID: "contract-harness",
    GOOGLE_CLIENT_SECRET: "contract-harness",
    // YouTube (NS-46): present so `user.youtube.available` is true and the
    // draft answers. Nothing here ever reaches Google — the one upload is
    // written straight into D1 (see build()), so no queue message is sent.
    YOUTUBE_CLIENT_ID: "contract-harness",
    YOUTUBE_CLIENT_SECRET: "contract-harness",
    YOUTUBE_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64"),
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

// A statement straight into the scratch D1 the running Worker reads — for
// state no route can make without a third party (a YouTube upload, NS-46).
function d1(sql) {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
      "d1", "execute", "track-history", "--local", "--persist-to", PERSIST, "--command", sql,
    ],
    { cwd: ROOT, stdio: "pipe" }
  );
}

// Sign in through the DEV_MODE bypass and keep the session cookie.
async function signIn(base) {
  const res = await fetch(new URL("/auth/login", base), { redirect: "manual" });
  const token = res.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
  if (!token) throw new Error(`DEV_MODE sign-in failed (status ${res.status})`);
  return token;
}

function apiClient(base, token) {
  const client = async (method, apiPath, body, headers = {}) => {
    const res = await fetch(new URL(`/api${apiPath}`, base), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Cookie: `session=${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // The same account against a restarted Worker (see captureCoaching).
  client.rebase = (newBase) => apiClient(newBase, token);
  // A raw-bytes PUT, for a clip part (NS-45), which is not JSON.
  client.putBytes = async (apiPath, bytes) => {
    const res = await fetch(new URL(`/api${apiPath}`, base), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", ...(token ? { Cookie: `session=${token}` } : {}) },
      body: bytes,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return client;
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
  // --- the free tier, before anything else --------------------------------
  // Phase D put requireEntitlement in front of the garage and the setups
  // routes, and this harness builds the fixture through those routes — so it
  // has to be Pro before it can create a part or a setup sheet, and every
  // capture after the claim below is a Pro one. The two captures that have to
  // be free therefore happen here, first: a fresh account's /me, and the 402
  // body every client maps to its paywall.
  record("me", "GET", "/me",
    "A fresh account: tier free, and checklist_template null — the common case, " +
    "where the client falls back to its built-in DEFAULT_CHECKLIST.",
    "src/routes/me.ts", await api("GET", "/me"));

  record("error-402", "GET", "/garage",
    "402: the Pro gate (requireEntitlement). Returned by GET /garage, the " +
    "parts/measurements routes and the setups routes for a free account; every " +
    "client maps this one body to its paywall rather than to a sync error.",
    "src/middleware.ts", await api("GET", "/garage"));

  // The Android transitional build's paid-app claim — the one billing route
  // that needs no store payload, so it is where the { ok, entitlement } shape
  // every billing route answers with gets pinned. It also makes this user Pro
  // for life, which is what lets the rest of the fixture be built.
  record("billing-legacy-claim", "POST", "/billing/google/legacy",
    "The Android transitional build's paid-app claim (X-TE-Client required; honoured before " +
    "LEGACY_CUTOFF). Every billing write answers with the fresh entitlement.",
    "src/routes/billing.ts",
    await api("POST", "/billing/google/legacy", {}, { "X-TE-Client": "android/1" }));

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
    // Three of the four cost line items (#147), so the goldens pin both a
    // number and a null on the same event, and `cost_cents` non-null here
    // against null on the bare event below.
    cost_entry_cents: 45_000,
    cost_fuel_cents: 12_050,
    cost_travel_cents: 30_000,
  });

  // track_hours overrides the estimate; the bare event leaves it null so both
  // branches of eventHours are captured.
  const patriot = await api("POST", "/events", { ...FIXTURE.patriotEvent, track_hours: 3.5 });
  const bare = await api("POST", "/events", FIXTURE.bareEvent);

  // --- sessions and laps --------------------------------------------------
  // 4 clean laps — enough for consistency (needs 3+ clean) — and a cool-down
  // lap beyond 107% of the session's best (NS-42). It counts toward lap_count
  // and hours but not consistency, which is the one difference between the
  // old all-laps rule and the clean-lap one; without it no golden could tell
  // them apart, and both native recomputeDetail tests would pass either way.
  const s1 = await api("POST", `/events/${rich.body.id}/sessions`, {
    label: "Session 1",
    notes: "Learning the line.",
    laps: [128_400, 125_100, 123_800, 124_200, 139_600],
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
  // { dStepM, laps: [{ n, timeMs, speed?/rpm?/latG?/throttle?/brake?/steering? }] }
  // with 10-800 samples per channel, all channels on the same grid length.
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
      // Session meta, so the conditions columns migration 0020 derives from it
      // (#191) are pinned with real values rather than nulls: `ambient_c` and
      // `elevation_m` on the session, and the event's `ambient_lo_c` /
      // `ambient_hi_c` / `elevation_m` aggregates. They survive the Pro strip
      // that nulls `channels`, which is the point of their being columns.
      meta: { ambientC: 21.4, intakeC: 44, elevationM: 38, odometerKm: 71_087 },
      laps: [
        {
          n: 1,
          timeMs: 121_900,
          speed: Array.from({ length: N }, (_, i) => 30 + i * 2),
          rpm: Array.from({ length: N }, (_, i) => 3000 + i * 150),
          latG: Array.from({ length: N }, (_, i) => Math.round((i % 4) * 0.4 * 1000) / 1000),
          throttle: Array.from({ length: N }, (_, i) => Math.round((i / (N - 1)) * 1000) / 10),
          brake: Array.from({ length: N }, (_, i) => Math.round(Math.max(0, 60 - i * 6) * 10) / 10),
          steering: Array.from({ length: N }, (_, i) => Math.round((i - N / 2) * 85) / 10), // signed deg
        },
      ],
    },
  });

  // A session whose channels carry yaw, steering and speed across a sweep of
  // speeds — a lap generated from the bicycle model (ratio 16.25, wheelbase
  // 2.71 m, understeer gradient 0.0014 s²/m²) — so `GET /vehicles/:id/steering-fit`
  // (#223) has a fit to pin and the `steering-fit` golden is not an empty list.
  // Slower than Session 3's lap, so the event's best and the leaderboard's
  // ranked lap stay where they were.
  const FIT_N = 24;
  const fitLap = { speed: [], steering: [], yaw: [] };
  for (let k = 0; k < FIT_N; k++) {
    const kph = 60 + ((175 - 60) * k) / (FIT_N - 1);
    const v = kph / 3.6;
    const deg = (15 + (k % 5) * 10) * (k % 2 ? -1 : 1);
    fitLap.speed.push(Math.round(kph * 100) / 100);
    fitLap.steering.push(deg);
    fitLap.yaw.push(Math.round(((v * (deg / 16.25)) / (2.71 * (1 + 0.0014 * v * v))) * 1000) / 1000);
  }
  await api("POST", `/events/${rich.body.id}/sessions`, {
    label: "Session 4",
    laps: [123_400],
    // An odometer reading (#192) as well as Session 3's, so the car in the
    // garage golden carries a reading and its parts a recorded span between
    // the two — the same day, so no other capture gains an event.
    channels: { dStepM: 20, meta: { odometerKm: 71_091.5 }, laps: [{ n: 1, timeMs: 123_400, ...fitLap }] },
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
  // Picked from the car catalog, so the fixture carries a non-null catalog_id
  // and the pre-filled geometry (#221); the bare Miata below shows the nulls.
  const c7 = (await api("GET", "/car-catalog")).body.find(
    (c) => c.make === "Chevrolet" && c.model === "Corvette" && c.generation === "C7"
  );
  if (!c7) throw new Error("car catalog fixture row not found — did seed/cars/list.json change?");
  const vehicle = await api("POST", "/vehicles", {
    name: "Corvette C7",
    notes: "Track car.",
    target_hot_psi: 32,
    catalog_id: c7.id,
  });
  // The events were created before the vehicle existed, so their `car` text
  // never matched a garage row; re-saving the rich event's car links it now
  // (events.vehicle_id), which is what gives the garage golden its hours and
  // `GET /vehicles/:id/steering-fit` a session to fit.
  await api("PUT", `/events/${rich.body.id}`, { car: "Corvette C7" });
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
  // A front pair with its size (migration 0029)…
  await api("POST", `/vehicles/${vehicle.body.id}/parts`, {
    kind: "tires_front",
    name: "Falken RT660",
    size: "255/40R17",
    installed_on: "2026-03-15",
  });
  // …swapped for a fresh pair after the rich event's first session (migration
  // 0030), so both mounts carry a swap point: the old pair's removed_* and the
  // new pair's mounted_* name the same event and session…
  const hoosiers = await api("POST", `/vehicles/${vehicle.body.id}/parts`, {
    kind: "tires_front",
    name: "Hoosier A7",
    size: "255/40R17",
    installed_on: FIXTURE.richEvent.start_date,
    swap: true,
    after_session_id: s1.body.id,
  });
  // …and a rear pair that has never been fitted: `equipped: false` with an
  // empty `mounts`, the spare-on-the-shelf branch.
  const spareRears = await api("POST", `/vehicles/${vehicle.body.id}/parts`, {
    kind: "tires_rear",
    name: "Falken RT660",
    size: "275/40R17",
    installed_on: "2026-03-15",
    equipped: false,
  });

  // Two measurements: enough for the least-squares projection path.
  await api("POST", `/parts/${pads.body.id}/measurements`, { measured_on: "2026-04-12", value: 9.5, unit: "mm" });
  await api("POST", `/parts/${pads.body.id}/measurements`, { measured_on: "2026-05-02", value: 7.8, unit: "mm" });

  // The rich event's day-2 sheet again, now carrying every key sanitizeSetup
  // accepts — the part refs too, pointing at the parts above (NS-40). Both
  // native SetupSheet models must decode and re-encode every one: a phone
  // that saves a sheet the web wrote would otherwise erase a key its model
  // lacks, and Android's strict golden decode is what notices. Non-null on
  // purpose, since iOS's golden check drops nulls before it diffs.
  await api("PUT", `/events/${rich.body.id}/setups/2`, {
    tp_cold: { fl: 25, fr: 25, rl: 24, rr: 24 },
    tp_hot: { fl: 33.5, fr: 34, rl: 31, rr: 31.5 },
    camber: { f: -3.5, r: -2.1 },
    toe: { f: -0.05, r: 0.1 },
    caster: { f: 7.5, r: 0 },
    rebound: { f: 10, r: 6 },
    compression: { f: 4, r: 3 },
    sway: { f: 2, r: 1 },
    fuel: 12.5,
    tires_f_id: hoosiers.body.id,
    tires_r_id: spareRears.body.id,
    pads_f_id: pads.body.id,
    notes: "Two clicks more rebound front; pushing less in T5.",
  });

  // A session note written after the fact, through the present-keys PUT
  // (NS-40): notes alone, so the label must survive.
  await api("PUT", `/sessions/${s1.body.id}`, { notes: "Learning the line. Brake later into T5." });

  // --- best-lap video (NS-45) ----------------------------------------------
  // One ready clip on the rich event's best lap, uploaded through the routes
  // into the harness's local R2, so the event detail carries `clip` as both an
  // object and a null and /me's `clips` counts it. The upload routes themselves
  // are pinned by test/api/clips.test.ts; the bytes stand for a video.
  const richDetail = (await api("GET", `/events/${rich.body.id}`)).body;
  const bestLap = richDetail.sessions
    .flatMap((s) => s.laps)
    .reduce((a, b) => (b.time_ms < a.time_ms ? b : a));
  const clipBytes = new Uint8Array(2048).map((_, i) => i & 0xff);
  const clip = await api("POST", `/sessions/${bestLap.session_id}/clip`, {
    time_ms: bestLap.time_ms,
    size_bytes: clipBytes.length,
    duration_ms: bestLap.time_ms + 5_000,
    lap_offset_ms: 3_000,
  });
  if (clip.status !== 201) throw new Error(`clip create failed: ${JSON.stringify(clip.body)}`);
  const part = await api.putBytes(`/clips/${clip.body.clip_id}/parts/1`, clipBytes);
  if (part.status !== 200) throw new Error(`clip part failed: ${JSON.stringify(part.body)}`);
  const done = await api("POST", `/clips/${clip.body.clip_id}/complete`);
  if (done.status !== 200) throw new Error(`clip complete failed: ${JSON.stringify(done.body)}`);

  // --- YouTube (NS-46) -------------------------------------------------------
  // That clip is on YouTube; a second, on another session's best lap, is not —
  // so the event detail pins `clip.youtube` as an object and as a null. The
  // connection and the upload are written straight into D1, because the
  // goldens are about shapes and an upload is Google's to finish; the tokens
  // are placeholders nothing decrypts. Every /me after this carries the
  // connected account; the fresh-account `me` above pins the nulls.
  const otherBest = richDetail.sessions
    .filter((s) => s.id !== bestLap.session_id && s.laps.length)
    .map((s) => s.laps.reduce((a, b) => (b.time_ms < a.time_ms ? b : a)))[0];
  const clip2 = await api("POST", `/sessions/${otherBest.session_id}/clip`, {
    time_ms: otherBest.time_ms,
    size_bytes: clipBytes.length,
    duration_ms: otherBest.time_ms + 5_000,
    lap_offset_ms: 2_000,
  });
  if (clip2.status !== 201) throw new Error(`second clip create failed: ${JSON.stringify(clip2.body)}`);
  await api.putBytes(`/clips/${clip2.body.clip_id}/parts/1`, clipBytes);
  await api("POST", `/clips/${clip2.body.clip_id}/complete`);
  const userId = (await api("GET", "/me")).body.user.id;
  d1(
    `INSERT INTO youtube_connections (user_id, google_sub, email, channel_title, refresh_token_enc, status, connected_at, verified_at, updated_at)
       VALUES (${userId}, 'golden-sub', 'driver@channel.example', 'Fast Laps', 'placeholder', 'ok', 0, 0, 0);
     INSERT INTO youtube_uploads (user_id, clip_id, status, title, description, privacy, bytes_sent, video_id, created_at, verified_at, updated_at)
       VALUES (${userId}, ${clip.body.clip_id}, 'done', 'VIR · best lap', 'Best lap.', 'unlisted', ${clipBytes.length}, 'goldenVid01', 0, 0, 0);`
  );

  // --- share --------------------------------------------------------------
  await api("PUT", "/share", { slug: "contract-fixture" });

  // POST /events returns only { id }, so resolve the track id we need for the
  // track-scoped captures from the list.
  const tracks = (await api("GET", "/tracks")).body ?? [];
  const trackId = tracks.find((t) => t.name === FIXTURE.richEvent.track_name)?.id;
  if (!trackId) throw new Error("fixture track not found — did resolveTrack change?");

  return {
    rich, patriot, bare, s1, vehicle, pads, spareRears, trackId, slug: "contract-fixture",
    clipId: clip.body.clip_id,
  };
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
  // Everything from here on is captured as a Pro account (see build()), which
  // is the tier that produces the fullest response shapes — a free account's
  // event detail is the same thing with `channels` nulled.
  //
  // The other branch of the prep list: a user who edited theirs in Settings.
  // The null case is `me`, captured before the claim.
  record("checklist-template-set", "PUT", "/me/checklist-template",
    "Replace the prep-checklist template. Null or [] clears it.", "src/routes/me.ts",
    await api("PUT", "/me/checklist-template", {
      checklist_template: ["Purchase Track insurance", "Torque lug nuts", "Set tire pressures"],
    }));
  record("me-checklist-template", "GET", "/me",
    "The signed-in user with a customized prep-checklist template.",
    "src/routes/me.ts", await api("GET", "/me"));

  // Leaderboard opt-in before the leaderboard read, so the capture has a row.
  // Both consents, so `lap_id` is populated and the lap detail below is
  // reachable — the withheld case is a null of the same type, pinned by the
  // route tests rather than by a second capture.
  record("leaderboard-opt-in", "PUT", "/me/leaderboard",
    "Toggle the per-track leaderboard opt-in, and the lap-sharing consent (NS-35) " +
    "stacked on top of it.", "src/routes/me.ts",
    await api("PUT", "/me/leaderboard", { opt_in: true, share_laps: true }));

  const lb = await api("GET", `/tracks/${track}/leaderboard`);
  record("track-leaderboard", "GET", "/tracks/:id/leaderboard",
    "The per-track community leaderboard: opted-in users' best laps at the same " +
    "catalog track. `you` marks the viewer's own row; `lap_id` is non-null only " +
    "when that row's owner shares the lap itself.",
    "src/routes/tracks.ts", lb);

  record("leaderboard-lap", "GET", "/tracks/:id/leaderboard/laps/:lapId",
    "One shared leaderboard lap: its racing line and gridded channel traces, with " +
    "nothing user-entered. `channels` is the one Pro field and is null for a free " +
    "account.",
    "src/routes/tracks.ts",
    await api("GET", `/tracks/${track}/leaderboard/laps/${lb.body.entries[0].lap_id}`));

  // The unit system is display-only, so the fixture is left on the default
  // afterwards: every other golden must read the way the app always has.
  record("units-set", "PUT", "/me/units",
    "Choose the unit system the logbook is shown in: \"metric\" or \"imperial\". " +
    "Display-only — nothing stored changes.", "src/routes/me.ts",
    await api("PUT", "/me/units", { units: "metric" }));
  record("me-units-metric", "GET", "/me",
    "The signed-in user after choosing metric units.",
    "src/routes/me.ts", await api("GET", "/me"));
  await api("PUT", "/me/units", { units: "imperial" });

  record("events-list", "GET", "/events",
    "All events with lap aggregates and computed stats (withComputed).",
    "src/routes/events.ts", await api("GET", "/events"));

  record("event-detail", "GET", "/events/:id",
    "One event with its sessions, laps and setup sheets. Populated stats branch.",
    "src/routes/events.ts", await api("GET", `/events/${ev}`));

  // Publishing a best-lap video to YouTube (NS-46): the form's pre-filled
  // words, and the status the lap page polls. The upload routes themselves
  // (POST, connect, disconnect) need Google and are test/api/youtube.test.ts's.
  record("youtube-draft", "GET", "/clips/:id/youtube/draft",
    "The upload form's pre-filled title, description and visibility (Pro), and the connected " +
    "account it uploads to (null when none).",
    "src/routes/youtube.ts", await api("GET", `/clips/${f.clipId}/youtube/draft`));
  record("youtube-upload", "GET", "/clips/:id/youtube",
    "A clip's YouTube upload as the lap page draws it: status, progress 0…1, privacy, the " +
    "youtu.be link once done, and the words for a failure or a wait.",
    "src/routes/youtube.ts", await api("GET", `/clips/${f.clipId}/youtube`));

  record("event-detail-no-laps", "GET", "/events/:id",
    "Event with no laps: best_ms and consistency are both null.",
    "src/routes/events.ts", await api("GET", `/events/${bare}`));

  record("event-setups-prefill", "GET", "/events/:id/setups/prefill",
    "Copy-forward prefill for a blank setup form.",
    "src/routes/events.ts", await api("GET", `/events/${ev}/setups/prefill`));

  record("tracks-list", "GET", "/tracks",
    "Tracks with per-track aggregates, plus the best-per-event series no client "
      + "renders any more (kept so shipped app builds keep decoding — see src/db.ts).",
    "src/routes/tracks.ts", await api("GET", "/tracks"));

  record("track-setups", "GET", "/tracks/:id/setups",
    "Setup-vs-lap-times rows for a track.",
    "src/routes/tracks.ts", await api("GET", `/tracks/${track}/setups`));

  record("catalog", "GET", "/catalog",
    "Seeded canonical track catalog backing event-form suggestions.",
    "src/routes/tracks.ts", await api("GET", "/catalog"));

  record("car-catalog", "GET", "/car-catalog",
    "Seeded car catalog: one row per generation with wheelbase, steering ratio (nullable — never a guess) and provenance; backs the vehicle form's picker and pre-fills a vehicle's geometry at pick time.",
    "src/routes/carCatalog.ts", await api("GET", "/car-catalog"));

  record("vehicles-list", "GET", "/vehicles",
    "The user's garage vehicles.",
    "src/routes/vehicles.ts", await api("GET", "/vehicles"));

  record("vehicle-steering-fit", "GET", "/vehicles/:id/steering-fit",
    "The per-session steering fits behind the vehicle form's measured-ratio line (#223): " +
    "steeringFit over the car's most recent channel-carrying sessions, newest first, " +
    "only those that fit. The client pools them against the wheelbase in the form.",
    "src/routes/vehicles.ts", await api("GET", `/vehicles/${veh}/steering-fit`));

  record("garage", "GET", "/garage",
    "Every vehicle with accrued hours, parts, measurements and computed wear.",
    "src/routes/vehicles.ts", await api("GET", "/garage"));

  // --- public share (unauthenticated) -------------------------------------
  record("share-public", "GET", "/share/:slug",
    "Public share page data. Deliberately reduced: no notes, email, per-lap data or garage/setup linkage.",
    "src/routes/share.ts", await anon("GET", `/share/${f.slug}`));

  // --- share one event or session (NS-48) ----------------------------------
  // The rich event carries the ready clip from above, so the shared views pin
  // `clip` as both an object and a null; the fixture account is Pro, so `pro`
  // is true and the channels are whole.
  const evShare = record("item-share-event-create", "POST", "/events/:id/share",
    "Share one event: its link, minted on first use and answered again after (200). Free.",
    "src/routes/itemShare.ts", await api("POST", `/events/${ev}/share`));
  record("item-share-event", "GET", "/events/:id/share",
    "The event's share link if there is one; 404 when it isn't shared.",
    "src/routes/itemShare.ts", await api("GET", `/events/${ev}/share`));
  const sessShare = record("item-share-session-create", "POST", "/sessions/:id/share",
    "Share one session: the same shape with kind \"session\" and a /share/s/ link.",
    "src/routes/itemShare.ts", await api("POST", `/sessions/${sess}/share`));
  record("item-share-session", "GET", "/sessions/:id/share",
    "The session's share link if there is one; 404 when it isn't shared.",
    "src/routes/itemShare.ts", await api("GET", `/sessions/${sess}/share`));
  record("shared-event", "GET", "/share/e/:token",
    "A shared event (unauthenticated): the event detail as the owner reads it, narrowed to " +
    "the lap data — notes, checklist, costs, setups and the garage link null or empty — " +
    "with `pro` the owner's tier and `clip` only while the owner has Pro.",
    "src/routes/itemSharePublic.ts", await anon("GET", `/share/e/${evShare.body.token}`));
  record("shared-session", "GET", "/share/s/:token",
    "A shared session (unauthenticated): the same shape with the one session, and the " +
    "header's best, lap count, consistency and weather worked out from it alone.",
    "src/routes/itemSharePublic.ts", await anon("GET", `/share/s/${sessShare.body.token}`));

  // --- writes -------------------------------------------------------------
  record("event-create", "POST", "/events", "Create an event.", "src/routes/events.ts",
    await api("POST", "/events", { track_name: "Watkins Glen", start_date: "2026-07-04" }));

  record("event-update", "PUT", "/events/:id", "Update an event.", "src/routes/events.ts",
    await api("PUT", `/events/${bare}`, { start_date: "2026-06-02", days: 2, club: "NASA" }));

  record("session-create", "POST", "/events/:id/sessions", "Create a session with laps.",
    "src/routes/sessions.ts",
    await api("POST", `/events/${bare}/sessions`, { label: "Session 1", laps: [95_000] }));

  record("session-update", "PUT", "/sessions/:id",
    "Update a session — only the keys present are written (NS-40).", "src/routes/sessions.ts",
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

  record("part-equip", "POST", "/parts/:id/equip",
    "Put a spare back on the car as of a date, taking off whatever shares its place; " +
    "`unequipped` lists the ids it took off (empty here: a rear pair swaps no front pair).",
    "src/routes/vehicles.ts", await api("POST", `/parts/${f.spareRears.body.id}/equip`, { on: "2026-06-01" }));

  record("part-mount-edit", "PUT", "/parts/:id/mount",
    "When a part went on the car, edited after the fact: moves its latest mount's start and whatever came " +
    "off the car at the old point with it; `moved` lists those parts' ids (empty here: nothing came off).",
    "src/routes/vehicles.ts", await api("PUT", `/parts/${f.spareRears.body.id}/mount`, { mounted_on: "2026-06-02" }));

  record("part-unequip", "POST", "/parts/:id/unequip",
    "Take a part off the car as of a date without retiring it — it goes to the shelf.",
    "src/routes/vehicles.ts", await api("POST", `/parts/${f.spareRears.body.id}/unequip`, { on: "2026-07-01" }));

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
  record("item-share-event-delete", "DELETE", "/events/:id/share",
    "Stop sharing an event: its link answers 404 from now on.",
    "src/routes/itemShare.ts", await api("DELETE", `/events/${ev}/share`));
  record("item-share-session-delete", "DELETE", "/sessions/:id/share",
    "Stop sharing a session.",
    "src/routes/itemShare.ts", await api("DELETE", `/sessions/${sess}/share`));

  // --- errors -------------------------------------------------------------
  // Every client surfaces err.message from these, so the { error: string }
  // shape is part of the contract.
  record("error-400", "POST", "/events", "400: missing required field.", "src/routes/events.ts",
    await api("POST", "/events", {}));

  record("error-401", "GET", "/events", "401: no session.", "src/middleware.ts",
    await anon("GET", "/events"));

  record("error-404", "GET", "/events/:id", "404: not found, or owned by another user.",
    "src/routes/events.ts", await api("GET", "/events/99999"));

  // --- billing (NS-32) ----------------------------------------------------
  // The claim itself is in build(), because the fixture cannot be built
  // without it. The three store routes need payloads signed by Apple or an
  // answer from Play, which this harness cannot mint against the pinned root,
  // so they are exercised by test/api/billing.test.ts instead; all four answer
  // with the same { ok, entitlement } shape as the claim.
  record("me-pro-legacy", "GET", "/me",
    "The signed-in user once entitled: tier pro, source legacy, no expiry.",
    "src/routes/me.ts", await api("GET", "/me"));

  // --- Season Wrapped (NS-36) ---------------------------------------------
  // Last, so the extra event it needs disturbs no capture above. A second,
  // quicker day on the Patriot layout — the catalog doesn't know it — gives
  // `improvement` its first-year fallback, so the golden pins that object's
  // shape rather than a null. By now the season has three tracks: VIR (Full),
  // whose catalog row carries a length, and the Patriot layout and the
  // "Watkins Glen" typed without its catalog suffix, neither of which the
  // catalog matches and neither with telemetry — so `miles_tracks_counted` is
  // below `tracks`, the "across N of M tracks" branch.
  await api("POST", "/events", { ...FIXTURE.patriotEvent, start_date: "2026-05-20", best_time_ms: 76_900 });
  // The garage was deleted above, so the Pro half gets its tire back: a car
  // re-linked to the rich event and a set of tires installed before it, so
  // `pro.tire` is an object rather than a null. `pro.top_speed` comes from the
  // rich event's channel sessions, which survive the deletes. The account is
  // Pro, so `pro` is the object; a free account's null is pinned by the route
  // tests.
  const car = await api("POST", "/vehicles", { name: "Corvette C7" });
  await api("POST", `/vehicles/${car.body.id}/parts`, {
    kind: "tires", name: "Continental ExtremeContact Force", installed_on: "2026-03-15",
  });
  await api("PUT", `/events/${f.rich.body.id}`, { car: "Corvette C7" });
  record("wrapped", "GET", "/wrapped/:year",
    "Season Wrapped (NS-36): the season's numbers for one calendar year, past events " +
    "only. `pro` is the one tier-dependent field — null for a free account; for Pro, " +
    "the favorite tire and top speed, each null when there is no data.",
    "src/routes/wrapped.ts", await api("GET", "/wrapped/2026"));

  // The public share of the same season: the slug was cleared above, so it is
  // claimed again (uncaptured — share-set already pins that response).
  await api("PUT", "/share", { slug: f.slug });
  record("share-wrapped", "GET", "/share/:slug/wrapped/:year",
    "A shared Season Wrapped (unauthenticated): the same shape as GET /wrapped/:year " +
    "with no `pro` key — the free card set only.",
    "src/routes/share.ts", await anon("GET", `/share/${f.slug}/wrapped/2026`));
}

// ---------------------------------------------------------------------------
// coaching (NS-38)
// ---------------------------------------------------------------------------

// Share with a coach needs two accounts, so it runs after everything else:
// the fixture's account (Pro, with the rich event) is the student, and the
// Worker is restarted as a second, free account that becomes their coach.
// Returns the restarted worker so main() disposes the live one.
async function captureCoaching(worker, api, f) {
  const PROFILE = {
    occupation: "Engineer",
    first_track_year: 2019,
    experience: "Autocross since 2015",
    license: "NASA HPDE4",
    instruction: "Two schools",
    helmet: "Bell GP3",
    helmet_rating: "SA2020",
    head_neck: "hans",
    suit: "Single-layer SFI 3.2A/1",
    gloves: true,
    shoes: true,
    gear_notes: "Wears glasses",
    goals: "Trail braking into T1",
    for_instructor: "Old left-wrist injury",
  };
  record("me-profile-set", "PUT", "/me/profile",
    "Replace the driver profile (NS-38). Answers with the stored profile, trimmed and " +
    "with unknown keys dropped; null clears it.",
    "src/routes/me.ts", await api("PUT", "/me/profile", { profile: PROFILE }));
  record("me-profile", "GET", "/me/profile",
    "The driver profile, headed by the owner's name, picture and tier — the same route a " +
    "coach reads under /students/:studentId.",
    "src/routes/me.ts", await api("GET", "/me/profile"));

  const invite = record("coaching-invite", "POST", "/coaching/invites",
    "Mint a single-use invite link for a coach (Pro). The token is in `url` and is shown " +
    "only here; only its hash is stored.",
    "src/routes/coaching.ts", await api("POST", "/coaching/invites"));
  const token = invite.body.url.split("/coach/")[1];
  const second = await api("POST", "/coaching/invites");
  const studentId = (await api("GET", "/me")).body.user.id;

  await worker.dispose();
  worker = await startWorker({ email: "coach@example.com", name: "Coach User", fresh: false });
  const base = String(await worker.url);
  const coach = apiClient(base, await signIn(base));
  const student = api.rebase(base);
  const as = (p) => coach("GET", `/students/${studentId}${p}`);

  record("coaching-invite-preview", "GET", "/coaching/invites/:token",
    "What opening an invite link shows: whose logbook, and whether accepting would work.",
    "src/routes/coaching.ts", await coach("GET", `/coaching/invites/${token}`));
  record("coaching-accept", "POST", "/coaching/invites/:token/accept",
    "Accept an invite: the caller becomes a read-only coach of the student. Burns the link.",
    "src/routes/coaching.ts", await coach("POST", `/coaching/invites/${token}/accept`));
  record("coaching-as-coach", "GET", "/coaching",
    "Coaching from the coach's side: the students whose logbooks they can read.",
    "src/routes/coaching.ts", await coach("GET", "/coaching"));

  record("student-events", "GET", "/students/:studentId/events",
    "A coach's view of a student's events: the event list with notes, checklist and costs " +
    "sent as null.",
    "src/lib/coaching.ts", await as("/events"));
  record("student-event-detail", "GET", "/students/:studentId/events/:id",
    "A coach's view of one event: sessions, laps, trace and channels (stripped to the " +
    "student's tier, here Pro) — notes null, setups empty.",
    "src/lib/coaching.ts", await as(`/events/${f.rich.body.id}`));
  record("student-tracks", "GET", "/students/:studentId/tracks",
    "A coach's view of a student's tracks, with the course notes sent as null.",
    "src/lib/coaching.ts", await as("/tracks"));
  record("student-vehicles", "GET", "/students/:studentId/vehicles",
    "A coach's view of a student's cars: the whole vehicle row, modifications included.",
    "src/lib/coaching.ts", await as("/vehicles"));
  record("student-profile", "GET", "/students/:studentId/me/profile",
    "A coach's view of the student's driver profile; `pro` is the student's tier, which " +
    "the coach's client opens the channel panel by.",
    "src/routes/me.ts", await as("/me/profile"));

  record("coaching", "GET", "/coaching",
    "Coaching from the student's side: their coaches (with when each last looked) and " +
    "their unused invites.",
    "src/routes/coaching.ts", await student("GET", "/coaching"));
  record("coaching-invite-delete", "DELETE", "/coaching/invites/:id",
    "Withdraw an unused invite.",
    "src/routes/coaching.ts", await student("DELETE", `/coaching/invites/${second.body.id}`));
  record("coaching-student-delete", "DELETE", "/coaching/students/:studentId",
    "A coach stops coaching a student.",
    "src/routes/coaching.ts", await coach("DELETE", `/coaching/students/${studentId}`));
  // Coach again, so the student can revoke.
  const again = await student("POST", "/coaching/invites");
  await coach("POST", `/coaching/invites/${again.body.url.split("/coach/")[1]}/accept`);
  const coachId = (await coach("GET", "/me")).body.user.id;
  record("coaching-coach-delete", "DELETE", "/coaching/coaches/:coachId",
    "A student revokes a coach; that coach's next read under /students/:studentId is a 404.",
    "src/routes/coaching.ts", await student("DELETE", `/coaching/coaches/${coachId}`));
  return worker;
}

// ---------------------------------------------------------------------------
// coverage check
// ---------------------------------------------------------------------------

// Every route registered under /api must appear in the manifest. A silently
// uncovered endpoint is a silently unprotected client.
const EXPECTED_ROUTES = [
  "GET /me", "PUT /me/checklist-template", "PUT /me/leaderboard", "PUT /me/units",
  "GET /events", "POST /events", "GET /events/:id", "PUT /events/:id", "DELETE /events/:id",
  "PUT /events/:id/setups/:day", "DELETE /events/:id/setups/:day", "GET /events/:id/setups/prefill",
  "POST /events/:id/sessions", "PUT /sessions/:id", "DELETE /sessions/:id",
  "POST /sessions/:id/laps", "DELETE /laps/:id",
  "GET /tracks", "POST /tracks", "PUT /tracks/:id", "DELETE /tracks/:id",
  "GET /tracks/:id/setups", "GET /tracks/:id/leaderboard",
  "GET /tracks/:id/leaderboard/laps/:lapId", "GET /catalog", "GET /car-catalog",
  "GET /vehicles", "POST /vehicles", "PUT /vehicles/:id", "DELETE /vehicles/:id",
  "GET /garage",
  "GET /vehicles/:id/steering-fit",
  "POST /vehicles/:id/parts", "PUT /parts/:id", "DELETE /parts/:id", "POST /parts/:id/refresh",
  "POST /parts/:id/equip", "POST /parts/:id/unequip", "PUT /parts/:id/mount",
  "POST /parts/:id/measurements", "DELETE /parts/:id/measurements/:mid",
  "PUT /share", "DELETE /share", "GET /share/:slug", "GET /share/:slug/wrapped/:year",
  "GET /wrapped/:year",
  // Publish a best-lap video to YouTube (NS-46). POST /clips/:id/youtube,
  // POST /youtube/connect and DELETE /youtube need Google (or mint a single-use
  // ticket) and are test/api/youtube.test.ts's.
  "GET /clips/:id/youtube/draft", "GET /clips/:id/youtube",
  // Share one event or session (NS-48).
  "POST /events/:id/share", "GET /events/:id/share", "DELETE /events/:id/share",
  "POST /sessions/:id/share", "GET /sessions/:id/share", "DELETE /sessions/:id/share",
  "GET /share/e/:token", "GET /share/s/:token",
  // Share with a coach (NS-38).
  "GET /me/profile", "PUT /me/profile",
  "GET /coaching", "POST /coaching/invites", "DELETE /coaching/invites/:id",
  "GET /coaching/invites/:token", "POST /coaching/invites/:token/accept",
  "DELETE /coaching/coaches/:coachId", "DELETE /coaching/students/:studentId",
  "GET /students/:studentId/events", "GET /students/:studentId/events/:id",
  "GET /students/:studentId/tracks", "GET /students/:studentId/vehicles",
  "GET /students/:studentId/me/profile",
  // Billing (NS-32). The three store routes — POST /billing/apple,
  // /billing/apple/legacy and /billing/google — need payloads signed by the
  // stores (or a Play API answer) that this harness cannot mint against the
  // pinned Apple root, so they are exercised by test/api/billing.test.ts
  // instead; all four answer with the same { ok, entitlement } shape, pinned
  // here through the one route that needs no store.
  "POST /billing/google/legacy",
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

let worker = await startWorker();
try {
  const base = String(await worker.url);
  const token = await signIn(base);
  const api = apiClient(base, token);
  const anon = apiClient(base, null);

  const fixture = await build(api);
  await captureAll(api, anon, fixture);
  worker = await captureCoaching(worker, api, fixture);
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
