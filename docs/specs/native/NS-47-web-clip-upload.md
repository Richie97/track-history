# NS-47 — Best-lap video upload from the web

**Phase:** post-rewrite · **Platform:** Web (no server change; a test-only fixture for both phones) · **Depends on:** [NS-45](NS-45-best-lap-clips.md) (the clip routes, R2, `clip.js`, the phones' `ClipUploadQueue`), the web importer (`js/import/ui.js`), the offline layer's temp-id map · **Estimate:** 7–9 days over four tickets · **Issue:** #415

## Goal

NS-45 made best-lap clips a native-first feature: the phones cut the best lap
out of an imported video and upload it, and the web only plays, downloads and
deletes. This spec closes the gap. When a Pro driver imports a PDR or GoPro
video **in the browser**, the review shows the same row the phones do:

```
┌───────────────────────────────────────────────────┐
│ ☑ Save best-lap video                             │
│   A clip of each session's fastest lap, about     │
│   150 MB each. Uploads from this tab — keep it    │
│   open until it's done. Your coaches can watch    │
│   it too.                                    Pro  │
└───────────────────────────────────────────────────┘
          [ Add as sessions ]   [ Cancel ]
```

Saving posts the sessions exactly as today. Then the browser cuts each
session's best lap out of the file the driver picked, **without re-encoding
and without copying the video into memory**, and uploads the clip through the
existing NS-45 routes. The clip then plays on every client, the same as one a
phone made.

The spec also adds a second door that only the web can offer well:
**Add best-lap video…** on a session that was imported from a video before
clips existed. The driver picks the same file again and the clip is cut and
uploaded onto that session.

## Why

- **The laptop is where most PDR cards are read.** NS-45's follow-up list
  says it: a Corvette or Blackwing card goes into a laptop's SD slot after
  the day, and that driver's import never offers the video. They have to move
  a 4 GB file to their phone to keep the one lap they care about.
- **Every import made before NS-45 has no clip, and the web can fix that.**
  A driver with last season's footage still on disk can attach the best lap
  to the session it belongs to. On a phone that means getting the file onto
  the phone first. In a browser it's one file picker.
- **It removes the one native-first exception from the feature split.** The
  web is meant to be the feature frontier (`docs/specs/native/README.md`).
  NS-45 broke that for a stated reason (the remux), and this spec answers
  that reason.
- **It costs no server work.** The create / parts / complete routes already
  take a cookie session, already resume, and already enforce the quota. Every
  decision here is client-side.

## Fixed decisions

| | |
|---|---|
| What is stored | **Unchanged from NS-45.** One clip per imported video session, that session's best lap, picked by `clipCandidate`, windowed by `clipWindow`, posted with `POST /sessions/:id/clip` keyed on `time_ms`. A web clip and a phone clip are indistinguishable to the server and to every player. |
| Server | **No change.** The web uses the routes NS-45 shipped, with its cookie session. `requireSession` already accepts the cookie, part uploads already require an exact `Content-Length` (which a browser sends for a `Blob` body), and `sw.js` already skips `/api/clips/` and `/clips/`. If the build finds it needs a server change, that's a spec bug and gets raised before it's made. |
| Cutting | **In the browser, passthrough, by a hand-written MP4 remuxer** (`public/js/import/mp4cut.js`, dependency-free like the rest of `public/`). It reads the source's `moov`, keeps one video track and one audio track, rebuilds their sample tables for the window, and writes a new `ftyp` + `moov` + `mdat`. No sample is decoded or re-encoded. It never touches WebCodecs or `MediaRecorder`: those re-encode, which costs minutes of CPU and the camera's quality. |
| Memory | **The video is never read into memory.** The cut is a `Blob` assembled from the new header (a few hundred KB) and **`File.slice()` ranges of the source** for the kept samples. Browsers hold a sliced `File` as a reference to the file on disk, so building the clip reads only the `moov`. Each 50 MiB part is `clip.slice(…)` of that Blob, and `fetch` streams it from disk. This rule is load-bearing: a day of five 150 MB clips must not need 750 MB of RAM. |
| Determinism | **The same file and window always give byte-identical output.** No clock reads, no random ids, a fixed box order, `mvhd`/`tkhd` times copied from the source. That is what makes resume work across a closed tab: a second cut of the same file declares the same `size_bytes`, so `POST /sessions/:id/clip` answers the existing upload with its parts already stored, and only the missing parts go up. A unit test cuts twice and compares bytes. |
| Tracks kept | **The phones' rule.** The first video track whose sample entry is `avc1` / `avc3` / `hvc1` / `hev1`, else the first other `vide` track whose entry isn't JPEG (`jpeg`, `mjpa`, `mjpb`), so PDR 2.5's MJPEG cover image is never the video. The first `soun` track whose entry is `mp4a`; any other audio is dropped and the clip is silent. Everything else is dropped: the telemetry track (`marl`, `adco`, `gpmd`), timecode (`tmcd`), and at file and track level `udta`, `meta`, `uuid` and `tref`, which is where location atoms live. The clip carries no telemetry and no location, as NS-45 requires. |
| Where the cut starts | **At the last sync sample at or before the window's start**, as Android's `MediaExtractor` cut does. The output's first presented frame is that keyframe. No edit list hides the frames between it and the requested start. **`lap_offset_ms` is measured** from the output (the lap's `startT` minus the first presented frame's time in the source), so it's at least `PRE_ROLL_S` and up to one GOP more (a Corvette PDR's lap lands about 3.3 s in, a PDR 2.5's at 3.0 s). iOS hides those frames and lands on 3.000 s. Both are correct, because the player seeks to the offset the server stores. |
| Where the cut ends | **At the first sync sample whose presentation time is at or after the window's end**, exclusive, or the end of the track. Every kept frame then decodes, B-frames included, at the cost of up to one GOP past `POST_ROLL_S`. Audio runs from the AAC frame that holds the first kept frame's presentation time to the frame that holds the last one's end. An audio edit list aligns its first frame to the video, so A/V sync is kept to within one audio frame (about 21 ms). |
| Formats refused | A fragmented MP4 (`moov` holds `mvex`), a file with no video track the rule accepts, a video track with no sync sample in or before the window, or a cut over `MAX_CLIP_BYTES`. Each is a **cut failure**, worded on the session (*"Couldn't save this lap's video"*), and the session is already saved. None of the three recorders NS-45 supports writes these files. |
| Upload | **From the page, while the tab is open.** `public/js/import/clip-upload.js` runs NS-45's state machine (below) one clip at a time and one part at a time, through `fetch` with the session cookie. **Nothing is persisted.** A web job lives in memory beside the `File` it reads, because a `File` handle can't outlive the tab (and IndexedDB would mean copying 150 MB per clip into browser storage). A closed tab or a reload stops the upload. Recovery is the *Add best-lap video* door: pick the file again and the upload resumes where it stopped. |
| Keeping the tab open | While any job is running, the shell shows **one in-place banner** (*"Uploading 2 lap videos — keep this tab open · 40%"*, updated like `#sync-banner`, never re-rendered by `shell()`), and a `beforeunload` handler asks before the tab closes. Navigating inside the SPA never stops a job: the uploader is module-level, not part of a view. |
| Offline | **The phones' rule.** If a session was posted offline, its id is a `tmp-N` id in the offline queue. Its job waits (`sessionState` → `waiting`) until the queue flushes and the id maps, then uploads, as long as the tab is still open. A transport failure backs off and never drops the job. |
| The source going away | The upload reads the source file until its last part. **An SD card ejected mid-upload, or a file changed on disk since it was picked**, makes the read fail (`NotReadableError`). That isn't retryable, so the job is dropped as *source unreadable*, and the session card says *"Couldn't read the video file — was the card removed? Add it again from this session."* That links to the *Add best-lap video* door, which resumes. |
| Wi-Fi / cellular | **No switch on the web.** A browser can't reliably tell a metered connection (the Network Information API is Chromium-only and advisory), and the web importer is a desk tool. The row says *"Uploads from this tab"* where the phones say *"Uploads on Wi-Fi"*. Settings gains nothing. |
| Free accounts | **The row is drawn locked**, never hidden. It's `proPanelHtml`'s shape, titled *Save best-lap video*, and points at the phone apps' subscription as every web Pro surface does: the web has no purchase surface by design. |
| Quota | `clipOffer`'s `"full"` state: the row reads `clipFullText`, unchecked and disabled. A create that still lands over quota (another device uploaded in between) is a 409 `clip storage full`, and the job drops with that sentence on the session card. Nothing is deleted to make room. |
| Coaches | **No change.** A coach can't import into a student's logbook, so `readOnly()` pages never draw the row or the *Add* door. The row's *"Your coaches can watch it too."* is `clipOfferNote`, as on the phones. |
| The *Add best-lap video* door | On the event page, a session card offers **Add best-lap video…** when the viewer owns it, it's Pro, **no lap in the session has a clip**, and its notes name a video source (`/^Imported from .+\.mp4\b/i`, the notes line every client's importer writes). It opens the **same review panel** in a one-file *video for this session* mode: the file is parsed by `parseTelemetryFile`, the line picker appears if the file needs one, and labels and include boxes are absent. The button reads **Save video**. The file is accepted only if its `clipCandidate` lap's `timeMs` **equals the session's best logged lap time**. Otherwise: *"This video's fastest lap is 1:59.412 and this session's is 1:58.977 — pick the file this session was imported from."* The match is exact because the server keys the clip on that `time_ms` and refuses a lap that isn't there. |
| Mobile browsers | **Same code, not a target.** A phone's browser can run it, but iOS Safari's photo picker may hand over a transcoded copy that has lost its telemetry track, so the import fails before a clip is offered. The phone apps are the supported path there, as they already are for import. |
| HEVC | **Passed through as recorded**, as on the phones. A GoPro shooting H.265 makes an H.265 clip, which Safari and Chromium on supported hardware play and Firefox doesn't. That's a property of the footage, not of the web cut, and the player's error state already says the clip can't play here. |

