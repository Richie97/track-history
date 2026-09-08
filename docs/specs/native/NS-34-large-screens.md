# NS-34 — Large screens: iPad, foldables and tablets

**Phase:** post-rewrite · **Platform:** iOS + Android (no server, no web changes) · **Depends on:** NS-25, NS-26 (the screens), NS-23, NS-24 (the charts), NS-17, NS-18 (the record screens) · **Estimate:** 5 tickets, roughly 8–10 days across both clients; ticket 1 alone is a day

## Goal

Both native apps already run on large screens — the Xcode project targets
iPad with every orientation, and the Android manifest has no orientation lock
or resizability restriction — but neither has a large-screen *layout*. Every
screen is one `NavigationStack` / `NavHost` column stretched to the window's
full width, so on a 13-inch iPad the app looks worse than the web app in
Safari on the same device, since the web caps its page at `--page-max` and
the phones cap nothing.

This spec gives the two clients a shared **layout class** derived from window
width, and uses the extra width to take back the three things the phone
layouts deliberately gave up: the analysis panel beside the track map, the
per-lap health table, and the wide table columns. It then adds the one
foldable-specific feature that earns its place (the tabletop-posture
recorder) and the two iPad-specific ones (pointer hover on the charts, drag
and drop of a clip onto an event).

The framing matters: this is **not** "add tablet features". It is the
observation that the phone layouts made width sacrifices, all of the logic
behind the sacrificed views already exists in the Kit and `:core`, and a wide
window gives them back as presentation-only changes.

## Where the phone layout gave something up

Each of these is recorded in the specs README or AGENTS.md as a deliberate
phone-width decision, and each is reversed on an expanded window by this spec:

| Phone decision | Where it is recorded | Expanded-width answer |
|---|---|---|
| The channel panel is a **sheet** over the event page, not a view beside the track map — so the friction circle's and balance scatter's hover, which marks the distance across the charts and rings the place on the map, stayed web-only | Friction circle and Balance entries in the README; `LapChannelChart` on iOS | The panel becomes the **right-hand pane** of the event page, beside the map. Tapping a chart point or a corner row marks the distance and rings the map, as the web does on hover |
| The health strip's **per-lap table is absent** ("fifteen columns is a desk layout") | Session health entry in the README | Rendered under the cards at expanded width only. `Health` already carries every number |
| The sector / shift / balance tables put the corner's **place and peak G under its label** rather than in columns | Balance entry in the README | Columns of their own at expanded width |
| Health cards go **two to a row** rather than an auto-filling grid | Session health entry | Auto-fill at expanded width, matching the web |

Nothing on that list needs a new function, a new fixture, or a change to
`contracts/logic/`. That is what makes this spec cheap relative to its value.

## Fixed decisions

| | |
|---|---|
| Unit of decision | **Window width**, never device or idiom. An iPad in Split View, a Fold opened flat, a phone in landscape and a Chromebook window all land in the same rules. iOS reads the horizontal size class *and* the window width (the size class alone cannot tell a 13-inch iPad from a half-screen Split View pane); Android reads `WindowSizeClass` from the window metrics. |
| The classes | Three: **compact**, **medium**, **expanded** — Material's window size class names and breakpoints, which iOS's `.compact` / `.regular` horizontal size class maps onto. See the table below. |
| Compact is unchanged | The phone layout as it ships today, byte for byte. This spec adds classes above it and touches nothing in it; a phone-only regression is a bug in this work. |
| Live, not launch-time | The layout class is a value observed while the app runs. Stage Manager, Split View, and folding all cross a breakpoint without relaunching. Anything read once at launch is wrong. |
| A column asks its own width | The window's class decides how many **panes** there are. Whether a page splits into two **columns** inside one of them is a question for that pane's own content width — `LayoutMetrics.sideColumnWidth` on both platforms — and the two answers disagree exactly where it matters: an iPad in portrait is an expanded window whose detail pane, once the sidebar is showing, is 683pt. Ticket 3 shipped reading the class, and the right-hand column ran off the side of the screen; below the expanded threshold a page is one column, whatever the window is. |
| Banners span the window | The recording banner and the sync banner stay pinned above the **whole window**, never above one pane. NS-18's rule that a recording is visible from anywhere is easy to break by accident once there are two panes. |
| No new routes | `Route` (iOS) and `Route` / `DeepLink` (Android) do not change. At expanded width the same values render in a detail pane instead of a pushed screen. A deep link lands the same place at every width. |
| Web-only stays web-only | The two-event compare overlay, the setup notebook and its diff, year in review and `.vbo` import remain on the deferred list. A large screen makes them tempting and does not reopen the decision; that is done in the README's deferred section, not in a layout ticket. |
| No recording on iPad | Most iPads have no GPS and an iPad on a dash is rare. The record screen stays reachable on iPad (it is a route) but gets no large-screen work, and the CarPlay scene is untouched. The foldable recorder work is about **posture**, not width. |
| Tier | Nothing here changes tier. Every gated surface renders the same Pro panel at every width. No row is added to the NS-32 table because no feature is added — every view here exists on the phones or the web already. |
| No server, no web | `src/` and `public/` do not change. |

