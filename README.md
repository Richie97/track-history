# Track Evolution

A personal HPDE/track-day logbook: events, sessions, lap times and notes per track,
with progress charts over time. Runs on Cloudflare Workers + D1 (SQLite), signs in
with Google, and fits comfortably in Cloudflare's free tier.

**The app:** https://trackevolution.app — the hosted instance, and where the docs
site points users. (This README covers development and deploying an instance;
the public docs site intentionally doesn't.)

**Marketing & docs site:** https://docs.trackevolution.app (also served at
https://richie97.github.io/track-history/) — static
pages in [`site/`](site/), deployed to GitHub Pages by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push to
`main` that touches `site/`. (One-time setup: repo *Settings → Pages → Source:
GitHub Actions*.)

Both the site and the app carry Open Graph / Twitter-card tags for link
previews; they share one social preview image, checked in as identical copies
at `site/og-image.png` and `public/og-image.png` (1200×630 PNG, rendered from
the site's design tokens — regenerate both together if the brand or tagline
changes).

## Stack

- **Cloudflare Workers** — serves the API (Hono) and the static frontend
- **D1** — SQLite database (tracks → events → sessions → laps; per-user tracks
  link to a seeded canonical track catalog by name, so the same physical track
  is identifiable across users — the catalog also backs the track-name
  suggestions in the event form)
- **Google OAuth** — login; new Google accounts get their own empty workspace
- Frontend is dependency-free vanilla JS (hash-routed SPA, SVG charts)

## Local development

```sh
npm install
npm run seed:generate       # writes seed/seed.sql from your seed data (see below)
npm run db:migrate:local    # creates the local SQLite schema
npm run db:seed:local       # loads the seed data
npm run dev                 # http://localhost:8787
```

Create `.dev.vars` (gitignored) for local development:

```
DEV_MODE=1
DEV_USER_EMAIL=you@example.com   # match your seed data's USER_EMAIL
DEV_USER_NAME=Your Name
GOOGLE_CLIENT_ID=dev
GOOGLE_CLIENT_SECRET=dev
```

`DEV_MODE=1` replaces Google login with a local dev user so you can develop
without OAuth credentials. It must never be set in production.

### Seeding your own history

`seed/generate.mjs` reads `seed/data.personal.mjs` if it exists (gitignored —
your real name, email and lap history stay out of the repo), otherwise
`seed/data.example.mjs`. Copy the example file to `data.personal.mjs`, fill in
your events, and re-run `npm run seed:generate`.

## Deploying to Cloudflare (one-time setup)

1. **Login & create the database**

   ```sh
   npx wrangler login
   npx wrangler d1 create track-history
   ```

   Copy the `database_id` it prints into `wrangler.jsonc` (replacing the zeros).

2. **Apply schema + seed your history**

   ```sh
   npm run db:migrate:remote
   npm run db:seed:remote      # imports your history (run once)
   ```

3. **Create a Google OAuth client**

   - Go to https://console.cloud.google.com/apis/credentials (any project)
   - *Create credentials → OAuth client ID → Web application*
   - Authorized redirect URI: `https://track-history.<your-subdomain>.workers.dev/auth/callback`
     (run `npx wrangler deploy` once first if you don't know your `workers.dev` subdomain;
     add your custom domain's `/auth/callback` too if you attach one)
   - If prompted to configure the consent screen: External, add yourself as a test
     user — or publish it, since only people you expect can do anything anyway.

4. **Set secrets & deploy**

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npm run deploy
   ```

Sign in with the Google account matching your seed data's `USER_EMAIL` and it
claims the imported history automatically. Other Google accounts get a fresh,
empty logbook.

## Video / telemetry import

On any event page, **Import video / telemetry…** turns recordings into sessions
with laps. Parsing happens entirely in the browser — for videos, via byte-range
reads of the embedded telemetry track (a few MB of a multi-GB file); **files
never leave your computer**. Supported sources:

- **Corvette PDR (Cosworth) MP4** — lap times from beacon/odometer telemetry,
  the GPS trace from the delta-encoded lat/lon channels, and car metrics (top
  speed, max RPM, max lateral G) from the speed/engine channels; a recording
  with no beacons still gets lap times, from the GPS line picker or recovered
  from the latitude + odometer channels (details below).
- **GoPro MP4** (Hero 5+) — the GPS trace from the GPMF metadata track.
- **Racelogic VBO** (VBOX, and RaceChrono / TrackAddict / Harry's LapTimer
  exports) — laps from the file's `[laptiming]` start line when present,
  otherwise from the GPS trace.

GPS-only sources have no lap markers, so the import preview shows the driven
track map: **click where the start/finish line is** and laps are timed each
pass across it (interpolated between 10–18 Hz fixes — accurate to roughly
±0.1–0.3s, shown with `~`). One picked line applies to every file in the
batch.

Imported sessions also store **per-lap channel data** — speed for every
source, plus RPM and lateral G for PDR — resampled onto a uniform
driven-distance grid (20 m) so laps overlay corner-for-corner. On the event
page the session's lap list doubles as the chip picker for the expandable
**channel graphs** below it: all laps as a dim context envelope, up to three
laps highlighted at a time via the chips (best lap pre-selected), with a
shared distance axis and hover readouts.
Everything is derived at import time in the browser (recordings are never
uploaded), sanitized server-side (`sanitizeChannels`), and stored as JSON on
the session row; the public share page never includes it.

How PDR lap times are derived (reverse-engineered from the `ctbx`/`marl`
telemetry track and validated against Cosworth Toolbox lap times):

- PDR "Beacon" events mark start/finish crossings to the millisecond, but the
  recorder drops some crossings.
- The cumulative odometer channel recovers the missing ones: beacon-to-beacon
  distance ÷ crossing count gives the lap length, and a missing crossing is the
  moment distance passes `D0 + k × lapLength` (accurate to ~0.05–0.3s, shown
  with `~`). Crossings beyond the first/last beacon are extrapolated the same
  way and sanity-checked against GPS latitude.
- The telemetry stream is **delta-encoded** (the framing matches ExifTool's
  GM.pm, the reference decoder for the Marlin format): a channel gets one
  16-byte full record — absolute channel/value/timestamp — and then streams
  8-byte diff records against the decoder's running state. Decoding the
  deltas is what yields the GPS trace (lat/lon at ~11Hz, stored as radians
  scaled by the file's channel dictionary) plus the car channels — Speed,
  RPM, accelerations — from which the import reports **top speed, max RPM
  and max lateral G**. (An earlier parser version read only full records,
  which made it look like PDR firmware recorded no GPS: longitude gets
  exactly one full record, at recording start.) All decoded coordinates
  still sit behind plausibility checks before they become a trace.
- With a GPS trace, a beacon-less PDR recording uses the same start/finish
  **line picker** as the other GPS sources. If the GPS channels don't decode,
  a beacon-less recording still gets lap times: latitude as a function of
  odometer distance repeats every lap, so the **lap length is the
  autocorrelation peak** of that profile, and lap times are cut every
  lap-length of distance (validated on real footage: lap length within 2m
  and lap times within ±0.2s of beacon-derived values). Start/finish
  alignment comes from a beacon-timed recording of the same track in the
  same import batch (matched by lap length, aligned by cross-correlating the
  latitude profiles); without one, laps are cut from where the car first
  reaches pace — real laps of the full track, just not aligned to the
  official line. All flagged `~`.

For manual testing with real recordings, drop them in a `telemetry-samples/`
directory at the repo root — it's gitignored, so large videos and personal
footage never end up in the repo. (Automated tests use small synthetic
fixtures generated by `test/fixtures/build.mjs` instead.)

## Notes on the data model

- An event's **best time** is `MIN(best logged lap, manual best)` — the manual
  field exists because the spreadsheet-era events only recorded a best time.
- **Consistency** is the coefficient of variation (stdev ÷ mean) of all laps in an
  event; shown once an event has 3+ laps. Lower is more consistent.
- Imported per-session bests (from a spreadsheet era) appear as one-lap sessions;
  full lap-by-lap data can be attached to any event via `RAW_SESSIONS` in the seed
  data or pasted into the UI.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
