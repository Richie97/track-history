# NS-45 — Best-lap video clips (Pro, on R2)

**Phase:** post-rewrite · **Platform:** Server + iOS + Android, with web playback (web *upload* is a follow-up) · **Depends on:** the video importers ([NS-30](NS-30-ios-video-import.md), [NS-32](NS-32-android-video-import.md)), the shared review flow, the offline layers' temp-id maps, `requireEntitlement` · **Estimate:** server + web 4–5 days, each phone 5–6 days · **Issue:** [#399](https://github.com/Richie97/track-history/issues/399) (tickets #400, #401, #402)

## Goal

When a driver imports a session from video, the review asks one question
under the session list:

```
┌───────────────────────────────────────────────────┐
│ ● Save best-lap video                       [ on ]│
│   A clip of each session's fastest lap, about     │
│   150 MB each. Uploads on Wi-Fi. Your coaches     │
│   can watch it too.                         Pro   │
└───────────────────────────────────────────────────┘
                  [ Save 3 sessions ]
```

The switch is **on by default**. When it's on, saving the review does three
things for each included video session. It cuts the session's best lap out
of the source file on the device, without re-encoding, with a few seconds
either side. It saves the session exactly as it does today. Then it uploads
the clip in the background. The clip plays on the lap's page on every
client, for the driver and for the coaches they have invited
([NS-38](NS-38-coach-sharing.md)).

The telemetry stays the record and the video is an extra on top of it. A
clip that fails to cut or upload never costs the session.

## Why

- **It's the one thing a driver can't get back.** The importer reads the
  telemetry out of a 700 MB file and leaves the footage on an SD card that
  gets wiped before the next event. A best lap from two seasons ago survives
  as numbers, but nobody can watch it.
- **It's the obvious Pro feature with a real cost behind it.** Every other
  Pro feature costs us roughly nothing per user. Video costs storage. Storing
  only the best lap instead of the whole day takes that from about 5 GB to
  about 150 MB per session, roughly 1/30 to 1/50 of the size. That's what
  makes it affordable (see *Cost*).
- **It's what a coach wants most.** NS-38 gives an instructor the
  telemetry, but a coach reviewing a student's day wants to watch the lap:
  where the eyes are, the hands, the line through the windscreen. A stored
  clip turns the coach's lap page into a debrief.
- **It sets up the follow-ups worth having.** Video synced to the trace
  cursor and side-by-side video in the two-lap compare both need a stored
  clip first.

## Fixed decisions

