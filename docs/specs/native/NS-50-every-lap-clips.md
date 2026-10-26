# NS-50 — Every-lap video clips from a PDR import

**Phase:** post-rewrite · **Platform:** Server + web + iOS + Android · **Depends on:** [NS-45](NS-45-best-lap-clips.md) (the clip routes, the cutters, the phones' uploaders), [NS-47](NS-47-web-clip-upload.md) (the web's remuxer and uploader) · **Estimate:** one PR · **Issue:** #429 · **Follow-up:** #430 (H.264 re-encode before upload, best-lap clips included)

## Goal

NS-45 saves one clip per imported video session, the best lap. A Pro driver
importing a **PDR** recording can now choose to save **every full lap**:

```
┌───────────────────────────────────────────────────┐
│ ☑ Save lap videos                                 │
│   ( • Best lap )  (   Every lap   )               │
│   A clip of every full lap in each PDR session —  │
│   14 clips, about 1.3 GB in all. Uploads on       │
│   Wi-Fi.                                     Pro  │
└───────────────────────────────────────────────────┘
```

Each lap gets its own clip, cut, uploaded and played exactly like a best-lap
clip. Nothing about a clip changes: one clip per lap, the same routes, and
the same player on the lap page.

## Fixed decisions

| | |
|---|---|
| Which sources | **PDR only** (`kind: "pdr"`, which covers both the Corvette's Marlin recorder and AliveDrive PDR 2.5). A GoPro clip in the same review still saves its best lap whichever scope is picked. `EVERY_LAP_KINDS = ["pdr"]` in `clip.js`. |
| Which laps | **Every lap with a usable `clipWindow`.** A PDR lap runs from one start/finish crossing to the next, so the out-lap and in-lap are never laps, and every lap is a full lap. Estimated laps (a recovered PDR) count, as they do for the best lap. A lap over `MAX_CLIP_S` or outside the file gets no clip. |
| The choice | **A two-way choice under the row's switch, Best lap / Every lap, starting on Best lap in every review**, drawn only when Every lap would save more clips than Best lap (some included PDR item has two or more windowed laps). Without that the row is NS-45's row, unchanged, titled *Save best-lap video*. With it, the row is titled *Save lap videos*. The choice isn't remembered: a driver who wants every lap picks it each time, so nobody fills their storage by accident. |
| The row's text | Best lap: `clipOfferText` / `clipOfferTextWeb`, unchanged. Every lap: `everyLapOfferText(count, bytes)`: *"A clip of every full lap in each PDR session — 14 clips, about 1.3 GB in all. Uploads on Wi-Fi."* (`everyLapOfferTextWeb` says *"Uploads from this tab — keep it open until it's done."*). `count` and `bytes` cover every clip the scope saves, the GoPro best laps included. |
| Quota | **`CLIP_QUOTA_BYTES` rises from 20 GiB to 50 GiB.** At about 95 MB per Corvette lap, that's roughly 65 eight-lap sessions. `clipOffer(items, entitlement, clips, scope)` checks the quota against the picked scope's total. When Every lap would go over and Best lap wouldn't, Every lap is drawn disabled with `everyLapFullText(clips)` (on iOS the picker isn't drawn at all, only the sentence, because a segmented picker can't disable one segment): *"Every lap would go over your lap video storage (50 GB)."* When Best lap is full too, the row is NS-45's full row. A create that still lands over quota is the usual 409, and that lap's job drops. Laps already uploaded stay. |
| Keying a clip to its lap | **`POST /sessions/:id/clip` gains an optional `lap_num`.** With it, the server finds the lap by `lap_num` **and** `time_ms`, and a mismatch is a 404. Without it, the server keeps NS-45's rule (lowest `lap_num` with that `time_ms`), so a shipped client keeps working. Every client sends `lap_num` from now on, for best-lap clips too. That fixes the tie NS-45 left open: two laps with the same time could only ever reach the first one. `lap_num` is the lap's position in the posted session, `index + 1` into `parsed.laps`, because a session POST stores its laps in order (`sanitizeLaps` drops only non-positive times, which no parser emits). |
| Upload | **One job per lap**, through the unchanged state machine. The job gains `lapNum` (null on a job from an older manifest, which then posts without it) and `createBody` adds `lap_num` when it's set. The transition table doesn't change, so `clip-upload.json` changes only by the new field. The web and Android upload one job at a time, in order (Android's workers take turns on a mutex). iOS keeps one part in flight per job, so a backgrounded iPhone's URL session carries every lap at once rather than relaunching the app for each in turn. Cuts run one at a time on every client. |
| Cutting on the phones | Each lap is cut at save time, as the best lap is now, into the app's own clip directory. A day of eight-lap sessions can hold a few GB of cuts on the device until they upload. That's the same disk rule as NS-45, eight times over, and each cut is deleted when its upload completes or drops. A cut that fails fails only its own lap. |
| Saying it | A session card or banner with several jobs says them **as one line per session**: *"Saving 6 lap videos · 40%"* (the remaining jobs, weighted by bytes). A single job keeps NS-45's wording. A failed lap is still said once, on its own lap's page. |
| Coaches, sharing, export | **No change.** Every clip is an ordinary `lap_clips` row, so a coach watches them all, a shared event plays them all, and the export lists them all. |
| Free accounts | **Unchanged.** The locked row is NS-45's *Save best-lap video* offer. The choice is never drawn locked. |

## Server

- `src/lib/clips.ts`: `CLIP_QUOTA_BYTES = 50 * GiB`. `validateClipCreate`
  accepts `lap_num` (a positive integer, or absent / null) and returns it.
- `src/routes/clips.ts`: the lap lookup adds `AND l.lap_num = ?` when
  `lap_num` is given.
- `contracts/golden/me*.json`: `quota_bytes` becomes 53687091200.

## Shared rule (`public/js/import/clip.js`, pinned by `contracts/logic/lap-clips.json`)

```js
export const CLIP_SCOPES = Object.freeze(["best", "every"]);
export const EVERY_LAP_KINDS = Object.freeze(["pdr"]);
// → [{ lap, index, lapNum }] in lap order. "best" is clipCandidate's one lap
// (or none); "every" is every windowed lap for an EVERY_LAP_KINDS source and
// the best lap for any other video.
export function clipCandidates(parsed, scope)
export function offersEveryLap(items)            // the choice is drawn
export function reviewClipCount(items, scope)    // clips the scope saves
export function reviewClipBytes(items, scope)    // their estimated total
export function clipOffer(items, entitlement, clips, scope = "best")
export function everyLapOfferText(count, bytes)
export function everyLapOfferTextWeb(count, bytes)   // web-only, outside the fixture
export function everyLapFullText(clips)
export function clipRowTitle(everyOffered)       // "Save lap videos" / "Save best-lap video"
```

`clipCandidate` also returns `lapNum`. Every existing pin keeps its value.

## Uploader (`public/js/import/clip-upload.js`, pinned by `contracts/logic/clip-upload.json`)

`newJob` takes `lapNum` (default null), and `createBody` adds
`lap_num` when it's set. The web adds `clipSessionLines(statuses)`, which
collapses one session's jobs into its line, with failures grouped per reason
through `clipFailuresText(reason, n)` (*"Couldn't save 6 lap videos."*). The
web's driver cuts one lap at a time, since each cut reads the source's
`moov`. Both phones port the field and
the body. Their lap-page helpers (`isFor`, `clipLap`) match on `lapNum` when
the job has one, and fall back to the time otherwise.

## Clients

- **Web** (`js/import/ui.js`): the row's choice, the handle list per item
  (`clipHandles(r, scope)`), one `enqueue` per lap, and the New Event form's
  staged body carrying its handles as a non-enumerable `clips` array.
- **iOS**: `LapClips` port, the review's *Save lap videos* choice, one
  `ClipUploader` job per lap with `lapNum` in the manifest, and the lap
  page's status matched by lap number.
- **Android**: the same through `LapClips`, `ClipUploadQueue`, `ClipManifest`,
  `ReviewScreen`'s `ClipRow` and `ClipUploads`.

## Web playback

The web ties a video to its lap, as the phones' lap rows do. Every lap chip
with a clip carries a ▶ joined to its end, both in the plain lap list and in
the channel panel's chips (`chipAfter` on `bindChannelGraphs`). A ▶ opens the
session's **one** player under the chips (`afterChips`), which names the lap
(*Lap 6 video 2:02.11 ★*) and offers *‹ Lap 5* / *Lap 7 ›* to step to the
neighbouring laps with a video (`lapVideoList` / `lapVideoStep`, web-only).
The active lap's ▶ is drawn pressed and hides the player when pressed again.
This replaces the stack of *▶ Lap N video* buttons, which was one button and
one player per clip.

## Tests

- API: `lap_num` picks the second of two tied laps. A `lap_num` whose time
  doesn't match is a 404. A body without `lap_num` keeps the old rule.
  `/me` answers the 50 GiB quota.
- Unit: `clipCandidates` for both scopes over PDR, GoPro and mixed reviews,
  `offersEveryLap`, `clipOffer`'s every-lap quota, the texts, and
  `createBody` with and without `lap_num`.
- Both phones assert the regenerated `lap-clips.json` and `clip-upload.json`.
