# Garmin Catalyst import — deep dive

Status: **research / proposal** (2026-09). Nothing here is built yet.

How Track Evolution could take sessions recorded on a Garmin Catalyst or
Catalyst 2, what the device actually hands over, where it fits in the existing
import pipeline, and what has to be verified with a real file first.

## TL;DR

- The Catalyst writes sessions as **Garmin FIT files**, a public binary format.
  Video goes into separate MP4s. Neither model reads the car's OBD-II port, so
  there is **no rpm, throttle, brake or steering**. You get position, speed and
  the device's own IMU (accelerometer and gyro).
- The best route is a **new `.fit` parser in the web importer**
  (`public/js/import/fit.js` + `catalyst.js`). It returns the same
  `{kind, date, time, durationS, laps, gps, needsLine}` shape as every other
  parser, so the review screen, line picker, channel builder, storage and
  leaderboard eligibility all work unchanged. **`src/` does not change.**
- Write the FIT decoder by hand, the way `gpmf.js` and `pdr.js` were. Don't ship
  Garmin's SDK: its license forbids redistributing it, sending its source to
  every browser is redistribution, and the repo has no build step or runtime
  dependencies anyway.
- **What blocks us is not code, it's a sample file.** Which FIT messages the
  Catalyst uses for its 10 Hz and 25 Hz data, and whether its laps come out as
  `lap` or `segment_lap` messages, is not publicly documented. One real session
  from each model in the gitignored `telemetry-samples/` settles it.

## What the device produces

| | Catalyst (2020) | Catalyst 2 (Feb 2026) |
|---|---|---|
| Positioning | 10 Hz multi-GNSS, fused with IMU | **25 Hz** multi-GNSS, fused with IMU |
| Other sensors | accelerometer, gyroscope | accelerometer, gyroscope, image processing |
| Video | separate camera module, MP4 | built-in 1440p camera, MP4 |
| Car data (OBD-II) | **none** | **none** |
| Session data format | FIT | FIT (assumed, same product line — *verify*) |
| Getting data off it | USB (MTP: "Catalyst › Internal storage"), sync to a Garmin account, Catalyst phone app | Bluetooth to the Catalyst app, Wi-Fi for video, USB |

What the sources say, and how firm each point is:

- **FIT is the storage format.** *Reported* by several owners on Rennlist and
  on Garmin's FIT SDK forum, who pulled sessions off the device and ran
  Garmin's `FitCSVTool` over them. The SDK's `FitToCSV-lap.bat` sample
  reportedly pulls lap data out. One forum thread is titled *"Finding Segment
  data within a Garmin Catalyst FIT file"*, which suggests the per-segment
  timing behind the "True Optimal Lap" feature is also in the file, in
  `segment_lap` messages or developer fields.
- **Garmin has a support article titled "Importing and Exporting Drive Session
  Data on the Garmin Catalyst"**, and the device mounts as a drive with
  "Internal storage". The folder path and file naming are *unverified*
  (support.garmin.com is unreachable from the research sandbox).
