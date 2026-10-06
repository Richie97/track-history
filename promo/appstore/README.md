# App Store assets

The iOS product page's creative assets, built from the same demo logbook as
the promo film (`../README.md`) — so run `node capture.mjs` first, once.

| Asset | Spec | Built by | Output (`out/appstore/`) |
|---|---|---|---|
| Universal creative asset | 5244×2950 PNG, opaque — the store crops it to the header and the search card | `header.html`, `render-header.mjs` | `universal-5244x2950.png` |
| Product page header | 21:9, 3840×1646 | the same canvas, cropped | `header-3840x1646.png` |
| Search results asset | 3:2, 3840×2560 | the same canvas, cropped | `search-3840x2560.png` |
| App preview | 886×1920 portrait (every Face ID iPhone), 29.9 s, H.264 High@4.0 30 fps ~11 Mbps, AAC 256 kbps stereo 48 kHz | `preview.html`, `preview.js`, `shots.mjs`, `render-preview.mjs` | `app-preview-886x1920.mp4` |

```sh
node appstore/render-header.mjs     # the three images, plus guides.jpg (crops + safe area drawn)
node appstore/render-preview.mjs    # the preview (needs out/score.wav: node audio/score.mjs)
node appstore/render-preview.mjs --stills 2,9.5   # single frames → out/appstore/stills/
node appstore/render-preview.mjs --draft          # every scene from its web stand-in
```

## The header

The PB lap at COTA — time, the gain since the first visit, and the racing line
drawn brighter-is-faster — inside the header's **art safe area** (Apple's
template: 1097,493 → 2743,1154 on the 3840×1646 header, which `header.html`
maps onto the universal canvas), with the lap's speed trace as bleed for the
wider crops. Nothing that matters sits outside the safe area, and the bottom
is kept quiet because the store draws the app's icon, name and Get button over
it. No wordmark: the store names the app itself. `?guides` on the page draws
the two crops and the safe area.

## The app preview

Apple takes **only screen captures of the app itself** (App Review Guideline
2.3.4), so every scene's footage has to come from the native iOS app. Until a
scene's clip exists, the cut fills it with a stand-in built from the *web*
app's phone-width captures, badges it `DRAFT · WEB STAND-IN`, and names the
file `app-preview-886x1920-DRAFT.mp4` — for judging the cut, never for upload.

The scenes are `SLOTS` in `shots.mjs` (`node appstore/shots.mjs` prints them
with what to tap): the recorder, an event, the lap analysis, the progress
chart, the garage and the leaderboard, each with a Free/Pro tag on the NS-32
tier table, then a closing card. Captions are short and claim nothing the app
doesn't do; no other platform is named, which App Review also requires
(2.3.10), so the promo's Google Play and browser mentions are absent here.

### Recording the footage (a Mac with Xcode)

```sh
node appstore/serve.mjs          # terminal 1: the demo logbook on localhost:8790, left running
appstore/ios-capture.sh          # terminal 2: iPhone 17 Pro Max; or: appstore/ios-capture.sh "<device>" <scene>
```

`ios-capture.sh` builds and installs a Debug build if the simulator lacks one
(the `-server.url` / `-authToken` launch arguments are DEBUG-only), signs it in
to the demo driver, sets dark mode and the 9:41 status bar, grants location,
and then walks the shot list: it prints each scene's move, and records
`out/ios/<scene>.mov` between two presses of Return. For the recorder it drives
the COTA racing line through the simulated GPS a lap at a time, each lap a
little faster or slower so the predictive delta moves.

Then mark where each scene starts in its clip — `out/ios/trims.json`, seconds:

```json
{ "record": 3.2, "event": 0.8, "analysis": 1.0, "progress": 0.5, "garage": 0.6, "leaderboard": 0.4 }
```

and render. A clip should run its scene's length plus about a second; a short
one holds its last frame. Any portrait recording works — a real-device screen
recording of the recorder at a track day is better footage than the simulator
and drops in as `out/ios/record.mov` (or `.mp4`).

Upload the result under the 6.9" iPhone size in App Store Connect (it covers
the smaller Face ID sizes); the poster frame defaults to 5 s, which lands on
the event page — set it to ~10 s for the analysis if you prefer. Previews for
iPad (1200×1600) are a separate cut this doesn't make.
