# NS-04 — Domain models + API client (iOS)

**Phase:** 0 · **Platform:** iOS · **Depends on:** NS-01, NS-03 · **Estimate:** 4–5 days

## Goal

`Codable` model types for every API response, and the HTTP client that fetches
them — all in `TrackEvolutionKit`, no SwiftUI, fully unit-tested against the
NS-03 golden files.

## Scope

**In scope:** model structs, the `APIClient` actor, error mapping, bearer-token
injection point, golden-file decode tests.

**Out of scope:** obtaining a token (NS-08), caching or offline behavior (NS-21),
any UI.

## Requirements

1. **Models in `TrackEvolutionKit/Models/`**, one file per resource: `Event`,
   `Track`, `Session`, `Lap`, `Vehicle`, `Part`, `Measurement`, `Setup`, `Me`,
   `CatalogTrack`, `ShareData`.
2. **Field names and nullability must match the server exactly.** The canonical
   shapes are `ComputedEvent` in `src/lib/stats.ts` and `eventSelect` in
   `src/db.ts`. Use `CodingKeys` to map `snake_case` → `camelCase`; do **not**
   rely on `.convertFromSnakeCase`, because it silently mangles keys like
   `best_time_ms` vs `best_ms` and makes mismatches hard to spot.
3. **Get the optionality right — this is where these bugs live.** From
   `withComputed`:
   - `best_ms: Int?` — null when the event has neither a manual best nor any laps.
   - `consistency: Double?` — **null below 3 laps.** Not zero.
   - `hours: Double` — never null; already rounded to 1dp server-side.
   - `checklist: [ChecklistItem]?` — parsed JSON, null when absent *or malformed*
     (`parseChecklist` degrades rather than throwing).
   - `club`, `run_group`, `car`, `notes`, `conditions`, `temp_f`, `vehicle_id`,
     `track_hours`, `best_time_ms` are all nullable.
   - `lap_best_ms: Int?`, but `lap_count: Int` and `session_count: Int` are not.
   - Note `lap_avg`/`lap_avg_sq` are **stripped** by `withComputed` and must not
     appear in the model.
4. **All lap times are integer milliseconds.** Model them as `Int`, never
   `TimeInterval`/`Double`. Formatting to `m:ss.fff` is a view concern — port the
   behavior of `fmtMs`/`parseTime` in `public/js/format.js` (and its test file
   `test/unit/format.test.js`) as `LapTime` helpers in the Kit.
5. **`APIClient`** — an `actor`, built on `URLSession`:
   - Base URL configurable (production `https://trackevolution.app`, plus a
     dev override; the Capacitor app had a server-settings panel and the native
     app should keep an equivalent for testing against `wrangler dev`).
   - Injects `Authorization: Bearer <token>` from a `TokenProviding` protocol —
     defined here, **implemented** in NS-08. Do not reach into the Keychain from
     this layer.
   - `async throws` methods, one per endpoint, typed to the models.
6. **Error mapping.** The server returns `{ error: string }` with a meaningful
   status. Define `APIError` carrying `status: Int` and `message: String`, mirroring
   the web client's `ApiError` (`public/js/api.js`). `401` must be a distinct case
   so the app can trigger re-auth. The `message` is what UI surfaces — never
   invent a generic string when the server sent one.
7. **Golden-file tests** in `TrackEvolutionKitTests`: iterate
   `contracts/golden/manifest.json` and decode every file into its model. Missing
   fields, wrong types, and unexpected-null all fail. Add the golden directory as
   a test resource so it is read from the repo, not copied and left to rot.
8. **Strict decoding.** Prefer failing loudly on an unexpected shape over
   defaulting. A field the server always sends must not be modelled as optional
   "just in case" — that hides exactly the drift this spec exists to catch.

## Acceptance criteria

- [ ] Every endpoint in `contracts/golden/manifest.json` has a model and a passing decode test.
- [ ] `consistency` is `nil` (not `0`) for the <3-lap golden fixture.
- [ ] `best_ms` is `nil` for the no-laps golden fixture.
- [ ] Error goldens decode to `APIError` with the server's message preserved.
- [ ] `xcodebuild test -scheme TrackEvolutionKit` passes with no simulator UI.
- [ ] `TrackEvolutionKit` still imports no UIKit/SwiftUI.
- [ ] `git diff --stat src/ public/` is empty.

## Verification

```sh
npm run contracts:generate      # goldens current
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolutionKit
```

Then break one field's type in a golden file by hand and confirm the test fails.

## Notes

- `public/js/api.js` (100 lines) is the reference for request shaping and error
  handling. Ignore its offline routing — that is NS-21.
- The share endpoint `GET /api/share/:slug` is **unauthenticated** and returns a
  deliberately reduced shape (no notes, email, per-lap data, or garage/setup
  linkage). Model it as a separate type, not an optional-riddled variant of the
  authed one.
- Endpoints for garage, setups, year review and compare are **deferred** (see
  `README.md` in this directory) — model them only if the golden manifest
  includes them and it costs nothing; no client methods needed yet.