## The remuxer (`public/js/import/mp4cut.js`, ticket 1)

Pure except for its reads, which go through `Blob.slice().arrayBuffer()` the
way `pdr.js`'s `bufAt` does, so it runs unchanged in Node against a `Blob` of
a fixture file.

```js
// → { blob, sizeBytes, durationMs, lapOffsetMs, video: "avc1", audio: "mp4a" | null }
//   or throws ClipCutError(reason) with reason one of
//   "fragmented" | "no-video" | "no-keyframe" | "window-outside" | "too-large"
export async function cutClip(file, window, lapStartS)
```

`window` is `clipWindow(lap, parsed.durationS)`. Steps:

1. **Find `moov`** among the top-level boxes. It's often at the end of the
   file (PDR). Reuse `boxes()` from `pdr.js` rather than writing a fourth box
   walker: export it, with `bufAt` and `fourcc`, from a shared
   `js/import/mp4.js`, which `pdr.js`, `pdr25.js` and `gpmf.js` move onto in
   the same ticket, so their private copies of those helpers collapse into
   one.
2. **Pick the tracks** by `hdlr` and `stsd` entry, as in *Tracks kept*.
3. **Expand each kept track's sample tables** into flat arrays: decode time
   (`stts`), composition offset (`ctts`, versions 0 and 1, signed), size
   (`stsz` / `stz2`), file offset (`stsc` + `stco` / `co64`) and sync flag
   (`stss`; absent means every sample is sync). Typed arrays only: a 25-minute
   30 fps source is about 45,000 video samples.
