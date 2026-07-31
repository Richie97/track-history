# NS-30 — Video telemetry import (iOS)

**Phase:** 2 · **Platform:** iOS · **Depends on:** NS-13, NS-17, NS-23, NS-25 ·
**Estimate:** 1.5 weeks (stage 1), +0.5 week (stage 2)

## Goal

Pick a video on the phone and get lap times out of it — what the web app's
**Import video / telemetry…** does, on the device that already has the footage.

## Why this comes off the deferred list

The product split (`README.md` in this directory) sends the desk-bound long tail
to the web, and **all telemetry file import** was named as part of it. That call
was right about the *shape* of import and wrong about one of its inputs.

A `.vbo` is desk-bound: a VBOX writes to an SD card that gets read on a laptop,
and the file lands next to a browser. Video does not arrive that way. A GoPro
clip comes over Wi-Fi into **Photos** via the Quik app; a Corvette PDR clip comes
off the USB stick into **Files**. Both are already on the phone, usually before
the laptop is opened, and today the only thing the app can say about a video
sitting in the camera roll is "go home and use a browser."

So the revision is narrow and deliberate, not a reopening of the split:

| | Ported to native | Stays web-only |
|---|---|---|
| `public/pdr.js` | ✅ | |
| `public/js/import/gpmf.js` | ✅ | |
| `public/js/import/channels.js` | ✅ | |
| `public/js/import/pdr-laps.js` | ✅ (stage 2) | |
| `public/js/import/vbo.js` | | ✅ — a VBOX file has no reason to be on a phone |
| `public/js/import/geo.js` | already ported (NS-13) | |

This directory's README says the telemetry parsers "are never ported. That is the
design, not a gap." That sentence is amended by this spec, for video only, and
the README is updated in the same change — per its own rule about changing a
decision deliberately rather than quietly dropping it.

## Scope

### Stage 1 — the ask

| Piece | Web reference | Lands in |
|---|---|---|
| Random-access byte source | `Blob.slice().arrayBuffer()` | `Kit/Telemetry/ByteSource.swift` |
| GoPro GPMF parser | `js/import/gpmf.js` | `Kit/Telemetry/GPMF.swift` |
| Corvette PDR parser | `pdr.js` | `Kit/Telemetry/PDR.swift` |
| Interpolating series | `series()` in `pdr.js` | `Kit/Telemetry/Series.swift` |
| Per-lap channels | `js/import/channels.js` | `Kit/Telemetry/LapChannels.swift` |
| File / photo picking | the dropzone | `App/Import/TelemetryPicker.swift` |
| Review + save | `reviewResults` in `js/import/ui.js` | **the existing `ReviewScreen`** |

### Stage 2 — the tail

- `pdr-laps.js`: lap recovery from latitude + odometer periodicity, for PDR
  recordings that have neither beacons nor decodable GPS.
- `anchorPdrBatch`: phase-anchoring a recovered recording against a beacon-timed
  one in the same multi-file selection.
- A share-sheet / "Open with" route (`CFBundleDocumentTypes` +
  `LSSupportsOpeningDocumentsInPlace`) so Files and the GoPro app can send a clip
  straight into the app.

## Requirements

1. **The video never leaves the device, and is never copied whole.** This is the
   same promise the web app makes (README, `site/docs/telemetry-import.html`) and
   it is load-bearing twice over on a phone: uploading is out of the question on
   track-day cellular, and a temp copy of a 4 GB clip will not reliably fit in the
   sandbox. Both parsers read only the MP4 index plus the telemetry track's own
   samples — a few MB for PDR, tens of MB for a long GoPro `gpmd` track, against
   an essence one to two orders of magnitude larger that is never touched.
   *Anything that needs the whole file on disk first is the wrong design here.*

2. **`src/` does not change, and neither does `public/`.** No upload endpoint, no
   server-side parse. The programme's fixed decisions stand.

3. **The parsers go in the Kit and stay UIKit-free.** They take a
   `TelemetryByteSource` — `func read(at: Int, count: Int) throws -> Data` plus
   `var size: Int` — so the Kit knows nothing about `URL`, Photos, or security
   scopes, and `swift test` exercises them on macOS against an in-memory
   implementation. The app supplies a `FileHandle`-backed one.