### The layout classes

| Class | Width | iOS | Android | Layout |
|---|---|---|---|---|
| **compact** | < 600 pt/dp | `.compact` horizontal size class | `WindowWidthSizeClass.Compact` | Today's phone layout, unchanged |
| **medium** | 600 – 839 | `.regular` and width < 840 | `WindowWidthSizeClass.Medium` | The phone layout, with **grids filling by width** rather than the phone's fixed column count, and the content column **capped at `PAGE_MAX` and centred** |
| **expanded** | ≥ 840 | `.regular` and width ≥ 840 | `WindowWidthSizeClass.Expanded` | Two-pane list-detail; analysis beside the map |

`PAGE_MAX` mirrors `--page-max` in `public/style.css`. Both clients read it
from the design-token generators (`apps/ios/Tools/generate-tokens.mjs`,
`apps/android/tools/generate-tokens.mjs`) rather than typing the number, so a
change to the web's page width reaches the phones the way a colour change
does. The generators emit dimensions today only for colours; this is the
first layout token, and the generator change is part of ticket 1.

`PAGE_MAX` is 1120 pt/dp today, so the cap only bites on a full-window iPad
in landscape (which is exactly the case ticket 1 fixes on its own, before the
two-pane shell exists). What fixes the stretched look at **medium** width is
the other half of the rule: the tracks grid, the garage cards and the health
cards take as many columns as the width allows instead of the phone's fixed
count, and forms keep the phone's single column but stop stretching their
controls — a full-width primary button at 800 dp is a banner, not a button,
so `TrackButton` / the iOS button styles cap at the web's control width at
medium and above. Half of a folded-open Fold and an iPad in portrait Split
View sit in this tier, and that is a perfectly good answer for them.

Both clients expose the class as one value: `LayoutClass` in the iOS app
(`App/DesignSystem/LayoutClass.swift`, an environment value derived in
`RootView`) and `LayoutClass` in `:app` (`ui/LayoutClass.kt`, a
`CompositionLocal` derived in `MainActivity`). Neither lives in the Kit or
`:core`: the class is a fact about a window, not about the domain, and both
pure-logic modules must stay free of UI frameworks. The breakpoint numbers
are constants named `MEDIUM_MIN_DP` / `EXPANDED_MIN_DP` (the same names on
both platforms, with the same values, checked by a plain unit test on each so
the two cannot drift).

## Per-screen rules

Rules apply at **expanded** width unless stated. Medium is the phone layout
with the column capped and centred, on every screen, with no per-screen rules.

### Shell

- **iOS**: `RootView.signedIn` becomes a `NavigationSplitView` with the
  dashboard as the sidebar and the pushed route as the detail. The sidebar is
  `.balanced` style and can be collapsed; the detail keeps its own
  `NavigationStack` for pushes *within* the detail (event → track, track →
  vehicle) so deep-link `show(_:)` semantics hold. At compact width the split
  view collapses to the stack it is today, which is the framework's own
  behaviour and what keeps the compact layout unchanged.
- **Android**: `SignedInScaffold` wraps the `NavHost` in a
  `ListDetailPaneScaffold` (`androidx.compose.material3.adaptive`) at
  expanded width, with the dashboard as the list pane and the graph's
  current destination in the detail. The `BackHandler` that navigates rather
  than stops (NS-18) is unchanged: back in the detail pops the detail; back
  with the detail at the dashboard minimizes (`moveTaskToBack`), as today.
- **Both**: the recording banner and the sync banner are laid out above the
  scaffold, spanning both panes. The **review overlay** (save or discard a
  recording or import) stays modal over the whole window, not the detail
  pane — it is above the graph today for a reason (NS-26) and a two-pane
  layout must not demote it.
