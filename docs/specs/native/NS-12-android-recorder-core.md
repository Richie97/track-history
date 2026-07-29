# NS-12 — RecorderCore port (Android)

**Phase:** 1 · **Platform:** Android · **Depends on:** NS-02 · **Estimate:** 2–3 days

## Goal

Port `public/js/record/core.js` to Kotlin in the pure-JVM `:core` module — no
Android location APIs, no UI — with its JS test cases ported alongside.

**Read `NS-11-ios-recorder-core.md` in full.** It is the same port, and it
documents the constants table, the `addFix` validation order, the two auto-stop
triggers, the rounding rules, the `toParsed` contract, and the checkpoint format.
None of that is repeated here. **The Swift and Kotlin ports must be
behaviorally identical**; diff them against each other as well as against the JS.

## Android-specific requirements

1. **Lives in `:core`** (pure Kotlin/JVM), so its tests run without an emulator.
   No `android.location.*`, no `Context`.
2. **Rounding.** Kotlin's `Math.round` is half-up for positive values but
   `kotlin.math.round` is half-to-even at `.5`. JS `Math.round` is half-up
   (toward `+∞`), so `-0.5` → `-0` in JS. Latitude, longitude, and the relative
   clock can all be negative or zero-crossing. Implement an explicit
   `jsRound(v, factor)` helper and test it against the JS behavior directly.
3. **Immutable data classes** with a `Recording` holding a `MutableList` of fix
   tuples, or an explicit builder — but the type crossing the service/UI boundary
   in NS-16 must be safe to hand between threads. Prefer immutable snapshots over
   shared mutable state.
4. **Fix tuples.** Keep the JSON array-of-arrays wire format
   (`[tRelS, lat, lon, v|null, acc|null]`) — do **not** promote it to a data class
   with named JSON fields. The format is shared with the web app and the iOS app
   and must stay byte-compatible.
5. **kotlinx.serialization** for the checkpoint, configured so a malformed
   document yields `null` rather than throwing. Wrap the decode in a
   `runCatching { }.getOrNull()`; a corrupt checkpoint must never crash launch.
6. **Port the tests** from `test/unit/record.test.js` as JVM unit tests, same
   inputs, same expectations.

## Acceptance criteria

- [ ] All seven functions ported with the names and constants from NS-11's table.
- [ ] Every `test/unit/record.test.js` case has a passing Kotlin equivalent.
- [ ] Negative and `.5` rounding matches JS exactly (explicit test).
- [ ] Grid-wait case does **not** auto-stop; forgot-to-stop case **does**.
- [ ] Corrupt/truncated/wrong-version checkpoint → `null`, no exception.
- [ ] A checkpoint written by the **web app** deserializes correctly.
- [ ] A checkpoint written by the **iOS** port deserializes correctly, and vice versa.
- [ ] `./gradlew :core:test` passes on the JVM; no `android.*` import.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

```sh
npx vitest run test/unit/record.test.js
cd apps/android && ./gradlew :core:test
```

Add the same web-generated `localStorage["recording.pending"]` string used in
NS-11 as a Kotlin test fixture, so all three implementations are pinned to one
real sample.

## Notes

- Do not improve the algorithm during the port. A genuine bug gets fixed in the JS
  first so all three clients inherit it.
- `js/record/remote.js` is NS-20's concern, not this spec.
