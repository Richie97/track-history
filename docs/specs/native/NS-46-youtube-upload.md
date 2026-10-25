# NS-46 — Publish a best-lap video to YouTube

**Phase:** post-rewrite · **Platform:** Server + web + iOS + Android (the upload runs on the server, so every client is a form and a status line) · **Depends on:** best-lap video clips ([NS-45](NS-45-best-lap-clips.md)), `requireEntitlement`, the daily cron, a Google Cloud project that has passed OAuth verification **and** the YouTube API Services audit (ticket 0) · **Estimate:** Google review is weeks of lead time with little work in it; server + web 5–6 days; each phone 2–3 days · **Issue:** [#409](https://github.com/Richie97/track-history/issues/409) (tickets #410, #411, #412, #413)

## Goal

A best-lap clip that is already stored ([NS-45](NS-45-best-lap-clips.md)) gets
one more action in its menu on the lap page: **Upload to YouTube…**

```
┌───────────────────────────────────────────────────┐
│ Upload to YouTube                                 │
│                                                   │
│ Title                                             │
│ ┌───────────────────────────────────────────────┐ │
│ │ VIR Full · 2:02.110 · Corvette C7             │ │
│ └───────────────────────────────────────────────┘ │
│ Description                                       │
│ ┌───────────────────────────────────────────────┐ │
│ │ Best lap of Session 3 at Virginia Inter-      │ │
│ │ national Raceway (Full), 14 June 2026.        │ │
│ │ Lap starts at 0:03.                           │ │
│ │                                               │ │
│ │ Logged with Track Evolution —                 │ │
│ │ https://trackevolution.app                    │ │
│ └───────────────────────────────────────────────┘ │
│ Visibility   ( Private )( ● Unlisted )( Public )  │
│                                                   │
│ Uploading to eric@… · Not made for kids           │
│                              [ Upload ]           │
└───────────────────────────────────────────────────┘
```

The driver taps **Upload**, and the sheet closes. The **server** copies the
clip from R2 to YouTube in the background. The phone doesn't need to stay
open, nothing goes over its cellular connection, and the web can do it as
well as the phones. The lap page then shows *Uploading to YouTube · 40%*,
and when YouTube has accepted it, *On YouTube · Unlisted* with an
**Open** link that stays on the lap.

The first time, the sheet is a **Connect YouTube** step instead: a Google
consent screen in the system browser, asking for permission to **upload
videos and nothing else**.

## Why

- **The clip is the thing people want to show.** NS-45 made the best lap
  watchable inside the app, for the driver and their coach. The next thing a
  driver does with a good lap is send it to the group chat, the car club
  forum or their instructor's inbox, and in this sport a YouTube link is how
  that's done.
- **The server already has the bytes.** The clip is in R2. A server-to-server
  copy costs the driver nothing: no 150 MB download back to a phone in a
  paddock, no re-upload over cellular, no app left open.
- **The metadata is ours to fill in.** Track, layout, lap time, session, car
  and where the lap starts in the clip are all known. A driver uploading by
  hand types a worse version of that, or uploads "VID_20260614_142233.mp4".
- **The link comes back.** The YouTube video is recorded against the lap, so
  the logbook says where the lap went, and a follow-up can put a public video
  on the share page.

## Alternatives considered

These are written down because the first one already works, and the cost of
this spec is mostly Google's review rather than code.

1. **Do nothing.** Both phones can already do this: lap page → *Download
   video* → share sheet → the YouTube app. That costs a 150 MB download to
   the phone, the YouTube app's own upload screen with an empty title, no
   link back to the lap, and on the web a download followed by YouTube
   Studio. **This stays the fallback.** If ticket 0's Google review fails or
   drags on, the cheap improvement is to give that share sheet a pre-filled
   title and description (`ShareLink`'s subject/message, `EXTRA_SUBJECT` /
   `EXTRA_TEXT`). It needs no Google review at all.
2. **Upload from the phone** with Google Sign-In on the device and a
   resumable upload from the local cut. Rejected. The local cut is deleted
   once R2 has it, so the phone would download it again first. It would mean
   three implementations, not one, with the web left out or done again in
   the browser. Upload tokens would live on three clients. And iOS would
   gain the Google Sign-In SDK as its first third-party auth dependency.
3. **Ask for the YouTube scope on the existing Google sign-in** (incremental
   authorization). Rejected for three reasons:
   - Drivers who sign in with Apple have no Google grant to extend.
   - A driver's channel is often a different Google account, or a brand
     account, from the one they sign in with.
   - Putting `youtube.upload` on the sign-in OAuth client would put the
     sign-in consent screen under the YouTube audit. A failed audit would
     then be a sign-in problem.

## Fixed decisions

| | |
|---|---|
| What can be uploaded | **A `ready` NS-45 clip, by its owner. Nothing else.** That means no other lap, no whole session, and no clip that's still uploading to R2. One YouTube upload per clip at a time. |
| Where the upload runs | **On the server**, from R2 to YouTube's resumable upload endpoint, one chunk per **Cloudflare Queue** message. Not `waitUntil`, which ends 30 s after the response. Not a single long request, which a dropped client would kill. Each step is short, resumable and retried by the queue. |
| Chunks | **`YT_CHUNK_BYTES = 32 MiB`**. YouTube requires chunk sizes to be a multiple of 256 KiB. A 150 MB clip goes up in five steps. Each chunk is read with `CLIPS.get(key, { range })` and passed to `fetch` through a `FixedLengthStream`, so the request carries a `Content-Length` and the Worker never buffers the chunk. **The offset after each chunk is the one YouTube reports** in its `308`'s `Range` header, never our own count. |
| The connection | **Its own OAuth grant, separate from sign-in**, against a **separate Google Cloud project** ("Track Evolution YouTube": `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`). The scopes are `https://www.googleapis.com/auth/youtube.upload`, `openid` and `email`. `openid` and `email` are there so Settings can say which account is connected. Nothing more: the app can't list, change or delete anything on the channel, and the consent screen says so. `access_type=offline`, `prompt=consent`, PKCE S256, a state cookie. One connection per user. |
| Storing the grant | The refresh token, the current access token and the resumable session URL are **encrypted at rest** (AES-GCM, `YOUTUBE_TOKEN_KEY`, a random IV per value). D1 never holds a usable credential in plaintext, the same rule `auth_sessions` and `oauth_tokens` follow by hashing. Encryption rather than hashing, because we have to send these back to Google. |
| Native connect | The phone can't hand its bearer token to a browser. `POST /api/youtube/connect` mints a **single-use, 5-minute ticket**, stored hashed, and answers `{ url }`, which is `https://<host>/youtube/connect?ticket=…`. The app opens that in `ASWebAuthenticationSession` (callback scheme `trackevolution`) or a Chrome Custom Tab. Never a WebView: Google blocks OAuth there. The callback redirects to `trackevolution://youtube?result=connected\|denied\|error`. The web goes to `/youtube/connect` with its session cookie and comes back to `#/settings`. |
| Metadata | **The server builds the draft** (`GET /api/clips/:id/youtube/draft`), so all three clients pre-fill the same words with no port. The driver can edit the title and description and pick the visibility. The rest is fixed: `categoryId: "2"` (Autos & Vehicles), `selfDeclaredMadeForKids: false` (stated on the sheet), tags `["track day", "HPDE", <track>, <car>]`. **No location is ever sent**: no `recordingDetails`. NS-45 already strips location atoms from the clip, and the metadata doesn't add them back. |
| Default visibility | **Unlisted.** It's the setting that matches sharing a link with a club or an instructor, and a public upload should be a choice the driver makes. Private and Public are one tap away. |
| Tier | **Pro to draft and to upload. Free to disconnect, always.** `GET …/youtube/draft` and `POST …/youtube` sit behind `requireEntitlement`. This is the **fourth stated exception** to "no write route checks entitlement", after the setup writes, coach invites and the clip create. It's safe for the same reason as those: it writes nothing to the logbook, and the clip it reads is Pro to play and download already. Connecting is ungated, since a ticket costs nothing, and disconnecting is never gated. A lapse doesn't stop an upload already in the queue, matching NS-45's rule that a lapse doesn't stop a part upload. The client predicate is **`canSaveLapVideo`, reused**: publishing is the same decision about the same clip as downloading it, and a second predicate that always answered the same would be one more name to keep in step. |
| Coaches | **Never.** No route here is in `COACH_ROUTES`, so every one of them is a 404 under the mount. `clip.youtube` isn't in `COACH_CLIP_FIELDS`, so the allow-list keeps the link from a coach without an edit. A driver who wants their coach to watch already has NS-45. |
| Share page, leaderboard, MCP | **Not carried.** They don't carry `clip` at all. Showing a *public* YouTube video on the share page is a follow-up with its own copy. |
| Deleting | **We never delete a YouTube video**, and we can't: `youtube.upload` doesn't allow it. Deleting the clip in the app (or its lap, session, event or the account) deletes our upload record and leaves the YouTube video alone. The delete confirmation says so when there's an upload: *"The copy on YouTube stays. Delete it in YouTube Studio."* Disconnecting says the same: *"Videos you've uploaded stay on YouTube."* |
| Re-uploading | A `done` upload blocks another with **409 `{ error: "already on youtube" }`**. A `failed` one can be retried, which resets the same row. When the daily refresh (below) finds the video is gone from YouTube, it deletes the record, and the lap offers the upload again. |
| Quota | YouTube's quota belongs to the **project**, not the user, so one driver can't be allowed to spend it all. **`MAX_DAILY_UPLOADS_PER_USER = 10`** in any 24 h (429 `{ error: "youtube upload limit" }`, *"You can upload 10 videos to YouTube a day."*). There's also a project budget, **`YOUTUBE_DAILY_BUDGET`** (an env var, counted in D1). When the budget is spent, new uploads stay `queued`, the message is retried at the next midnight Pacific (YouTube's reset), and the lap says *"Waiting for YouTube — uploads continue tomorrow"*. A YouTube `quotaExceeded` or the channel's own `uploadLimitExceeded` is handled the same way. **The current per-upload cost is ticket 0's to confirm** (see *Google prerequisites*). |
| Availability | **Feature-flagged** by the three secrets, like Sign in with Apple's four. `YOUTUBE_ALLOWLIST` (comma-separated emails, optional) narrows the feature to the listed accounts while it is set. That covers the audit reviewers and our own testing before launch. `GET /me`'s `user.youtube.available` is the one switch every client reads. A client that's told `false` draws nothing: no menu item, no Settings section. |
| Offline | Upload and connect need a connection, and the control stands down with *"Uploading to YouTube needs a connection."* Neither is queueable: `QUEUEABLE` and both native whitelists stay as they are, and a test pins that. `clip.youtube` is cached with the event detail like the rest of `clip`, so the *On YouTube* link shows offline. Opening it is the browser's business. |
| Google's policies | The consent copy, Settings and the privacy policy say what Google's API terms require: that we use **YouTube API Services**, with links to the **YouTube Terms of Service** and the **Google Privacy Policy**. They also say how to revoke access, both in Settings and at Google's own permissions page (`https://myaccount.google.com/permissions`). API data we keep (the account email, the channel title, each video's id and status) is **re-checked or deleted within 30 days**, by the daily cron. A revoked grant's data is deleted within 30 days as well. |