- **No OBD on either model.** *Confirmed* in Catalyst 2 coverage ("does not
  connect with a car's OBD data, and that is the same as the original").
- **The Catalyst app syncs over Bluetooth and a Garmin account.** *Confirmed*.
  Whether the app can **export a file** (for example a share-sheet FIT) is
  *unknown*, and it decides the native question below.
- **No public cloud API.** Garmin's Connect developer program is partner-gated
  and built for fitness activities. Nothing suggests Catalyst sessions are
  reachable through it.

## The FIT format, as far as it matters here

FIT is little-endian and self-describing. A 12- or 14-byte header is followed
by *definition* messages (the field layout for a local message type) and
*data* messages (records in that layout), then a CRC. Timestamps can be
compressed into the record header. Developer fields let a device add fields the
public profile doesn't have. The Catalyst very likely uses them, as Garmin's
motorsport devices before it did.

The public profile messages a Catalyst file is likely to carry (field lists
checked against the published `@garmin/fitsdk` profile, v21.217):

| Message (#) | Fields we'd use | Maps to |
|---|---|---|
| `file_id` (0), `device_info` (23) | manufacturer, product, time_created | detection ("is this a Catalyst?"), `date`/`time` |
| `session` (18) | start_time, sport (`driving` 24 / `motor_sports` 81), sub_sport | sanity check, date |
| `record` (20) | position_lat/long (semicircles), enhanced_speed (m/s), distance (m), **timestamp (whole seconds)** | `gps` if that's where the high-rate data is |
| `gps_metadata` (160) | timestamp_ms, position_lat/long, enhanced_speed, heading, velocity[3] | `gps` at 10/25 Hz (**prime candidate**) |
| `lap` (19) | start_time, total_elapsed_time, total_timer_time, lap_trigger | `laps` with `startT`/`endT` windows |
| `segment_lap` (142) | start_time, total_elapsed_time, name | sector splits (maybe), or the laps themselves |
| `accelerometer_data` (165) | timestamp_ms, sample_time_offset[], calibrated_accel_x/y/z (g) | `longG` / `latG` |
| `gyroscope_data` (164) | timestamp_ms, sample_time_offset[], calibrated_gyro_x/y/z (deg/s) | `yaw` |
| `timestamp_correlation` (162) | system ↔ UTC timestamps | aligning IMU to GNSS clocks |
| `video_clip` (187) / `camera_event` (161) | clip start/end | syncing with the MP4 (out of scope) |

Two facts from the profile decide the parser's design:

1. **`record.timestamp` is in whole seconds.** A 10 or 25 Hz trace therefore
   lives either in `gps_metadata` (which has `timestamp_ms`) or in `record`s
   whose sub-second time comes from a developer field or `time128`. A decoder
   that only reads `record` could silently hand back a **1 Hz** trace, which
   gives much worse line-crossing lap times (the phone recorder's ±0.2–0.5 s
   instead of a logger's ±0.1 s). The parser must pick whichever source has
   the highest rate and report the rate it got.
2. **Coordinates are semicircles**: degrees = `value × 180 / 2³¹`, and
   `0x7FFFFFFF` means invalid. That sentinel has to go before a point reaches
   `geo.js`, the same way `pdr.js` screens implausible coordinates.

## Where it fits in the codebase

The import pipeline is already built for this. Every parser resolves to one
shape (`public/js/import/parse.js`), and everything downstream is generic.

```
.fit ──► fit.js (decode: header, definitions, data, compressed timestamps, dev fields, CRC)
           │
           ▼
        catalyst.js (map messages → { kind: "catalyst", date, time, durationS,
                                      gps: [{t, lat, lon, v}], laps: [{timeMs, startT, endT}],
                                      imuChannels?, metrics?, needsLine })
           │
           ▼
        attachLapChannels (channels.js) ──► review / line picker (ui.js) ──► POST /events/:id/sessions
```

Concretely:

- `parse.js`: add `.fit` to `SUPPORTED_EXT`, dispatch it, and add
  `catalyst: "Catalyst"` to `KIND_LABELS`, which gives the default session
  label "Catalyst 09:15:00".
- **Laps**: when the file has `lap` messages with plausible windows, use them.
  They are the Catalyst's own timing against its track database's
  start/finish, so the session needs no line pick. Otherwise set
  `needsLine: true` and the existing click-a-map picker does the rest from the
  high-rate trace. `estimatedNote` in `ui.js` grows a Catalyst case
  ("lap times from the Catalyst" vs. "derived from GPS start/finish
  crossings, 25 Hz (~±0.05 s)").
- **Channels** (`channels.js` `channelDataFor`): distance and `speed` come from
  the trace for free, as for GoPro and VBO. The IMU is what makes a Catalyst
  file worth more than a GoPro file:
  - `longG` / `latG` from `accelerometer_data`. Which axis is which depends on
    how the unit is mounted. Don't guess it: rotate the device frame into the
    car frame with a least-squares fit against GPS-derived acceleration (dv/dt
    for longitudinal, v·dψ/dt for lateral). It's cheap, and it survives a
    crooked windshield mount. Store `latG` as a **magnitude**: `sanitizeChannels`
    clamps it at 0 and `grip.js` gets the side from `steering`, which this
    source doesn't have, so the friction circle plots one-sided, as the grip
    note in AGENTS.md already allows.
  - `yaw` from the gyro axis closest to the car's vertical. `yaw` is already in
    `CHANNEL_NAMES` and on the Grip tab.
  - IMU data is ~25–100 Hz and GNSS is 10/25 Hz, both far above the ~5 Hz line
    that `channels.js` uses to decide what becomes a gridded trace, so all of
    it grids. Nothing becomes a per-lap scalar, and the Car tab stays empty.
  - `rpm`, `throttle`, `brake`, `steering`, `gear` are **absent**. So the Inputs
    tab doesn't render, **the balance view doesn't work** (`balance.js` needs
    `steering`), and the steering-ratio fit (#223) gets nothing from these
    sessions. Say so in the docs rather than leave people to discover it.
- **Storage and server**: the stored `channels` blob is the same `v: 1`
  shape, so `sanitizeChannels`, the D1 schema and every API response are
  unchanged. Laps whose `time_ms` matches a channel lap entry are flagged
  `device_timed` by the existing trigger (migration 0018). **Catalyst imports
  are therefore leaderboard-eligible with no extra work**, the same as a PDR
  import.
- **Tier**: import is free on every client; the Pro line falls on `channels`,
  which the server strips for a free account. Nothing new is gated, so no row
  in the NS-32 tier table is needed beyond noting the new source.
- **Size**: a 25 Hz, 30-minute session is 45,000 GNSS records plus IMU, likely
  a few MB of FIT. Read it whole with `file.arrayBuffer()`. It doesn't need
  the byte-range reads that `pdr.js` uses for multi-GB video.
- **Tests**: `test/fixtures/build.mjs` gains `buildFitFile(points, {laps,
  imu, hz})`, the same synthetic circle trace every other format uses. Unit
  tests cover the decoder (compressed timestamps, a definition redefined
  mid-file, dev fields skipped by size, the invalid-coordinate sentinel, CRC),
  the mapping, and line-picker fallback when there are no `lap` messages.
  `@garmin/fitsdk` can be a **devDependency** to cross-check our decoder
  against the reference on the fixture. That is internal use, which its
  license allows, and it never reaches `public/`.

## Which clients

This follows the feature split in `docs/specs/native/README.md`:

- **Web first.** It's a logger file that arrives by USB on a computer, the
  same situation as `.vbo`, which is exactly the web's "desk-bound long tail".
  It also ships instantly and needs no port.
- **Native only if a phone becomes where the file shows up.** NS-30 ported
  video import because a GoPro clip lands in Photos before a laptop is
  opened. The same argument applies here only if the Catalyst app can
  *export* a FIT to the phone's share sheet or Files. If it can, the port
  follows the video pattern: `Fit`/`Catalyst` in the Kit and `:core` under the
  same names, pinned by a `contracts/logic/fit-parsers.json` generated from
  the JS over committed synthetic `.fit` files. If it can't, it stays web-only
  and that goes in the split doc.
- **Cloud sync: no.** There's no public API to call, and polling someone's
  Garmin account is not something Track Evolution should do.
- **Catalyst video: no special handling.** The MP4 is video. Unless the sample
  shows an embedded telemetry track (Garmin's VIRB line used separate FIT
  files, so probably not), dropping it into the importer would give the
  existing "No PDR or GoPro telemetry in this video" error. That error should
  say "import the session's .fit instead" when the MP4 looks like a Garmin one.

## Plan

0. **Get samples** (blocker): one Catalyst and one Catalyst 2 session `.fit`,
   plus a note of the folder they came from, into `telemetry-samples/`. Dump
   them with `npx @garmin/fitsdk` or `FitCSVTool` and write down which
   messages carry the high-rate trace, laps, segments and IMU, and what the
   developer fields are. This fills in the "verify" marks above.
1. **`fit.js`**: a generic, dependency-free FIT decoder with unit tests and a
   fixture builder. Roughly 250 lines, the size of `gpmf.js`.
2. **`catalyst.js` + dispatch**: trace, laps (own or line-picked), speed
   channel, notes line, label. Useful from day one: lap times, racing line,
   speed overlays, sectors, the theoretical best, the leaderboard.
3. **IMU channels**: mount-frame alignment, `latG`/`longG`/`yaw`, which light
   up the friction circle, corners and limits' G-based reads.
4. **Docs, in the same change as 2**: README, `site/docs/telemetry-import.html`
   (sources list, where to find the file on the device, what a Catalyst
   session does and doesn't carry), `site/index.html`'s telemetry sources,
   AGENTS.md's `js/import/` bullet, and the split record in
   `docs/specs/native/README.md`.
5. **Native port**: only if step 0 shows the Catalyst app exports files.

## Risks

- **Developer-field-only data.** If Garmin put the high-rate trace or laps in
  undocumented developer fields, the parser depends on reverse-engineered
  meanings, like the PDR beacon logic. That's manageable, but they need the
  same "see README before touching" treatment and a real-file regression
  sample.
- **Firmware drift.** Garmin can change the layout in an update. The decoder
  is layout-agnostic by construction (FIT describes itself); only the mapping
  can break, and it should fail loudly ("no position data in this FIT file"),
  never import a 1 Hz trace without saying so.
- **Non-Catalyst FIT files.** A watch's run will also be a `.fit`. Detect the
  product and sport (`driving` / `motor_sports`), and still accept any FIT with
  a position trace, since a lap is a lap. Refuse only a file with no positions.
- **License.** Our own decoder written from the published protocol description
  is fine. What we must not do is copy the SDK source into `public/`.

## Sources

- Garmin, *Importing and Exporting Drive Session Data on the Garmin Catalyst*: https://support.garmin.com/en-US/?faq=YJzQFGKzJQ57ZcviKmhcYA
- Garmin Catalyst owner's manual, *Transferring Data From Your Computer* / *Synchronizing Session Data*: https://www8.garmin.com/manuals/webhelp/GUID-16C78876-E016-40FD-8A0A-049BA52B462B/EN-US/GUID-D7555914-5660-4CE6-B79F-9BF58B62FFB5.html
- Garmin FIT SDK forum, *Finding Segment data within a Garmin Catalyst FIT file*: https://forums.garmin.com/developer/fit-sdk/f/discussion/317794/finding-segment-data-within-a-garmin-catalyst-fit-file
- Rennlist, *Garmin Catalyst Technical "Hacks"*: https://rennlist.com/forums/data-acquisition-and-analysis-for-racing-and-de/1325046-garmin-catalyst-technical-hacks.html
- Garmin press release, Catalyst 2: https://www.garmin.com/en-US/newsroom/press-release/automotive/optimize-time-on-the-track-with-the-cutting-edge-garmin-catalyst-2/
- Grassroots Motorsports on Catalyst 2: https://grassrootsmotorsports.com/news/new-garmin-catalyst-2-streamlines-everything-into-tidier-package/
- Garmin FIT SDK tools (FitCSVTool): https://github.com/garmin/fit-sdk-tools/tree/main/FitCSVTool
- `@garmin/fitsdk` on npm (profile used for the message/field table above)