4. **Map the window into media time** through the track's `elst`
   (`media_time`, and `segment_duration` for an empty first edit). This is
   the trap iOS hit (*As built (ticket 2)*): an encoder with B-frames shifts
   media time behind its own edit list, and ignoring it puts the cut 250 ms
   out. Presentation time = (DTS + CTS offset − `media_time`) / timescale.
5. **Choose the sample ranges**, as in *Where the cut starts* / *ends*.
6. **Group each track's kept samples into runs** that are contiguous in the
   source file. Each run becomes one output chunk and one `File.slice()`.
   Runs from the two tracks are interleaved by time, so a player reading by
   range never seeks far.
7. **Write the header**: `ftyp` (`isom`, compatible `isom` `iso2` `mp41`
   plus `avc1` or `hvc1`), then `moov`. `mvhd` takes the source's timescale
   and times, the new duration and `next_track_ID` 3. Per track: `tkhd`
   copied (matrix and dimensions kept, so a rotated clip stays rotated), with
   the new duration and track ID 1 / 2; an `edts`/`elst` with one edit
   starting at the first kept sample's composition offset (video) or at the
   audio alignment (audio); `mdhd` with the new duration; `hdlr`;
   `vmhd`/`smhd`; a self-contained `dinf`; and `stbl` with `stsd` **copied
   byte for byte** (it holds `avcC` / `hvcC` / `esds`), plus rebuilt `stts`
   (run-length), `ctts` only if the source had one, `stss` only if the source
   had one, `stsz`, `stsc` and `stco`. `stco` is always 32-bit: a clip is
   under `MAX_CLIP_BYTES` (1 GiB). Per-sample side tables (`sdtp`,
   `sbgp`/`sgpd`, `subs`) are dropped. They're optional, and slicing them
   right is more code than they're worth. **`moov` comes before `mdat`**, so
   the clip plays from the first range request. Offsets are computed after
   the `moov` size is known.