- **Both**: the sign-in screen and the paywall sheet are capped at their
  existing widths and centred. They need no other work.

### Dashboard (the list pane)

- Becomes the **list pane**. Upcoming events, the tracks grid and the garage
  cards keep their order (the shared dashboard rule in AGENTS.md); the
  tracks grid takes as many columns as the pane's width allows rather than
  the phone's fixed count.
- Selecting an event, track or vehicle sets the detail rather than pushing.
  The selected row is highlighted, since the detail is visible beside it.
- `+ Add event` opens the form **in the detail pane**. `Record laps` still
  pushes the record screen full-window at every width, since the record
  screen is designed for a phone in a mount and a half-width recorder is
  worse than a full one.
- With nothing selected the detail pane shows an empty state naming the
  next upcoming event, or "Pick an event" if there is none. It never shows
  the dashboard twice.

### Event page

The load-bearing screen. Today: one `List` / `LazyColumn` — summary, checklist,
best-lap trace with the limit legend, pace chart, a card per session with its
stats line, and *Add a session* at the bottom — with the channel panel as a
sheet from each session card.

At expanded width the page is **two columns inside the detail pane**:

- **Left column**: everything the phone page has today, in the same order,
  capped at `PAGE_MAX`. The session cards' *Channel graphs* control becomes a
  **selection** rather than a sheet trigger: the selected session's panel
  renders in the right column, and the card is highlighted. The best lap's
  session is pre-selected when the page opens, so a Pro user with channel
  data sees analysis immediately.
