# NS-11 — RecorderCore port (iOS)

**Phase:** 1 · **Platform:** iOS · **Depends on:** NS-01 · **Estimate:** 2–3 days

## Goal

Port `public/js/record/core.js` to Swift in `TrackEvolutionKit` — pure logic, no
CoreLocation, no UI — with its JS test cases ported alongside.

This is the brain of the lap recorder. It is only **164 lines**, every threshold
is already a named constant, and `test/unit/record.test.js` is its executable
specification. Treat it as a translation, not a redesign.

## Source

`public/js/record/core.js`, in full. Read the file before starting; it is short
and heavily commented, and the comments explain *why* each rule exists.

## Requirements

1. **Keep the names.** `addFix`, `fixSpeeds`, `shouldAutoStop`, `trimIdle`,
   `toParsed`, `serializeRecording`, `deserializeRecording`. Same constants, same
   values:
   | Constant | Value | Meaning |
   |---|---|---|
   | `RECORDING_V` | 1 | checkpoint format version |
   | `MAX_ACC_M` | 100 | worse reported accuracy than this is noise, drop the fix |
   | `DRIVEN_MPS` | 15 | ~54 km/h — above this the car has been on track |
   | `IDLE_MPS` | 2 | brisk walking pace — "stationary" for trim and auto-stop |
   | `AUTO_STOP_IDLE_S` | 900 | stop after 15 min stationary *once driven* |
   | `MAX_DURATION_S` | 14400 | hard 4-hour cap |
   | `MAX_FIXES` | 20000 | |

   Same names means a human can diff the Swift against the JS and against the
   Kotlin (NS-12) by eye. That is the drift defense for logic no contract test
   covers.
2. **`addFix` validation order matters** — reproduce it exactly. Reject
   non-finite values, `|lat| > 90`, `|lon| > 180`, accuracy worse than
   `MAX_ACC_M`, negative relative time, non-monotonic time (`t <= last.t`), and
   the `MAX_FIXES` cap. Returns whether the fix was kept.
3. **Rounding is part of the format**, not cosmetic: `t` to 2dp, lat/lon to 6dp,
   speed to 2dp, accuracy to 1dp. It keeps the checkpoint ~50 bytes per fix. Match
   it, including the `Math.round(v * f) / f` semantics — note Swift's `rounded()`
   is half-away-from-zero while JS `Math.round` is half-**up** (`-0.5` → `-0` in
   JS, `-1` in Swift). Latitudes and speeds can be negative, so this matters.
   Write a test for it.
4. **`shouldAutoStop` has two independent triggers**, and the subtlety is
   load-bearing:
   - The hard `MAX_DURATION_S` cap, driven or not.
   - Stationary for `AUTO_STOP_IDLE_S` **but only once the car has exceeded
     `DRIVEN_MPS` at some point**. This is what stops a long grid wait from
     killing a recording before the session starts. Do not "simplify" it.
5. **`fixSpeeds`** uses the source's own speed when reported, else the
   displacement rate to the neighbouring fix, equirectangular
   (`kx = 111320 · cos(lat₀)`, `ky = 110540`) — the same approximation as
   `js/import/geo.js`. Keep the neighbour-window edge clamping.
6. **`toParsed`** returns the same shape a telemetry file parser returns —
   `{kind: "live", date, time, durationS, laps: [], gps, needsLine: true}` — so a
   finished recording flows into the identical review + line-picker path as an
   imported file (NS-17). Returns `nil` for fewer than 30 fixes after trimming or
   under 60 s duration. `date` is `yyyy-MM-dd` and `time` is `HH:mm` in **local
   time**, not UTC.
7. **Checkpoint (de)serialization.** The wire format is the tuple array
   `{v, eventId, startedAtMs, fixes: [[tRelS, lat, lon, v|null, acc|null]]}`.
   `deserializeRecording` must return `nil` — never throw — for anything
   implausible: wrong version, non-finite `startedAtMs`, malformed fixes. **A
   corrupt checkpoint must not crash launch.**
   - Keep the JSON tuple encoding rather than inventing a Swift-native one. It
     keeps the format debuggable and identical across all three clients.
8. **Model as a `struct` with value semantics**, and keep it `Sendable` — NS-15
   feeds it from a background location callback under Swift 6 strict concurrency.
9. **Port the tests.** Every case in `test/unit/record.test.js` becomes a Swift
   test with the same inputs and expectations. Where a JS test is thin, the
   grid-wait and forgot-to-stop cases in particular deserve extra coverage.

## Acceptance criteria

- [ ] All seven functions ported with matching names, constants, and behavior.
- [ ] Every `test/unit/record.test.js` case has a passing Swift equivalent.
- [ ] Negative-value rounding matches JS (explicit test).
- [ ] Grid-wait: 20 min stationary with no fix above `DRIVEN_MPS` does **not** auto-stop.
- [ ] Forgot-to-stop: driven above `DRIVEN_MPS`, then 15+ min stationary, **does** auto-stop.
- [ ] A corrupt/truncated/wrong-version checkpoint deserializes to `nil` without throwing.
- [ ] A checkpoint written by the **web app** deserializes correctly in Swift — cross-check with a real string from `localStorage`.
- [ ] `xcodebuild test -scheme TrackEvolutionKit` passes; no CoreLocation import.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

```sh
npx vitest run test/unit/record.test.js     # the reference suite still passes
xcodebuild test -project apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolutionKit
```

Generate a checkpoint JSON from the web app (record briefly in the browser, read
`localStorage["recording.pending"]`) and add it as a Swift test fixture.

## Notes

- Resist improving the algorithm during the port. If you find a genuine bug,
  raise it — it should be fixed in the JS **first**, so all three clients get it.
- `js/record/remote.js` (the CarPlay remote-control seam) is NS-19, not this spec.
  But read `test/unit/record-remote.test.js` for the rule it encodes: a remote
  start attaches to the event whose `start_date` + `days` cover today, and
  **never guesses further** — recording is on-device and must not depend on the
  network or a session.
