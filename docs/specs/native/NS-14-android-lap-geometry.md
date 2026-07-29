# NS-14 — Lap geometry port (Android)

**Phase:** 1 · **Platform:** Android · **Depends on:** NS-02 · **Estimate:** 2–3 days

## Goal

Port `public/js/import/geo.js` to Kotlin in the pure-JVM `:core` module.

**Read `NS-13-ios-lap-geometry.md` in full.** It explains why this one file is
ported when the rest of the telemetry import stays on the web, and it documents
every function's contract — the heading-window widening, the interpolated
crossing time, the direction filter, `minGapS`, the `[30 s, 3600 s]` lap window,
and the `estimated` flag. None of that is repeated here.

**The Swift and Kotlin ports must produce identical output.** Diff them against
each other as well as against the JS.

## Android-specific requirements

1. **Lives in `:core`** — pure Kotlin/JVM, no `android.location.*`, tests run on
   the JVM without an emulator.
2. **Rounding.** `timeMs` is a rounded integer millisecond value and the trace
   polyline rounds coordinates to 1dp and speed to 2dp. Reuse the `jsRound` helper
   from NS-12 rather than `kotlin.math.round` — the half-to-even difference will
   otherwise produce off-by-one-millisecond lap times against the JS.
3. **Doubles throughout** for the projection and intersection maths. Do not use
   `Float`; the projection works in metres over kilometre-scale traces and `Float`
   precision will visibly distort a gate.
4. **Port the tests** from `test/unit/geo.test.js` as JVM unit tests.

## Acceptance criteria

- [ ] All eight functions ported with matching names and defaults.
- [ ] Every `test/unit/geo.test.js` case has a passing Kotlin equivalent.
- [ ] `buildGate` returns `null` for a stationary pick, succeeds for a slow-corner pick.
- [ ] Direction filtering, `minGapS` jitter suppression, and the lap-length window all verified.
- [ ] Given the same trace and picked index, Kotlin lap times match the **JS and the Swift port** to the millisecond, using the shared fixture from NS-13.
- [ ] `./gradlew :core:test` passes on the JVM; no `android.*` import.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

```sh
npx vitest run test/unit/geo.test.js
cd apps/android && ./gradlew :core:test
```

Use the same exported real-trace fixture as NS-13 so all three implementations
are pinned to one sample.

## Notes

- `js/import/channels.js` is not in scope; see NS-13's note.
- `lapTrace` output is rendered by NS-24's trackmap.
