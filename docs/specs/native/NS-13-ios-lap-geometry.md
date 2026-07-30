# NS-13 — Lap geometry port (iOS)

**Phase:** 1 · **Platform:** iOS · **Depends on:** NS-01 · **Estimate:** 2–3 days

## Goal

Port `public/js/import/geo.js` to Swift in `TrackEvolutionKit`: project GPS traces
to local meters, build a start/finish gate from a picked point, and derive lap
times from gate crossings.

## Why this is in Phase 1, even though telemetry import is not being ported

The programme deliberately leaves the telemetry **file parsers** on the web
(see `README.md` in this directory). `geo.js` is the exception, because it is not
part of the import feature — it is part of the **recorder's save path**.
`toParsed()` in `record/core.js` returns `needsLine: true`, meaning a live
recording has no lap markers and its laps are timed by the user picking the
start/finish line. Without this port there is no way to turn a native recording
into laps.

## Source

`public/js/import/geo.js` (148 lines), tests in `test/unit/geo.test.js`.

## Requirements

1. **Keep the names**: `projectTrace`, `buildGate`, `gateFromSegment`,
   `gateCrossings`, `lapsFromCrossings`, `deriveLaps`, `lapTrace`, `bestLapTrace`.
2. **`projectTrace`** — equirectangular projection, `kx = 111320 · cos(originLat)`,
   `ky = 110540`, origin defaulting to the first point. Fine at track scale.
   An explicit origin lets multiple traces share one coordinate frame.
3. **`buildGate`** — a segment through `trace[idx]` perpendicular to the local
   direction of travel, default half-width 20 m. The heading window **widens
   (3 → 6 → 12 → 24) until the displacement exceeds 2 m**; returns `nil` if it
   never does (car stationary at the picked point). Reproduce the widening loop
   exactly — it is what makes picking a point in a slow corner work.
4. **`gateCrossings`** — segment/segment intersection with the crossing time
   **interpolated within the trace segment** (`t = a.t + s·(b.t − a.t)`). This
   interpolation is why GPS-derived laps are accurate to ~±0.1–0.3 s between
   10–18 Hz fixes.
   - Direction filtering when the gate has a heading (`dx·hx + dy·hy <= 0` skips),
     so you only time crossings in the racing direction.
   - `minGapS = 5` suppresses jitter double-counts.
5. **`lapsFromCrossings`** — deltas outside `[minLapS 30, maxLapS 3600]` are
   dropped: jitter double-counts below, pit stops and session gaps above. Each lap
   carries `timeMs` (**rounded integer milliseconds**), `estimated: true`, and
   `startT`/`endT` on the trace clock.
   - `estimated` is user-visible — these laps render with a `~` prefix. Do not
     drop the flag.
6. **`lapTrace` / `bestLapTrace`** — the downsampled `[x, y, v]` polyline of the
   fastest lap, max 300 points, used for the speed-painted racing line on the
   event page. Note it always appends the final point when the stride misses it,
   and returns `nil` under 10 points. Rounding: x/y to 1dp, speed to 2dp.
7. **Sign conventions do not matter** — everything is relative geometry within one
   trace. Do not add "corrections" for hemisphere or for Racelogic's west-positive
   longitude; the web parser handles that at its own layer and this code is
   deliberately agnostic.
8. **Port the tests** from `test/unit/geo.test.js`, same inputs and expectations.

## Acceptance criteria

- [ ] All eight functions ported with matching names and defaults.
- [ ] Every `test/unit/geo.test.js` case has a passing Swift equivalent.
- [ ] `buildGate` returns `nil` for a stationary pick and succeeds for a slow-corner pick.
- [ ] Direction filtering rejects the reverse crossing on an out-and-back trace.
- [ ] `minGapS` suppresses a deliberately jittered double-crossing.
- [ ] Laps outside `[30 s, 3600 s]` are dropped.
- [ ] Given the same trace and picked index, Swift produces **lap times identical to the JS** to the millisecond — test with a shared fixture.
- [ ] `xcodebuild test -scheme TrackEvolutionKit` passes; no CoreLocation or SwiftUI import.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

```sh
npx vitest run test/unit/geo.test.js
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolutionKit
```

Export one real trace + picked index from the web app and assert both
implementations produce the same lap times to the millisecond. That
cross-language fixture is the single most valuable test in this spec.

## Notes

- `js/import/channels.js` (per-lap speed resampled onto a 20 m driven-distance
  grid) is **not** in scope here. Decide in NS-17 whether native recordings store
  channel data at parity with web; if yes, it becomes a follow-up spec. The
  server validates the shape via `sanitizeChannels` in `src/lib/validate.ts`.
- `lapTrace` output is stored on the session row and rendered by NS-23's trackmap.