8. **Assemble** `new Blob([ftyp, moov, mdatHeader, ...runSlices], { type:
   "video/mp4" })` and return it with the measured `lapOffsetMs`: the lap's
   `startT` in the source minus the first kept frame's presentation time,
   rounded to ms.

`clip.js` stays the shared rule. `clipCandidate`, `clipWindow`,
`estimateClipBytes` and `clipOffer` are called here unchanged, and their
`lap-clips.json` pins are untouched. The cutter itself is **web-only and not
ported**, so it has no fixture in `contracts/logic/`. The phones have
AVFoundation and MediaExtractor.

## The upload queue (`public/js/import/clip-upload.js`, ticket 2)

**A port of the iOS Kit's `ClipUploadQueue` under the same names**:
`nextAction`, `apply`, `sessionState`, `nextPart`, `partRange`, `backoffMs`,
`isRetryable`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `MAX_RESTARTS`, and
`DropReason`'s strings. Its Swift test cases are ported one for one. Two
differences, both additive:

- **`sourceUnreadable`** (*"source unreadable"*), a drop reason for a failed
  part read (see *The source going away*). The phones read app-private
  copies, so they never hit it.
- No persistence fields are read (`not_before_ms` is kept in memory).

Today the state machine has two hand-kept copies, the Kit's and `:core`'s,
and AGENTS.md's rule is that ported logic asserts against the web reference,
never against the other port. NS-45 had no JS copy, so it couldn't follow that
rule. Now there is one, so this ticket **makes it the reference**:
`contracts/logic.mjs` generates **`contracts/logic/clip-upload.json`** from
it. The rows are a scripted walk through every transition in the Kit's
table (create → parts → complete; resume with held parts; each 409 reason;
402; a 404 mid-upload restarting up to `MAX_RESTARTS`; the backoff ladder;
temp-id waiting / mapped / lost). Ticket 4 points both phones' existing
tests at it.

The driver around it is `clipUploads`, a module-level singleton in the same
file:

- `enqueue({ sessionId, timeMs, file, window, lapStartS })` cuts first. A
  cut failure records a failed job and never throws into the save.
- Jobs then run one at a time: `fetch` `PUT /api/clips/:id/parts/:n` with
  `body: clip.slice(offset, offset + length)`, and `POST` for create and
  complete through `api()` (both live, both off the offline whitelist, as on
  the phones).
- `subscribe(fn)` feeds the banner and the session cards
  (`{ sessionId, state: "cutting" | "waiting" | "uploading" | "failed",
  fraction, reason }`).
- `cancelAll()` aborts every request through an `AbortController`. Sign-out
  calls it before clearing the cache.
- When a job finishes, the event page it belongs to re-runs `route()` if it's
  showing, so the new `clip` appears.

## Web UI (ticket 2)

- **Import review** (`renderReview`): results keep their `File` (`source`
  beside `file`, the name). The row sits under the item list, drawn from
  `clipOffer(items, state.entitlement, state.me.clips)` with `items = results
  as { parsed, include, fileBytes: source.size }`.
  - `"none"`: no row.
  - `"locked"`: the Pro panel.
  - `"full"`: `clipFullText`, disabled.
  - `"on"`: a checkbox, **checked every time the review opens** and kept
    across line-pick re-renders like the include boxes. The first sentence is
    `clipOfferTextWeb(largestEstimate)`, the second `clipOfferNote`.
  - `clipOfferTextWeb` is new in `clip.js` and web-only, so it isn't in the
    fixture. It says the same thing as `clipOfferText` with *"Uploads from
    this tab — keep it open until it's done."* in place of *"Uploads on
    Wi-Fi."*
  - Changing an include box or picking a line recomputes the row.
- **Save** posts each body as today, then, for each included result with a
  candidate and the box checked, calls `clipUploads.enqueue` with the
  `POST`'s returned id. It doesn't await the uploads. The review closes when
  the sessions are saved, as now.
- **New Event form**: `options.onSessions` bodies gain a non-enumerated
  `clip` handle (`{ file, window, timeMs, lapStartS }`), which
  `JSON.stringify` never sends. The form's post loop calls
  `clipUploads.enqueue` with each id `POST /events/:id/sessions` returns. A
  staged body removed with *Remove* takes its clip with it. This mirrors the
  phones' `sessionPosted` hand-off.
