# NS-05 — Domain models + API client (Android)

**Phase:** 0 · **Platform:** Android · **Depends on:** NS-02, NS-03 · **Estimate:** 4–5 days

## Goal

`@Serializable` model types for every API response and the HTTP client that
fetches them, in the pure-JVM `:core` module, unit-tested against the NS-03
golden files.

**Read `NS-04-ios-api-client.md` first.** This is its exact counterpart; the
requirements about field naming, optionality, and error mapping are identical and
are not repeated in full here. Where the two specs disagree, NS-04 is wrong and
should be fixed — the two clients must model the same server identically.

## Scope

**In scope:** data classes, the `ApiClient`, error mapping, token-provider
interface, golden-file decode tests.

**Out of scope:** obtaining a token (NS-09), caching/offline (NS-22), any UI.

## Requirements

1. **Models in `:core`** under `app.trackevolution.core.model`, one file per
   resource: `Event`, `Track`, `Session`, `Lap`, `Vehicle`, `Part`, `Measurement`,
   `Setup`, `Me`, `CatalogTrack`, `ShareData`.
2. **kotlinx.serialization** with explicit `@SerialName("best_time_ms")` on every
   field. Do not use a global snake_case naming strategy — explicit names make a
   mismatch visible at the field.
3. **Optionality must match `ComputedEvent` in `src/lib/stats.ts`** exactly. In
   particular `consistency: Double?` is **null below 3 laps, not zero**, and
   `best_ms: Int?` is null with no laps and no manual best. `hours: Double` is
   non-null. `lapAvg`/`lapAvgSq` are stripped server-side and must not appear.
4. **Lap times are `Int` milliseconds**, never `Duration` or `Float`. Port
   `fmtMs`/`parseTime` from `public/js/format.js` (with `test/unit/format.test.js`
   as the test cases) into `:core`.
5. **`ApiClient`** — Ktor client (or Retrofit + kotlinx-serialization; Ktor is
   preferred since `:core` is a plain JVM module with no Android dependency):
   - Configurable base URL, including a dev override for `wrangler dev`.
   - `Authorization: Bearer <token>` from a `TokenProvider` interface defined here
     and **implemented** in NS-09. `:core` must not touch Android keystores.
   - `suspend` functions, one per endpoint.
6. **Error mapping.** `ApiException(status: Int, message: String)` from the
   server's `{ error: string }`. `401` distinguishable for re-auth. Surface the
   server's message; never replace it with a generic one.
7. **Golden-file tests** in `:core`'s JVM test source set: read
   `contracts/golden/manifest.json` from the repo (relative path, not a copy) and
   decode each file. Configure `Json { ignoreUnknownKeys = false }` so an added
   server field is caught rather than silently dropped.
8. **Strict decoding** — no speculative defaults. A field the server always sends
   is non-nullable.

## Acceptance criteria

- [ ] Every endpoint in `contracts/golden/manifest.json` has a data class and a passing decode test.
- [ ] `consistency` is `null` (not `0.0`) for the <3-lap fixture; `bestMs` is `null` for the no-laps fixture.
- [ ] Error goldens decode with the server's message preserved.
- [ ] `./gradlew :core:test` passes on the JVM with no emulator.
- [ ] `:core` has no `android.*` import.
- [ ] Swift and Kotlin models agree field-for-field on nullability — diff them deliberately.
- [ ] `git diff --stat src/ public/` is empty.

## Verification

```sh
npm run contracts:generate
cd apps/android && ./gradlew :core:test
```

Then hand-edit a golden field's type and confirm the test fails.

## Notes

- `public/js/api.js` is the behavioral reference; ignore its offline routing (NS-22).
- `GET /api/share/:slug` is unauthenticated and returns a reduced shape — a
  separate data class, not an optional-riddled variant.
- Garage/setup/year-review endpoints are deferred; no client methods needed yet.