4. **Pinned against the JS, not eyeballed.** `contracts/logic.mjs` gains a
   `video-parsers` fixture: the synthetic MP4s from `test/fixtures/build.mjs`
   (`buildGpmfMp4`, `buildPdrMp4`, `buildPdrDeltaMp4`, `buildPdrRealMp4` — 20–50
   KB each, committed as binaries under `contracts/logic/video/`) plus the JS
   parsers' output over them, committed as JSON. Swift asserts equality: lap
   times to the millisecond, coordinates to 1e-9, channel arrays element for
   element. Reimplementing the fixture generator in Swift would only prove the two
   ports agree with each other.

5. **Ported names are the JS names.** `boxes`, `child`, `klvItems`, `parsePayload`,
   `gpsFromChannels`, `series`, `buildLapChannels`, `D_STEP_M`, `MAX_LAP_POINTS`,
   `MAX_LAPS`, `MAX_TOTAL_VALUES`, `UNIT_SCALE`. The JS test cases
   (`test/unit/pdr.test.js`, `gpmf.test.js`, `channels.test.js`) port with them.

6. **JS number semantics where they bite.** The PDR decoder is sign-extension and
   running state: a 6-bit signed channel delta, a 24-bit signed value delta, a
   64-bit tick counter assembled as `hi * 2^32 + lo`, and a `MAX_TICKS` clamp that
   keeps a corrupt timestamp from poisoning the stream. `Math.round` is half-up,
   `Int()` truncates toward zero, and `Math.trunc((min + max) / 2)` seeds a channel
   with no full record — route all of it through the Kit's existing `JSMath` rather
   than reaching for `rounded()`.

7. **The review flow is not rebuilt.** `ReviewScreen` + `LinePickerView` already
   do line picking, lap display, event selection and save — because the web app
   funnels recordings and imports into one `reviewResults`, and NS-17 ported the
   recording half. Generalise `ReviewModel`'s input from `ParsedRecording` to a
   `ParsedTelemetry` value (`kind`, `date`, `time`, `durationS`, `laps`, `gps`,
   `needsLine`, `metrics`, `lapChannels`) that both sources produce, and keep the
   recorder-specific checkpoint/discard behaviour behind an optional. A PDR file
   with beacons arrives with exact laps and skips the picker entirely; GoPro
   always needs a line.

8. **Imported sessions carry channels.** NS-23 already draws the lap overlay, and
   `sessions.channels` is written only by the web importer today. Without
   `buildLapChannels` ported, a clip imported on the phone yields a visibly poorer
   session than the same clip imported at a desk — so channels are stage 1, not a
   follow-up. The shape is validated server-side by `sanitizeChannels`; an
   outsized session stores no channels rather than failing the save, exactly as
   the JS does.

9. **Named failures, not a spinner that stops.** "No PDR or GoPro telemetry in
   this video" (neither parser recognised it), "No GPS data in this video (was GPS
   enabled on the camera?)", the iCloud-not-downloaded case, and the
   not-URL-backed case each get the web app's wording where one exists.

## Design notes

### Picking the file

Three routes, and only the first two are worth building:

| Route | Random access? | Cost |
|---|---|---|
| `.fileImporter` → security-scoped `URL` → `FileHandle` | **yes** | none — the primary path |
| PHPicker with `photoLibrary:` → `PHAsset` → `requestAVAsset` → `AVURLAsset.url` | **yes**, for local assets | one Photos read permission |
| `PhotosPicker` → `loadTransferable` / `loadFileRepresentation` | no | **copies the entire clip** — do not use |

The third is the obvious SwiftUI reach and it is the trap: `loadTransferable`
materialises a full temp copy before handing anything back, which for track
footage means minutes of waiting and gigabytes of scratch space for a file we
intend to read 20 MB of. Getting a `PHAsset` instead requires
`PHPickerConfiguration(photoLibrary: .shared())` so results carry an
`assetIdentifier`, which in turn requires `PHPhotoLibrary` read authorisation and
an `NSPhotoLibraryUsageDescription` in `Info.plist` — that permission prompt is
the price of not copying, and it is worth paying.

