# NS-32 — Video telemetry import (Android)

**Phase:** post-rewrite · **Platform:** Android · **Depends on:** NS-14, NS-18,
NS-24, NS-26, NS-30

## Goal

Pick a video on the phone and get lap times out of it — what NS-30 built for
iOS, on Android. Same parsers, same fixture, same review screen.

## Why

NS-30's argument was never iOS-specific: a GoPro clip lands in the camera roll
over Wi-Fi and a Corvette PDR clip comes off the USB stick into Files, both on
the phone and usually before the laptop is opened. Until this, the Android app's
only answer to a video already sitting on the device was "go home and use a
browser", while the iPhone app imported it in place — the one feature the two
native clients disagreed on. `AGENTS.md`'s split rule ("everything else is on all
three and should stay that way") wanted this closed.

## Scope

| Piece | Web reference | iOS | Lands in |
|---|---|---|---|
| Random-access byte source | `Blob.slice().arrayBuffer()` | `ByteSource.swift` | `:core` `telemetry/ByteSource.kt` |
| MP4 box walk | `boxes`/`child`/`fourcc` (both parsers) | `MP4.swift` | `telemetry/MP4.kt` |
| Interpolating series | `series()` in `pdr.js` | `Series.swift` | `telemetry/Series.kt` |
| Corvette PDR parser | `pdr.js` | `PDR.swift` | `telemetry/PDR.kt` |
| GoPro GPMF parser | `js/import/gpmf.js` | `GPMF.swift` | `telemetry/GPMF.kt` |
| Per-lap channels | `js/import/channels.js` | `LapChannels.swift` | `telemetry/LapChannels.kt` |
| Lat + odometer lap recovery, batch anchoring | `js/import/pdr-laps.js` | `PDRLaps.swift` | `telemetry/PDRLaps.kt` |
| Dispatch + review maths | `parse.js`, non-DOM half of `ui.js` | `Telemetry.swift` | `telemetry/Telemetry.kt` |
| The parsed shape | the object every parser returns | `ParsedTelemetry.swift` | `telemetry/ParsedTelemetry.kt` |
| Picking the file | the dropzone | `App/Import/` | `app/.../videoimport/` |
| Review + save | `reviewResults` | the shared `ReviewScreen` | **the existing `RecordingFlow` + `ReviewScreen`**, generalised |

Everything in NS-30's stage 2 is included from the start — lap recovery, batch
anchoring, and a share-sheet route — because the Kotlin port had the Swift one
to follow and the fixture already covered them.

`.vbo` stays web-only, for the reason NS-30 gives.

## Requirements

1. **The video never leaves the device, and is never copied whole.** Both
   parsers read the MP4 index plus the telemetry track's own samples — a few MB
   for PDR, tens for a long GoPro `gpmd` track — against an essence one to two
   orders of magnitude larger that is never touched. On Android that is the
   *default* rather than something to engineer around: the Storage Access
   Framework, the photo picker and a share-sheet `ACTION_SEND` all hand back a
   `content://` URI, and `ContentResolver.openFileDescriptor` gives a real,
   seekable descriptor. `ContentByteSource` is positional reads on its
   `FileChannel` and nothing else. The one provider shape that *doesn't* work is
   a pipe, which surfaces as a per-clip error rather than a hang.

2. **`src/` does not change, and neither does `public/`.** No upload endpoint,
   no server-side parse.

3. **The parsers go in `:core` and stay Android-free.** They take a
   `TelemetryByteSource` — `val size: Long` plus
   `fun read(offset: Long, count: Int): ByteArray` — so `:core` knows nothing
   about `Uri` or `ContentResolver`, `checkNoAndroidDependency` still passes, and
   `:core:test` exercises them on the JVM against `ByteArraySource`.
   Cancellation reaches the parsers through the byte source (`read` throws
   `CancellationException` when the job dies), which is what lets the parsing
   code stay identical to the JS.

4. **Pinned against the JS, not eyeballed — and not against iOS.**
   `VideoContractTest` asserts equality with `contracts/logic/video-parsers.json`
   over the committed clips in `contracts/logic/video/`: lap times to the
   millisecond with their `estimated` flags, coordinates to 1e-9, metrics, every
   channel array element for element, the picked-line laps and the batch-anchored
   result. It is the *same* fixture `VideoContractTests` asserts against in the
   iOS Kit, so the two ports are checked against the web implementation rather
   than against each other.

5. **Ported names are the JS names.** `boxes`, `child`, `klvItems`,
   `parsePayload`, `gpsFromChannels`, `series`, `buildLapChannels`, `D_STEP_M`,
   `MAX_LAP_POINTS`, `MAX_LAPS`, `MAX_TOTAL_VALUES`, `UNIT_SCALE`,
   `latDistanceProfile`, `findLapLength`, `matchPhase`, `cutLapsAtDistance`,
   `recoverPdrLaps`, `anchorPdrBatch`, `applyGate`, `metricsSummary`,
   `estimatedNote`. The JS test cases port with them (`test/unit/pdr.test.js`,
   `gpmf.test.js`, `channels.test.js`, `pdr-laps.test.js`, `import-parse.test.js`,
   `import-ui.test.js` → `PDRTest`, `GPMFTest`, `LapChannelsTest`, `PDRLapsTest`,
   `TelemetryTest`), over the committed fixture clips where the JS built its
   input with `test/fixtures/build.mjs`.

