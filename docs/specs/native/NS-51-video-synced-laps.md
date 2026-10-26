# NS-51 — Video-synced lap analysis (the lap stage)

**Phase:** post-rewrite · **Platform:** Web + iOS + Android (no server change) · **Depends on:** [NS-45](NS-45-best-lap-clips.md) / [NS-50](NS-50-every-lap-clips.md) (lap clips and their `lap_offset_ms`), [NS-23](NS-23-ios-charts.md) / [NS-24](NS-24-android-charts.md) (the channel panels), [NS-34](NS-34-large-screens.md) (layout classes, `sideColumnWidth`, postures, tap-to-mark), #165 (the two-lap compare), [NS-35](NS-35-leaderboard-lap-detail.md) (the leaderboard lap) · **Estimate:** shared logic + web 4–5 days, each phone 6–8 days · **Issue:** [#437](https://github.com/Richie97/track-history/issues/437) (tickets #434, #435, #436) · **Design:** [design doc with screenshots](https://claude.ai/artifact/Sviifnj32ZkJMA9RyUmabn), [interactive prototype](https://claude.ai/artifact/X1j49M5ChmNQHvYUZuzy21)

## Goal

When a lap has a video, the lap's analysis becomes **video-first**. The video
sits at the top. Every chart below it carries a **playhead line** at the
car's place in the video. Scrubbing the video moves the line, and tapping or
dragging any chart seeks the video, so the picture and the traces always show
the same metre of track. A two-lap compare plays **both** laps' videos from
one transport, synced by distance. A single lap uses the same layout against
a quiet reference lap. A lap with no video gets the same layout too: the map
takes the video's slot and *play* replays the lap on it.

Large screens (iPad, the open iPhone Duo, Android tablets and foldables, a
desktop browser):

```
┌────────────────────────────────────────────────────────────────────────┐
│ ‹ Session 2                 Lap 5 vs Lap 3                        Laps │
├───────────────────────────┬───────────────────────────┬────────────────┤
│ ● Lap 5 · 2:19.812        │ ● Lap 3 · 2:16.680 ★      │ Where the car is│
│                           │                           │   ╭──╮  T4      │
│       (video A)           │       (video B)           │ ──╯● ╰──        │
│                           │                           ├────────────────┤
├───────────────────────────┴───────────────────────────┤ 1.50 km · in T2 │
│ ▶  ──────●──────────────────── 0:36.0 / 2:19.8 [Same place|Same time]│ 84 mph  3 gear │
│    (delta drawn along the track, corner ticks under)  │ ▮ thr ▮ brk    │
│                                                       │ +0.71 s vs B   │
├───────────────────────────────────────────────────────┴────────────────┤
│ Time  Inputs  Grip  Car                                                │
│ Delta · A vs B  +0.71 s      T1    T2        T3  T4          T5   T6   │
│ ─────────────────────│──────────────────────────────────────────────── │
│ Speed  85 mph 84 mph │                                                 │
│ ╱╲╱╲___╱╲____╱╲______│____╱╲______  (charts scroll under the stage)    │
└────────────────────────────────────────────────────────────────────────┘
```

Phones and the closed Duo:

```
┌─────────────────────────┐
│ ‹ Session 2  Lap 5 vs 3 │
├─────────────────────────┤
│                         │
│     (video A)  ┌──────┐ │   ← lap B as an inset; tap to swap
│                │  B   │ │
├────────────────┴──────┴─┤
│ ▶ ───●──────── 0:36/2:19│
│ 1.50 km  84 mph 3  ▮▮ +0.71 s │
│ [Same place|Same time]  │
│ Time Inputs Grip Car    │
│ Delta ────│──────────── │   ← charts scroll under the sticky player
│ Speed ╱╲__│_╱╲_____     │
└─────────────────────────┘
```

The design doc has a screenshot of every layout, taken from the prototype.
The prototype's source is the reference for the look and the interaction,
not for the code: it runs a simulated session, and its "video" is drawn from
the telemetry.

## Why

- **The video and the numbers answer one question together.** The channel
  panel says the driver braked 18 m earlier into T11; the video shows why
  (a car ahead, a mirror check, a missed marker). Today they are two cards a
  scroll apart, with nothing tying a frame to a metre.
- **The compares show no video at all**, even when both laps have a clip.
  With every-lap clips (NS-50) a PDR session has a video on every lap, so a
  session compare usually has two.
- **Large screens are under-used.** On a 13-inch iPad or the open Duo the lap
  page is one long centred column, and the video scrolls off-screen before
  the charts begin.
- **The phones gain most even without video.** Today a tap shows a read-out
  and nothing else. Under this spec it parks a line that stays across every
  chart, and the scrubber draws the delta, so the lap's story is visible
  before any chart is read.

## Fixed decisions