| | |
|---|---|
| What is stored | **One clip per imported video session: that session's best lap.** The best lap is the lowest `timeMs` among the session's laps that have a `startT`/`endT` window inside the file. A tie goes to the lower lap number. Only that one clip, never the whole session. |
| The question | **One switch per review, on by default, every time.** It isn't remembered as off between reviews, so the default the user asked for always holds. It applies to every included item that has a clip candidate. It's offered only when at least one included item is a **video file** with a candidate. A phone recording, a `.vbo` or a `.csv` has no video, so the row isn't drawn. |
| Free accounts | The row is drawn **locked** (`ProUpsellCard` / `TEProLocked`, "Save best-lap video — Pro"), never hidden. A 402 is an offer. |
| Cutting | **On the device, passthrough, at save time.** No re-encode: the clip keeps the source's codec and bitrate. Only the video and audio tracks are copied. The telemetry track (PDR's `marl`/`adco`, GoPro's `gpmd`) and file-level metadata, including GPS location atoms, are dropped. The cut happens while the review still has access to the source, because afterwards it may not (security-scoped URLs on iOS, photo-picker URIs on Android). The cut clip goes to app-private storage, so the upload never needs the source again. |
| Window | `PRE_ROLL_S = 3` before the lap's `startT`, `POST_ROLL_S = 2` after its `endT`, clamped to the file. A lap longer than `MAX_CLIP_S = 600` gets no clip. The clip records **`lap_offset_ms`**, which is where the lap starts inside the clip, **measured from the cut result** rather than assumed. A passthrough cut can start at the previous keyframe. |
| Time alignment | Every video parser's `startT`/`endT` is on the telemetry clock: PDR's 10⁷-tick stream, PDR 2.5's event ticks, GoPro's metadata-track sample times. The spec **assumes that clock is the file's media timeline**, which is what it is for a telemetry track muxed into the same MP4. Ticket 1 **verifies this on real footage for all three formats** (`telemetry-samples/pdr-beacons/`, `pdr-caddy/`, a GoPro clip): the cut must start the lap within a frame of the car crossing the line. A format that turns out to be offset gets a per-format correction in `clipWindow`, pinned by the fixture. |
| Storage | **R2**, bucket `track-evolution-clips`, binding `CLIPS`. Keys are `clips/<userId>/<clipId>.mp4`, so one user's objects share a prefix. Standard storage class. Infrequent Access is a follow-up. |
| Upload path | **Multipart, through the Worker, over the R2 binding.** Parts are `CLIP_PART_BYTES = 50 MiB`. R2 requires every part except the last to be the same size, and 50 MiB stays well under the 100 MB request-body cap on the zone's plan. A clip can't go up in one request: 150 MB is over that cap. Going through the Worker rather than to pre-signed S3 URLs means no R2 access keys in the Worker, no SigV4 code (the Worker takes no dependencies), no CORS on the bucket, and the normal session/bearer auth on every part. The Worker streams each part body straight into `uploadPart` and never buffers it. |
| Playback path | **A short-lived signed URL**, not the API with a bearer header. `GET /api/clips/:id/url` returns `{ url, expires_at }`. The URL is `https://<host>/clips/<id>.mp4?exp=<unix>&sig=<hex>`, an HMAC-SHA256 over `"<id>.<exp>"` with the `CLIP_URL_SECRET` secret, valid for **1 hour**. AVPlayer, ExoPlayer, `<video>`, AirPlay and casting all play a plain URL. Header injection would work on some of them and not others. A leaked URL is good for an hour, for one clip. |
| Tier | **Pro to create and to play. Free to delete, always.** `POST /sessions/:id/clip` and `GET /clips/:id/url` sit behind `requireEntitlement`. This is the **third stated exception** to "no write route checks entitlement", after the setup writes and coaching invites, and it is safe for the same reason: a clip isn't a recording, and the session it belongs to has already saved without it. Part uploads and `complete` are **not** gated, so a driver whose Pro lapses mid-upload still finishes. Deleting is never gated: a lapsed driver can always remove their video. |
| Lapse | Clips are **kept and hidden**, on the #264 rule ("a lapse hides the Pro half and never deletes it"). The lap still carries its `clip` metadata, so the client draws a locked player that offers Pro back. Deleting clips after a long lapse is an open question (below). It isn't settled here because at expected scale the cost is small. |
| Quota | **`CLIP_QUOTA_BYTES = 20 GiB` per user**, which is about 130 clips. The sum covers every `ready` clip plus the declared size of every `uploading` one. A create that would exceed the quota is a **409 `{ error: "clip storage full" }`**. The review's row then says *"Your lap video storage is full (20 GB). Delete old clips from a lap's page."* with the switch off and disabled. **Nothing is ever deleted to make room.** |
| Cellular | **Wi-Fi only by default.** Settings gets *"Upload lap videos over cellular"*, off by default. Tracks often have no Wi-Fi, so most clips upload when the driver gets home. Until then the lap row says *Video waiting for Wi-Fi*. |
| Who can see a clip | **The driver and the coaches they have invited.** A coach can **watch** a student's clips, on the student's lap pages, under the coach mount (NS-38). A coach can't download or delete one: the mount answers only `GET`, and the download route isn't in `COACH_ROUTES`. Clips are not on the share page, the leaderboard lap (NS-35), Season Wrapped or the MCP tools. Each of those is a deliberate follow-up with its own consent copy. |
| Coach consent | **Asked where the video is made, not per grant.** No coach has seen a clip before this ships, because none exist, so no existing grant widens over anything already uploaded. From then on, the review row says *"Your coaches can watch it too."* whenever the driver has at least one coach. Every clip is uploaded knowing who will see it. The Coaching page's *what they see* sentence names best-lap videos on all three clients. A driver who wants one clip out of a coach's reach deletes it. A per-grant *include videos* switch is a follow-up if anyone asks for it. |
| Coach tier | **The student's**, as NS-38 decides every coach read. The URL route runs with the student's `entitledUntil`, so a Pro student's free coach watches, and a lapsed student's clips are locked for their coach too. The coach sees *"Lap videos play while <name> has Pro"* rather than an upsell, because the upgrade is the student's, not the coach's (`studentFreeNote`'s rule). |
| Revoking a coach | Takes effect for **new** URLs at once: `requireCoachGrant` answers 404 the moment the grant is gone. A URL already handed out keeps playing until it expires, at most an hour. Any player that can play a URL can also save the file, so revoking stops future viewing, not copies already made. The Coaching page says so in one line (*"Removing a coach stops them watching your videos; it can't take back a video they saved."*), and so does the privacy policy. |
| Offline | Clip **metadata** is cached with the event detail like any other lap field. **Playback needs a connection.** The player says *"Playing a lap video needs a connection"* rather than spinning. A clip saved offline waits locally for its session's real id (see *Uploader*). |
| Export | NS-44's JSON lists each lap's clip as `{ duration_ms, lap_offset_ms, size_bytes, created_at }`, metadata only. The video itself is downloadable from the lap's page (*Download video*). Putting video in a JSON stream would make the export unusable. |
| Web | **Plays, downloads and deletes. Doesn't upload yet.** A passthrough cut in the browser means writing an MP4 remuxer by hand (the web app takes no dependencies). That's a ticket of its own, listed under follow-ups. This makes NS-45 the first feature to land on the phones before the web, which the feature split in `README.md` has to say. The web's import review draws no clip row in v1. |

## Cost

At about 150 MB per clip and the R2 rate of $0.015 per GB-month (10 GB-month
free per account, free egress, request charges negligible):

| | Clips added a year | Storage after a year | Monthly bill then |
|---|---|---|---|
| One driver (10 days × 5 sessions) | 50 | ~7.5 GB | ~$0 (inside the free 10 GB) |
| 100 Pro drivers | 5,000 | ~750 GB | ~$11 |
| 1,000 Pro drivers | 50,000 | ~7.5 TB | ~$110 |

A driver who fills the 20 GiB quota costs about **$0.30 a month**. Upload
traffic is roughly 4 part requests per clip, so 50,000 clips a year is about
200,000 Class A operations, inside the 1 M free each month. Playback costs
one signed-URL request plus range reads (Class B, 10 M free each month).

## Server (ticket 1)

### Migration `0032_lap_clips.sql`

```sql
CREATE TABLE lap_clips (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  lap_id        INTEGER NOT NULL UNIQUE REFERENCES laps(id) ON DELETE CASCADE,
  r2_key        TEXT    NOT NULL UNIQUE,
  upload_id     TEXT,                 -- R2 multipart id; NULL once ready
  status        TEXT    NOT NULL CHECK (status IN ('uploading','ready')),
  size_bytes    INTEGER NOT NULL,     -- declared at create, checked at complete
  duration_ms   INTEGER NOT NULL,
  lap_offset_ms INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE lap_clip_parts (
  clip_id     INTEGER NOT NULL REFERENCES lap_clips(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag        TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  PRIMARY KEY (clip_id, part_number)
);
-- No foreign keys: a tombstone outlives the user, event, session and lap it came from.
CREATE TABLE lap_clip_tombstones (
  r2_key     TEXT PRIMARY KEY,
  upload_id  TEXT,
  deleted_at INTEGER NOT NULL
);
CREATE TRIGGER lap_clips_tombstone AFTER DELETE ON lap_clips BEGIN
  INSERT OR REPLACE INTO lap_clip_tombstones (r2_key, upload_id, deleted_at)
  VALUES (OLD.r2_key, OLD.upload_id, unixepoch() * 1000);
END;
```

Plus the `updated_at` triggers. A clip becoming ready bumps its lap →
session → event, as `0011` does, so the event detail's `updated_at`
changes and every client's prefetch picks up the new `clip`.

**Deleting a row never deletes the object; the cron does.** The trigger
covers every way a clip row disappears: deleting a clip, a lap, a session,
an event or a track, and **account deletion**, because `users` cascades.
That's why account deletion needs no extra runbook step. SQLite fires
child-table triggers on cascaded deletes, and the API test **asserts it**
rather than trusting it: delete an event and its clip's tombstone exists.

### Routes (`routes/clips.ts`, under `/api`, authed)

| Route | Gate | Does |
|---|---|---|
| `POST /sessions/:id/clip` `{ time_ms, size_bytes, duration_ms, lap_offset_ms }` | **Pro** | Finds the session's lap with that `time_ms` (lowest `lap_number` on a tie), ownership-scoped. Refuses with 400 if `size_bytes` > `MAX_CLIP_BYTES` (1 GiB) or `duration_ms` > `MAX_CLIP_S`. Checks the quota (409). Calls `createMultipartUpload` and inserts the row as `uploading`. Answers `{ clip_id, part_bytes, parts, uploaded: [] }`. **Idempotent for resume**: if an `uploading` row already exists for the lap with the same `size_bytes`, it answers that row with the part numbers already stored. A `ready` row answers 409 `{ error: "lap already has a clip" }`. Keying on the session id and `time_ms` rather than a lap id means the client never needs the lap ids a session `POST` doesn't return. |
| `PUT /clips/:id/parts/:n` (raw body) | — | Owner only; the clip must be `uploading` and `1 ≤ n ≤ parts`. Requires `Content-Length`, which must equal `part_bytes`, or the remainder for the last part. Streams the body into `uploadPart` and upserts the part's etag. Answers `{ ok }`. Rate-limited by `CLIP_PARTS` (below). |
| `POST /clips/:id/complete` | — | Every part must be present and their sizes must sum to `size_bytes` (otherwise 409, listing the missing parts). Calls `complete`, sets `ready`, clears `upload_id`, deletes the part rows. Answers the clip. |
| `DELETE /clips/:id` | — | Owner only. Deletes the row. The tombstone and the cron do the rest. Answers `{ ok }`. |
| `GET /clips/:id/url` | **Pro** | Owner only, `ready` only. Answers `{ url, expires_at }`. |
| `GET /clips/:id/download` | **Pro** | Same signature scheme, with `Content-Disposition: attachment; filename="<track>-<date>-lap-<n>.mp4"`. |

Every refusal on another user's clip is a **404**. The router joins
`API_ROUTERS` in `entitlement-gates.test.ts`, where the create, URL and
download handlers are enumerated as gated. The conventions bullet in
`AGENTS.md` names the create route as the third write exception.

### `/clips/*` (outside `/api`, in `run_worker_first`)

`GET /clips/:id.mp4?exp&sig` verifies the signature and expiry with a
constant-time compare. On failure it answers **403**: this URL can't be
used to discover that a clip exists, so 403 confirms nothing. It then
serves from `CLIPS.get(key, { range })` with `Accept-Ranges: bytes`,
`206` for a range request, `Content-Type: video/mp4` and `Cache-Control:
private, max-age=3600`. No session is consulted, because the signature is
the authorization. That lets a player that sends no cookies (AirPlay, a
cast receiver) play it. `sw.js` skips `/clips/`, as it skips
`/api/export/`.

### Event detail

Each lap in `GET /events/:id` gains `clip: { id, duration_ms,
lap_offset_ms, size_bytes } | null`, non-null only for a `ready` clip.
This is **not** stripped for a free account: the clip's existence is the
driver's data, and the locked player is the offer. `withComputed` and the
offline mirrors pass it through untouched. The share endpoint and the
leaderboard lap don't carry it. The share endpoint already strips per-lap
data, so that's a test, not code. The MCP tools' lap summaries drop it,
and the output schemas don't grow.

### The coach mount

- **`COACH_LAP_FIELDS` gains `clip`**, copied through its own allow-list,
  `COACH_CLIP_FIELDS = ["id", "duration_ms", "lap_offset_ms"]`. That's the
  `publicLapChannels` rule: a field added to the clip object later stays
  private without an edit here. `size_bytes` is the student's storage
  bookkeeping, not lap data, so it stays out.
- **`COACH_ROUTES` gains `{ path: /^\/clips\/\d+\/url$/, view:
  coachClipUrl }`**, which copies `{ url, expires_at }`. Under the mount the
  route's owner check runs against the student, so a coach gets URLs for
  that student's clips and nobody else's. `requireEntitlement` reads the
  student's `entitledUntil`. `/clips/:id/download`, `DELETE /clips/:id`
  and every upload route stay off the table, so a coach gets a 404 from
  each.
- Coach URLs are signed the same way as the owner's. `/clips/*` doesn't
  know who asked, which is why a revocation can't recall a URL already
  issued (see *Revoking a coach*).
- `last_viewed_at` is touched by these reads like any other coach read.

### `GET /me`

Gains `clips: { used_bytes, quota_bytes, coach_count }`, which the review
row and Settings read. `coach_count` is the number of coaches who would see
a new clip, so the row can say so without fetching `GET /coaching`. Both native `User` models get the field (optional), and the
goldens capture it.

### Cron

`sweepClips`, beside `sweepOAuth` in the daily `scheduled`:

1. For up to 500 tombstones: `abortMultipartUpload` if `upload_id`, else
   `delete(key)`, then drop the tombstone. A failure leaves the tombstone
   for tomorrow.
2. Delete `uploading` rows older than 7 days. Their tombstones abort the
   upload on the next run.

### Bindings and secrets

`wrangler.jsonc`: `r2_buckets: [{ binding: "CLIPS", bucket_name:
"track-evolution-clips" }]`, plus a `CLIP_PARTS` rate limit (`{ limit: 60,
period: 60 }` per user). `CLIP_URL_SECRET` via `wrangler secret put`.
`Env` gets both, the binding optional so the test pool can supply its own.
The bucket has no public access and no custom domain: every byte goes
through `/clips/*`.

### `src/lib/clips.ts` (pure)

`CLIP_PART_BYTES`, `CLIP_QUOTA_BYTES`, `MAX_CLIP_BYTES`, `MAX_CLIP_S`,
`partCount(size)`, `partSize(size, n)`, `clipKey(userId, clipId)`,
`signClipUrl` / `verifyClipUrl` (WebCrypto HMAC, with time injected), and
`clipFilename`.

### Tests

- **`test/api/clips.test.ts`**: create → parts → complete → url → ranged
  GET against the miniflare R2.
  - Resume: create twice, and get the uploaded parts back.
  - A wrong `Content-Length` is refused.
  - A missing part fails `complete`.
  - Quota: 409 at the edge.
  - A free account gets 402 on create and url, and 200 on delete.
  - A lapsed account can finish an in-flight upload.
  - Another user's clip is 404 on every route.
  - An expired or tampered signature gives 403.
  - Deleting the event leaves a tombstone, and the cron drains it.
  - `clip` is absent from the share and leaderboard responses, and in the
    coach's event detail carries only `COACH_CLIP_FIELDS`.
  - A coach gets a URL for a student's clip, and that URL plays.
  - A coach gets 404 on another student's clip, on the download route, on
    `DELETE`, and on every upload route under the mount.
  - A lapsed student's coach gets 402 on the URL.
  - Revoking the grant makes the next URL request a 404.
  - `/me`'s `coach_count` counts the student's grants.
- **`test/unit/clips.test.ts`**: part arithmetic, the signature, filenames.

## Shared pure logic (ticket 1, web; ported in 2 and 3)

`public/js/import/clip.js` is the reference, in the same spirit as
`js/record/`. The web doesn't cut in v1, but it holds the rule both ports
are pinned to:

- `PRE_ROLL_S`, `POST_ROLL_S`, `MAX_CLIP_S`.
- **`clipCandidate(parsed)`** → `{ lap, index }` or null. The best lap with
  a usable window, only for `kind` ∈ `pdr` / `gopro` (the video kinds),
  never `live`, `vbo` or `csv`.
- **`clipWindow(lap, durationS)`** → `{ startS, endS, lapOffsetS }`, padded,
  clamped to `[0, durationS]`, null over `MAX_CLIP_S`. This is the
  *requested* window: the native cut reports the real offset.
- **`clipOffer(items, entitlement, clips)`** → `"none"` | `"locked"` |
  `"full"` | `"on"`. Which state the review row is in: no candidate among
  the included items, free account, over quota once the candidates'
  estimated sizes are added, or offered and on.
- **`clipOfferNote(clips)`**: the row's second sentence. *"Your coaches can
  watch it too."* when `coach_count ≥ 1`, else nothing. It's one sentence
  for every count: naming coaches belongs on the Coaching page, and a count
  in a switch's subtitle reads as a warning.
- **`estimateClipBytes(lap, fileBytes, durationS)`**: the file's average
  bitrate × the window. The row's "about N MB" and the quota check use it.
- **`canSaveLapVideo(entitlement)`** goes in `entitlement.js` (a new Pro
  decision gets a predicate there first), ported, with a row added to
  `contracts/logic/entitlement.json`.

These are pinned by **`contracts/logic/lap-clips.json`**, generated by
`contracts/logic.mjs` from the committed fixture clips in
`contracts/logic/video/` plus synthetic rows chosen for the ways a port goes
wrong:

- a best lap tied on time;
- a lap whose pre-roll would start before 0;
- a lap ending within `POST_ROLL_S` of the file's end;
- a lap at exactly `MAX_CLIP_S`, which is inclusive;
- a recovered PDR session whose laps are all `estimated`. They still get a
  candidate: an estimated boundary is still a boundary, and the padding
  absorbs the error.

## Web (ticket 1)

- **Event page, session card**: the lap row that has a clip gets a
  **▶ Video** control. Clicking it opens an inline `<video controls
  preload="none" playsinline>` under the row, with its `src` from
  `GET /clips/:id/url`. On the first `loadedmetadata` it seeks to
  `lap_offset_ms`, so playback starts at the lap and the pre-roll is one
  scrub back. Next to it: *Download video* (the download URL) and *Delete
  video*, which asks for confirmation (*"Delete this lap video? The lap and
  its telemetry stay."*).
  - A free account sees `proPanelHtml` in the player's place.
  - Offline, or with `OfflineError`, the panel shows the needs-a-connection
    sentence.
  - **A student view** (`readOnly()`, a coach reading through the mount)
    draws the control and the player, without *Download* or *Delete*. The
    URL comes from `api()`, which already prefixes `/students/<id>`. When
    the student isn't Pro (`ent()`, the student's tier), the player's place
    says *"Lap videos play while <name> has Pro."* instead of
    `proPanelHtml`.
- **Settings → Your data** gains one line: *"Lap videos: 3.2 GB of 20 GB"*.
- **Coaching page**: `COACH_SHARES` names *"your best-lap videos"* beside
  the racing lines, and the coaches list gains the revocation sentence from
  *Revoking a coach*.
- **The import review is unchanged in v1.**

## iOS (ticket 2)

- **Review** (`ReviewScreen`): the row under the item list reads
  `clipOffer` and shows its size estimate. The switch state lives on the
  review's model, starting `true` every time a review opens. The importer
  keeps each item's source alive until the review closes: the
  security-scoped URL's access stays started, or the `PHAsset`'s
  `AVURLAsset`. Today the parse task releases the source when it ends.
  **The source is released on save or discard, never earlier.**
- **Cutting** (`App/Import/ClipCutter.swift`): build an `AVMutableComposition`
  holding only the source's video track and its first audio track over the
  `clipWindow`, then export it with `AVAssetExportPresetPassthrough` to
  `.mp4` in `Application Support/clips/`. The real `lapOffsetS` comes from
  the composition's time mapping. This runs at save, after each session's
  `POST` is issued and **not awaited by it**: the review closes when the
  sessions are saved, as now, and the cut finishes in the background. A cut
  that fails writes nothing and says so once on the lap row (*"Couldn't save
  this lap's video"*).
- **Uploader** (`App/Import/ClipUploader.swift`, with its state machine in
  the Kit as `ClipUploadQueue`, pure and unit-tested). A job is `{ session
  id (temp or real), time_ms, file, size, duration, offset, clip id?,
  uploaded parts }`, persisted as JSON in `Application Support/clips/`.
  - It **waits while the session id is a temp id**, and maps it through
    `OfflineStore`'s id map once the queue flushes.
  - It runs create → parts → complete. Each part is copied to its own file
    and sent with a **background `URLSession`** upload task, so an upload
    survives the app being suspended. `allowsCellularAccess` follows the
    Settings switch.
  - The local file is deleted after `complete` returns 200. On a 409 for
    *full* or *already has a clip*, the job is dropped and the file deleted,
    since neither changes on retry. On transport failures and 5xx it backs
    off.
- **Lap page** (`LapDetailScreen`): with a `clip`, an AVKit `VideoPlayer`
  appears above the trace, fed from the signed URL and seeked to the offset
  on first play, with *Download* (`ShareLink` of the downloaded file) and
  *Delete* in its menu.
  - A free account sees `ProUpsellCard` in its place.
  - A pending local job shows *Video uploading* / *waiting for Wi-Fi*
    instead.
  - The event page's lap row gets a ▶ glyph, spoken as "has video".
  - **Under `StudentLogbook`** (`owner.isReadOnly`) the player shows
    without the menu. The URL comes through `auth.api.scoped(to: owner)`,
    and the locked state is the student-tier sentence, not
    `ProUpsellCard`. A coach has no local upload jobs, so the pending
    states never show for them.
- **Settings**: *Upload lap videos over cellular* and the storage line.
- **Coaching page**: the *what they see* copy in `CoachingScreen` and the
  revocation sentence, worded as on the web.
- `Info.plist`'s `NSPhotoLibraryUsageDescription` currently promises the
  video is "never uploaded or copied". It becomes *"…reads the telemetry
  track of a video you pick to work out your lap times. If you choose to
  save your best-lap video, only that lap is copied and uploaded."*

## Android (ticket 3)

- **Review** (`ReviewScreen` / `RecordingFlow`): the same row. The switch is
  a `rememberSaveable` on the flow model, `true` per review. `ReviewItem`
  keeps its content `Uri`, already readable for the activity's lifetime, so
  the cut at save time can open it.
- **Cutting** (`videoimport/ClipCutter.kt`): `MediaExtractor` over the
  descriptor `ContentByteSource` already opens. Select the video track and
  the first audio track, `seekTo(startS, SEEK_TO_PREVIOUS_SYNC)`, copy
  samples into a `MediaMuxer` (MPEG-4) until `endS`, and take
  `lapOffsetS` from the first sample's presentation time. Output goes to
  `filesDir/clips/`. It runs on `Dispatchers.IO`, outside the save's job.
- **Uploader**: `ClipUploadWorker`, unique WorkManager work per job,
  constrained to `UNMETERED` unless cellular is allowed. It's long-running
  through `setForeground` with a *"Uploading lap video"* notification
  (`foregroundServiceType="dataSync"`, declared). Jobs are a JSON manifest
  in `filesDir/clips/`, **not a Room table**, so the offline database owes
  no migration. The state machine is `:core`'s `ClipUploadQueue`, a port of
  the iOS Kit's with the same tests. Temp ids map through `OfflineStore`.
- **Lap page** (`LapDetailScreen`): Media3 ExoPlayer (`media3-exoplayer`,
  `media3-ui` in `libs.versions.toml`, `:app` only) with the same seek,
  menu, locked and pending states. R8 needs no keep rules: Media3 ships
  consumer rules. Under `LogbookOwnerScope` it follows `readOnly`: no
  menu, the URL comes from the scoped client, and a free student's clip
  shows the student-tier sentence, as on iOS.
- **Settings**: the cellular switch and the storage line.
- **Coaching page**: `CoachingScreen.kt`'s *what they see* copy and the
  revocation sentence.
- **Backups**: `filesDir/clips/` is excluded in **both** backup XMLs. A
  restored manifest pointing at a missing file is a dead job.

## Goldens and native models (ticket 1)

`contracts/generate.mjs` creates one `ready` clip row on the rich event's
best lap. It inserts the row directly, since the goldens are about shapes,
not R2. So the event-detail golden carries `clip` as both an object and a
null, and `me` carries `clips`. The coach-mount event-detail capture
carries the coach's cut of `clip`, so the allow-list is pinned at the
shape as well as by the API test. Both native `Lap` models gain an optional
`clip` (iOS `LapClip?`, Android `LapClip?` with `@SerialName`s) and `User`
gains `clips`, all decoded in the golden tests. Android's
`ignoreUnknownKeys = true` means a shipped build doesn't break when the
server deploys first. The test harness's strict decode is what makes the
models catch up.

## Docs owed (in the same PRs)

- **`site/docs/privacy.html`**: the *Telemetry* section stops saying video
  is never uploaded. Instead: an imported video is read on the device; if
  you choose *Save best-lap video*, a clip of each session's best lap, with
  audio, is uploaded and stored. It's visible to you and to the coaches
  you've invited, never on your share page or a leaderboard. It's deleted
  when you delete it, its lap, or your account. Removing a coach stops
  them watching, but can't take back a video they saved. Bump the
  effective date. The coaching paragraph near line 278 names videos among
  what a coach sees.
- **`site/docs/index.html`**: the *Share with a coach* paragraph (near
  line 264) adds best-lap videos to what a coach sees.
- **`site/docs/telemetry-import.html`**: a *Best-lap video* section with
  the switch, Wi-Fi, quota, where it plays, and deleting. Fix line 324.
- **`site/index.html`**: line 333's "never uploaded" becomes true only of
  the session file. Add a mention in the Pro features.
- **`site/docs/data-model.html`**: line 281, and the share-page privacy list
  (clips never shared).
- **`site/docs/account-deletion.html`**: lap videos are deleted with the
  account.
- **`site/docs/terms.html`**: user-uploaded video under the existing user
  content terms, if it isn't already covered.
- **`README.md`**: the R2 bucket, the secret, `sweepClips`, deploy steps
  (`wrangler r2 bucket create track-evolution-clips`), and the 100 MB body
  cap that sets the part size.
- **`AGENTS.md`**: the routes, the `/clips/*` worker-first path, the
  tombstone arrangement, the third write exception, and `ClipCutter` /
  `ClipUploadQueue` on both phones. The NS-38 `coaching.ts` bullet gains
  `/clips/:id/url` in `COACH_ROUTES` and `COACH_CLIP_FIELDS`.
- **`NS-38-coach-sharing.md`**: its *What is shared* decision adds
  best-lap videos (watch only) and points here.
- **`NS-32-subscriptions.md`**: a tier-table row, *"Best-lap video:
  saving, playing, downloading — **Pro**; deleting — free. Server:
  `requireEntitlement` on create, url, download."*
- **`docs/specs/native/README.md`**: the index row, plus a feature-split
  line saying this is the one feature that lands **native-first**, and why
  (browser remuxing).
- **App Store privacy label**: *Photos or Videos*, linked to the user, not
  used for tracking. **Play Data safety**: *Photos and videos*, collected,
  not shared, user-deletable.

## Tickets

1. **Server + shared logic + web playback**: the migration, routes,
   `/clips/*`, cron, `lib/clips.ts`, `clip.js` with its fixture,
   `canSaveLapVideo`, the goldens and both native models' fields, web
   playback/download/delete, Settings' line, and the docs above except the
   store forms. Verifying the media-timeline alignment on real footage for
   PDR, PDR 2.5 and GoPro is part of this ticket. Its result is written
   into *As built*.
2. **iOS**: the review row, `ClipCutter`, `ClipUploadQueue` (Kit) +
   `ClipUploader`, the lap-page player, Settings, `Info.plist`, the App
   Store label. A UI test runs `-importFixture` with the switch on against
   `npm run dev` and asserts the lap page plays. The fixture clips are tiny,
   which is the point.
3. **Android**: the same, plus Data safety. `ClipCutterTest` (Robolectric
   can't mux, so the cut runs as an instrumented test or is skipped with a
   stated reason) and `ClipUploadQueueTest` on the JVM. `RecordingFlowImportTest`
   asserts a save with the switch on posts the session first and enqueues
   one job per candidate.

## Acceptance criteria

- [ ] Importing a PDR, PDR 2.5 or GoPro video on either phone, as Pro, shows
      the *Save best-lap video* row **on**. Saving uploads one clip per
      included video session, and that clip plays on the best lap's page on
      all three clients, starting at the line.
- [ ] Turning the switch off saves the sessions and uploads nothing. The
      next review opens with it on again.
- [ ] A recording, `.vbo` or `.csv` review draws no row. A free account
      sees it locked, as an offer.
- [ ] The session saves even when the cut or the upload fails, and a clip
      saved offline uploads once its session syncs.
- [ ] The clip contains no telemetry track and no location metadata.
- [ ] Quota full gives a disabled row in words. Nothing is deleted to make
      room.
- [ ] Deleting a clip, its lap, session or event, or the account, removes
      the R2 object within a day.
- [ ] A coach plays a Pro student's clips on the student's lap pages, on
      all three clients, whatever the coach's own tier. They can't
      download or delete one, and they get nothing from another student.
- [ ] A coach of a lapsed student sees the clip locked with the
      student-tier sentence, not an upsell. A removed coach's next play
      fails.
- [ ] The review row says *"Your coaches can watch it too."* exactly when
      the driver has a coach, and the Coaching page names videos among
      what coaches see, on all three clients.
- [ ] No clip is reachable from the share page, the leaderboard or the MCP
      tools.
- [ ] A lapsed account keeps its clips. They're locked, not gone, and still
      deletable.
- [ ] Privacy policy, store forms and the import docs say what is uploaded.

## As built (ticket 1)

Server, shared logic, goldens, native model fields and web playback. Where the
code differs from the text above, and why:

- **Ids and keys.** `lap_clips.id` is `AUTOINCREMENT`: the R2 key is derived
  from the id, and a reused id would put a new clip under a key whose tombstone
  the cron hasn't drained yet, which would then delete the new object. The row
  is inserted with a `pending/<uuid>` placeholder key, which the create swaps
  for `clips/<userId>/<clipId>.mp4` once `createMultipartUpload` answers. A
  failed create deletes the row; its tombstone names an object that never
  existed, and deleting that is a no-op.
- **The quota is folded into the insert** (`INSERT … SELECT … WHERE used +
  size ≤ quota ON CONFLICT(lap_id) DO NOTHING`), so two creates at once can't
  both slip under it, and two creates of one lap give one row.
- **Length limits.** The 400s are `time_ms > MAX_CLIP_S × 1000` (the lap) and
  `duration_ms > (MAX_CLIP_S + 30) × 1000` (the clip). A literal
  `duration_ms > MAX_CLIP_S` would refuse the 605 s clip of a 600 s lap, which
  `clipWindow` says is inclusive.
- **Resume with a different size** (a re-cut) deletes the old uploading row,
  whose tombstone aborts its upload, and starts again. **`complete` on a ready
  clip answers the clip**, so a retry after a lost response is harmless.
- **Download is a 302** to the signed URL with `&dl=1`, which isn't part of
  the signature (it only adds `Content-Disposition`). The filename comes from
  D1 when the file is served. A redirect lets a plain link (the web) and a
  downloading client (the phones) use the same route. `expires_at` is ms, like
  every other timestamp the API answers.
- **`/me`** carries the storage as `user.clips`, which is where both native
  `User` models read it.
- **The web control** sits under the session's lap chips, one *▶ Lap N video*
  button per clipped lap (*Hide lap N video* while open), rather than on the
  lap row itself. An imported session's lap list is the channel panel's
  chips, which the panel owns. The player is `preload="metadata"`, not
  `"none"`, and seeks as soon as the metadata is in: with `"none"` it opened
  as an empty box at 0:00 until pressed, and the URL is fetched on the click
  anyway. The toggle is one delegated listener bound once, so a click that
  lands while the page re-renders still reaches the button under it. The
  signed URL is read with `api(path, { cache: false })`, new in `js/api.js`,
  which neither reads nor writes the offline cache.
- **The goldens** upload the clip through the routes into the harness's
  local R2 rather than inserting the row, which exercises the routes for
  free. The upload routes themselves aren't captured: their shapes are the
  phones' ticket, and pinning them now would make both golden suites demand
  models for them.
- **`clip.js`** takes review items as `{ parsed, include, fileBytes }` (the
  native `ReviewItem`'s names plus the file size). `VIDEO_KINDS` is
  `["pdr", "gopro"]`: PDR 2.5 resolves to `pdr`, and Track Precision's CSV
  parses as `trackprecision`, not `csv`. It also carries the row's and
  Settings' wording (`clipOfferText`, `clipFullText`, `clipStorageLine`,
  `fmtClipBytes`), pinned with the rest so the phones say the same thing.

**Not done in ticket 1:**

- **Media-timeline alignment was verified on real footage after the build,
  for PDR and PDR 2.5** (one Corvette clip, three Blackwing clips, against
  this ticket's code; PR #403). The telemetry clock is the media timeline to
  within about a quarter second: the Corvette's burned-in speed readout trails
  the telemetry by a steady ~0.24 s, which is the readout's own render delay,
  and on the Blackwing the car moves ~0.2 s after telemetry says it did and
  stops on the same frame. That is well inside `PRE_ROLL_S`, so **no
  per-format correction** goes into `clipWindow`. `clipCandidate` picked the
  right lap on all four, and `estimateClipBytes` came within 1–7% of the real
  passthrough cuts. **GoPro remains unverified on real footage**; ticket 2
  checks it. Two facts for the cutters came out of it:
  - **Keyframe spacing differs by recorder.** The Corvette PDR writes one
    every 1.475 s, so a passthrough cut can start up to ~1.5 s before the
    requested window: a cut put the lap 3.317 s in, not 3 s. The cutter must
    report the offset it actually got, as *Window* says. PDR 2.5 has a
    keyframe on every frame, so its cuts land exactly.
  - **PDR 2.5 files carry a fourth stream**, an MJPEG cover image, beside
    video, audio and the `adco` telemetry. Map only the *first* video track
    and the first audio track, as *Cutting* says; a cutter that copies
    "every video track" picks up the cover image.
- **The user-facing how-to** (`telemetry-import.html`'s *Best-lap video*
  section, the landing page's Pro mention, `docs/index.html`'s coaching
  paragraph) waits for ticket 2. Until a phone offers the switch, those pages
  would advertise a feature nobody can use. What ships now is what is already
  true: the privacy policy, the terms, account deletion, the data model's
  privacy list, and the web Coaching page's *what they see* sentence.
- **The native test suites weren't run here** (no Swift toolchain; Google's
  Maven repository is blocked, so Gradle can't configure the Android build).
  CI runs `LapClipGoldenTest(s)` and the entitlement fixture tests on both.

## As built (ticket 2, iOS)

- **One clip per session**, as written; the open question below is settled.
- **The Kit** carries `LapClips` (the port of `clip.js`, same names, pinned by
  `lap-clips.json`; `fmtClipBytes` rounds tenths of a GiB over the integers,
  which is `toFixed(1)` on the exact quotient) and `ClipUploadQueue`, the
  state machine, with its transition table on the type and one test per row
  for Android to port. Beyond the spec's rows: a 404 on a part or `complete`
  (the clip deleted elsewhere, or swept after a week) **restarts from the
  create**, at most `MAX_RESTARTS` (3) times; 401, 408 and 429 back off like
  5xx; a temp session id whose create is no longer queued and never mapped is
  *lost* and the job dropped. Backoff is 30 s doubling to an hour, and
  nothing is dropped for being offline. `APIClient` gained `createClip`,
  `completeClip` (its 409 carries `missing` as `ClipMissingParts`),
  `deleteClip` (live, never queued), `clipURL` (past the cache) and
  `authorizedRequest` for the background session; `OfflineStore` answers
  `hasQueuedCreate(tempId:)`.
- **The cut lands on the requested start, and the offset is measured.**
  AVFoundation's passthrough export copies from the keyframe before the
  window and writes an **edit list** that hides the frames before it, so a
  Corvette clip's first presented frame is the source frame at the requested
  start (checked frame-for-frame with `ffmpeg -f framemd5`) and its offset
  comes back 3.000 s — not the 3.317 s an ffmpeg `-c copy` cut gives. The
  measurement still reads it from the file (the source keyframe plus the
  output edit list's skip), so a player or a muxer that behaves otherwise is
  reported honestly. One trap found on the way: a sample cursor works in
  *media* time, which an encoder with B-frames offsets from track time behind
  its own edit list, so the source keyframe is looked up through the track's
  segments (`ClipCutter.sourceKeyframe`); without that the phone's own H.264
  came back 250 ms out.
- **The Corvette's PDR audio is invisible to AVFoundation.** `AVURLAsset`
  lists the H.264 track and the `marl` track and no audio at all (its AAC has
  a media timescale of 440,988), while AudioToolbox reads it. A composition
  can only copy what AVFoundation sees, so that file goes through `ClipRemux`
  — an `AVAssetWriter` fed the video by an `AVAssetReader` and the audio as
  raw AAC packets from `AudioFileReadPacketData`, still no re-encode, session
  started at the window's start so the writer writes the same edit list. The
  Blackwing's audio is visible and takes the composition path.
- **PDR 2.5's cover image** isn't exposed by AVFoundation as a track at all
  on these files; `firstPictureTrack` skips a JPEG video track anyway, in
  case another recorder's is.
- **Verified on real footage** (a macOS harness over the same source file):
  Corvette lap 6 (`startT` 681.544 s) → 127.110 s, 86 MB, h264 + aac, offset
  3000 ms; ADV_1635 lap 2 (`startT` 283.234 s) → 86.345 s, 75 MB, offset
  3000 ms; ADV_1633/1640 likewise. Every output: exactly one h264 and one aac
  stream, no data or MJPEG stream, no `udta`/`meta` (the Blackwing's `title`
  and `grouping` tags gone). About half a second per cut. **GoPro is still
  unverified on real footage** — no GoPro recording was to hand.
- **Not awaited, and staged when there's no session yet.** `ReviewModel.save`
  posts each session and then calls `ClipUploader.cutAndQueue`; a review that
  hands its drafts to the New Event form (`forNewEvent`, or *Save to a new
  event*) stages each cut against its draft, and `EventFormModel` calls
  `sessionPosted` with the id once it posts it. A staged cut the form never
  posts is held in memory until the app ends.
- **Pending and failed states** are the owner's only: *Video uploading* (also
  while the cut runs) or *Video waiting for Wi-Fi* when the only network is
  expensive and cellular is off; a failed cut is remembered in the manifest
  and said once on the lap page (*Couldn't save this lap's video*), on the
  lap the server would attach the clip to (the lowest lap number with the
  time). An open lap page re-reads its event when an upload finishes.
- **A lapsed owner** sees `ProUpsellCard` *and* a *Delete video* button —
  deleting is free, always. (The web's free state shows only the Pro panel;
  that's ticket 1's, and worth matching.)
- **Download** asks `/clips/:id/download` with the bearer, follows the 302,
  keeps the server's filename and offers the file through `ShareLink`.
- **The UI test** (`LapClipUITests`) can't cut the committed fixtures, which
  carry no picture; DEBUG `-syntheticClipVideo YES` swaps in a generated
  160×90 H.264 file of the same length, so the cutter, the queue, the
  background part upload, `complete`, the signed URL and the player are all
  the production path. It asserts the clip arrives with a 3000 ms offset and
  the lap page's player reaches *ready*.
- **The how-to ships with it**: `telemetry-import.html`'s *Best-lap video*
  section (and its "never uploaded" lines, 324 among them, now say what is),
  the landing page's Pro list and import paragraph, and `docs/index.html`'s
  coaching paragraph — worded for the iPhone app, so the Android ticket
  widens them rather than rewrites them.
- **Owed outside the code:** the App Store privacy label (*Photos or Videos*,
  linked to the user, not used for tracking) is a Console form.

## As built (ticket 3, Android)

The review row, `ClipCutter`, `ClipUploadQueue` + `ClipUploadWorker`, the lap
page's player, Settings and the Coaching copy. Where the code differs from the
text above, and why:

- **`ClipUploadQueue` is the iOS Kit's, ported.** The two phones were built
  in parallel and first wrote two different queues; they were then made one
  before merging: `:core`'s `ClipUploadQueue` is the Kit's state machine under
  the same names, with `ClipUploadQueueTests` ported one for one, so both
  phones follow the transition table on the Kit's type (summarised under
  *As built (ticket 2)*) — create only
  without a clip id (a held one resumes at the next part), drop on any create
  refusal, restart from create on a 404 mid-upload at most `MAX_RESTARTS` (3)
  times, send exactly the parts `complete`'s 409 names, and back off on
  transport, 401, 408, 429 and 5xx from 30 s doubling to an hour, **never
  dropping for that**. `ClipUploadRunner` is the loop that drives it, and
  `ClipUploadWorker` re-enqueues a waiting job with the queue's own delay
  rather than WorkManager's backoff. Two details came out of the comparison
  and are now the same on both: a temp id's *queued* create is read **before**
  its id map (a flush writes the map and then deletes the queued item, so the
  other order could call a just-saved session lost), and the lap page shows a
  pending upload only on `clipLap`'s lap — the lowest lap number with the
  clip's time, the server's rule. What still differs is plumbing, not policy:
  Android keeps its jobs' cut state on the job (`CUTTING` / `PENDING` /
  `CUT_FAILED`) where iOS keeps failed cuts in a list beside them, and a
  missing cut file is dropped before the first request rather than when a part
  is copied out — both as `refused`.
- **A job exists before its cut.** It is written `CUTTING` the moment the
  review hands it over, so the lap page can say *Video uploading* at once; a
  process that dies mid-cut leaves it `CUT_FAILED` at the next start (the
  source's grant died with the process), which the lap page says for a week
  before the job is pruned.
- **The review row is a card the whole of which is the switch**, under the
  session list. Locked, it is `TEProLocked` titled *Save best-lap video* with
  `clipOfferText` and one sentence about who can watch; its *See Track
  Evolution Pro* opens the paywall over the review. The size in "about N MB
  each" is the largest included candidate's estimate. The switch is plain
  state on `RecordingFlow`'s `ReviewUiState` (held by the activity-outliving
  model, like the rest of the review) rather than a `rememberSaveable`: every
  fresh review state starts it on.
- **Drafts staged on the New Event form keep their clips.** An import begun
  from the form, and a review's *Save to a new event*, have no session to
  attach a clip to until the form posts the drafts, so the clips wait in
  `RecordingFlow` and are handed over when the form reports the session ids it
  got back (`EventFormModel.postedStagedIds`). A draft removed from the form is
  never posted, so its clip is never cut.
- **The cut** selects the first H.264 or HEVC track, then any other non-JPEG
  video track, so PDR 2.5's MJPEG cover is never the video wherever it sits;
  an audio track MPEG-4 can't hold is dropped rather than failing the cut; and
  a window the file doesn't reach is refused rather than cut from the file's
  last keyframe. `MediaMuxer` writes no location (and only `creation_time` and
  `com.android.version` as file metadata).
- **Download** goes through `GET /clips/:id/download` into the cache's
  `clip-downloads/` — the app's FileProvider's second path, beside Wrapped's —
  and then the share sheet (Save to Files, Drive, Photos), the counterpart of
  iOS's `ShareLink`; nothing is written to shared storage, so no storage
  permission is needed down to API 26.
- **The player is tap to load**: the lap page draws the card and fetches the
  signed URL when the driver asks to watch, so opening a lap in a paddock
  costs no request. The player is prepared at `lap_offset_ms`, so it opens on
  the lap's first frame.
- **Verified on real footage**, on an emulator (API 37), through the real
  parser, `clipCandidate` and the cut (`ClipCutterTest`'s real-footage cases):
  the Corvette PDR's lap 6 (2:02.110 from 681.544 s) cut to 90.2 MB (estimate
  90.9 MB) in 4.3 s with the lap at **3.317 s** — the keyframe at 678.227 s,
  matching ticket 1's finding — and the Blackwing's `ADV_1635.mp4` lap 2
  (1:21.345 from 283.234 s) to 78.9 MB (estimate 84.7 MB) in 1.4 s with the lap
  at **3.026 s**, the frame at 280.208 s. `ffprobe` on both cuts: one `h264`
  video stream and one `aac` audio stream, no data stream (`marl` / `adco`),
  no MJPEG, no location tag. GoPro remains unverified on real footage.

## Open questions

- **Per session or per review?** Settled for ticket 2: per session, as this
  spec says (a day of five sessions gives five clips). The alternative was one
  clip per review, the batch's single fastest lap — a fifth of the storage,
  but it loses the morning-vs-afternoon comparison.
- **Audio.** Kept, because engine and tire noise are much of why anyone
  rewatches a lap. But an in-car mic also records the instructor and any
  passenger. An *include audio* toggle would cost one more control on the
  review.
- **Retention after a lapse.** Clips are kept forever as written. If lapsed
  accounts with clips become a real share of storage, a policy like
  *"deleted 12 months after Pro ends, with notice in the app"* needs the
  privacy policy and a notice surface. There's no email sending today.

## Follow-ups, deliberately not here

- **Web upload**: a dependency-free MP4 passthrough cutter in
  `public/js/import/`, which matters most for PDR cards read on a laptop.
  Specified in [NS-47](NS-47-web-clip-upload.md).
- **Video synced to the trace cursor**: the lap page's channel charts and
  the player share one clock through `lap_offset_ms`. It also needs a
  distance → time mapping, which `lapTimeSeries` already provides.
- **A per-coach *include videos* switch**: only if a driver asks for it.
  Deleting a clip already covers one clip.
- **Coach comments pinned to a moment in a clip**: needs the first
  coach *write*, which NS-38 rules out.
- **Side-by-side video in the two-lap compare.**
- **Clips on the leaderboard lap (NS-35)**: needs a third consent beside
  `leaderboard_share_laps`.
- **Infrequent Access** for clips untouched for 90 days.
- **Saving a lap other than the best**: a per-lap *Save video* action that
  needs the source file again, so it has to be done at review time.