6. **JS number semantics where they bite.** Raw channel values accumulate as
   `Long` (a JS number never wraps at 32 bits, and neither did Swift's `Int`);
   the 64-bit tick counter is assembled as `hi · 2^32 + lo` in a `Double`
   exactly as the JS does, so a corrupt high word compares as *larger* than
   `MAX_TICKS` rather than wrapping a signed `Long` negative; `Math.round` goes
   through `JsMath`; `Math.trunc((min + max) / 2)` is integer division, which
   also truncates toward zero. `Array.prototype.sort` is stable and so is
   `sortBy`.

7. **The review flow is not rebuilt.** `RecordingFlow` and `ReviewScreen`
   already did line picking, lap display, event selection and save for a
   recording. They are generalised from one `Recording` to a list of
   `ReviewItem`s over `ParsedTelemetry` (a `ParsedRecording` converts via
   `asTelemetry()`), exactly as NS-30 generalised iOS's `ReviewModel`. A PDR
   clip with beacons arrives with exact laps and skips the picker; a GoPro clip
   needs a line; one picked line applies to every clip in the batch in a shared
   projection frame, with the JS's longitude-sign mirroring; a clip that yielded
   nothing is listed by name with the parser's own message.

8. **Imported sessions carry channels, and so do recorded ones now.**
   `TelemetryChannels.buildLapChannels` exists natively, so the save posts the
   per-lap arrays NS-24 draws — and a *recorded* session, which used to post
   `channels: null`, gets speed on the distance grid from the phone's own fixes.
   A source that yields none still posts `null`, never a half-formed shape,
   because `sanitizeChannels` rejects one with a 400.

9. **Named failures, not a spinner that stops.** "No PDR or GoPro telemetry in
   this video", "No GPS data in this video (was GPS enabled on the camera?)",
   and "Couldn't read this video: …" for a provider that won't serve a file,
   each per clip in the review. Cancel stops the read at the next sample.

## Design notes

### Picking the file

Two doors, both no-copy, plus a share target:

| Route | Random access? | Notes |
|---|---|---|
| `OpenMultipleDocuments` (`video/mp4`, `video/quicktime`, `video/*`) | **yes** | Files, Downloads, the USB stick, and every photo app that publishes a documents provider — Google Photos included. The primary path. |
| `PickMultipleVisualMedia(VideoOnly)` | **yes** | The photo picker, for the camera roll on phones where the document picker doesn't surface it. Same `content://` URIs. |
| `ACTION_SEND` / `ACTION_SEND_MULTIPLE` for `video/*` | **yes** | "Share to Track Evolution" from Files, Photos or the camera app. `MainActivity.sharedVideos` parks the URIs the way deep links are parked, and the signed-in scaffold opens the chooser on them. The read grant travels with the task, which is one more reason the activity is `singleTask`. |

Neither picker needs a permission prompt — the URI grant *is* the permission —
which is the one place this is simpler than iOS.

Multiple selection is on from the start: a session is often several clips, and
the batch is what lets a beacon-timed PDR recording re-anchor a beacon-less one
beside it (`TelemetryImporter.finish` sorts by the clock the file wrote, runs
`anchorPdrBatch`, and re-cuts channels for anything whose laps moved).

### Running the parse

On `Dispatchers.IO`, in one job held by `ImportModel` (scoped to the chooser's
back stack entry through `rememberScreenModel`, so a rotation mid-parse neither
restarts nor loses it). Memory is bounded by the decoded channels, not the file.

### The hand-off

`ImportScreen` is only the chooser, on `Route.Import(eventId)`. Once the clips
are parsed, the scaffold does what it does when a recording stops: hands them to
`RecordingFlow.beginImport`, raises the review overlay, and pops the chooser
underneath it — so backing out of the review lands on the event page. A saved
import navigates to a *fresh* `Route.Event` for the event it came from, which is
what makes the page re-fetch and show the new sessions; a saved recording keeps
landing on the dashboard as before.

### What is genuinely hard

Nothing that wasn't already hard for iOS, and the Swift port was there to follow
where the JS's dynamic typing hides a decision — the bucket precedence for a
duplicated channel id, the `Math.floor(NaN)` window, the zero lag in
`findLapLength`. The pinned fixture said whether each call was right.

## Acceptance criteria

- [x] Kotlin reproduces `contracts/logic/video-parsers.json` exactly over every
      committed clip: PDR lap times to the millisecond, `estimated` flags
      included; GPS to 1e-9; `metrics`; `lapChannels` element for element; the
      picked-line laps, gate and best-lap trace; the batch-anchored result.
- [x] Every ported JS unit test has a Kotlin counterpart with the same inputs.
- [x] `:core`'s telemetry code has no Android dependency and
      `./gradlew :core:test` runs it with no SDK.
- [x] Importing a beacon-carrying PDR clip produces laps without showing the line
      picker at all; a GoPro clip goes to the picker and one pick times every
      waiting clip in the batch (`RecordingFlowImportTest`).
- [x] The saved session carries laps, the best-lap trace, channels and the web
      importer's exact notes line; a recorded session now carries channels too
      (`RecordingFlowImportTest`).
- [x] The video is read in place through a real `ContentResolver` descriptor,
      clamps at end of file, and stops at the next read when cancelled
      (`ContentByteSourceTest`).
- [x] A clip with no telemetry track and an unreadable URI each end in a stated
      outcome, per clip, without failing the batch.
- [x] `README.md`, `site/`, `docs/specs/native/README.md` and `AGENTS.md` stop
      saying video import is iOS-only.

## Out of scope, still deferred

`.vbo` import, the setup notebook, the setup-vs-lap-times diff, year in review,
the two-event compare. Video import graduating on a second platform does not
graduate the rest of the long tail.