## Google prerequisites (ticket 0, no code, start first)

This is the long pole and can't be compressed, so it starts the day this spec
is accepted, alongside ticket 1:

1. **A separate Google Cloud project**, with the YouTube Data API v3 enabled
   and an OAuth client of the web type. Its redirect URIs are
   `https://trackevolution.app/youtube/callback` and the dev host's.
   `trackevolution.app` gets verified in Search Console for that project.
2. **OAuth app verification for `youtube.upload`**, which is a sensitive
   scope. It needs the consent screen, the privacy policy's YouTube section
   live (ticket 1 ships it ahead of the feature), and a demo video of the
   connect and upload flow on an allowlisted account.
3. **The YouTube API Services compliance audit.** Videos uploaded by an
   **unaudited** project created after July 2020 are locked to **private**,
   whatever visibility was asked for, and passing the audit later doesn't
   unlock videos already uploaded. **So the feature doesn't launch, and the
   allowlist stays on, until the audit passes.** Before that, every upload is
   ours and is deleted.
4. **Confirm the quota.** Published figures disagree. Older documentation
   charges `videos.insert` 1,600 of the default 10,000 daily units, which
   allows six uploads a day for the whole project. Newer reports describe a
   separate daily upload allowance. Read the project's actual quota page,
   ask for an increase in the audit if needed, and set `YOUTUBE_DAILY_BUDGET`
   from it. The figure goes into *As built*.