| | |
|---|---|
| Server | **No change.** `lap.clip` already carries `id`, `duration_ms` and `lap_offset_ms` on every event detail; `GET /clips/:id/url` signs the URL. No route, column, golden or gate is added. |
| Clients | **All three**: web, iOS and Android, including the Mac (the iPad build). The pure half is written in JS first and ported, as always. |
| The playhead | **One driven distance**, a fractional grid index `k` on the lap's 20 m grid, held by one value per view (`LapPlayhead`). Everything — the charts' line, the map's dot, the now-strip, the video — reads it. |
| Video ↔ distance | **Derived** from `lapTimeSeries` (already the delta chart's curve) and the clip's `lap_offset_ms`. No new stored data. See *The sync model*. |
| Exact timing at import | **Deferred.** Storing each grid point's real elapsed time in `sessions.channels` would make the sync exact, but changes the stored format. Ticket 1 measures the derived curve's drift on real footage and records it in *As built*; the decision is taken after that. The pure functions take the time curve as an argument, so a stored `t` series can replace the derived one without changing a caller. |
| Two-lap sync modes | **Same place** (both videos at the same distance; the slower lap's video runs faster to keep up) and **Same time** (both at the same elapsed time from the line; one car pulls ahead, the gap in metres). **Same place is the default.** |
| Remembering the mode | **Remembered per device**, like the theme override: the last mode picked is the next compare's mode. Web `localStorage` (`th-sync-mode`, the `th-` prefix `theme.js` and `units.js` use), iOS `UserDefaults` (`syncMode`), Android `stringPreferencesKey("sync_mode")` in the one `settingsDataStore`. Not an account setting: nothing else about viewing a chart is. |
| Single lap | **The same stage, one-sided.** The now-strip and scrubber carry the delta to a **reference lap**: the session best, or the next-best lap when this lap *is* the best, or nothing when the session has no other lap with channels. |
| No video | **Replay.** The video slot shows the track map, and *play* runs the playhead at real lap speed from a clock instead of a video. The layout never changes shape because a side lacks video. |
| The lap page's *Compare laps* sheet | **Retired on the native lap page.** The lap page's channel panel is inline under the stage, and *Compare laps* opens the two-lap stage (this lap against the reference) as a pushed destination. The event page keeps its many-lap session overlay. |
| Phone landscape | **Rotating a phone to landscape while the stage shows a video goes full-bleed, automatically**, playing or paused, and rotating back returns. A fullscreen button does the same in portrait. Tablets and the open Duo never auto-enter it (their landscape is the expanded layout). |
| Audio | **Only the large (master) video plays sound.** The other is muted. Swapping the inset swaps which one is heard. |
| Driving | **Never reachable from the record screen, CarPlay or the debug Android Auto build.** This is a paddock view. |
| Tiers | **No new gate.** Playing video is `canSaveLapVideo`; the delta, the two-lap compare and the Pro channels are `canViewChannels`, as today. A free account gets the playhead on its free charts (speed, throttle, brake) in replay. NS-32's tier table gets a row saying so. |
| Coach and shared views | **Unchanged rules.** A coach plays on the student's tier; a shared event or session plays through its link's signed URL only while the owner is Pro (NS-48). The stage is read-only in both — it has no write control to hide. |
| Leaderboard lap | **The other driver's side is always replay**: no clip ever reaches the leaderboard (NS-45). The viewer's own side plays their video when their best lap has one. |

## Terms

- **Stage** — the pinned top band: the video slot(s), the transport, and on
  large screens the map card and the now-strip.
- **Side** — `A` or `B`. A is the lap the view was opened for (lap page) or
  the left/first pick (compare). B is the reference or the second pick.
- **Master** — the side whose clock drives playback: always A unless the
  phone's inset has been swapped, which makes the large video the master.
- **Replay** — a side with no playable video: its slot shows the map, and if
  it is the master its clock is a timer.
- **Reference lap** — on a single-lap stage, the lap the delta is measured
  against (see *Fixed decisions*). It has no slot; its speed trace is drawn
  dim under the lap's own.

## The sync model

Each side carries its lap's channel entry (the stored `{ n, timeMs, speed, … }`)
and, when it has one, its clip (`lap_offset_ms`, `duration_ms`).

**The time curve.** `T = lapTimeSeries(entry.speed, dStepM, entry.timeMs)` —
elapsed seconds from the line at every grid point, integrated from the speed
trace and scaled so `T[n−1]` equals the timed lap. It is exact at both ends
and drifts in between. Against the promo's COTA simulator the worst drift
over five laps was 0.38 s (about 10 m at corner speed); real footage is
measured in ticket 1.

**Video → distance.** A clip time `c` (ms) gives lap elapsed
`e = (c − lap_offset_ms) / 1000`, and `k = gridAtElapsed(T, e)`: the
fractional index where `T[k] = e`, by binary search and linear
interpolation (`T` is strictly increasing because `lapTimeSeries` floors the
speed at `DELTA_MIN_KPH`).

**Distance → video.** A tap, drag or scrub gives `k`, and the seek target is
`c = lap_offset_ms + 1000 · valueAt(T, k)`.

**Outside the lap.** Clips carry `PRE_ROLL_S` (3 s) before the line and
`POST_ROLL_S` (4 s) after, and players open at `playbackStartMs` (2 s
before the line). While `e < 0` or `e > timeMs / 1000` the playhead is
**out of the lap**: no line on the charts, no dot on the map, and the
now-strip says *Before the line* or *After the line*. The scrubber's range
is `[−PLAYBACK_LEAD_S, timeMs/1000 + PLAYBACK_LEAD_S]` in the master's lap time.

**Two sides.** The master's elapsed time `eM` is the clock.

- *Same place*: `k = gridAtElapsed(T_M, eM)`, and the other side's target
  elapsed is `valueAt(T_O, k)` — both at the same distance.
- *Same time*: the other side's elapsed is `eM`, and its own
  `kO = gridAtElapsed(T_O, eM)` — both at the same time. The gap on track is
  `(kO − kM) · dStepM` metres (positive: the other side is ahead).

Laps whose driven lengths differ by more than `LENGTH_MISMATCH_WARN` (5 %)
are matched by **lap fraction** instead of grid index (`k_O = k_M · (n_O−1)/(n_M−1)`),
and the compare's existing warning is shown.

**Keeping the follower in step.** While playing in *Same place*, the
follower's playback rate is set from the speed ratio at the shared distance,
`followRate = clamp(v_M(k) / v_O(k), 0.5, 2.0)`, recomputed at most every
250 ms, and the follower is re-seeked whenever it is more than
`RESYNC_MS` (150) from its target. In *Same time* both play at rate 1 from
a common start and are re-seeked only past `RESYNC_MS`. While scrubbing,
both players seek directly (fast/keyframe seeks while the finger moves, an
exact seek on release). A follower whose target falls outside its own clip
pauses on its last frame and resumes when the target re-enters.

**The delta at the playhead** is `valueAt(T_A, k) − valueAt(T_B, k)` (positive: A is
slower), the number the delta chart already plots, now named in words:
*+0.31 s at T11*. Corner names come from `sessionCorners` / `cornerLabel`
(`corners.js`), whose numbering is the app's, not the circuit's.

## Shared pure logic (ticket 1)

A new module, `public/js/video-sync.js`, ported as `VideoSync` to the Kit
(`Analysis/VideoSync.swift`) and `:core` (`VideoSync.kt`) under the same
names, and pinned by `contracts/logic/video-sync.json`, generated from the JS
by `contracts/logic.mjs` like every other fixture. Nothing in it touches the
DOM; `src/ai/` doesn't import it.

```js
export const SYNC_MODES = Object.freeze(["place", "time"]);
export const DEFAULT_SYNC_MODE = "place";
export const RESYNC_MS = 150;
export const FOLLOW_RATE_MIN = 0.5;
export const FOLLOW_RATE_MAX = 2;

// Fractional grid index where t[k] === e; clamped to [0, t.length − 1].
export function gridAtElapsed(t, e)
// Linear interpolation of a series at fractional k, clamped.
export function valueAt(series, k)
// A clip time (ms) → { e, k, inLap } for one side.
export function sideAtClipTime(side, clipMs)
// k → the clip time (ms) to seek that side to.
export function clipTimeAtGrid(side, k)
// The whole view's state from the master's elapsed time:
// { mode, inLap, a: { e, k, clipMs }, b: { e, k, clipMs } | null,
//   deltaS, gapM, byFraction }
export function playheadAt(sides, masterKey, eMaster, mode)
// The follower's rate in "place" mode.
export function followRate(sides, masterKey, k)
// Whether the follower is far enough from its target to re-seek.
export function needsResync(targetMs, actualMs)
// The words: the now-strip line, the scrubber's accessibility value, and the
// screen-reader "next / previous corner" stops.
export function playheadText(state, corners, units)   // → { place, value, delta }
export function cornerStops(corners, t)                // → [{ label, e }]
// Which lap is the single-lap stage's reference: the session best, the
// next-best when this lap is the best, else null. Takes matched laps
// ({ lap, chIdx } from matchLapsToChannels) and the lap's own chIdx.
export function referenceLap(matched, chIdx)
// Which of a session panel's lit laps the stage shows: A = the lap the view
// was opened for if lit, else the most recently lit; B = the fastest other lit.
export function stageSides(lit, laps, openedChIdx)
// A side is { key: "A" | "B", entry, dStepM, t, clip: { lapOffsetMs, durationMs } | null }.
export function makeSide(key, entry, dStepM, clip)
```

`makeSide` computes `t` once with `lapTimeSeries`. A future stored time
series is a second argument to it, nothing else.

**Fixture rows** (`video-sync.json`), chosen for the ways a port goes wrong:

- `gridAtElapsed` at `e < 0`, exactly `0`, between two points, exactly on a
  grid point, at the last point and past it.
- `sideAtClipTime` / `clipTimeAtGrid` round trips at the line, mid-lap and
  inside the pre- and post-roll (out of the lap).
- `playheadAt` in both modes for a fast and a slow lap, including the gap's
  sign, a pair over the length-mismatch threshold (`byFraction: true`), and a
  master swap.
- `followRate` clamped at both ends; `needsResync` at 149, 150 and 151 ms.
- `playheadText` for a corner, a straight after a corner, before T1, and out
  of the lap, in both unit systems (speed through `fmtSpeedKph`).
- `referenceLap` where the lap is the best, isn't the best, and is alone.

Test cases live in `test/unit/video-sync.test.js` and port with the module
(`VideoSyncTests.swift`, `VideoSyncTest.kt`).

**Ticket 1 also measures drift** on the real PDR and GoPro footage in
`telemetry-samples/` (gitignored): import, cut, then compare the derived
`k` against hand-marked frames at three braking markers per lap. Record the
numbers under *As built*.

## The playhead in the channel panel (ticket 1 web, 2 and 3 phones)

Every client's channel panel gains one **inbound** value, the playhead, beside
the outbound hit it already reports (`ChannelHit` / the web's `onHover`
payload: `chIdx`, `k`, `frac`).

- **Precedence of the mark.** What a chart marks is, in order:
  `hovered ?: scrubbing ?: playhead ?: parked`. A pointer hovering still
  borrows the mark without seeking (NS-34 ticket 5's rule). While the video
  plays, the playhead *is* the mark. A tap on a chart **pauses playback,
  seeks to that `k` and parks there**, so "a tap parks" still holds; pressing
  play again continues from the parked place. **Touch never drags a chart**:
  iOS rejected a `DragGesture` on the charts because it steals the page's
  scroll, and that stands on every client — dragging is the scrubber's job.
  A **mouse** may click-and-drag a chart to scrub (web, iPad / Mac pointer,
  Android `PointerType.Mouse`).
- **What draws it.** Every distance-axis chart (delta, speed, throttle,
  brake, steering, RPM, lateral G, yaw, the gear ribbon, the limit bands'
  charts) draws a vertical line at `k` with a dot on each lit lap's trace
  and that value in the chart's title read-out. The friction circle and the
  balance scatter ring the sample nearest `k` on each lit lap. The sector
  table highlights the sector containing `k`. The per-lap health strip (Car
  tab) is per lap, not per metre, and draws nothing.
- **Which laps it marks.** In *Same place* one `k` serves every lit lap. In
  *Same time* each side's own `k`: the line is A's, and B's dot sits at
  `k_B` on B's trace, so the gap is visible as two dots apart.
- **How it's drawn.** As an overlay above the chart, never as a mark inside
  the chart's own data (see each platform below). Only the overlay changes
  per frame; the traces never re-render because the playhead moved.
- **Out of the lap** nothing is drawn, and the read-outs go blank.

The track map gets the same value: a dot (two in *Same time*) placed with
`traceIndexAtFraction(trace, k · dStepM / lapLengthM)` — cumulative chord
length, not sample index (`contracts/logic/trackmap.json`). The stored trace
is the **session's best lap only**, so on any other lap the dot marks the
*place*, not that lap's line — the rule balance corner rows already use. A
cross-event compare places both dots on side A's session trace.

## The stage

### Video slot

- 16:9, letterboxed when the source isn't. Rounded like a card on large
  screens, square-cornered and edge to edge on a phone.
- A chip at top-left: the lap's colour dot (`--chart-line` for A,
  `--chart-line-b` for B), *Lap 5 · 2:19.812*, and ★ when it is its
  session's best. The colour is never the only way to tell the sides apart.
- No native player chrome. The stage's own transport drives the player;
  the platform's fullscreen control is replaced by the stage's (see
  *Phones*).
- **Replay slot** (no playable clip): the track map, the dot, and the
  label *Lap 3 · no video · replaying telemetry*. Offline, the label is
  *Playing a lap video needs a connection.* A Pro-locked clip shows today's
  upsell (`proPanelHtml` / `ProUpsellCard` / `TEProLocked`) above the replay
  slot, and a coach of a free student today's student-tier sentence.

### Transport

One row: **play/pause** (a 38 pt round button in the accent), the
**scrubber**, the **times** (*0:36.0 / 2:19.8*, the master's lap time, monospaced),
and in a compare the **mode control** *Same place | Same time*. On a phone
the mode control moves to its own row under the now-strip.

The scrubber:

- Its range is the master's lap time plus `PLAYBACK_LEAD_S` either side; a dashed tick
  marks the line (e = 0).
- Its track draws **the delta** (A − reference, or A − B) as a thin line
  scaled to the lap's largest absolute delta, in the danger colour. With no
  reference it draws A's speed instead.
- Ticks under it at each corner's start (`sessionCorners`), and at the two
  sector boundaries.
- Dragging seeks continuously (fast seeks) and exactly on release.
- Keyboard and screen reader: see *Accessibility*.

**Lap stepping** (single lap, NS-50 every-lap sessions): *‹ Lap 4* and
*Lap 6 ›* beside the chip step to the neighbouring lap that has a clip
(`lapVideoList` / `lapVideoStep` in `clip.js`, already the web's), keeping the
playhead's `k`. On the native lap page a step replaces the destination with
the neighbouring lap's (`Route.lap…`), so Back still returns to the event.

**Rate** (large screens only, a small menu at the transport's end): 0.25×,
0.5×, 1×. A slowed master slows the follower by the same factor.

### Now-strip

What the car is doing at the playhead, for side A (and B's speed in a
compare):

- distance and place — *1.50 km · in T2*, *after T4*, *before T1*, or
  *Before the line* / *After the line*;
- speed (big, monospaced, in the account's units) and gear;
- throttle and brake as two bars (`--limit-power`, `--limit-brake`);
- the delta — *+0.71 s vs B* / *vs best*, coloured slower/faster — or in
  *Same time* the gap, *B ahead 26 m*.

Large screens lay it out as a card with rows; phones and the tabletop's
lower half as one row (place · speed · gear · two vertical bars · delta).

## Layouts

The decision of which layout to use reads the **pane's own content width**
(`layout.contentWidth`, `PaneWidth`, the web's container width), never the
window's layout class, and the side column's width comes from
`sideColumnWidth(fraction:minimum:maximum:)` — the NS-34 rule that fixed the
iPad-portrait overflow. Numbers below are points (dp, CSS px).

| Content width | Layout | Stage | Charts |
|---|---|---|---|
| ≥ 1000 and `sideColumnWidth(0.24, 280, 360)` non-nil | **Wide** | Videos side by side (or one video) in the left area; transport under them; a right column with the map card above the now-strip. Stage height ≤ 45 % of the visible height. | Full width, one per row, scrolling under the pinned stage. |
| 600 – 999 | **Medium** | Videos side by side (each ≥ 280 wide), transport under them, then one row: map card (46 %) and now-strip card. | Full width, scrolling. The stage scrolls away with the page, but the transport row pins at the top once it reaches it. |
| < 600 | **Compact** (phone, closed Duo) | Sticky 16:9 player edge to edge; in a compare B is an inset (132 pt wide on a phone, 160 on a 466 pt closed Duo) at the bottom-right; transport row; now-strip row; mode row. | Full width, scrolling under the sticky player. |
| Tabletop posture (any width) | **Tabletop** | Above the crease: videos and the map card, vertically centred. Below: transport + now-strip in one row. Split at `Folds.tabletopTopShare` from the hinge. | Below the crease, two per row, the delta first. |
| Book posture (Android) | **Book** | Left page: the stage stacked as Medium. | Right page. The gutter lands on the hinge via `bookDirective`. |
| Phone landscape, stage has a video | **Full-bleed** | The master video fills the window; a HUD over a bottom gradient (speed, gear, delta, place), the scrubber along the bottom, the map (150×110) top-right and B's inset under it; the back chip top-left. | None. |

Wide is what an iPad in landscape, the open Duo in landscape, an Android
tablet in landscape and a desktop browser get. With an iPad's sidebar
showing, the detail pane is ~900 pt wide and drops to Medium — that is the
point of reading the pane, not the window.

**The compact player collapses**: once the charts have scrolled ~120 pt, the
player shrinks to a 64 pt mini bar (thumbnail, play/pause, scrubber) pinned
at the top; a tap on it scrolls back and expands it. Reduce Motion makes the
change a cut.

## Surfaces

| Surface | Today | Under this spec |
|---|---|---|
| **Lap page** (native `LapDetailScreen`; no web equivalent) | Header, video card, *Compare laps* sheet, best-lap map, facts, panel — one column | Header, **stage** (one-sided, reference = `referenceLap`), the panel inline under it, the facts card at the end. *Compare laps* pushes the session compare with this lap as A and the reference as B. |
| **Session compare** (Android `SessionCompareScreen`; iOS today the event page's overlay sheet, a new pushed `Route.sessionCompare` under this spec; web the event page's channel panel) | Chips and charts | The two-sided stage above the chips, its sides chosen by `stageSides(lit, …)`; lighting a lap changes A. With fewer than two lit laps, the stage is one-sided. |
| **Track compare** (`CompareLapsScreen` / `viewLapCompare`, `#/track/:id/lap-compare`) | A/B pickers, head-to-head, panel; no video | Pickers, then the stage (A and B are the picks), head-to-head below the transport on large screens and after the charts on phones, then the panel. The models already read each event's full detail, which carries `lap.clip`. |
| **Leaderboard lap** (`LeaderboardLapScreen` / `viewLeaderboardLap`) | Their line and traces vs your best | Their side is always replay. Your side plays your best lap's clip when it has one. |
| **Event page analysis column** (expanded native) | Map above panel | Unchanged layout; the session's panel gains the playhead and the map dot. When the selected session's lit lap has a clip, a *Watch* button opens the session compare. |
| **Shared item page** (NS-48) and **student view** (NS-38) | Lean read-only event pages | The same stages, read-only, with each existing tier rule. |

## Phones

- **Rotate to go full-bleed.** On a compact layout, when the stage shows a
  video (playing or paused) and the device turns to landscape, the stage
  presents the full-bleed layout over the window; turning back dismisses it
  at the same playhead. A fullscreen button on the video does the same in
  portrait, and the full-bleed back chip leaves it. With no video (replay
  only) rotation does nothing special. The rest of the app's orientation
  behaviour is unchanged.
- **Swap.** Tapping B's inset swaps the slots and the master; the scrubber
  and times then follow the new master. The swap is per view, not
  remembered.
- **The mini bar** keeps play/pause and the scrubber reachable while
  reading the steering trace at the bottom of the panel.

## Edge cases

| Case | Behaviour |
|---|---|
| One side has a clip, the other doesn't | That side is replay. The master is the side with video if A has none. |
| Neither side has a clip | **One** map card with two dots in place of two identical replay slots; play runs a timer at real speed. |
| Single lap with no other lap in the session | No reference: no delta in the strip or scrubber, which draws speed. |
| A lap with no channel entry (typed-in, or hand-added) | No stage. The lap page is today's time and sentence; a clip on such a lap plays in today's plain player. |
| A free account, or Pro lapsed | Video slots show the upsell and then replay. The delta and B are Pro (`canViewChannels`); a free account's stage is one-sided with no delta, the playhead on speed / throttle / brake. |
| Offline | Replay, with the connection sentence in the slot. |
| Signed URL expired (1 h) | On a load error or resume after expiry, fetch `/clips/:id/url` again (past the cache) and seek back to the same `k`. |
| A clip whose window doesn't cover the whole lap (a cut that started late) | Outside the clip's range the side behaves as replay until the playhead re-enters it. |
| Different grids (`dStepM` differs) | Already resampled by `alignLapPair`; the sync uses the aligned entries. |
| Laps over `LENGTH_MISMATCH_WARN` apart | Matched by fraction; the existing warning shows. |
| Deleting the clip from the stage's menu | The slot turns to replay in place; the playhead stays. |
| App backgrounded mid-play | Pauses. Picture-in-picture is out of scope. |

## Accessibility

- The scrubber is **one adjustable element**. Its value is
  `playheadText(...).value`: *0:41.2, 2.84 km, in T11, 82 mph, braking 64 %,
  +0.31 s*. Adjusting it (swipe up/down on iOS, `customActions` *Next corner*
  / *Previous corner* on Android, ↑/↓ on the web's `role="slider"`) moves to
  the next or previous corner from `cornerStops`.
- Play/pause, the mode control, the swap and fullscreen are labelled
  buttons; every tap that seeks has a named action, the NS-34 rule for chart
  cards that are one accessibility element.
- Keyboard (iPad, Mac, web): Space play/pause; ← / → one second; ⌥← / ⌥→
  one grid point (20 m); `,` / `.` one frame (paused); `S` toggles the sync
  mode; `F` full-bleed on a phone-sized web window. On iPad they are titled
  `Button`s with `.keyboardShortcut` so they list in the ⌘ overlay. None
  clashes with the panel's `1`–`4`, `[` / `]`, ⌘F.
- Reduce Motion: the mini-player collapse is a cut, and the onboard map dot
  jumps instead of easing. The playhead itself still moves — it is content.
- The live region does **not** announce every frame; it announces the
  corner on pause and after a seek.

## Performance

- Position comes from the player at display rate (30 Hz is enough) and is
  pushed to one observable; only the overlays read it.
- Two 1080p decodes at once are fine on every supported iPhone and iPad.
  Android caps the inset's decoder at 640×360 through track selection.
- Seeks while dragging use the fastest mode each platform offers (keyframe
  tolerance), with one exact seek on release; Corvette PDR clips have
  ~1.5 s GOPs, so an exact seek per drag event would stall.
- The replay clock and the video clock are the same seam (`eMaster` per
  frame), so the panel can't tell them apart.

## Web (ticket 1)

The web has no lap page, so its surfaces are the **event page's channel
panel** (the session stage), **`viewLapCompare`** (`#/track/:id/lap-compare`)
and **`viewLeaderboardLap`** (`#/track/:id/leaderboard/:lapId`), all of which
are also reached through the student view (`#/student/:id/…`) and the shared
item view (`/share/(e|s)/:token`, `sharedView`).

What exists today, and what changes:

- **Player.** `showLapVideo(box, clipId)` in `app.js` (~2094) builds a
  `<video controls preload="metadata" playsinline>` from an HTML string,
  seeks once on `loadedmetadata` to `playbackStartMs(offsetMs)`, keeps no
  reference to it, and listens to nothing else. The signed URL is
  `api(`/clips/${id}/url`, { cache: false })`, or `sharedClipUrl(id)` under
  `sharedView`. The stage replaces it for imported sessions; a plain session
  (no `channels`) keeps today's player unchanged.
- **Where it goes.** The event page already places the session's player in
  `bindChannelGraphs`' `afterChips` slot (between the chips and the panel's
  `<details>`), and the ▶ on a chip comes from `chipAfter` → `lapPlayHtml`.
  The stage takes that slot. A ▶ opens the stage with that lap as A and B
  from `stageSides(lit, …)`; lighting or dimming a chip re-picks the sides;
  the ▶ of the open lap hides the stage, as today. `openLapVideos` (the
  session → open clip map) keeps meaning "which lap's stage is open".
  `lapVideoList` / `lapVideoStep` drive the stage's lap stepper.
- **The charts.** `renderCharts` rebuilds `chartsEl.innerHTML` on every chip
  toggle, which wipes anything drawn into the SVGs, and there is no hook
  after it. Add an **`onRender(chartsEl)`** option to `bindChannelGraphs`,
  called after each render, so the stage can re-apply the playhead. Add
  **`showPlayhead(root, state)`** beside `showDistanceMark` in
  `channel-graphs.js`: a solid `<line class="ch-playhead">` (and a `<g>` of
  per-lap dots) in every `svg[data-channel]` under `root`, placed with the
  same `data-x1` / `data-padl` / `data-padr` geometry `showDistanceMark`
  uses; `null` removes them. It updates attributes only — it never
  re-renders a chart. The hover mark and `#tooltip` stay as they are: on the
  web the hover is already its own dashed mark, so it simply draws over the
  playhead.
- **Seeking from a chart.** The SVGs answer only `mousemove` today; nothing
  handles a click or a tap. Add one delegated `pointerdown` on the charts'
  container (bound once per container, like `bindGripCircle`), mapping x to
  `k` with the same geometry, calling the stage's seek; a mouse that keeps
  the button down scrubs (`pointermove` with capture), a touch only seeks.
  `viewLapCompare` and `viewLeaderboardLap` don't use `bindChannelGraphs` —
  they draw with `deltaChartSvg` / `channelChartSvg` / `gearRibbonSvg` into
  `#cmp-charts` / `#lb-charts` and read out with `bindPairTooltip` — so the
  helper is a free function, `bindChartSeek(root, dStepM, onSeek)`, that all
  three call. The friction circle's and balance scatter's existing `onHover`
  stays; their click seeks the same way.
- **The map.** `renderTrackMap` (`trackmap.js`) returns `{ setHighlight }` and
  animates a free-running dot (~8 s a lap) unrelated to anything. Add
  `setPlayhead(points | null)` to the handle — up to two `{ frac, colour }`
  — which **stops the free-running dot while set**. The stage renders its own
  map card (`renderTrackMap` into a canvas inside the stage), so the event
  page's big map, `#lb-trackmap` (whose handle is thrown away today) and the
  stage's never fight over one canvas.
- **Clips in the compares.** `comparableLaps` rows carry no clip, and the
  pinned row shape must not change. `viewLapCompare` already holds
  `sessionsById` from the event details it fetched; look the lap up there by
  `(sessionId, lapNum)` to get its `clip`. `viewLeaderboardLap`'s own side
  does the same; the other driver's never has one.
- **New module `public/js/lap-stage.js`** — the DOM half, web-only, never
  ported: `lapStageHtml(sides, ctx)` and `bindLapStage(container, opts)` →
  `{ seekGrid(k), setSides(sides), setMode(mode), destroy() }`. It owns up to
  two `<video>` elements **without** `controls`, `preload="metadata"`,
  `playsinline`, the follower `muted`; reads time each frame with
  `requestVideoFrameCallback` where it exists, else `requestAnimationFrame`
  over `currentTime`; calls `playheadAt`, then updates the transport, the
  now-strip, the stage map and `showPlayhead`. Follower rate through
  `playbackRate`; fast seeks with `fastSeek()` where it exists while
  dragging. Replay uses `performance.now()` as the clock. Errors keep
  today's words (`VIDEO_NEEDS_CONNECTION`, *This video has been deleted.*).
- **Layout.** The stage is a CSS **container** (`container-type:
  inline-size`) whose `@container` queries at 1000 px and 600 px pick Wide /
  Medium / Compact from its own width, which is the pane rule. The compact
  stage is `position: sticky` under the shell header; full-bleed is a fixed
  overlay covering the viewport (not the Fullscreen API, which needs a
  gesture), entered when `matchMedia("(orientation: landscape) and
  (max-height: 500px)")` matches while a video is loaded, and from the
  stage's fullscreen button, which also asks `requestFullscreen()` and
  tolerates a refusal. Colours from the existing tokens only.
- **Keyboard.** One `keydown` listener bound once at module level (the
  `wrapped-story.js` pattern), acting on the current stage and ignoring
  events whose target is an input, select or textarea. Space on a focused
  button keeps its native meaning.
- **Preference.** `currentSyncMode()` / `setSyncMode()` beside `currentTheme`
  in the `theme.js` style (try/catch around `localStorage`, unknown values
  fall back to `DEFAULT_SYNC_MODE`), in `lap-stage.js`.
- **Analytics**: no new route, so no new page-view shape.

## iOS (ticket 2)

What exists today: `LapVideoPlayer` (`LapVideo.swift`) owns its `AVPlayer`,
polls `AVPlayerItem.status` every 100 ms, seeks once to
`playbackStartMs`, and shows it in `LapPlayerView`, a private
`AVPlayerViewController` wrapper using AVKit's own fullscreen; nothing
observes time. `LapChannelPanel`'s mark is private `@State` (`parked`,
`hovered`, `mark = hovered ?? parked`) going out through `onHit` only, and
its read-out rule is **a two-point `LineMark` series inside the same samples
array as the traces** (`samples()`, `deltaSamples()`), deliberately not a
`RuleMark`. Chart taps arrive through each chart's `.chartOverlay`
`Rectangle().onTapGesture` + `onContinuousHover`.

Changes:

- **Kit**: `Analysis/VideoSync.swift` (the port), `VideoSyncTests.swift`
  (Swift Testing, `RepoRoot.path("contracts/logic/video-sync.json")`).
- **`App/Screens/LapStage/`** (new):
  - `LapStageModel` — `@MainActor @Observable`. Holds the sides, up to two
    `AVPlayer`s, `mode`, `swap`, `playing`, `eMaster`, `rate`. Observes
    `AVPlayerItem.status` by KVO (not a poll). One
    `addPeriodicTimeObserver(forInterval: 1/30 s)` on the master writes
    `eMaster`; the follower's rate and re-seeks follow *The sync model*,
    started together with `setRate(_:time:atHostTime:)`. Seeks while
    scrubbing use `toleranceBefore/After: .positiveInfinity` and one exact
    seek on release. Replay ticks from a `CADisplayLink`. Created in the
    screen's `.task { if model == nil … }` like every model, and keyed with
    the destination (`.id(route)`, NS-34), so a two-pane replacement builds a
    new one.
  - `LapStageView` — picks the layout from `layout.contentWidth`,
    `sideColumnWidth(fraction: 0.24, minimum: 280, maximum: 360)`,
    `\.verticalSizeClass` and `\.foldGeometry` through a pure
    `StageLayout.choose(…)` tested in `apps/ios/Tests/StageLayoutTests.swift`
    (the app target's unit tests, beside the breakpoints).
  - `StageVideoView` — a `UIViewRepresentable` over an `AVPlayerLayer`
    (`.resizeAspect`), **no** `AVPlayerViewController`: its controls can't
    drive two players or draw the delta.
  - `StageTransport`, `NowStrip`, `StageMapCard`. `TrackMapView` gains
    `dots: [TrackMapView.Dot]` (fraction + colour) beside `highlight`.
- **The panel**: `LapChannelPanel(…, playhead: LapPlayhead? = nil, onSeek:
  ((Double) -> Void)? = nil)`. The playhead is drawn **in each chart's
  existing `.chartOverlay`** as a `Path` placed with `proxy.position(forX:)`,
  never appended to the samples array — that array is the chart's data, and
  changing it 30 times a second re-lays-out every chart (the wedge
  `LapChannelChart.swift` documents for mixed marks is the same family of
  failure). With `onSeek` set, a tap calls it instead of toggling `parked`;
  without it the panel behaves exactly as today. The friction circle,
  balance scatter and sector table seek through the same `onHit` → `onSeek`
  path. The title read-out shows the playhead's values when there is no
  hover or park.
- **Lap page** (`LapDetailScreen`): header → `LapStageView` (one-sided) →
  the panel inline with `playhead` / `onSeek` → facts. `CompareLapsButton`
  and its `.sheet` are **deleted**; *Compare laps* pushes the new route
  below. The best-lap trace card moves into the stage's map card.
- **New route `Route.sessionCompare(eventId:sessionId:lapId:)`** (Android
  already has `Route.SessionCompare`): a pushed destination with the
  two-sided stage above `LapChannelPanel` over the whole session. The event
  page's *Compare laps* control pushes it too, below expanded width, instead
  of its sheet — one fewer `.sheet` on a page that already presents one. At
  expanded width the event page keeps `AnalysisColumn`. `analyticsPath`
  `/event/:id/session/:id/compare` (and the `/student/:id` form) — the shape
  Android already reports — and `remapTempIds` follows all three ids.
  `LapChannelChart` (the sheet wrapper) stays for `-channelGraphs` and
  `SharedItemScreen`.
- **Compares**: `CompareLapsModel.load()` already fetches every
  `EventDetail` and throws them away after building `rows`; keep
  `lapsBySession: [Int: [Lap]]` and resolve each pick's `Lap` (and `clip`)
  by `(sessionId, lapNum)`. `CompareLaps.Row` is pinned and unchanged.
  `LeaderboardLapScreen` (a sheet off the leaderboard screen) gets the stage
  inside the sheet, their side replay.
- **Full-bleed**: compact layout + `verticalSizeClass == .compact` + a
  loaded video → `.fullScreenCover` from the stage's host, the same
  `LapStageModel` passed in so playback doesn't restart; leaving landscape
  dismisses it. Check each host has no other modal on the same view (the
  one-presentation-per-view hazard); deleting the lap page's sheet makes the
  lap page safe.
- **Postures**: apply `publishingFoldGeometry()` to the lap,
  session-compare and track-compare destinations (today only the record
  route has it); `-tabletop <fraction>` forces it for review.
- **Keyboard**: zero-size titled `Button`s with `.keyboardShortcut`, the
  `keyboardCommands` pattern, so they list in the ⌘ overlay.
- **Preference**: a `SyncModeStore` in the `ThemeStore` style
  (`@Observable`, `UserDefaults` key `syncMode`, one owner, injected at the
  root), so a UI test can force it with `-syncMode time`.
- **Mac** (*Designed for iPad*): Wide layout, keyboard and pointer; no
  rotation path.
- **Debug**: `-lapStage` opens the stage on synthetic data with no server
  (the `-channelGraphs` pattern, and a generated H.264 file as
  `-syntheticClipVideo` does), for screenshots and the keyboard test.

## Android (ticket 3)

What exists today: `ClipPlayerHolder` (a `ViewModel` keyed
`lap-clip-player-<clipId>` on the back-stack entry) owns the `ExoPlayer`,
prepares it at `playbackStartMs`, and survives rotation — which matters,
because **`MainActivity` declares no `configChanges`, so every rotation
recreates the activity**. `ClipPlayer` shows an `AndroidView(PlayerView)`
and a full-window `Dialog` sharing the same player; no position is read.
`LapChannelChart` has no inbound mark: `PanelPointer` is created inside it
with `remember(channels)`, and `ChannelPlot` draws its dashed mark from a
private `markDistance`. **`ChannelPlot` and `DeltaPlot` have no
`pointerInput` at all** — only `SectorTable`, `FrictionCircle` and
`BalanceScatter` produce hits — so the lap page's *"Tap a chart to read
values."* hint is false today. `DeltaPlot` draws no mark.

Changes:

- **`:core`**: `VideoSync.kt` (the port), `VideoSyncTest.kt` reading
  `RepoRoot.path("contracts/logic/video-sync.json")`.
- **`app/…/ui/stage/`** (new):
  - `LapStageHolder` — a `ViewModel` on the back-stack entry, the
    `ClipPlayerHolder` pattern, owning both `ExoPlayer`s, the sides, `mode`,
    `swap`, `playing` and `eMaster` as `mutableFloatStateOf`, so rotation,
    a fold and the two-pane breakpoint keep the playhead and the playback.
    A player factory is injected so Robolectric tests run it without Media3.
  - Position: a `withFrameNanos` loop while playing reads the master's
    `currentPosition` into `eMaster`. Follower: `setPlaybackSpeed` from
    `followRate`, volume 0, `TrackSelectionParameters.setMaxVideoSize(640,
    360)` when it is the inset. Seeks: `SeekParameters.CLOSEST_SYNC` while
    dragging, `EXACT` on release. Replay uses the same frame loop with a
    clock.
  - `LapStage` (layout from `LocalLayoutMetrics.current.contentWidth`,
    `sideColumnWidth(0.24f, 280.dp, 360.dp)`, `LocalFoldGeometry` and the
    window height, through a pure `StageLayout.choose(…)` with a JVM test),
    `StageVideo` (`PlayerView` with `useController = false`, `RESIZE_MODE_FIT`),
    `StageTransport`, `NowStrip`, `StageMapCard`. `TrackMap` gains `dots`.
- **The panel**: `LapChannelChart(…, playhead: State<LapPlayhead?>? = null,
  onSeek: ((Double) -> Unit)? = null)`. Each plot draws the playhead in a
  `Modifier.drawWithContent` that reads the state **in the draw phase**, so a
  frame re-draws the overlay without recomposing the plot. Add
  `pointerInput { detectTapGestures }` to `ChannelPlot` and `DeltaPlot` (the
  missing taps above), mapping x with the plot's own `padLeft` / `span`,
  calling `onSeek` when set and `pointer.park` otherwise — which makes the
  hint true on every lap page, stage or not. A mouse drag scrubs through the
  `pointerHover` modifier's `PointerType.Mouse` filter extended to pressed
  moves. `DeltaPlot` gains the mark. `PanelPointer`'s precedence becomes
  `hovered ?: parked` over the playhead, with a tap clearing `parked` when
  playback resumes.
- **Lap page** (`LapDetailScreen`): the `LazyColumn` becomes header → stage
  item → panel item → facts, with the stage item sticky on compact
  (`stickyHeader`). `LapVideoCard` remains for laps without channels.
  *Compare laps* goes to `Route.SessionCompare(eventId, sessionId, lapId)`
  as today, which now draws the two-sided stage above its panel.
- **Compares**: `CompareLapsModel` keeps each event detail's laps by session
  and resolves `(sessionId, lapNum)` to a real `Lap` with its `clip`;
  `LapPair.laps` stops being synthetic for the clip. The track page's
  side-by-side compare (in `AppNavHost`'s `Route.Track` destination, not in
  `TrackScreen`) gets the stage inside its column, reading `PaneWidth`.
  `LeaderboardLapScreen` gets the stage, their side replay.
- **Lap stepping** replaces the destination (`navigate(Route.Lap(…)) {
  popUpTo<Route.Lap> { inclusive = true } }`), so Back returns to the event.
- **Full-bleed**: the phone-in-landscape test is **height, not class** —
  NS-34 records that a 915 dp landscape Pixel is an *expanded* window here —
  so full-bleed is `orientation == LANDSCAPE && screenHeightDp < 480` with a
  loaded video. It is the existing full-window `Dialog` (system bars hidden,
  `usePlatformDefaultWidth = false`), driven by `LapStageHolder`, so the
  activity recreation that the rotation causes doesn't restart playback.
- **Postures**: `LocalFoldGeometry` (tabletop: `Folds.tabletopTopShare`;
  book: the stage on the left page, as `bookDirective` already splits the
  shell).
- **Preference**: `stringPreferencesKey("sync_mode")` in the single
  `settingsDataStore` (`data/Settings.kt`), exposed like `ThemePreference`.
- **TalkBack**: the scrubber is one element with `stateDescription` from
  `playheadText` and `customActions` *Next corner* / *Previous corner*,
  plus *Play* / *Pause*.

## Tests

- **Unit (web)**: `test/unit/video-sync.test.js` — every fixture row's case,
  plus `lapTimeSeries` monotonicity on a lap with a standstill (the
  `DELTA_MIN_KPH` floor is what keeps `gridAtElapsed` well-defined).
  `channel-graphs.test.js`: `onRender` fires after a chip toggle's render.
- **Contracts**: `npm run contracts:check` covers `video-sync.json`; both
  phones assert it.
- **iOS**: `VideoSyncTests` (Kit); `StageLayoutTests` (app target);
  `LapStageUITests` against `npm run dev` with `-syntheticClipVideo YES`:
  open a lap with a clip, play, assert the scrubber's accessibility value
  advances; tap the speed chart and assert the video's state is paused and
  the value names that distance; open *Compare laps* and toggle the mode.
  `ChannelPanelKeyboardUITests` gains Space / ← / → on `-lapStage` (no
  server). `TwoPaneUITests` gains the stage invariant: at both iPad
  orientations the stage ends where the window ends.
- **Android**: `VideoSyncTest` (`:core`); `StageLayoutTest` (JVM);
  Robolectric: a tap on `channelChart:speed` calls `onSeek` with the
  expected `k`; `LapStageHolder` keeps `eMaster` and `mode` through
  `StateRestorationTester` and an activity recreation; the lap page at
  `w411dp-h891dp` and `w891dp-h411dp` (full-bleed) and `w1400dp-h1000dp`
  (wide).
- **Manual, per platform**: a real PDR every-lap session and a GoPro clip:
  scrub to three braking markers and check the line sits in the braking
  zone; a cross-event compare where one day has no video; offline; a free
  account; a coach of a free and of a Pro student; a shared session link.

## Docs owed (in the same PRs)

- **`README.md`** — the lap video section: the stage, sync modes, replay.
- **`AGENTS.md`** — `video-sync.js` (pure, ported, pinned) and
  `lap-stage.js` (web-only DOM half) in the `js/` bullet; `onRender`,
  `showPlayhead` and `bindChartSeek` on the channel-graphs bullet;
  `setPlayhead` on the trackmap note; the iOS `LapStage` folder,
  `Route.sessionCompare`, the retired lap-page sheet and the
  overlay-not-samples rule; the Android `ui/stage/`, the new chart taps and
  the height-based full-bleed rule.
- **`site/docs/telemetry-import.html`** — the *Best-lap video* section gains
  *Watching a lap*: the video and charts move together, tap a chart to jump
  the video, *Same place* / *Same time* in a compare, turn the phone for full
  screen, replay without video. Users' words, no implementation detail.
- **`site/index.html`** — the telemetry card's last sentence (*"…played on
  the lap's page."*) says the video plays in step with the charts. It also
  still says only "the iPhone app" saves clips, which has been stale since
  NS-47 / Android's NS-45 ticket — fix it in the same edit.
- **`docs/specs/native/README.md`** — the index row, and a feature-split
  line: on all three clients.
- **`NS-32-subscriptions.md`** — a tier-table row: *Video-synced analysis —
  follows its parts: video Pro (`canSaveLapVideo`), delta and two-lap
  compare Pro (`canViewChannels`), the playhead on the free charts free.
  No server gate.*
- **Privacy / store forms** — no change: nothing new is collected or sent,
  and analytics gains no new path shape on Android (iOS's new route reports
  the shape Android already does).

## Tickets

1. **Shared logic + web.** `video-sync.js`, its fixture and tests; the drift
   measurement on real footage, written into *As built*; `channel-graphs.js`
   (`onRender`, `showPlayhead`), `trackmap.js` (`setPlayhead`),
   `lap-stage.js`, `bindChartSeek`; the event page, `viewLapCompare`,
   `viewLeaderboardLap`, the student and shared views; the preference; the
   docs above except the phone halves of AGENTS.md. **Blocks 2 and 3**
   (they port the module and assert the fixture).
2. **iOS.** The Kit port; the panel's `playhead` / `onSeek` overlay; the
   `LapStage` folder; the lap page; `Route.sessionCompare` and the retired
   sheets; the compares and the leaderboard lap; full-bleed; postures;
   keyboard; the preference; `-lapStage`; tests; its AGENTS.md half.
3. **Android.** The `:core` port; the panel's taps, `DeltaPlot`'s mark and
   the draw-phase overlay; `ui/stage/`; the lap page; the session and track
   compares and the leaderboard lap; full-bleed by height; postures;
   TalkBack; the preference; tests; its AGENTS.md half.

Tickets 2 and 3 are independent of each other. Each may land as two PRs —
(a) the port, the panel's playhead and the lap page; (b) the compares,
full-bleed and postures — as long as (a) leaves the app shippable.

## Acceptance criteria

- [ ] On all three clients, a lap with a clip opens with the video above the
      charts, and while it plays a line moves along every distance-axis
      chart at the car's place and a dot moves on the map.
- [ ] Scrubbing moves the line, the dot and the now-strip together; tapping
      a chart pauses the video and seeks it to that place.
- [ ] Touch never drags a chart; the page still scrolls over the charts on
      every phone.
- [ ] A two-lap compare with two clips plays both from one transport. In
      *Same place* both cars reach each corner within `RESYNC_MS` of each
      other's distance; in *Same time* the now-strip shows the gap in metres.
- [ ] *Same place* is the first compare's mode; the last mode picked is the
      next compare's mode on that device, on each client.
- [ ] A side without a clip replays on the map; with no clip anywhere, play
      still runs the playhead at real speed.
- [ ] A single lap's stage shows the delta to the session best, or to the
      next-best lap when it is the best.
- [ ] The native lap page has no *Compare laps* sheet; *Compare laps* opens
      the two-lap stage with this lap and the reference.
- [ ] Turning a phone to landscape with a video on the stage goes full-bleed
      with the HUD, and turning back returns, at the same place, without the
      video restarting (Android: across the activity recreation).
- [ ] The open Duo in tabletop shows the picture above the crease and the
      transport and charts below it; an iPad with the sidebar showing gets
      the Medium stage and nothing runs off the window.
- [ ] Before and after the line, no line or dot is drawn and the read-out
      says so.
- [ ] Free, lapsed, coach, shared-link and offline cases behave as the
      *Edge cases* table says.
- [ ] VoiceOver and TalkBack can play, pause and step corner by corner
      through the scrubber; the keyboard shortcuts work on iPad, Mac and web.
- [ ] The charts don't recompose or re-render per frame (verified with the
      SwiftUI / Compose recomposition tools and a web performance trace).
- [ ] `npm test`, `npm run typecheck`, `npm run contracts:check`, `swift
      test`, `./gradlew :core:test :app:testDebugUnitTest` pass.

## As built — ticket 1 (shared logic + web)

### Drift of the derived time curve

Measured against the recording's own clock rather than hand-marked frames:
the importer cuts each grid point at a known time (`distS.timeAt(d0 + k·20 m)`
in `buildLapChannels`), so the true elapsed time at every grid point is
available from the parse itself, exactly, for every lap. The script compared
it with `lapTimeSeries` over the stored 20 m speed trace. "Braking points"
are the speed peak before each of the lap's first corners (`sessionCorners`),
the places a driver checks a marker.

| Recording | Laps | Worst drift a lap | Mean drift a lap | At the braking points |
|---|---|---|---|---|
| Corvette PDR (beacon-timed) | 7 | 0.14 – 0.26 s | 0.03 – 0.14 s | ≤ 0.16 s, ≤ 8.5 m (typically 1–5 m) |
| Cadillac PDR 2.5 (CT5-V Blackwing), 3 files | 4 | 0.10 – 0.23 s | 0.04 – 0.09 s | ≤ 0.20 s, ≤ 7.7 m (typically 1–3 m) |

No GoPro footage was to hand; a GoPro lap's channels come from GPS distance
the same way, so it should land in the same range. Much of the worst-case
figure sits at the end of the lap: the grid's last point stops up to 20 m
short of the line, yet `lapTimeSeries` scales that point to the whole timed
lap, so the last few hundred metres read up to a cell's time late. Scaling to
the lap's driven fraction would remove that part, but it changes
`lapTimeSeries`, which `contracts/logic/lap-delta.json` pins for both phones.

**Recommendation**: keep deriving. The error is a car length or two at the
braking points and within `RESYNC_MS` for most of a lap; storing a time
series stays the deferred option, and the end-of-lap scaling is the cheaper
fix if the drift ever shows on video.

### Deviations from the spec

- **More of the pure half is pinned.** `playheadAt`'s state carries
  `masterKey`, each side's `distM`, `inClip` (a cut that doesn't cover the
  moment leaves that side on replay) and `now` (speed, throttle, brake, gear at
  its `k`), so `playheadText(state, corners, units)` keeps the spec's
  signature. Also exported and in the fixture: `scrubRange`, `matchByFraction`,
  `cornerPlace`, `fmtStageTime`, `fmtDeltaS`, `fmtGap`, `BRAKING_WORD_PCT`.
  The ports implement them under the same names.
- **Signs are A/B-relative whichever side is the master.** `deltaS` is A − B
  at A's place in both modes (positive: A slower) and `gapM` is B's distance
  ahead of A (positive: B ahead), so the words stay *B ahead 26 m* after a
  swap. The spec's master-relative wording agrees whenever A is the master.
- **Out of the lap** in *Same place*, the follower keeps the master's time
  from the line — the same run-up before it, the same roll-out after — so the
  two cars cross it together.
- **Layout** is a `ResizeObserver` on the stage setting `stage-wide` /
  `stage-medium` / `stage-compact` rather than `@container` queries: the same
  rule (the stage's own width), and the same code also sets the sticky offset.
  The stage's wrappers are `display: contents` so the sticky stage pins over
  the charts rather than inside a box its own size.
- **Medium** orders videos, then the map and now-strip, then the transport:
  a sticky element shows its bottom edge when pinned with a negative `top`,
  so the transport has to be last to be what pins.
- **Compact** isn't sticky: the stage scrolls with the page and, 120 px past
  it, its transport moves into a bar fixed under the header (no thumbnail).
  The transport's slot keeps its height, so nothing below jumps.
- **The clock** is `requestAnimationFrame` over the master's `currentTime`;
  `requestVideoFrameCallback` wasn't needed.
- **No `setSides`**: when the lit laps change the event page rebuilds the
  stage, keeping the playhead's place and whether it was playing.
- **A door for laps without video**: the event page has *Play the lap* beside
  the chips, opening the stage on the newest lit lap (replay when it has no
  clip). A ▶ still opens its own lap.
- **Deleting a clip** from under the stage re-reads the page (the stage
  closes) rather than turning the slot to replay in place; a video that fails
  to load or play does turn to replay in place.
- **Head to head** stays above the charts on every width of the track
  compare.
- **Passing fix**: the session header (Edit / Share / Delete) didn't wrap, so
  on a phone it widened the whole event page; it wraps now.

### Verified

In a browser against `wrangler dev`, with three real Cadillac PDR sessions
and four lap clips cut by `mp4cut.js` and uploaded through the clip routes:
two-video playback (the follower rate-matched, ~1.13×), tap-to-seek (both
videos paused at the same place, 3.03 s apart), *Same time* (both at the same
elapsed time, the gap in words), → stepping a second, the remembered mode,
Wide pinning over the charts, Compact with the inset, full-bleed on rotation
and back at the same place, and the cross-session track compare. Not checked
in a browser: the leaderboard lap (it needs a second, opted-in account) and
the mini bar's scroll-back. The DOM half has no unit tests — the unit suite
has no DOM — so `onRender` after a chip toggle was checked in the browser
instead of in `channel-graphs.test.js`.

## As built — ticket 2 (iOS)

### What landed

- **Kit**: `Analysis/VideoSync.swift`, every export of `video-sync.js` under
  its name — the spec's list and ticket 1's extras (`scrubRange`,
  `matchByFraction`, `cornerPlace`, `fmtStageTime`, `fmtDeltaS`, `fmtGap`,
  `BRAKING_WORD_PCT`) — with the A/B-relative signs and the out-of-lap rule.
  `VideoSyncTests` asserts every row of `video-sync.json` (numbers to 1e-9,
  strings exactly) and carries the JS cases.
- **`App/Screens/LapStage/`**: `LapStageModel`, `LapStageView` (a container
  the page hands its `header` and scrolling `content`), `StageLayout.choose`
  (`apps/ios/Tests/StageLayoutTests.swift`), `StageVideoView` over an
  `AVPlayerLayer`, the transport, scrubber, now-strip and map card,
  `SyncModeStore`, `SessionCompareScreen` and the `-lapStage` demo.
- **The panel**: `LapChannelPanel(…, playhead:, onSeek:, onLitChange:)`. The
  playhead is a `LapPlayhead` (its own `@Observable`) read only by
  `PlayheadLayer` in each chart's `.chartOverlay` and by `PlayheadReadout` in
  its title, so a frame never touches the samples array.
- **Routes**: `Route.sessionCompare(eventId:sessionId:lapId:)` and
  `StudentPage.sessionCompare`, analytics `/event/:id/session/:id/compare`,
  `remapTempIds` and the temp-id follower over all three ids. The lap page's
  *Compare laps* sheet and the event page's overlay sheet are gone (the event
  page keeps one `.sheet`, its form sheet).
- **Surfaces**: the lap page, the session compare, the track compare (inside
  its sheet or column) and the leaderboard lap (inside its sheet). The
  student view reuses them. The expanded event page's analysis column gains a
  *Watch* button when the session has a lap video.

### Deviations from the spec

- **One clock, a display link.** The spec asks for
  `addPeriodicTimeObserver` on the master plus a `CADisplayLink` for replay.
  One `CADisplayLink` (30 Hz) does both: each tick reads the master player's
  `currentTime()` while it is playing, else advances by the wall clock. A
  master that leaves its clip mid-play (a late cut) becomes replay without a
  second mechanism, and the panel can't tell the two apart.
- **No `setRate(_:time:atHostTime:)`.** It needs
  `automaticallyWaitsToMinimizeStalling = false`, which on a streamed clip
  trades a start a few frames apart for stalls. The players seek exactly and
  start, and the follower's `RESYNC_MS` re-seek closes any start skew.
- **The single lap's reference is in the panel**, as a second lap that isn't
  lit — so it draws dim under the lap's own trace, as the spec says, and its
  chip can be lit to bring up the delta chart.
- **What the playhead draws**: the line and a dot per lit lap on every
  distance-axis line chart and the delta chart, and the values in each
  title. **Not yet**: the ring on the friction circle and balance scatter,
  the lit sector in the sector table, and the gear ribbon's line. Their taps
  do seek. Follow-up.
- **Compact isn't sticky**, as on the web. The stage scrolls with the page.
  Once its transport has slid under the top, the mini bar appears as an
  overlay (thumbnail, play/pause, scrubber), and a tap on the thumbnail
  scrolls back. The first build pinned the whole stage and shrank it to the
  bar in place. That made the page ~300 pt shorter, so near the bottom the
  clamped scroll offset fell back under the threshold, the stage grew again,
  and the page jumped back up. An overlay never changes the page's height.
- **Medium** pins the transport as a `LazyVStack` section header, so the
  transport sits *under* the videos and map, as on the web.
- **Tabletop** puts the charts below the crease one per row, not two. On a
  narrow window (under 600 pt) the map card leaves the top half to the
  pictures, and the now-strip and mode stack under the transport. Side by
  side there, the scrubber gets no width at all.
- **The track compare's head-to-head** sits above the panel at Medium and
  wider, and after it on a phone.
- **Medium caps the slots row** at 45 % of the visible height, as Wide does.
  A lone replay map across a whole iPad pane is otherwise taller than the
  screen.
- **Lap stepping** replaces the destination but does not carry `k` across.
  The new lap opens at its run-up.
- **The shared item page** (NS-48) keeps its sheet panel with no stage, as
  the iOS section allows. The **event page's analysis column** draws no
  playhead (it has no stage). It opens the session compare instead.
- **An expired URL** is fetched again once, on the item's failure. A resume
  after an hour paused with the item still healthy is not re-signed.
- **Deleting a clip** from the stage's menu re-reads the page, as on the web.

### Verified

Built with Xcode 27.1, against `npm run dev`:

- `swift test`: all 670 Kit tests pass, `VideoSyncTests` included.
- The app target's unit tests: 129 pass, with `StageLayoutTests` and the new
  `LapDetailTests`, `RouterTests`, `AnalyticsPathTests` and
  `CoachingRoutesTests` rows.
- On an iPhone 17 Pro simulator (iOS 26.4.1):
  - `LapStageUITests` passes. A lap with a clip opens video-first, play
    moves the playhead, a tap on the speed chart pauses the video and parks
    the playhead at that distance, and *Compare laps* opens the two-sided
    stage whose mode toggles.
  - `LapClipUITests`, `ChannelGraphsUITests` (now through the pushed
    compare) and `ChannelPanelKeyboardUITests` pass, the last including the
    stage's Space / ← / →.
- On an iPad Pro 13-inch: `TwoPaneUITests` passes, including the new
  `testTheLapStageEndsWhereTheWindowEnds` at both orientations.
- By hand:
  - `-lapStage`: two videos playing from one transport, the line and dot
    moving on the charts, the mini bar, and a replay stage with one map.
  - Rotating the iPhone to landscape enters full-bleed, and turning back
    leaves it at the same place.
  - On the iPhone Duo simulator (iOS 27.1), `-tabletop 0.55` splits the
    stage at the crease.

**Not verified**:

- A real PDR every-lap session and a GoPro clip on a device: the spec's
  braking-marker check.
- A real fold, the Mac (*Designed for iPad*), VoiceOver's corner stepping
  and announcements, and the 1-hour URL expiry.
- A free account, a lapsed one, and the coach and shared-link cases. Those
  paths reuse each screen's existing tier reads; no UI test covers them on
  the stage.
- `CoachingUITests`' coach half needs `TEST_RUNNER_TE_COACH_TOKEN`, which
  wasn't set here.
- `CoreScreensUITests.testEventLogsLapsAndShowsTheirStats` fails, but it
  fails identically on `main` (checked in a scratch worktree), so it
  predates this ticket.

## Open questions

- **Exact timing** — store each grid point's elapsed time at import, or keep
  deriving it? Deferred until ticket 1's drift numbers (see *Fixed
  decisions*).
- **The web's two-pane width** — the web shell has no two-pane layout, so
  Wide on the web is a desktop window. Is a 1000 px threshold right for a
  laptop with the panel inside the page's 1120 px column? Tune in ticket 1.

## Follow-ups, deliberately not here

- Picture-in-picture and AirPlay / cast of the synced stage.
- A frame-exact time track (above).
- Burning the HUD into an exported or YouTube video (NS-46 uploads the clip
  as cut).
- Syncing more than two videos.
- Video on the leaderboard (other drivers' clips stay private, NS-45).