- **Session card**, for the owner, under the lap-video buttons:
  - While a job is running: *"Saving lap video · 40%"*, or *"Lap video waiting
    to sync"* for a temp id.
  - When a job has failed: the reason's sentence, with *Add it again* where
    re-adding can help.
  - Otherwise, when the door's conditions hold: **Add best-lap video…**, a
    quiet link that opens the review in *video for this session* mode in the
    session's own `#pdr-review`-style box.
- **Shell**: the upload banner and `beforeunload`, as in *Keeping the tab
  open*.
- **The import dropzone's copy** (the hint under *Import*) stays as it is.
  The row is where the video is mentioned.

## *Add best-lap video* (ticket 3)

`reviewResults(box, event, results, onDone, { attachTo: session })`:

- One file, no include box, no label field.
- The clip row is drawn **without the checkbox**, because adding the video is
  the whole point. A locked or full row replaces the button.
- The line picker works as in a normal import.
- *Save video* checks the match (*Fixed decisions*), then enqueues and
  closes.
- A session that already has a clip never shows the door. If a clip arrives
  from another device between opening and saving, the 409 `lap already has a
  clip` drops the job, and the card shows the clip once the page re-reads.

It is also the resume path. Picking the same file after a closed tab
produces the same bytes, and the create answers the parts already stored.

The match helper is pure and unit-tested:
`clipMatchesSession(candidate, sessionLaps) → { ok } | { ok: false,
fileBestMs, sessionBestMs }`, in `clip.js`. It's web-only and not in the
fixture.

## Tests

