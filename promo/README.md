# The promo video

An 84-second promotional film for Track Evolution — 1920×1080, 30 fps, with a
synthesised score — built from the **real app**: a demo logbook is written
through the API into a scratch database, the web app is filmed against it in
Chromium, and the screens are cut into a motion-graphics piece in the app's own
design tokens. When the UI changes, re-running the pipeline re-films it; nothing
in the video is a mock-up of a screen except the one screen the web can't show
(the native lap recorder, drawn from `RecordingScreen.swift`'s layout).

Published at <https://youtu.be/UBnjPYRr8wU>, and played in the hero of the
docs site's landing page (`site/index.html`, poster `site/promo-poster.jpg`).
Upload a re-cut, and the video id and the poster frame there change with it:

```sh
ffmpeg -ss 5.45 -i out/track-evolution-promo.mp4 -frames:v 1 -vf scale=1280:-2 -q:v 3 ../site/promo-poster.jpg
```

The App Store's product page header, search results asset and app preview
are built from the same logbook — see [`appstore/README.md`](appstore/README.md).

## Build it

```sh
npm install                      # at the repo root: wrangler, which serves the app
cd promo && npm install          # Playwright (needs a Chromium: `npx playwright install chromium`)

node capture.mjs                 # demo logbook + filming → out/screens/*.png, out/data.json
node audio/score.mjs             # the score → out/score.wav
node render.mjs                  # the film → out/track-evolution-promo.mp4
```

`render.mjs` needs an ffmpeg with libx264 and aac, on `PATH` or named by
`$FFMPEG`. Everything it writes is under `out/`, which is gitignored — the
source is what's committed; the MP4 is a build product.

Useful while editing:

```sh
node render.mjs --stills 12,40.5   # single frames → out/stills/
node render.mjs --from 38 --to 52  # one scene in motion, silent → out/section-38-52.mp4
node render.mjs --mux              # re-mux a changed score without re-rendering
node capture.mjs --reuse           # re-film against the logbook already in .state/
```

Open `video/index.html?t=12` through any static server rooted at the repo to
look at a moment interactively; `render.mjs` serves the repo to Chromium itself.

## How it's put together

| Step | Files | What it does |
|---|---|---|
| Circuit | `demo/track.mjs` | The Circuit of the Americas racing line from TUM's open racetrack database (originally OpenStreetMap), downloaded once into `.cache/` — LGPL-3.0 / ODbL data, so it isn't vendored, and the end card carries the OSM credit. |
| Telemetry | `demo/sim.mjs` | A quasi-steady-state lap simulation of a C8 Z06 on that line (grip, aero, power, braking, a friction ellipse), and a driver whose grip use, braking and trail-braking scale with skill. Every channel the importer stores is derived from one speed trace, so the app's analysis finds real things. Steering follows the bicycle model `steeringFit` fits, so the car's measured ratio comes out as the catalog's 15.7:1. |
| Logbook | `demo/logbook.mjs`, `demo/seed.mjs` | A fictional driver's two seasons: six COTA weekends with telemetry, typed-in days at five other circuits, a garage with measured pad wear, setup sheets, costs, nine leaderboard rivals and a coach. Seeded **through the API** on a scratch D1 (`.state/`), with sessions cut by the importer's own `buildLapChannels` and traced by its own `geo.js`. |
| Filming | `capture.mjs`, `lib/` | Starts the Worker (`unstable_startWorker`, as `contracts/generate.mjs` does), signs in through `DEV_MODE`, turns on Pro, and screenshots each screen in dark mode at 2× (desktop) and 3× (phone) — including a real GoPro-format import (`buildGpmfMp4` from the test fixtures) with its start/finish line picked on the map. It also exports `out/data.json`: the PB lap's racing line, the lap-time progression, the leaderboard, element boxes the video zooms onto, and an AI-assistant comparison computed by the app's own `compare-laps.js` / `sectors.js`. |
| Film | `video/index.html`, `video/promo.js`, `video/timeline.js` | The composition. `timeline.js` is a seekable tween engine — every property a pure function of time, CSS transitions off — so any frame renders exactly. |
| Score | `audio/score.mjs` | 120 BPM in A minor on the video's two-second bars; oscillators, filters, a delay and a Freeverb, no samples. |
| Render | `render.mjs` | Seeks the page frame by frame across parallel Chromium pages, encodes segments with x264, concatenates them, and muxes the score gain-matched to -14 LUFS. |

## The cut

Bars are two seconds; every scene starts on one.

| Time | Scene | Tier shown |
|---|---|---|
| 0–6 | Cold open: the PB lap drawn on COTA at its own pace, the timer locking on 2:17.827 | — |
| 6–10 | Logo and tagline | — |
| 10–18 | The logbook: dashboard in a browser and on a phone | Free |
| 18–24 | Progress: the track's best-lap chart drawing itself, −11.5 s | Free |
| 24–32 | Telemetry import: a GoPro clip, the start/finish picked, laps appear | Free |
| 32–38 | Recording laps on the phone (the native recorder, drawn) | Pro |
| 38–52 | Analysis montage: sectors + delta, ABS/TC on the map, gear ribbon, friction circle, car health, cross-season compare | Pro |
| 52–58 | Garage: wear projected, front pads ≈2 track days | Pro |
| 58–64 | Leaderboard (P4 of 10), sharing, coach access | Free / Pro |
| 64–70 | An AI assistant answering from the logbook | Pro |
| 70–74 | Season Wrapped | Free |
| 74–78 | Every platform, offline | — |
| 78–84 | "Free is the logbook. Pro is the analysis." — trackevolution.app, both stores | — |

## Keeping it honest

The video is marketing, so it follows the site's rules (see `AGENTS.md`):
it points at the hosted app and both store listings, never mentions how the app
is hosted, and makes no claim the landing page doesn't. Specifically:

- The Free / Pro tags follow the tier table in `docs/specs/native/NS-32-subscriptions.md`
  and the landing page's pricing grid — move a feature between tiers and the
  tag in `video/promo.js` moves with it.
- The logbook is **fictional** and the end card says so. Driver, rivals and coach
  are invented; the circuits are real catalog tracks.
- The recorder is the only drawn screen, because the web app has none; it
  mirrors the native layout (elapsed clock, predictive delta, lap / current /
  last / best, fix quality, Stop). CarPlay is named for what it does — start and
  stop — and Android Auto isn't named, because it doesn't ship.
- The AI chat's numbers come from `out/data.json`, which the app's own analysis
  modules computed — the same ones the MCP tools use.
