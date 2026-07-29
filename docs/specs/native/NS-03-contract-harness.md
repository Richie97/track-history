# NS-03 — Golden-JSON API contract harness

**Phase:** 0 · **Platform:** Shared · **Depends on:** — · **Estimate:** 3–4 days

## Goal

Produce a directory of **real captured API responses** that the Swift and Kotlin
test suites decode, so a backend response-shape change fails the native builds
immediately instead of silently at runtime.

## Why this exists

`AGENTS.md` already names the pain: *"Frontend and backend share no code — keep
API response shapes in sync with the `app.js` consumers by hand."* That is
tolerable with one client. With three, hand-syncing is how the apps break in
production.

We are **not** introducing codegen — at ~40 endpoints the tooling costs more than
it saves, and the backend is explicitly staying as-is. Golden files give the same
drift protection with no backend change and no build-time dependency between
languages.

## Scope

**In scope:** a generator that captures responses, the `contracts/golden/` files
themselves, a manifest describing them, and CI wiring to detect staleness.

**Out of scope:** the Swift and Kotlin decoders (NS-04/NS-05 consume these files).
Any change to `src/`.

## The constraint that shapes this

`test/api/` runs inside workerd via `@cloudflare/vitest-pool-workers`
(`vitest.workers.config.mts`), which has **no filesystem access** — those tests
cannot write golden files.

**Required approach:** a standalone Node script `contracts/generate.mjs` that
starts the Worker programmatically (wrangler's `unstable_startWorker` /
`unstable_dev`) against a local D1 with `migrations/` applied and the same
`DEV_MODE` bindings used in `vitest.workers.config.mts`, drives the API over
HTTP, and writes the results. Node side, so `fs` is available.

If `unstable_startWorker` proves unworkable, the fallback is spawning
`wrangler dev --local` as a child process and polling its port — but try the
programmatic path first. **Do not** try to make the workerd tests write files.

## Requirements

1. **`contracts/generate.mjs`**, run via a new `npm run contracts:generate` script.
   It must:
   - Apply `migrations/` to a throwaway local D1.
   - Sign in via the `DEV_MODE` bypass (`GET /auth/login` on a local dev host) to
     get a session, exactly as `test/api/helpers.ts` does conceptually.
   - Build a **deterministic, representative dataset** — see below.
   - Capture the response of every GET endpoint and every mutating endpoint's
     response body.
   - Write one JSON file per endpoint to `contracts/golden/`.
2. **Determinism is mandatory.** Regenerating without a backend change must produce
   a byte-identical tree, or the staleness check in CI is worthless. That means:
   - Fixed dates and fixed input values — no `Date.now()` in the fixture data.
   - Stable ordering.
   - Volatile fields (`id`, `created_at`, `updated_at`, share slugs, tokens) must
     be **normalized, not deleted** — replace with a stable placeholder that
     preserves the *type and nullability*, e.g. `"id": 1`, `"updated_at": 0`.
     The point is to pin shape, not values. Deleting a field would let a
     nullability regression through.
3. **Dataset coverage.** The fixture must exercise the shapes the native clients
   actually depend on, including the awkward ones:
   - A track with and without a `catalog_id`.
   - An event with laps (so `best_ms`, `consistency`, `hours` from
     `src/lib/stats.ts` are populated) **and** an event with none (so the null
     branches are captured).
   - Fewer than 3 laps on one session — `consistency` is null below 3 laps.
   - A session with `channels` and one without.
   - An event with `track_hours` overridden and one without.
   - A vehicle with parts, measurements, and a computed `wear`; and a bare vehicle.
   - Setup sheets for at least two days of one event, plus the prefill response.
   - A share slug enabled, capturing the **public** `GET /api/share/:slug` shape —
     which deliberately strips notes, email, per-lap data, and garage/setup linkage.
   - At least one error response per status the clients handle (400, 401, 404),
     confirming the `{ error: string }` shape.
4. **`contracts/golden/manifest.json`** listing, for each golden file: HTTP method,
   path template, status, a one-line description, and which endpoint in `src/routes/`
   produced it. This is what NS-04/NS-05 iterate over.
5. **CI staleness check (extend `.github/workflows/ci.yml`)**: regenerate and fail
   if `git diff --exit-code contracts/golden/` is dirty. A backend change that
   alters a response shape then fails the *backend* PR with a clear diff, which is
   exactly the early warning we want.
6. **Endpoint coverage check.** The generator must assert it captured every route
   registered under `/api` — enumerate from `src/routes/*.ts` or maintain an
   explicit list that CI verifies is complete. A silently-uncovered endpoint is a
   silently-unprotected client.

## Acceptance criteria

- [ ] `npm run contracts:generate` writes `contracts/golden/*.json` + `manifest.json`.
- [ ] Running it twice produces zero `git diff`.
- [ ] All 33 `/api` routes and the public share endpoint are represented.
- [ ] Both populated and null/empty branches are captured for computed stats.
- [ ] CI fails when a response shape changes without regenerated goldens — prove it by temporarily altering a field in `src/routes/` and showing the red build, then reverting.
- [ ] `npm test` and `npm run typecheck` still pass; **`git diff --stat src/` is empty**.

## Verification

```sh
npm run contracts:generate
git diff --exit-code contracts/golden/   # clean on a second run
npm test && npm run typecheck
git diff --stat origin/main -- src/      # must be empty
```

## Notes

- Read `test/api/helpers.ts` for how users, sessions, and the `api` client are set
  up — the same patterns apply, just over real HTTP instead of `SELF.fetch`.
- `test/api/` remains the behavioral test suite. This harness is only about
  **shape**, and it is additive: no existing test changes.
- Keep the golden files readable (2-space indented, sorted keys). They are
  reviewed by humans in PRs when shapes legitimately change.
