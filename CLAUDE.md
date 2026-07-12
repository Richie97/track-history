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
npm test                    # vitest: unit tests + API tests against a real D1 (miniflare)
npm run typecheck           # tsc over src/ and test/ (no linter is configured)
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
- `index.ts` — composes the routers. Route order matters: `/api/share` (public, no auth) is registered before `/api` so `GET /api/share/:slug` stays unauthenticated while everything else under `/api` passes through `requireSession` (`middleware.ts`).
- `routes/` — one router per resource: `auth.ts` (Google OAuth or the DEV_MODE bypass → `auth_sessions` row → `session` cookie; first Google sign-in claims a pre-seeded user row by matching email where `google_sub IS NULL`), `me.ts`, `tracks.ts`, `events.ts`, `sessions.ts` (sessions + laps), and `share.ts` (authed slug management plus the public share endpoint, which returns stats/times but strips notes, email, and per-lap data).
- `db.ts` — data-access helpers. All take `(db, userId, ...)` explicitly so ownership scoping is visible at call sites: `ownedEvent`/`ownedSession` guard nested writes, `resolveTrack` find-or-creates tracks by name (`COLLATE NOCASE`), and `EVENT_SELECT`/`listEvents`/`tracksSummary` produce event rows with lap aggregates.
- `lib/` — pure logic, unit-tested: `stats.ts` (`withComputed` derives `best_ms = MIN(manual best_time_ms, best logged lap)` and `consistency` — coefficient of variation, only with 3+ laps), `validate.ts` (slug/goal/lap validation), `session.ts` (session token + cookie plumbing), `oidc.ts` (id_token decode).

**Frontend** (`public/`, dependency-free vanilla JS as native ES modules — no build step):
- `app.js` — the module entry (`<script type="module">`): app state, `shell()`, the views and the hash router (`#/`, `#/new`, `#/event/:id`, `#/event/:id/edit`, `#/track/:id`, plus public `/share/<slug>` pages with their own hash routes). Each route re-renders the whole view via `shell()`, so element handles go stale after any navigation; module-level listeners are used where per-render listeners would accumulate. HTML is built with template strings — always pipe user data through `esc()`.
- `js/` — extracted modules, importable by unit tests: `format.js` (`fmtMs`/`parseTime`/`esc`…), `chart.js` (hand-rolled SVG `lineChart`; lower lap time plotted lower = improvement trends downward), `api.js` (fetch wrapper throwing `ApiError` with status), `theme.js`, `us-tracks.js`, `pdr-import.js` (the PDR import UI).
- `pdr.js` — parses lap times out of Corvette PDR (Cosworth) MP4 telemetry entirely in the browser via byte-range reads; the video is never uploaded. The beacon/odometer lap-derivation logic is reverse-engineered — see README before touching it.

**Database** (`migrations/`, applied in order by wrangler): schema changes are new numbered migration files, never edits to existing ones.

**Seed** (`seed/generate.mjs`): reads `seed/data.personal.mjs` if present (gitignored — real personal data), else `seed/data.example.mjs`, and writes `seed/seed.sql`.

**Tests** (`test/`, Vitest with two projects — see `vitest.config.mts`):
- `test/unit/` — pure-function tests running in Node: `src/lib/*` plus the frontend modules (`public/js/format.js`, `chart.js`) and `pdr.js` internals.
- `test/api/` — the whole Worker under `@cloudflare/vitest-pool-workers`: real D1 with migrations applied per test (`setup.ts`), requests via `SELF.fetch`. `helpers.ts` creates users/sessions directly in D1 so multi-user ownership isolation is testable; DEV_MODE bindings live in `vitest.workers.config.mts`.
- New API behavior needs a test here; new pure logic belongs in `src/lib`/`public/js` where it's unit-testable.

## Conventions

- Lap times are integer milliseconds everywhere; the frontend formats/parses `m:ss.fff` via `fmtMs`/`parseTime`.
- API errors are `{ error: string }` with a meaningful status; the frontend surfaces `err.message` from that.
- Frontend and backend share no code — keep API response shapes in sync with the `app.js` consumers by hand.