## Server (ticket 1)

### Migration `0033_youtube.sql` (or the next free number when it lands)

```sql
CREATE TABLE youtube_connections (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_sub        TEXT    NOT NULL,
  email             TEXT,
  channel_title     TEXT,               -- learned from the first upload's response
  refresh_token_enc TEXT    NOT NULL,
  access_token_enc  TEXT,
  access_expires_at INTEGER,
  status            TEXT    NOT NULL CHECK (status IN ('ok','revoked')),
  connected_at      INTEGER NOT NULL,
  verified_at       INTEGER NOT NULL,   -- the 30-day re-check
  updated_at        INTEGER NOT NULL
);
CREATE TABLE youtube_connect_tickets (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE youtube_uploads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  clip_id         INTEGER NOT NULL UNIQUE REFERENCES lap_clips(id) ON DELETE CASCADE,
  status          TEXT    NOT NULL CHECK (status IN ('queued','uploading','done','failed')),
  title           TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  privacy         TEXT    NOT NULL CHECK (privacy IN ('private','unlisted','public')),
  session_url_enc TEXT,               -- the resumable session URI; a capability, so encrypted
  bytes_sent      INTEGER NOT NULL DEFAULT 0,
  restarts        INTEGER NOT NULL DEFAULT 0,
  lease_until     INTEGER,            -- one queue step at a time
  video_id        TEXT,
  error           TEXT,               -- the words the lap page shows
  created_at      INTEGER NOT NULL,
  verified_at     INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE youtube_daily (day TEXT PRIMARY KEY, uploads INTEGER NOT NULL);
-- No foreign keys: a revocation outlives the account it came from.
CREATE TABLE youtube_revocations (
  refresh_token_enc TEXT PRIMARY KEY,
  queued_at         INTEGER NOT NULL
);
CREATE TRIGGER youtube_connection_revoke AFTER DELETE ON youtube_connections BEGIN
  INSERT OR IGNORE INTO youtube_revocations (refresh_token_enc, queued_at)
  VALUES (OLD.refresh_token_enc, unixepoch() * 1000);
END;
```

Plus `updated_at` triggers. An upload row changing bumps its clip's lap →
session → event, so the event detail's `updated_at` moves and every client's
prefetch picks up the new `clip.youtube`.

**Deleting a connection never forgets to revoke it.** This is NS-45's
tombstone arrangement over again. Disconnecting, and account deletion (which
reaches the connection through the `users` cascade), both leave a revocation
row, and the cron calls Google's revoke endpoint. `DELETE /youtube` revokes
synchronously first, so the cron's later call gets `invalid_token`, which
counts as done. The API test asserts the cascade fires the trigger, as
NS-45's does.

### Routes

Under `/api` (authed):

| Route | Gate | Does |
|---|---|---|
| `POST /youtube/connect` | — | Mints the native ticket (hashed, 5 min, single use) and answers `{ url }`. 404 when the feature isn't available to this user. |
| `DELETE /youtube` | — | Revokes at Google (best effort), deletes the connection, and marks the user's `queued`/`uploading` rows `failed` with *"YouTube was disconnected."* Answers `{ ok }`. |
| `GET /clips/:id/youtube/draft` | **Pro** | Owner, `ready` clip. Answers `{ title, description, privacy: "unlisted", account }` from `defaultVideoMetadata`. |
| `POST /clips/:id/youtube` `{ title, description, privacy }` | **Pro** | Owner, `ready` clip, connection `ok`; otherwise 409 `{ error: "youtube not connected" }`. Runs `sanitizeVideoMetadata`, which gives a 400 naming the rule. Gives 409 if a row is `done`, `queued` or `uploading`, and 429 over the per-user limit. Inserts or resets the row as `queued`, sends `{ upload_id }` to `YOUTUBE_QUEUE`, and answers **202** with the upload. |
| `GET /clips/:id/youtube` | — | The upload row as the lap page draws it (`{ status, progress, privacy, url, error }`), or 404. The lap page polls this every 5 s while `queued` or `uploading`, so it isn't refetching the whole event detail. |

Outside `/api`, both in `run_worker_first`:

| Route | Does |
|---|---|
| `GET /youtube/connect[?ticket=…]` | Resolves the user from the ticket (which it burns) or the session cookie, sets the state, PKCE and return-target cookies (`SameSite=Lax`; Google's redirect is a top-level GET), and 302s to Google. With neither a ticket nor a session, it redirects to `/auth/login`. |
| `GET /youtube/callback` | Checks state, exchanges the code, verifies the id_token's `sub`/`email`, encrypts the tokens and upserts the connection. Then it redirects to `trackevolution://youtube?result=…` for a ticket flow, or `/#/settings?youtube=…` for the web. A consent the user declined is `result=denied`, not an error. |

Every refusal on another user's clip is a **404**. The router joins
`API_ROUTERS` in `entitlement-gates.test.ts` with the draft and the create
enumerated as gated, and the conventions bullet in `AGENTS.md` names the
create as the fourth write exception.

### The queue step (`src/youtube/step.ts`)

`YOUTUBE_QUEUE` (queue `track-evolution-youtube`) is consumed by the same
Worker's `queue` handler, beside `scheduled`. Each message is
`{ upload_id }`, and each step does **one thing** and then enqueues the next:

1. **Lease.** `UPDATE youtube_uploads SET lease_until = now + 5 min WHERE id
   = ? AND status IN ('queued','uploading') AND (lease_until IS NULL OR
   lease_until < now)`. Zero rows means the row is gone, finished, or being
   stepped by another message, so the message is acked. This is what makes a
   duplicate delivery harmless.
2. **Token.** Refresh the access token if it expires within 5 minutes. An
   `invalid_grant` marks the connection `revoked` and the upload `failed`
   with *"YouTube access was removed. Reconnect in Settings."*
3. **No session yet.** Check the project budget in `youtube_daily`. If it's
   spent, `message.retry({ delaySeconds: secondsToPacificMidnight(now) })`.
   Otherwise `POST
   https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
   with the metadata, `X-Upload-Content-Length` and `X-Upload-Content-Type:
   video/mp4`. Store the `Location` encrypted, count the upload against the
   budget, and set the row to `uploading`.
4. **Send a chunk.** Read `[bytes_sent, bytes_sent + YT_CHUNK_BYTES)` from R2
   and `PUT` it to the session with `Content-Range: bytes a-b/total`.
   - **`308`**: `bytes_sent` becomes `parseResumeRange(Range) + 1`. Enqueue
     the next step.
   - **`200`/`201`**: store `video_id`, set `done`, and save
     `snippet.channelTitle` onto the connection.
   - **`404`/`410`**: the session expired, which YouTube does after about a
     week. Clear the session and `bytes_sent`, increment `restarts`, and go
     back to step 3, at most `MAX_RESTARTS = 2` times. Each restart costs
     quota again.
   - **`5xx` or a transport failure**: before retrying, ask YouTube where it
     got to with an empty `PUT` and `Content-Range: bytes */total`, the
     documented resume. Then `message.retry` with a delay that doubles from
     30 s to an hour.
   - **`403` `quotaExceeded` / `uploadLimitExceeded`**: retry at midnight
     Pacific.
   - **Any other `4xx`**: `failed`, with YouTube's reason through
     `youtubeErrorText`. That covers a rejected title, a suspended channel,
     and the channel not being allowed to upload.
5. Release the lease on every exit.

After the queue's `max_retries`, the dead-letter path marks the row `failed`
with *"YouTube didn't accept the upload. Try again."* A clip deleted
mid-upload deletes the row by cascade, the next step acks, and the abandoned
session expires on YouTube's side.

### Event detail and `/me`

- Each lap's `clip` gains **`youtube: { status, video_id, url, privacy } |
  null`** (`url` is `https://youtu.be/<id>` once `done`). Like the rest of
  `clip`, it's not Pro-stripped: the link is the driver's. `withComputed`
  and the offline mirrors pass it through. The coach mount's
  `COACH_CLIP_FIELDS` allow-list drops it without an edit, which the API
  test asserts.
- `GET /me` gains **`user.youtube: { available, connected, account,
  channel_title }`**. `connected` is false for a `revoked` connection, which
  Settings words as *"Reconnect YouTube"*.

### Cron (`sweepYouTube`, beside `sweepClips`)

1. Revoke up to 200 `youtube_revocations` at
   `https://oauth2.googleapis.com/revoke`. `200` and `invalid_token` both
   drop the row, and anything else waits for tomorrow.
2. Delete expired connect tickets.
3. **The 30-day re-check.** For connections with `verified_at` older than 25
   days: refresh the token (an `invalid_grant` marks it `revoked`) and bump
   `verified_at`. Delete a connection that has been `revoked` for 30 days,
   which leaves its revocation row. For `done` uploads with `verified_at`
   older than 25 days: look the video up by id with the owner's token. Gone
   means the row is deleted and the lap offers the upload again. Present
   means `verified_at` is bumped. With no usable token, the row is deleted.
4. Re-enqueue `queued` rows untouched for an hour (a lost message), and
   fail `uploading` rows untouched for two days.

### Bindings and secrets

`wrangler.jsonc` gets `queues.producers: [{ binding: "YOUTUBE_QUEUE", queue:
"track-evolution-youtube" }]` and a consumer with `max_batch_size: 1`,
`max_retries: 10` and a dead-letter queue. The vars are `YOUTUBE_DAILY_BUDGET`
and the optional `YOUTUBE_ALLOWLIST`. The secrets are `YOUTUBE_CLIENT_ID`,
`YOUTUBE_CLIENT_SECRET` and `YOUTUBE_TOKEN_KEY` (32 random bytes, base64).
`Env` gets all of them, optional, and the queue binding is optional so the
test pool can supply its own. **Queues need the Workers Paid plan**, which
the R2 and rate-limit bindings already imply. Queue operations per upload
come to about 3 per chunk, about 15 per clip, which is negligible against
the included million.

### `src/lib/youtube.ts` (pure)

- `YT_CHUNK_BYTES`, `MAX_DAILY_UPLOADS_PER_USER`, `MAX_RESTARTS`.
- **`defaultVideoMetadata({ track, lapTimeMs, sessionLabel, sessionNumber,
  date, car, lapOffsetMs, units })`**:
  - The title is `<track> · <m:ss.fff>[ · <car>]`. If that's over 100
    characters, the track is cut first, then the car.
  - The description is the two sentences in the mock-up, then *Lap starts at
    m:ss.* (YouTube links a timestamp in a description), then the
    attribution line. The driver can delete any of it.
  - The date is written as words in English, so the server needs no locale.
- **`sanitizeVideoMetadata(body)`** → `{ meta }` or `{ error }`:
  - The title is trimmed and must be 1–100 characters.
  - The description must be ≤ 5,000 UTF-8 bytes.
  - `<` and `>` are refused rather than stripped, because YouTube rejects
    them and silently editing the driver's text would be worse.
  - Privacy must be one of the three values.
- `contentRange(start, length, total)`, `parseResumeRange(header)`,
  `secondsToPacificMidnight(now)` (via `Intl`, with `America/Los_Angeles`).
- `encryptSecret` / `decryptSecret` (WebCrypto AES-GCM, `iv.ciphertext`
  base64url).
- `youtubeErrorText(reason)`: YouTube's error reasons in our words, with an
  unknown reason given the generic sentence.
- `youtubeAvailable(env, email)`.

### Tests

- **`test/api/youtube.test.ts`**. Google's token, revoke and upload
  endpoints are `fetchMock` interceptors, the way the billing tests stub the
  stores. The queue handler is driven directly with
  `createMessageBatch` / `getQueueResult` from `cloudflare:test`. Cases:
  - Connect over a cookie and over a ticket. A ticket works once, and an
    expired one is refused.
  - A declined consent is `denied`.
  - **No plaintext token anywhere in D1** after a connect: walk every row.
  - Draft and create: 402 for a free account, 404 for another user's clip,
    409 when not connected, already on YouTube or not ready, 429 at the
    eleventh upload in a day, and 400 for each `sanitizeVideoMetadata` rule.
  - Stepping a 150 MB clip: init, then five chunks with the offsets taken
    from YouTube's `Range` rather than our own sums, then `done` with
    `video_id`.
  - A duplicate message acks without sending.
  - A session `404` restarts, at most twice.
  - A `5xx` re-queries the offset and retries.
  - `quotaExceeded` and a spent budget both retry at Pacific midnight.
  - `invalid_grant` revokes the connection and fails the upload in words.
  - Deleting the clip mid-upload acks the next step.
  - The coach mount gets 404 on every route here, and its event detail's
    `clip` has no `youtube`.
  - The share and leaderboard responses carry no `clip`.
  - Deleting the account leaves a revocation, and the cron sends it.
  - The cron deletes a `done` row whose video is gone, and re-enqueues a
    stale `queued` one.
- **`test/unit/youtube.test.ts`**: the metadata builder (truncation order,
  the offset line, a missing car), the sanitizer, range parsing, the Pacific
  reset across both DST changes, and an encrypt/decrypt round trip.

## Shared client logic (ticket 1, web; ported in 2 and 3)

`public/js/youtube.js` is the reference, ported to the Kit and `:core` as
`YouTubeUpload` under the same names and pinned by
**`contracts/logic/youtube.json`**:

- **`youtubeOffer(clip, entitlement, me, readOnly)`** → `"none"` |
  `"locked"` | `"connect"` | `"upload"` | `"pending"` | `"done"` |
  `"failed"`. These are the states the lap page draws:
  - `none` when `available` is false, there's no ready clip, or it's a
    coach's view.
  - `locked` for a free account (`canSaveLapVideo`).
  - `connect` with no live connection.
  - The other four follow `clip.youtube.status`.
- **`youtubeStatusLine(upload)`**: *Waiting to upload to YouTube*,
  *Uploading to YouTube · 40%*, *On YouTube · Unlisted*, or the row's
  `error`. The percentage is floored, so it never says 100% before `done`.
- `YOUTUBE_PRIVACY` (value + label) and `YOUTUBE_CONNECT_TEXT`. The consent
  explanation is quoted in full in *Web* below, and the three clients must
  say exactly the same thing.

The fixture's rows cover the ways a port goes wrong: `99.6%` reads 99, a
`revoked` connection reads `connect` rather than `upload`, a lapsed owner
with a `done` upload reads `done` (the link isn't Pro), and a coach reads
`none` whatever the upload state.

## Web (ticket 1)

- **Lap video panel** (event page, under *▶ Lap N video*): `youtubeOffer`
  decides the control.
  - `upload` gives *Upload to YouTube…*, which opens a `<dialog>` with the
    form, pre-filled from the draft. The title has a character counter, and
    the visibility is a three-way radio group.
  - `connect` gives *Connect YouTube…*, which navigates to
    `/youtube/connect?next=<this event>`.
  - `pending` gives the status line, polled every 5 s through
    `api(path, { cache: false })`.
  - `done` gives *On YouTube · Unlisted* plus an *Open* link
    (`rel="noopener"`).
  - `failed` gives the error and *Try again*, which reopens the dialog with
    the last values.
  - `locked` gives nothing beyond the panel NS-45 already draws.
- The consent explanation, shown above *Connect*: *"Track Evolution will ask
  Google for permission to upload videos to your YouTube channel. It uploads
  only the videos you choose, and can't see, change or delete anything else
  on your channel. Uses YouTube API Services: YouTube Terms of Service ·
  Google Privacy Policy."*
- **Delete video**'s confirmation gains *"The copy on YouTube stays. Delete
  it in YouTube Studio."* when `clip.youtube` is `done`.
- **Settings → YouTube** (only while `available`): *Connected as eric@…* (and
  the channel title once it's known), *Disconnect* (confirming: *"Videos
  you've uploaded stay on YouTube."*), and a link to Google's permissions
  page. When not connected, *Connect YouTube…*. A `?youtube=denied|error`
  return shows one sentence.
- `sw.js` skips `/youtube/`.

## iOS (ticket 2)

- **Lap page** (`LapVideoSection`): the player's menu gains *Upload to
  YouTube…* / *Connect YouTube…* per `YouTubeUpload.youtubeOffer`. The form
  is a **pushed page** (`Route.youtubeUpload(clipId:)`), not a sheet. The lap
  page already presents one, and two `.sheet`s on one view is the watchdog
  crash. Its typed fields are held on `AppRouter.heldFields`, so a rotation
  across 840 pt keeps them. The status line sits under the player, polled
  while the page is visible.
- **Connect**: `APIClient.youTubeConnectURL()` → `ASWebAuthenticationSession`
  with callback scheme `trackevolution`. The callback URL's `result` is read
  from the session's completion, never routed. The Kit's `DeepLink` refuses
  `trackevolution://youtube` the way it refuses `auth?code`. After it, re-read
  `/me`.
- **Settings**: the YouTube section, worded as on the web.
- `analyticsPath`: `/event/:id/lap/:id/youtube`. `remapTempIds` has nothing
  to follow, because a clip only exists on a real lap.
- Under `StudentLogbook` the menu items aren't drawn, and
  `auth.api.scoped(to:)` refuses the routes unsent in any case.

## Android (ticket 3)

- **Lap page** (`LapVideoCard`): the same menu items. The form is a
  destination (`Route.YouTubeUpload(clipId)`, a `pageComposable`), with its
  fields in a `SavedStateHandle` under the event form's `hydrated` rule. The
  status line is polled while the destination is resumed.
- **Connect**: a Custom Tab on `ApiClient.youTubeConnectUrl()`, launched
  from the Activity. The redirect to `trackevolution://youtube` arrives
  through the existing scheme intent filter as `DeepLink.YouTubeConnect(result)`.
  `MainActivity` re-reads `/me` and shows Settings with the result sentence.
- **Settings**: the YouTube section.
- `analyticsPath`: `/event/:id/lap/:id/youtube`.
- Under `LogbookOwnerScope` nothing is drawn, and `forOwner` refuses the
  routes with `ApiException.ReadOnly`.

## Goldens and native models (ticket 1)

`contracts/generate.mjs` gives the rich event's clip a `done` upload,
inserted directly because the goldens are about shapes, not Google. That way
`clip.youtube` is captured as an object and as a null, and `me` carries
`youtube`. It also captures `youtube-draft` and `youtube-upload` (the `GET
/clips/:id/youtube` shape) so the phones' models are pinned before they're
built. The coach-mount event detail pins the absence. Both native `LapClip`
models gain an optional `youtube` and both `User`s an optional `youtube`.

## Docs owed (in the same PRs)

- **`site/docs/privacy.html`**: a *YouTube* section. Connecting stores an
  encrypted Google grant limited to uploading videos, plus the account email
  and channel title. We send YouTube only the clip and the title,
  description and visibility you approved. We keep each upload's video id so
  the lap can link to it. The data is re-checked or deleted within 30 days,
  and the grant is revoked when you disconnect or delete your account.
  Videos on YouTube are governed by YouTube's terms and Google's privacy
  policy (both linked), and deleting a lap doesn't delete its YouTube copy.
  Include the YouTube API Services statement and Google's permissions link,
  and bump the effective date. **Ships ahead of the feature**, because
  Google's verification reads it.
- **`site/docs/terms.html`**: uploading to YouTube means agreeing to
  YouTube's Terms of Service, and what you publish there is yours.
- **`site/docs/telemetry-import.html`**: the *Best-lap video* section gains
  *Upload to YouTube*: connecting, visibility, the daily limit, what
  disconnecting and deleting do.
- **`site/docs/account-deletion.html`**: deleting the account revokes the
  YouTube grant. It doesn't delete videos already on YouTube.
- **`site/index.html`**: the Pro list's lap-video line gains "and publish it
  to YouTube in one tap". This lands only at launch, not before the audit.
- **`README.md`**: the Google project and its redirect URIs, the secrets and
  vars, `wrangler queues create track-evolution-youtube` (plus the
  dead-letter queue), the allowlist, and the audit's private-only lock.
- **`AGENTS.md`**: the routes, `/youtube/*` in `run_worker_first`, the queue
  consumer and its lease, encrypted (not hashed) tokens and why, the
  revocation tombstone, the fourth write exception, and `youtube.js` and its
  ports.
- **`NS-32-subscriptions.md`**: a tier-table row, *"Publishing a best-lap
  video to YouTube — **Pro**; connecting and disconnecting — free. Server:
  `requireEntitlement` on draft and create."*
- **`NS-45-best-lap-clips.md`**: the follow-ups list points here.
- **`docs/specs/native/README.md`**: the index row.
- **Store forms**: an upload is a transfer the user starts to a service they
  sign in to themselves, which both stores exempt from "shared with third
  parties". Note it on Play's Data safety form. The App Store label is
  unchanged (*Photos or Videos* is already declared by NS-45).

## Tickets

0. **Google**: the project, OAuth verification, the YouTube audit and the
   quota figure, as listed under *Google prerequisites*. It needs no code,
   but the privacy section from ticket 1 has to be live before it can
   finish. **It blocks launch, not the build.**
1. **Server + shared logic + web**: the migration, routes, queue consumer,
   cron, `lib/youtube.ts`, `youtube.js` with its fixture, the goldens and
   both native models' fields, the web lap panel and Settings, and the docs
   other than the landing page. It ships with no secrets in production, so
   `available` is false everywhere until ticket 0 is through.
2. **iOS**: the form page, connect, the status line, Settings, and a UI
   test. The test runs against `npm run dev` with a stub upload server
   standing in for Google (`YOUTUBE_API_BASE` under `DEV_MODE` on a dev host
   only, following the hostname rule), from Connect to *On YouTube*.
3. **Android**: the same, plus `YouTubeUploadTest` (Robolectric,
   `MockEngine`) over the form and the status polling, and `DeepLinkTest`
   cases for the redirect.

## Acceptance criteria

- [ ] A Pro driver with a stored best-lap clip uploads it to YouTube from the
      lap page on all three clients, with the title and description
      pre-filled and editable and Unlisted chosen. The lap then links to the
      video.
- [ ] The upload carries on with the app closed and the phone offline, and it
      survives a Worker restart and a duplicated queue message without
      sending a chunk twice or skipping one.
- [ ] Connecting asks Google for upload permission only, the consent and
      Settings copy name YouTube API Services with both links, and
      disconnecting revokes the grant at Google.
- [ ] No usable Google credential is stored in plaintext.
- [ ] A free account sees no upload control beyond NS-45's locked player, and
      gets 402 from the draft and create routes. A lapsed driver keeps the
      link to a video already uploaded and can still disconnect.
- [ ] A coach can't upload a student's clip or see its YouTube link. Nothing
      here reaches the share page, the leaderboard or the MCP tools.
- [ ] Deleting a clip, its lap or the account never deletes the YouTube video,
      and the app says so wherever that could surprise someone. Deleting the
      account revokes the grant within a day.
- [ ] No location is sent with a video.
- [ ] The per-user limit and the project budget are said in words, and an
      upload over the budget finishes the next day without the driver
      doing anything.
- [ ] API data is re-checked or deleted within 30 days.
- [ ] The feature is invisible wherever `user.youtube.available` is false.
      Production stays allowlisted until the YouTube audit has passed.
- [ ] The privacy policy, terms, import docs and README say what's sent,
      stored and revoked.

## Open questions

- **Made for kids.** The plan sends `selfDeclaredMadeForKids: false` and says
  so on the sheet, since in-car track footage isn't directed at children.
  YouTube makes the uploader responsible for that declaration. If the audit
  asks for an explicit choice, it becomes a two-option control defaulting
  to *No*.
- **Which scope reads back a private video?** The 30-day re-check looks
  videos up by id with the owner's token. If `youtube.upload` doesn't allow
  `videos.list` on a private video, the re-check can't tell "gone" from "not
  allowed to see it". In that case it treats a private video as unknown and
  re-checks only the grant, which still meets the deletion rule. Ticket 0
  confirms this.
- **Brand-account channels.** Google's consent lets the user pick a channel
  for YouTube scopes. Confirm that the upload lands on the channel picked,
  and that the `email` scope's answer is the one worth showing in Settings
  for a brand account (it may be better to wait for the channel title).
- **Should the coach see the link?** It's left out because an unlisted video
  is the driver's to hand out. If coaches ask, it's one field added to
  `COACH_CLIP_FIELDS` and one sentence in the Coaching copy.

## As built (ticket 1: server, shared logic, web)

Landed as specified, with these decisions the spec left open or that the code
forced. Tickets 0, 2 and 3 are still open, so production has no secrets and
`available` is false everywhere.

- **Migration `0035_youtube.sql`**, as the spec's schema plus two indexes
  (`youtube_uploads(user_id, created_at)` for the daily limit and
  `(status, updated_at)` for the sweep). The `updated_at` trigger fires on a
  change of status, video id or privacy and **not** on `bytes_sent`: the lap
  page polls `GET /clips/:id/youtube` for progress, so a chunk doesn't refetch
  every client's event detail.
- **The consent round trip carries no D1 row.** The spec's "state, PKCE and
  return-target cookies" are one AES-GCM-sealed cookie (`yt_connect`, path
  `/youtube`, `SameSite=Lax`, 10 minutes) holding the user, the state, the
  verifier and where to come back. It also carries the user across a ticket
  flow, where the system browser has no session cookie. A web `next` must be a
  bare hash route (`#/event/12`), so it can't be an open redirect.
- **A grant without the upload scope is `denied`.** Google's granular consent
  lets a user untick `youtube.upload` and still approve. The callback revokes
  what it was given and says `denied`, rather than storing a connection that
  can't upload.
- **Reconnecting the same Google account updates in place; a different
  account replaces.** Revoking a Google token revokes the whole grant, so
  tombstoning the old refresh token on a same-account reconnect would kill the
  grant just made. A different `sub` deletes and re-inserts, and the trigger
  queues the old account's revocation.
- **`DELETE /youtube` drops the revocation row it made redundant.** When the
  synchronous revoke succeeds, the trigger's row goes in the same batch rather
  than waiting for the cron's `invalid_token`.
- **`YOUTUBE_ALLOWLIST` is a secret, not a var.** `wrangler deploy` replaces
  every var with `wrangler.jsonc`'s. An allowlist set anywhere else would be
  wiped on the next deploy and open the feature to everyone. A secret
  survives. `YOUTUBE_DAILY_BUDGET` stays a var (empty: no budget) until ticket
  0 fixes the figure.
- **`available` also requires the queue binding**, beside the three secrets.
  A server that could take an upload and never send it is worse than one that
  offers none.
- **Waits are new messages, not retries.** The spec's quota case says
  `message.retry({ delaySeconds })`. That would count a day's wait toward
  `max_retries` and the dead-letter queue, and Queues caps a delay at 12 hours
  anyway. So a spent budget, `quotaExceeded` or `uploadLimitExceeded` acks and
  sends a fresh message for `min(secondsToPacificMidnight, 12 h)`. A wait past
  12 hours just waits twice. Transport failures and 5xx still `retry`, with
  the 30 s → 1 h backoff, and do reach the DLQ.
- **Every write a step makes is conditional on still holding the lease**, not
  only the lease itself. So a disconnect or a Try again landing mid-step is
  never overwritten by the step's own later write.
- **The waiting note is the row's `error` while it's `queued`.** *"Waiting for
  YouTube — uploads continue tomorrow."* is stored there and cleared when the
  step proceeds. `youtubeStatusLine` lets a queued or uploading row's `error`
  win over the default line.
- **The cron's "untouched for an hour" is 13 hours** (`STALE_STEP_MS`). A row
  waiting for the quota is legitimately untouched for up to 12. With one hour,
  the cron would give a waiting row a second message every day, and the two
  chains would step it in turn until it finished. 13 hours also covers lost
  messages on `uploading` rows, not only `queued` ones, before the two-day
  failure.
- **Deletions at 25 days, not 30.** The cron runs daily, so it re-checks
  grants and `done` uploads, and deletes revoked connections, at 25 days to
  stay inside YouTube's 30. A disconnected driver's `done` rows go at the next
  re-check, because there's no usable grant to check them with. The video
  stays on YouTube, and the lap offers the upload again.
- **A `failed` row is retried by the same `POST`**, which resets the row
  in place. The per-user limit counts `created_at`, which the reset moves, so
  a retry counts as an upload.
- **`youtube.js` grew past the spec's list**: `youtubeIsPending`,
  `youtubeRequestError` (the server's refusals in words, including *"You can
  upload 10 videos to YouTube a day."*), `youtubeAccountLine` (Settings), and
  every fixed sentence (`YOUTUBE_LINKS`, `GOOGLE_PERMISSIONS_URL`,
  `YOUTUBE_KIDS_TEXT`, `YOUTUBE_DELETE_NOTE`, `YOUTUBE_DISCONNECT_NOTE`,
  `YOUTUBE_OFFLINE`, `YOUTUBE_RESULT_TEXT`). All are in
  `contracts/logic/youtube.json`, so the phones port the words rather than
  retyping them. `youtubeOffer` checks `done` / `pending` before the tier, so a
  lapsed owner keeps both, and a revoked connection with a failed upload reads
  `connect`.
- **Web**: the panel sits under the lap's player, and also under NS-45's
  locked panel for a lapsed owner, so a `done` link stays visible. A failure
  re-reads `/me` before drawing its control, so a grant revoked mid-upload
  offers *Reconnect YouTube…* rather than a Try again that would 409. The
  connect result (`?youtube=`) shows once in a shell banner and is then taken
  off the hash.
- **Goldens**: the fixture gets a second clip, on another session's best lap,
  so `clip.youtube` is pinned as an object and as a null on one event detail.
  The connection and the `done` upload are written straight into the
  harness's scratch D1 (`d1()` in `contracts/generate.mjs`), so no queue
  message is ever sent there. Both native models' fields are strings for
  status and privacy, not enums, so a value the server adds later doesn't fail
  the whole event detail.
- **Tests** step uploads in 256 KiB chunks. The test pool points
  `YOUTUBE_QUEUE` at a queue nothing consumes, and Google's calls take an
  injected `fetch` (`FakeYouTube`). undici's mock can't vary a status by
  request body, so the route-level Google mocks answer 200 only. The error
  statuses are covered through the step and the cron.
- **Not yet**: the quota figure and the open questions are ticket 0's, and the
  landing page's Pro line waits for launch. The iOS UI test's stub upload
  server (`YOUTUBE_API_BASE` under `DEV_MODE`) is ticket 2's: the injected
  `fetch` covers the server's own tests.

## Follow-ups, deliberately not here

- **Public videos on the share page**, embedded on the share page's best-lap
  rows with `youtube-nocookie.com` click-to-play (the landing page's
  pattern). It needs its own sentence in the share-page privacy list.
- **Chapters from sectors**: `0:00` lead-in, then a chapter per sector from
  `sectorTimes`, offset by `lap_offset_ms`. YouTube needs at least three
  chapters of 10 s or more, which a lap over about 40 s always gives. The
  server would need the sector maths, which today it imports only under
  `src/ai/`'s exception.
- **A telemetry overlay** (speed, lap timer, delta) burned into the video.
  That's a re-encode, so it can't be a passthrough copy: the work is on the
  device or in a media pipeline we don't have.
- **Upload from the review**: an *also publish to YouTube* switch beside
  NS-45's *Save best-lap video*. It waits until the manual flow has proven
  people want it.
- **A pre-filled share sheet** for drivers who'd rather use the YouTube app,
  which is alternative 1's improvement. It's worth doing anyway, and it's
  cheap.
- **Other destinations** (Instagram, Vimeo, Strava). The connection table is
  YouTube-specific on purpose. A second destination should prove what a
  general one needs before anything is generalized.
