# NS-55 — Import laps from an AiM SmartyCam video

**Phase:** post-rewrite · **Platform:** Web + iOS + Android (no server change) · **Depends on:** the video importers (NS-30, NS-32), [NS-45](NS-45-best-lap-clips.md) / [NS-47](NS-47-web-clip-upload.md) / [NS-50](NS-50-every-lap-clips.md) (clips), [NS-53](NS-53-track-map-on-maps.md) (the trace anchor) · **Estimate:** four PRs · **Issue:** not opened yet · **Status:** specced, not built

## Goal

A driver with an AiM SmartyCam drops the camera's `.MOV` into the importer and
gets what a PDR owner gets: the session's laps with the logger's own lap
times, the racing line, speed / RPM / throttle / gear traces, and a best-lap
(or every-lap) video clip. Nothing is uploaded but the clip, as with every
other video source.

This is **SmartyCam video only**. AiM logger files (`.xrk`, `.xrz`, `.drk`)
and Race Studio CSV exports are a separate piece of work with no samples yet;
see *Follow-ups*.

## What the file is

Reverse-engineered on 2026-11-21 from one SD card: 129 readable recordings
from one SmartyCam GP HD (firmware 01.03.30), wired as a slave to an AiM
logger, over 29 track days at six tracks. 441 laps decode. **One camera, one
car, one configuration** — that limit shapes several decisions below.

**Container.** QuickTime (`ftyp qt  `), `moov` after `mdat`. Three tracks:

| Track | Handler | Entry | What it is |
|---|---|---|---|
| 1 | `vide` | `avc1` 1280×720, 30 fps (`stts` 100 / 3000) | the picture, overlay burned in |
| 2 | `soun` | `sowt`, 48 kHz 16-bit mono | the sound: **PCM, not AAC** |
| 3 | `free` ("TmcdHandler") | `sowt`, declared as 48 kHz audio | **the telemetry** |

