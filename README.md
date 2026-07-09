# Track History

A personal HPDE/track-day logbook: events, sessions, lap times and notes per track,
with progress charts over time. Runs on Cloudflare Workers + D1 (SQLite), signs in
with Google, and fits comfortably in Cloudflare's free tier.

## Stack

- **Cloudflare Workers** — serves the API (Hono) and the static frontend
- **D1** — SQLite database (tracks → events → sessions → laps)
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

## PDR video import

On any event page, **Import PDR video…** reads lap times straight out of
Corvette PDR (Cosworth) MP4 recordings — select one or more videos and each
becomes a session with its laps. Parsing happens entirely in the browser via
byte-range reads of the embedded telemetry track (a few MB of a multi-GB file);
**the video is never uploaded**.

How lap times are derived (reverse-engineered from the `ctbx`/`marl` telemetry
track and validated against Cosworth Toolbox lap times):

- PDR "Beacon" events mark start/finish crossings to the millisecond, but the
  recorder drops some crossings.
- The cumulative odometer channel recovers the missing ones: beacon-to-beacon
  distance ÷ crossing count gives the lap length, and a missing crossing is the
  moment distance passes `D0 + k × lapLength` (accurate to ~0.05–0.3s, shown
  with `~`). Crossings beyond the first/last beacon are extrapolated the same
  way and sanity-checked against GPS latitude.

## Notes on the data model

- An event's **best time** is `MIN(best logged lap, manual best)` — the manual
  field exists because the spreadsheet-era events only recorded a best time.
- **Consistency** is the coefficient of variation (stdev ÷ mean) of all laps in an
  event; shown once an event has 3+ laps. Lower is more consistent.
- Imported per-session bests (from a spreadsheet era) appear as one-lap sessions;
  full lap-by-lap data can be attached to any event via `RAW_SESSIONS` in the seed
  data or pasted into the UI.
