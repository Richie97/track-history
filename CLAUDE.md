# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal HPDE/track-day logbook on Cloudflare Workers + D1 (SQLite): tracks → events → sessions → laps, with progress charts and Google OAuth sign-in. Multi-user — every domain row is scoped to a `user_id`.

## Commands

```sh
npm install
npm run seed:generate       # writes seed/seed.sql from seed data (see below)
npm run db:migrate:local    # applies migrations/ to the local D1 SQLite
npm run db:seed:local       # loads seed/seed.sql locally
npm run dev                 # wrangler dev → http://localhost:8787
npx tsc --noEmit            # typecheck (no test suite or linter is configured)
```

Local dev needs a gitignored `.dev.vars`:

```
DEV_MODE=1
DEV_USER_EMAIL=you@example.com   # must match the seed data's USER_EMAIL
DEV_USER_NAME=Your Name
GOOGLE_CLIENT_ID=dev
GOOGLE_CLIENT_SECRET=dev
```

`DEV_MODE=1` makes `GET /auth/login` sign in as a fixed local user (no Google OAuth) — navigate there once to get a session cookie. Never set it in production.

Deployment: `npm run deploy` (plus `db:migrate:remote` / `db:seed:remote`). Secrets are set via `npx wrangler secret put`.

## Architecture

One Worker serves both the API and the static frontend (`wrangler.jsonc`: `public/` is served as SPA assets; `/api/*` and `/auth/*` hit the Worker first).

**Backend** (`src/`, Hono):
- `index.ts` — mounts the routers. Route order matters: `/api/share` (public, no auth) is registered before `/api` so `GET /api/share/:slug` stays unauthenticated while everything else under `/api` passes through the session-cookie middleware in `api.ts`.
- `auth.ts` — Google OAuth (or the DEV_MODE bypass) → `auth_sessions` row → `session` cookie. First Google sign-in claims a pre-seeded user row by matching email where `google_sub IS NULL`; otherwise creates a fresh empty account.
- `api.ts` — all CRUD. Every query filters by `c.get("userId")`; ownership helpers (`ownedEvent`, `ownedSession`) guard nested writes. Tracks are find-or-created by name (`COLLATE NOCASE`) when events are saved. `EVENT_SELECT` + `withComputed()` centralize the derived fields: `best_ms = MIN(manual best_time_ms, best logged lap)` and `consistency` (coefficient of variation, only with 3+ laps). The public share endpoint returns stats/times but strips notes, email, and per-lap data.

**Frontend** (`public/`, dependency-free vanilla JS):
- `app.js` — hash-routed SPA (`#/`, `#/new`, `#/event/:id`, `#/event/:id/edit`, `#/track/:id`, plus public `/share/<slug>` pages with their own hash routes). Each route re-renders the whole view via `shell()`, so element handles go stale after any navigation; module-level listeners are used where per-render listeners would accumulate. HTML is built with template strings — always pipe user data through `esc()`. Charts are hand-rolled SVG (`lineChart`), lower lap time plotted lower = improvement trends downward.
- `pdr.js` — parses lap times out of Corvette PDR (Cosworth) MP4 telemetry entirely in the browser via byte-range reads; the video is never uploaded. The beacon/odometer lap-derivation logic is reverse-engineered — see README before touching it.

**Database** (`migrations/`, applied in order by wrangler): schema changes are new numbered migration files, never edits to existing ones.

**Seed** (`seed/generate.mjs`): reads `seed/data.personal.mjs` if present (gitignored — real personal data), else `seed/data.example.mjs`, and writes `seed/seed.sql`.

## Conventions

- Lap times are integer milliseconds everywhere; the frontend formats/parses `m:ss.fff` via `fmtMs`/`parseTime`.
- API errors are `{ error: string }` with a meaningful status; the frontend surfaces `err.message` from that.
- Frontend and backend share no code — keep API response shapes in sync with the `app.js` consumers by hand.