Two Photos cases fall back with a message rather than a hang: an asset whose
video is iCloud-only (`requestAVAsset` needs `isNetworkAccessAllowed` and then
downloads the whole thing — offer it, don't do it silently), and one that isn't
`AVURLAsset` at all (slo-mo and edited clips come back as `AVComposition`; they
have no telemetry track anyway). From Files, an undownloaded iCloud Drive item
needs `startDownloadingUbiquitousItem` first.

Multiple selection is on from the start (`allowsMultipleSelection: true`) — a
session is often several clips, and stage 2's batch anchoring needs the batch.

### Running the parse

Off the main actor, in one `Task`, with the `FileHandle` confined to it — a
`FileHandle` is not `Sendable` and the parse is a single sequential walk, so
there is nothing to share. Budget a few seconds; long enough to want a progress
line, short enough not to need a `BGProcessingTask`. Cancellation matters: a user
who picked the wrong 4 GB clip should be able to back out, so check
`Task.isCancelled` between samples.

Memory is bounded by the decoded channels, not the file: a 30-minute PDR
recording at ~11 Hz across six channels is on the order of a million points.
Store them as `[Double]` in parallel arrays rather than arrays of structs.

### What is genuinely hard

The PDR sample decoder, and nothing else. Everything in `gpmf.js` is
well-documented KLV over standard MP4 sample tables. `pdr.js` is
reverse-engineered against real footage and its comment block is the only
specification that exists — the delta framing, the `mrld` dictionary layout, the
beacon-plus-odometer crossing reconstruction with its GPS-latitude sanity check.
Port it line for line, resist restructuring it, and let the pinned fixtures say
whether the port is right. `buildPdrDeltaMp4` and `buildPdrRealMp4` exist
precisely because that decoder needed fixtures with real delta framing.

## Acceptance criteria

- [x] `contracts/logic/video/` holds the committed fixture MP4s and
      `contracts/logic/video-parsers.json` the JS parsers' output over them;
      `npm run contracts:check` is clean on a fresh regenerate.
- [x] Swift reproduces that output exactly: PDR lap times to the millisecond,
      `estimated` flags included; GPS to 1e-9; `metrics`; `lapChannels` element
      for element.
- [x] Every ported JS unit test has a Swift counterpart with the same inputs.
- [x] The Kit's telemetry code imports neither UIKit, SwiftUI, Photos nor
      AVFoundation, and `swift test` runs it with no simulator.
- [x] Importing a GoPro clip from Files produces a session whose laps match the
      web app's for the same file and the same picked line.
- [x] Importing a beacon-carrying PDR clip produces laps without showing the line
      picker at all.
- [x] A multi-GB clip is imported without a temp copy — measured rather than
      watched: a 671 MB PDR recording parses by reading **7.8 MB (1.16%) in 59
      reads**, in about a second, through a `FileHandle` that never copies. The two
      other real recordings on hand read 1.11% and 0.77%.
- [x] An imported session's lap overlay (NS-23) renders from channels the phone
      wrote.
- [x] A video with no telemetry track, an iCloud-only asset, and a cancelled
      import each end in a stated outcome. The first is unit-tested
      (`PDRTests.DispatchTests`) and surfaced per clip in the review; the other two
      are `PickerFailure.notDownloaded` / the cancel button, which the simulator
      can't stage — they are reachable only with a real iCloud-only asset.
- [x] A UI test imports a fixture clip end to end and deletes the session it made.
- [x] `README.md`, `site/docs/telemetry-import.html` and this directory's README
      stop saying import is browser-only; `AGENTS.md` gains the new Kit directory.

## Out of scope, still deferred

`.vbo` import, the setup notebook, the setup-vs-lap-times diff, year in review,
compare. Video import graduating does not graduate the rest of the long tail.

## Notes for whoever ports this to Android (NS-31?)

The parsers are the portable half and the fixtures are already cross-language —
Kotlin asserts against the same `contracts/logic/video-parsers.json`. The picking
half does not transfer at all: Android's Storage Access Framework hands back a
`content://` URI, and `ContentResolver.openFileDescriptor` gives a real seekable
fd, so the no-copy path is the *default* there rather than something to engineer
around. The `ByteSource` seam is what makes that a swap of one file.