After `moov` comes a `free` box holding `<aim_meta_data>` XML. Its size field
is wrong (it claims hundreds of megabytes); read from its body to the end of
the file. It carries `track_name`, `track_lat0` / `track_lon0` (×1e7), `date`
(`dd/mm/yyyy`), `hour` (`HH:MM.SS`, the camera's local clock), `nlap`, `best`,
`vehicle_name`, `racer_name`, `championship` and hardware details.

**The telemetry track.** One chunk per **five video frames** (6 Hz), 16,000
bytes each on the real camera. Only the first 124 bytes are a record; the rest
is noise. Little-endian:

| Offset | Type | Field |
|---|---|---|
| 0 | u32 | video frame index (0, 5, 10, …) |
| 8 | i32 | logger clock, ms |
| 16, 24 | i32 | latitude, longitude ×1e7 — updates at ~2 Hz and trails the ECEF fix by up to 45 m; **not used** |
| 32 | i32 | completed-lap counter |
| 40 | i32 | time of the lap just completed, ms (10 ms resolution) |
| 48 | i32 | GPS time of week, ms |
| 60, 64, 68 | i32 | ECEF position X, Y, Z, cm — fresh in every record |
| 76, 80, 84 | i32 | ECEF velocity, cm/s |
| 104 | i32 | RPM |
| 108 | i32 | throttle, % |
| 112 | f32 | a configurable channel (longitudinal G in 2025–26 files, a constant −21 in 2024 files) — **not read** |
| 120 | i32 | gear |
| 72, 88, bytes 92 and 95 | | four slow channels nobody has identified — **not read** |

`-12290` in any car field means *no value*. Offsets 4, 12, 20, 28, 36, 44 and
100 never changed in any sample and are ignored.

## Three traps

1. **The camera drops frames, so video time is not real time.** Every file
   loses about 3 s at the start, and 37 of 80 full sessions lose more than 1 %
   after that (median 0.9 %, worst 3.2 %). A 128 s lap can be 125 s of video.
   The frame index says where a record is **in the video**; the logger clock
   and the lap counter say what time it **was**.
2. **The lap counter trails the crossing by one record.** At 14 of 17
   boundaries checked against the start/finish point, the car was closest to
   the line one record (about 170 ms) before the counter stepped.
3. **The XML's `nlap` and `best` are the logger's running totals for the day**,
   not this file's. Never read laps from the XML.

## Fixed decisions

| | |
|---|---|
| Kind | **`kind: "smartycam"`**, `KIND_LABELS.smartycam = "SmartyCam"`. It doesn't reuse `"pdr"`: the lap rule, the clock and the audio all differ. |
| File type | `SUPPORTED_EXT` gains `mov`. `.mp4` and `.mov` both run the same video chain: Marlin PDR, PDR 2.5, **SmartyCam**, then GoPro. Each parser still throws *"No … telemetry track"* when the file isn't its own. |
| Detection | A track whose `hdlr` subtype is `free`, whose sample entry is `sowt`, and whose chunks are at least `RECORD_BYTES` (124) long. **Chunk offsets and length come from `stco` / `co64` and `stsc`, never a hard-coded 16,000**, so a fixture can use 136-byte chunks. |
| The parser's clock | **`t` is video time: `frame / fps`**, with `fps` from the picture track's `stts`. `gps[].t`, every car series and each lap's `startT` / `endT` are video seconds, and `durationS` is the video's. This is the one decision everything else leans on: `clipWindow`, `estimateClipBytes`, the cutters and the lap page's `lap_offset_ms` then work unchanged. |
| Lap times | **The logger's own**, from offset 40. Never `endT − startT`, which is video time and short by the dropped frames. |
| Which laps | A lap needs **both** boundaries in the file. For two consecutive counter steps, to `c` at record `i` and to `c + 1` at record `j`: `{ timeMs: m[j], startT: t[i − 1], endT: t[j − 1], estimated: false }` (`LAP_LATENCY_RECORDS = 1`, trap 2). The first step in a file closes a lap with no start in the video — the out-lap, whose time is measured from when the logger started — and is dropped. So is a lap across a counter that jumps by more than one or goes backwards. |
| Sanity check | A lap is dropped when the logger clock's elapsed time between its boundaries differs from `timeMs` by more than `LAP_CLOCK_TOLERANCE_MS` (1500). Measured agreement is within 250 ms. |
| No line picker | `needsLine` is always false. A file with no complete lap is the importer's ordinary *no laps* result. A picked line would time laps on the video clock and be up to 3 % fast with nothing to say so. |
| Position | ECEF → WGS-84 latitude / longitude (`ecefToGeodetic`, five fixed-point iterations — fixed so the three ports agree to the last digit). A record whose ECEF is all zero or `-1` is skipped. |
| Speed | The magnitude of the ECEF velocity, m/s, as `gps[].v`. |
| Car channels | `carChannels`: `rpm`, `throttle` (clamped 0–100), `gear` (already in `STEP_HOLD`). 6 Hz clears the 5 Hz bar for a gridded trace. No brake, steering, lateral or longitudinal G, no scalars, no `sessionMeta`. |
| Plausibility, per channel | The meaning of offsets 104 / 108 / 120 is confirmed on **one** camera configuration. So each is kept only if it looks like what it claims over the whole file: RPM peaks between 1,000 and 20,000; throttle stays within 0–100 and moves by at least 30; gear is whole numbers 0–8. **A channel that fails is dropped; the import never fails on it.** |
| Metrics | `metrics.topSpeed` and `metrics.maxRpm`, as PDR's. No lateral G. |
| Date and time | The XML's `date` and `hour`, reformatted to the importer's shape. Without the XML, the `mvhd` creation time. |
| Trace and anchor | `bestLapTrace` from `lapTrace(projectTrace(gps), best.startT, best.endT)`; `traceGeo` from `traceOrigin(gps)`. |
| Personal data | `racer_name`, `vehicle_name`, `championship` and the hardware serials are **not read into the parsed result**. `track_name` isn't either: the event already names its track. |
| Clips | `VIDEO_KINDS` and `EVERY_LAP_KINDS` both gain `"smartycam"`: every lap the rule above keeps is a full, logger-timed lap, which is why PDR qualified. |
| Clip sound | **SmartyCam clips are silent in this spec, on all three clients.** MP4 can't carry `sowt`, and a clip is an `.mp4`. Each cutter keeps the picture and takes no sound from a track that isn't AAC; none may fail on one. The `free`-handler track is never picked as anything. Encoding the PCM to AAC is a follow-up. |
| Interrupted recordings | A `.MOV` with no `moov` (the camera leaves a `.FOF` beside it) is *"This recording wasn't finished by the camera and can't be read."* Rebuilding it from the `.FOF` is not attempted. |
| Tier | Unchanged. Import is free; speed and throttle are free channels, RPM and gear are Pro, as from any source. No new gate. |
| Server | **No change.** `sanitizeChannels` already accepts every channel sent. |

## The parser (`public/js/import/smartycam.js`)

Reads through `mp4.js` (`readMoov`, `boxes`, `child`), like the other three
MP4 readers. It reads the `moov`, then 124 bytes at each chunk offset — about
0.8 MB for a 19-minute session, in batched range reads rather than one per
record — and the last 4 KB for the XML.

```js
export const RECORD_BYTES = 124;
export const NO_VALUE = -12290;
export const LAP_LATENCY_RECORDS = 1;
export const LAP_CLOCK_TOLERANCE_MS = 1500;

export function ecefToGeodetic(xM, yM, zM)        // → { lat, lon } degrees
export function readRecord(dv, offset)            // one 124-byte record → fields, NO_VALUE as null
export function lapsFromCounter(records)          // the "Which laps" rule
export function plausibleChannels(records)        // → { rpm, throttle, gear } booleans
export function parseAimMeta(text)                // the XML → { date, time } only
export async function parseSmartyCamFile(file)    // → the parsed shape below
```

```js
{
  kind: "smartycam", date, time, durationS,       // durationS = the video's
  laps: [{ timeMs, startT, endT, estimated: false }],
  gps: [{ t, lat, lon, v }],                      // t = video seconds
  carChannels: { rpm, throttle, gear },           // each [{ t, v }] or absent
  metrics: { topSpeed, maxRpm },
  bestLapTrace, traceGeo, needsLine: false,
}
```

`parse.js` calls it between the PDR pair and GoPro and passes the result
through `attachLapChannels`, which already reads `carChannels` for any kind
that sets it.

`ui.js`: `estimatedNote` needs no branch (no lap is estimated), and the notes
line is the standard *Imported from <file>*.

## Clips

- `clip.js`: the two kinds lists. `clipOfferText` and friends are unchanged.
  `everyLapOfferText` says *"each PDR session"*; reword it to *"each session"*
  so it is true of both kinds, and regenerate `lap-clips.json`.
- `mp4cut.js`: `pickTracks` already takes only `mp4a` sound and only a `vide`
  handler, so a SmartyCam file cuts as picture-only. Add the case to
  `mp4cut.test.js`, and make sure the box walk tolerates the trailing `free`
  box's bad size.
- iOS `ClipCutter`: a passthrough export of LPCM to `.mp4` fails, so the
  composition must leave the sound out when the audio track isn't AAC. Verify
  the `free`-handler track isn't offered by AVFoundation as audio.
- Android `ClipCutter.pickTracks`: take an audio track only when its MIME is
  AAC (`MediaMuxer` rejects `audio/raw`). Verify `MediaExtractor` opens the
  QuickTime brand; `ClipTrackPickTest` gains the case.

## Ports

`SmartyCam.swift` in the Kit's `Telemetry/` and `SmartyCam.kt` in `:core`'s
`telemetry/`, under the JS names, reading through `TelemetryByteSource`, with
the JS test cases. Both dispatches gain the step in the same place. Both
`LapClips` ports take the two list changes.

- iOS: `ImportScreen` already allows `.quickTimeMovie`. Check the drop target
  and the debug fixture launcher accept `.mov`.
- Android: the SAF picker and the `video/*` share filter already admit
  `video/quicktime`. `ContentByteSource.nameForType` should give a bare shared
  name typed `video/quicktime` a `.mov`, as it does `.csv`.

## Fixtures and tests

Footage is never committed. `buildSmartyCamMov` in `test/fixtures/build.mjs`
writes a synthetic file: a token `avc1` track with a real `stts`, a `sowt`
sound track, the `free`-handler track with **136-byte chunks**, and the
trailing XML in a `free` box with a wrong size.

- `smartycam-laps.mov` — counter from 0 through four steps, so three laps;
  a run of dropped frames inside one lap (logger clock jumps, frame index
  doesn't); stale ×1e7 coordinates that disagree with the ECEF, to prove they
  aren't read; `NO_VALUE` in the car fields for a stretch.
- `smartycam-midsession.mov` — starts at counter 3, then the counter resets
  (a second logger run in one file); a gear field holding values over 8, so
  the gear channel is dropped and the rest imports.

Both go in `contracts/logic/video/` and `video-parsers.json`, which the Kit's
and `:core`'s `VideoContractTest`s already iterate. Unit tests in
`test/unit/smartycam.test.js`: each exported function, the interrupted file,
and a file that is somebody else's `.mov`.

Real-footage checks, run by hand against `telemetry-samples/aim/` and recorded
in the PR: all 129 files parse on each client, lap times equal the camera's
own log lines, and a best-lap clip from a session with dropped frames starts
on the line.

## Docs owed (in the same PRs)

`README.md` (import sources); `site/docs/telemetry-import.html` (the source,
what it carries, the silent clip); `site/docs/track-days.html`'s recording
table (AiM is likely among "the ones the importer can't read" today);
`site/docs/brake-throttle-traces.html` (which sources carry which channels);
`site/llms.txt` and the landing page's telemetry sources and FAQ;
`AGENTS.md` (the `smartycam.js` bullet, the three traps); this directory's
`README.md`. The site says *AiM SmartyCam*, never just *AiM*, until logger
files are read.

## Tickets

1. **Web parser** — `smartycam.js`, the dispatch, fixtures, `video-parsers.json`, docs.
2. **iOS port** — `SmartyCam.swift`, dispatch, contract test.
3. **Android port** — `SmartyCam.kt`, dispatch, contract test, the `.mov` name rule.
4. **Clips** — the kinds lists on all three, the three cutters' no-PCM rule, the reworded offer text.

## Acceptance criteria

- A SmartyCam `.MOV` imports on the web, iOS and Android with identical laps, trace and channels (the contract fixtures).
- Lap times are the logger's to the 10 ms; the out-lap and any lap missing a boundary are absent.
- A file with dropped frames produces a clip whose `lap_offset_ms` lands on the crossing within 0.3 s.
- A file whose car fields fail plausibility still imports, with speed alone.
- No name, serial or championship from the XML reaches a request body.
- A PDR, PDR 2.5 or GoPro file imports exactly as before.

## Open questions

- **Are offsets 104 / 108 / 120 fixed, or the overlay's configurable slots?** One configuration can't say. The plausibility rule makes a wrong guess cost a channel rather than a bad chart, but a second owner's file is the real answer.
- **Does a standalone SmartyCam (no logger) fill the lap counter?** Unseen. If it doesn't, such files import no laps under this spec.
- **SmartyCam 3 and other firmware.** Unseen; detection will simply not match if the layout differs.

## Follow-ups, deliberately not here

- **The lap stage drifts on dropped-frame footage.** NS-51 maps video time to a place on the lap through `lapTimeSeries`, which is real time. On a lap that lost 3 s of frames the charts trail the video by up to 3 s at the lap's end. The fix is a stored per-lap video-time curve that `makeSide` already has a parameter for; it needs a new gridded channel and so a server change.
- **AAC sound for SmartyCam clips.** Silent was accepted for the first release (2026-11-21). Sound means an AAC encode on each client (WebCodecs on the web, which Firefox lacks).
- **AiM logger data** — Race Studio 3 CSV first, `.xrk` after. Needs sample exports, ideally of sessions on this same card, which would also name the four unidentified channels and the float at offset 112.
- **Rebuilding an interrupted recording from its `.FOF`.**