- **Right column**: the channel panel — `LapChannelChart` on both platforms,
  the *same* view the sheet hosts today — for the selected session, with the
  best-lap track map **above it** in the same column so map and charts are
  in one eyeline. The panel keeps its tabs (Time / Inputs / Grip / Car) and
  its lit-lap chips; its memory of tab and lit state per session id (the
  `memory` the web panel grew for #190) applies here too, so switching
  sessions and back keeps the tab.
- **Cross-linking, the point of the column**: tapping a sample on the
  friction circle, a sample or a corner row on the balance scatter, or a
  sector row marks that driven distance across every chart in the panel and
  rings the place on the track map — the behaviour the web has on hover and
  that the README records as web-only *because* the phones' panels are
  sheets. The distance-marking primitive is per platform (`showDistanceMark`
  on the web; the two `LapChannelChart`s carry the axis geometry to place
  it); the mark-to-trace mapping is `Limits.limitMarkers`'s driven-distance
  fraction rule, already ported. A corner row carries no lap index (it is a
  place every lap shares) and rings whichever lap the trace is, exactly as
  `bindBalance` documents.
- The **iOS sheet stays** at compact and medium width and is not rebuilt.
  The `LapChannelChart` note that a chart of this many marks inside a `List`
  row never settles still holds: the right column is **not** a `List` row.
  It is a sibling of the `List` in an `HStack`, with its own `ScrollView`.
  Putting the chart inside the left `List` to save a column is the bug that
  note exists to prevent.
- **Health per-lap table** renders under the health cards on the Car tab.
  Columns are `HEALTH_DEFS` in order, the same set and order as
  `healthTableHtml`. Cards auto-fill the column width rather than going two
  to a row.
- **Sector, shift and balance tables** put place-on-track and peak G in
  columns of their own, as the web does.
- The pace chart and the best-lap trace widen with the column. Nothing else
  on the left changes.

### Track page

- Two columns: the summary, the best-lap-per-event chart with its conditions
  wash, the leaderboard section and the event list on the left; the *Setup
  vs. lap times* placeholder is **not** added (web-only, deferred list).
- The **two-lap compare** (#165, a sheet on both phones today) opens in the
  right column at expanded width, with its picker at the top and the
  head-to-head, delta chart and channel overlays under it. It is the same
  `CompareLapsScreen` view; only its container changes. The compare view's
  sector table and gear ribbon come with it unchanged.

### Vehicle page (the garage)

- Two columns: tiles, the maintenance strip and the consumable cards on the
  left; the selected part's measurements and the track-hours ledger on the
  right. Selecting a card selects the part. The ledger's driven-only filter
  and the "no basis, no bar" rule (NS-31) are unchanged. *(Since 2026-09 the
  ledger is gone from the page on every client; the right column is the
  selected part's measurements alone.)*
- Garage writes stay off the offline queue, as before. Width changes
  nothing about what a screen may write.

### Event form, Settings, shared logbook

- Capped at `PAGE_MAX` and centred at medium and expanded. The event form
  renders in the detail pane when opened from the list pane. No columns:
  a form that spreads into two columns reads out of order.
- The shared logbook (`/share/<slug>`) follows the event page rules for its
  event view and the dashboard rules for its list, since it is the same
  screens read-only.

### Record screen

- **No width work.** The record screen is a phone-in-a-mount layout and stays
  full-window and single-column at every width.
- **Posture work** (Android, ticket 4): in **tabletop posture** — the device
  half-open, hinge horizontal, lying flat or on a dash — the screen splits
  at the hinge. The **top half** carries the live timing read-out (lap
  counter, running lap, predictive delta from `LiveTiming`) at a size
  readable from the driver's seat; the **bottom half** carries Start / Stop,
  the fix-quality indicator and the event it will attach to. Nothing is laid
  across the hinge. Posture comes from `androidx.window`'s
  `WindowInfoTracker` / `FoldingFeature` (`state == HALF_OPENED`,
  `orientation == HORIZONTAL`); any other posture is the existing layout.
- iOS has no foldable and no posture API; the record screen is unchanged
  there.

## Foldables

Foldables add **posture** and **screen switching**, not only width, and the
recorder is where that pays off:

- **Tabletop posture as a pit-wall timer** (above). The one
  foldable-specific *feature* in this spec.
- **Folding mid-recording.** Folding a Fold moves the app from the inner to
  the cover display, which is a configuration change with a new window size.
  The recording is owned by the foreground service (NS-16) and survives
  this by construction; the things to *verify* are that the record screen's
  model, the review flow's held pick (`RecordingFlow`, above the view tree
  for exactly this reason), and a half-typed event form (`SavedStateHandle`)
  all survive too. The groundwork is there — screen models are scoped to the
  `NavBackStackEntry`, not `remember`ed (NS-26) — so this is an **audit** of
  anything still held in a bare `remember`, with a Robolectric test per
  screen that changes the configuration mid-state. Anything found is a bug
  to fix in that screen, not a layout feature.
- **Book posture** (hinge vertical, half-open) is the expanded two-column
  layout with the columns aligned to the halves. It falls out of the event
  page rules and needs no rule of its own beyond: nothing lays across the
  hinge, so column widths follow the fold's `bounds` when one is present
  rather than splitting the width evenly.
- **Play's large-screen quality guidelines** score readiness on the store
  listing, and current Android versions ignore orientation and resizability
  restrictions on large screens regardless — the manifest already declares
  none, and this spec adds none.

## iPad specifics

- **Pointer hover** (ticket 5). With a trackpad or Magic Keyboard attached,
  hovering a chart point does what tapping does at expanded width (marks the
  distance, rings the map), via `.onContinuousHover`. Hover is additive to
  tap, never a replacement, since the same iPad is used by touch a moment
  later. Compose has `hoverable` / pointer-input hover events for the same
  behaviour on a Chromebook or a tablet with a mouse; it is in scope but
  second to iPad, since that hardware is rarer.
- **Keyboard shortcuts** for the panel: `1`–`4` switch tabs, `[` / `]` step
  the lit lap, `⌘F` toggles the friction circle's envelope. Declared with
  `.keyboardShortcut`, so they appear in the iPad's ⌘-key overlay for free.
- **Drag and drop a clip** from Files onto the event page (or onto a session
  card's *Add a session*) to start an import. The drop yields a file URL and
  feeds the existing `.importVideo(eventId:, incoming:)` route — the same
  no-copy security-scoped path `.fileImporter` uses (NS-30). Nothing about
  parsing changes; this is a drop target and a route push. Android's SAF
  picker and `ACTION_SEND` already cover the equivalent flows and get no
  drop target (drag and drop between apps on Android tablets exists but is
  rare enough not to build for yet).
- **Stage Manager and Split View** resize the window while the app runs,
  which is the "live, not launch-time" decision above and needs nothing
  further once the class is an observed value.

## Testing

- **Unit** (both): `LayoutClass` from a width, at the three boundaries and
  one below each; `MEDIUM_MIN_DP` / `EXPANDED_MIN_DP` equal on both
  platforms (each platform's test pins the literal; a PR that changes one
  and not the other fails the other's test).
- **iOS UI tests**: `CoreScreensUITests` and `ChannelGraphsUITests` run on
  an iPad destination as well as the phone (`-destination
  'platform=iOS Simulator,name=iPad Pro 13-inch (M4)'` in `ios.yml`), attaching
  screenshots as today. One new assertion: selecting a session on the event
  page at expanded width shows the panel beside the map with no sheet
  presented. The gallery (`-tokenGallery`) gains the three layout classes.
- **Android**: Compose previews at 400, 700 and 1000 dp for every screen
  that has per-screen rules; Robolectric tests under `w840dp` and
  `w600dp` qualifiers for the scaffold (two panes vs one), the event page
  (panel beside the map vs sheet) and the fold audit (state survives a
  configuration change mid-edit); `AutoRecording`-style plain tests for the
  tabletop layout's string and template assembly. `ChartGalleryActivity`
  in the `debug` source set gains an expanded-width page.
- **Manual, before rollout**: an iPad in Split View at each of the three
  widths, a Fold folding and unfolding mid-recording and mid-form, and Stage
  Manager resizing across a breakpoint with the channel panel open.

## Tickets

Each ticket is a PR on its own, covers **both** platforms, and leaves `main`
shippable. The first two carry almost all of the value. The epic is
[#214](https://github.com/Richie97/track-history/issues/214).

| | Ticket | Delivers |
|---|---|---|
| 1 | **Layout class + content max-width** ([#215](https://github.com/Richie97/track-history/issues/215)) | `LayoutClass` on both platforms with the pinned breakpoints; `PAGE_MAX` emitted by both token generators; every screen capped and centred, grids filling by width and controls no longer stretching at medium and expanded. No two-pane work. A day, and every current large-screen user's experience becomes presentable |
| 2 | **Two-pane shell** ([#216](https://github.com/Richie97/track-history/issues/216)) | `NavigationSplitView` / `ListDetailPaneScaffold` at expanded width; dashboard as the list pane with selection highlighting; banners and the review overlay above the whole window; the detail pane's empty state; the event form in the detail pane |
| 3 | **Analysis beside the map** ([#217](https://github.com/Richie97/track-history/issues/217)) | The event page's right column: track map over the channel panel, session selection instead of the sheet at expanded width, tap-to-mark across charts and map; the health per-lap table; wide table columns; the track page's compare in the right column; the vehicle page's two columns |
| 4 | **Foldable postures** ([#218](https://github.com/Richie97/track-history/issues/218)) | Tabletop-posture recorder on Android; the fold/unfold state audit with a Robolectric test per screen; book-posture column alignment to the hinge |
| 5 | **iPad pointer, keyboard and drop** ([#219](https://github.com/Richie97/track-history/issues/219)) | Hover on the chart panel; the panel's keyboard shortcuts; drop a clip on the event page to import |

Ticket order is the order above; 3 depends on 2, 4 and 5 depend on 1 only
and can run in parallel with 2 and 3.

## Rejected alternatives

- **A separate iPad app or a tablet module.** Two apps to keep in step, for
  layout differences that a width class expresses in one. Rejected.
- **Porting the web-only features because the screen is now big enough.**
  The deferred list is a product decision about where work happens, not a
  screen-size constraint; reopening it is a README change with its own
  argument, as the garage and video import each had. Rejected here.
- **Deriving the class in the Kit / `:core`** so both ports share one
  implementation. The class is derived from platform window APIs, and both
  pure modules forbid UI-framework imports. The breakpoint constants are
  pinned by tests instead. Rejected.
- **Keeping the panel as a sheet on iPad, wider.** A wider sheet is still a
  sheet over the map, and the whole value of ticket 3 is the map and the
  charts in one eyeline. Rejected.
- **A three-pane layout** (list, event, panel) on a 13-inch iPad. The panel
  is per session and the session list is inside the event, so a third pane
  has nothing to be a list *of*. Two panes with two columns in the detail is
  the right shape. Rejected.
- **Recording on iPad as a target.** No GPS on most models, rarely on a
  dash; the recorder's value is the phone in a mount and the head unit.
  Rejected — the route stays reachable, and gets no work.

## Follow-ups this spec does not cover

- **Sidebar sections** (events by year, tracks, garage) once the list pane
  exists and the dashboard's flat list grows long. A separate ticket after
  ticket 2 ships and the shape is seen.
- **Hover on Android** tablets and Chromebooks with a mouse — in scope in
  ticket 5 but second to iPad, and may slip to its own ticket if the iPad
  work fills it.
- **Android drag-and-drop** onto the event page, once tablet usage
  justifies it.
- **CarPlay** is untouched here. A CarPlay dashboard widget or a wider
  template is a CarPlay ticket, not a large-screen one.