- **`test/unit/mp4cut.test.js`**, over fixture MP4s built by
  `test/fixtures/build.mjs` (`buildCutSourceMp4`). The cutter never decodes,
  so the samples are synthetic bytes. The fixtures cover:
  - an `avc1` track with 1.5 s keyframes and a `ctts` / `elst` B-frame shift;
  - an `mp4a` track;
  - a leading MJPEG track;
  - a `marl` telemetry track;
  - a `co64` source;
  - `udta` with a `©xyz` location atom and `meta` with an ISO 6709 key.

  Assertions:
  - the output parses with `mp4.js`'s walker;
  - it holds exactly two tracks, with no `udta`, `meta`, `uuid` or `tref`
    anywhere;
  - **every output sample's bytes equal the source sample's** (read back
    through the output's own tables);
  - the first video sample is a sync sample at or before the window;
  - the measured `lapOffsetMs` is right on the B-frame fixture (the iOS 250
    ms trap);
  - audio starts within one frame of the video;
  - a cut is byte-identical when run twice;
  - each `ClipCutError` reason fires.
- **A decode check, run when ffmpeg is present** (CI may lack it; the test is
  skipped with that stated, like `promo/`'s render). It uses
  `apps/android/app/src/androidTest/assets/clip-source.mp4`, the committed
  real-H.264 file Android's `ClipCutterTest` uses (MJPEG lead track, 1.48 s
  keyframes, a `loci` box). `ffprobe` must show one h264 and one aac stream
  and no data stream, and `ffmpeg -v error -i out.mp4 -f null -` must exit
  clean.
- **`test/unit/clip-upload.test.js`**: the Kit's cases ported, plus
  `sourceUnreadable`.
- **`test/unit/clip.test.js`**: `clipOfferTextWeb`, `clipMatchesSession`.
- **`test/api/`: nothing new.** No route changes. One worker test uploads a
  `cutClip` output of the fixture through the real routes and plays it back
  through `/clips/:id.mp4` with a range request, to prove a web-made clip
  goes through the same server path.
- **Real footage, by hand, recorded in *As built*.** Run the Corvette PDR
  clip, the three Blackwing clips (`telemetry-samples/pdr-beacons/`,
  `pdr-caddy/`) and a GoPro clip if one turns up (still unverified on every
  client) through the web import in Chrome, Safari and Firefox. For each,
  record the cut's size against `estimateClipBytes`, the offset, and that
  the lap starts at the line in all three browsers' players and on a phone.
  Also time the cut (it should be under a second, since only the `moov` is
  read) and the upload, and check memory stays flat in the browser's task
  manager while five clips upload.

## Docs owed (in the same PRs)

- **`site/docs/telemetry-import.html`**: *Best-lap video* stops saying the
  phone apps keep the lap and the browser is "planned". It gains the browser
  half: the switch, *keep the tab open*, and the *Add best-lap video* door
  for sessions imported earlier.
- **`site/docs/privacy.html`**: the *Best-lap videos* paragraph says *"in the
  iPhone or Android app"* and *"cut on your phone"*. It becomes *"in the
  app or in your browser"* / *"cut on your device"*. Bump the effective
  date. Nothing new is collected.
- **`site/docs/data-model.html`** line 281, and **`terms.html`** line 130:
  check the wording isn't phone-only.
- **`site/index.html`**: the Pro list's video line, if it names the phones.
- **`README.md`**: *Best-lap video clips* gains a web paragraph (the remuxer,
  the zero-copy rule, in-tab upload, the door). The import paragraph near
  line 776 says clips can be saved from the browser.
- **`AGENTS.md`**: the `js/import/clip.js` bullet stops calling it
  reference-only, since the web imports it now. New bullets for `mp4.js`,
  `mp4cut.js` and `clip-upload.js`, stating the zero-copy and determinism
  rules and that `clip-upload.json` is now the reference both phones' queues
  assert against. The *Three clients* paragraph's "the one feature that
  lands native-first" becomes past tense.
- **`docs/specs/native/README.md`**: the feature-split bullet's NS-45
  exception says the web caught up in NS-47. Add the index row.
- **`NS-45-best-lap-clips.md`**: its *Web upload* follow-up points here.

## Tickets

1. **The remuxer** (3–4 days): `js/import/mp4.js` (the shared box walker,
   with `pdr.js` / `pdr25.js` / `gpmf.js` moved onto it), `mp4cut.js`, the
   fixture builder, `mp4cut.test.js` with the ffmpeg check, and the
   real-footage pass, written into *As built*. **No UI.** It goes first
   because it's the only part that can turn out not to work, and a format
   that won't cut is better found before a switch promises it.
2. **Upload from the import review** (3 days): `clip-upload.js` with the
   ported cases and `contracts/logic/clip-upload.json`, the review row, the
   New Event form hand-off, the session card states, the banner and
   `beforeunload`, the API round-trip test, and the docs.
3. **Add best-lap video** (1–2 days): the session card door, the review's
   *attach* mode, `clipMatchesSession`, and the resume-after-close check by
   hand.
4. **Pin the phones** (½ day, test-only): `ClipUploadQueueTests` (Kit) and
   `ClipUploadQueueTest` (`:core`) assert against `clip-upload.json`. No app
   code changes. A row that fails is a real divergence, and gets fixed in
   whichever port is wrong.

## Acceptance criteria

- [ ] Importing a PDR, PDR 2.5 or GoPro video in the browser, as Pro, shows
      *Save best-lap video* checked. Saving uploads one clip per included
      video session, and it plays on all three clients, starting at the
      line.
- [ ] Unchecking it saves the sessions and uploads nothing. The next review
      opens with it checked.
- [ ] A `.vbo` or `.csv` review draws no row. A free account sees it locked.
      Over quota, it's disabled and says so.
- [ ] Browser memory stays flat while clips upload: the source is never read
      whole.
- [ ] The clip holds one video and at most one audio stream, no telemetry
      track and no location metadata, and decodes cleanly.
- [ ] The sessions save even when a cut or upload fails, and the session
      card says which and what to do.
- [ ] A session saved offline uploads its clip once it syncs, while the tab
      is open.
- [ ] Closing the tab mid-upload and then using *Add best-lap video* with the
      same file resumes, sending only the missing parts.
- [ ] *Add best-lap video* on a session imported before NS-45 attaches the
      clip, and the wrong file is refused in words.
- [ ] Sessions imported through the New Event form get their clips.
- [ ] No server file changes. Both phones' queue tests pass against
      `clip-upload.json`.
- [ ] The import guide and privacy policy say videos can be saved from the
      browser.

## As built (ticket 1)

`js/import/mp4.js`, `mp4cut.js`, `buildCutSourceMp4` and
`test/unit/mp4cut.test.js`. Where the code differs from the text above, and
why:

- **`mp4.js` also owns `readMoov`.** The three parsers each had the same
  top-level walk to find `moov`, not only the box helpers, so it moved too
  (same error strings). `pdr.js` re-exports `boxes`, which `pdr25.js` and two
  test files imported from it.
- **A sixth refusal, `"malformed"`**, for sample tables that contradict each
  other (a missing `stts`, `stsc` / `stco` covering fewer samples than `stsz`).
  It is worded on the session like the others.
- **Both kept tracks are written enabled.** Android's `clip-source.mp4`
  marks its H.264 track *disabled* (`tkhd` flags 2) behind the enabled MJPEG
  cover track, and copying that made a clip AVFoundation refused to open
  (`-11869 Cannot Open`). The cutter sets enabled + in-movie on both.
- **A short `stts` is carried forward, not refused.** The Corvette PDR's
  audio `stts` covers 45,953 samples and its `stsz` 45,954. ffmpeg extends
  the last duration; so does `sampleTable`. Pinned by
  `buildCutSourceMp4({ audioSttsShort: true })`.
- **The Blackwing's cover image isn't a track.** ffprobe lists it as a fourth
  stream, but it lives in `moov/udta` (attached picture), which the cut drops
  with the rest of `udta`. The `jpeg` / `mp4v`-with-JPEG-esds rule still
  matters for Android's fixture, whose cover image *is* a track.
- **`cutClip` takes a fourth `{ maxBytes }` argument**, for the `too-large`
  test only. A gigabyte fixture isn't reasonable.
- **`mp4v` entries are checked for a JPEG object type** (0x6C–0x6E in the
  esds), which is how ffmpeg muxes a cover image as a track. The spec named
  only the `jpeg` / `mjpa` / `mjpb` entries.

**Real footage** (Node 24 with `fs.openAsBlob`, so the source is a
file-backed Blob as in a browser; each file's best lap by `clipCandidate`):

| Source | Lap | Clip | `estimateClipBytes` | Duration | `lapOffsetMs` | Cut |
|---|---|---|---|---|---|---|
| Corvette PDR, 763 MB, 17:47 | 6, 2:02.110 | 86.5 MiB | 86.7 MiB (−0.2%) | 128.272 s | 3317 | 60 ms |
| Blackwing ADV_1633, 238 MB | 1, 1:24.582 | 91.0 MiB | 92.7 MiB (−1.8%) | 89.632 s | 3029 | 8 ms |
| Blackwing ADV_1635, 494 MB | 2, 1:21.345 | 75.2 MiB | 80.8 MiB (−6.9%) | 86.399 s | 3026 | 20 ms |
| Blackwing ADV_1640, 282 MB | 1, 1:22.752 | 90.1 MiB | 92.6 MiB (−2.7%) | 87.798 s | 3023 | 51 ms |

- The Corvette offset is the 3.317 s NS-45 measured for an ffmpeg `-c copy`
  cut (1.475 s keyframes). The Blackwing lands within one frame of 3.0 s.
- Each cut read the `moov` (290–670 KB) and nothing else. RSS moved by
  10 MB at most, and a second cut gave the same bytes.
- **ffmpeg** decodes all four with no error (`-f null`). ffprobe shows one
  h264 and one aac stream, no data stream, and no tag but the brands and
  `creation_time`. On the Android fixture, every video and audio packet's MD5
  matches the source's, and the audio's first frame sits 4.989 ms ahead of
  the picture.
- **AVFoundation** (Safari's player stack): all four are playable, with two
  tracks and no metadata, and a frame decodes at 3.4 s. The Corvette's AAC,
  which AVFoundation doesn't list as a track in the source (*As built
  (ticket 2)* of NS-45), shows up as a track in the clip.
- **Chromium 152** (the desktop app's browser pane, from a range-capable
  local server): the three Blackwing clips and the fixture play, and seek to
  the measured offset. **The Corvette clip plays audio but decodes no video
  frames, and so does the Corvette source file**, so the problem is that
  footage (H.264 Baseline, level 4.2, 1280×720, 100,000 timescale) in this
  Chromium build, not the cut. The cut's packets are the source's byte for
  byte. Desktop Chrome needs checking by hand. If it fails there too, every
  Corvette clip, the phones' included, plays without video in Chromium. That
  belongs to NS-45, not here.
- **Not yet done:** desktop Chrome, Safari and Firefox by hand (no Firefox
  on the machine this was built on), playback on a phone (needs ticket 2's
  upload), upload timing, and the browser task-manager memory check while
  five clips upload. All of these come with ticket 2. No GoPro footage has
  turned up yet.

## As built (ticket 2)

`js/import/clip-upload.js`, `contracts/logic/clip-upload.json`, the review
row, the New Event hand-off, the session-card lines, the banner and
`beforeunload`, and the API round trip. Where the code differs from the text
above, and why:

- **Parts go by `XMLHttpRequest`, not `fetch`.** `fetch` reports no upload
  progress, and a 50 MiB part is the whole of a short clip, so the banner
  would sit at 0% and jump. XHR with a `Blob` body still sends the exact
  `Content-Length` the route requires, and still streams from disk. Create
  and complete are `fetch`, outside `api()`: live writes, never queued.
- **The driver is built in `app.js`, not in `clip-upload.js`.**
  `createClipUploads` takes every effect (the cut, the three requests,
  `tempIdState`, the clock and timers) as an argument, so the tests run the
  real driver with no network and the API test runs it against the Worker.
  `app.js` holds the one instance (`clipUploads`) with the live set. The
  module keeps no DOM and no app state.
- **An ejected card is found by reading, not by failing.** Before each part
  the driver reads that part's first and last byte. A `File` whose card is
  gone, or that changed on disk, fails that read with `NotReadableError`. The
  upload itself would only fail as a dropped connection and back off forever.
  The read failing is the `unreadable` response, and `apply` drops the job as
  `sourceUnreadable`. Until ticket 3's door exists, its sentence stops at
  *"…was the card removed or the file moved?"*.
- **A lap that already has a clip finishes quietly.** The 409 means another
  device got there first. The page re-reads and shows that clip, with no
  failure line.
- **A finished clip re-renders the page only when the page is showing that
  session and nothing on it has focus.** `route()` re-renders the whole view,
  which would throw away a half-typed session note. Otherwise the clip shows
  on the next navigation.
- **`offline.js` gained `tempIdState(tempId)`**, which reads the queue before
  the id map, the order both phones' stores use.
- **The fixture is the JS objects**: camelCase, a `kind` tag on actions,
  responses and outcomes, and temp ids as `"tmp-N"`, which a port reads as its
  own temp id for N. The `unreadable` row is marked `webOnly`. Ticket 4 points
  both phones' tests at it.
- **Failures each have a sentence** (`clipFailureText`): storage full is
  `clipFullText`; Pro lapsed, session never synced, session deleted and card
  removed each have their own; everything else, cut failures included, is
  *"Couldn't save this lap's video."* Each line carries *Dismiss*.

**Verified in a browser** (headless Chromium 141 through Playwright, against
`wrangler dev` with a local R2 bucket):

- As Pro, a PDR import draws the row checked, with *"about 1 MB each. Uploads
  from this tab"*.
- That fixture has no picture, so saving it leaves *"Couldn't save this lap's
  video."* on the session. That is the cut-failure path.
- A free account sees the Pro panel in the row's place. A `.vbo` review draws
  nothing.
- A real cut of the synthetic camera file went through `liveCreate`,
  `livePutPart` and `liveComplete` in the page. The clip landed on its lap,
  the signed URL served exactly the bytes cut in the page, and the event page
  then offered *▶ Lap 1 video*. The API test does the same through the
  Worker, with a range request.

**Not yet done:**

- **The banner and `beforeunload` haven't been driven end to end in a
  browser.** No committed fixture has both a telemetry track the importer
  reads and a picture the cutter accepts, so the app's own review can't
  produce a clip that uploads. `clipBannerText` is unit-tested, and the
  painting is a few lines. Real footage covers it.
- **The hand-run passes owed from ticket 1** are still outstanding:
  - real footage through the web import in desktop Chrome, Safari and
    Firefox;
  - playback of a web-made clip on a phone;
  - upload timing;
  - the browser task manager's memory while five clips upload.

  This build had no real footage and no desktop browsers.

## Open questions

- **Two parts at once?** Sequential parts keep the code and the banner
  simple, and one stream usually saturates a home uplink. If the
  real-footage pass shows a slow single stream on a fast line, two in flight
  is a small change to the driver, not to the queue.
- **Should the door also offer the whole event?** *"Add best-lap videos…"* on
  the event page, taking a folder's worth of files and matching each to a
  session by best lap, would rescue a past season in one go. That's more UI
  than v1 needs. It goes in if drivers use the single-session door.
- **Persisting jobs across a reload** would mean storing the cut in
  IndexedDB or OPFS: a 150 MB copy per clip into browser storage that
  Safari may evict. The door covers the same failure without the copy. This
  gets revisited only if closed-tab uploads turn out to be common.

## Follow-ups, deliberately not here

- **The phones' *Add best-lap video* door** for old sessions: the same
  matching rule, if drivers ask for it on a phone.
- **A video other than the best lap**, a per-lap *Save video* from the
  review. It's the same cutter with a different window and no server change
  (the create already keys on any lap's `time_ms`), but it means NS-45's
  one-clip-per-session decision has to change on all three clients, and the
  quota maths with it.
- **Video synced to the trace cursor**, unchanged from NS-45's list.
