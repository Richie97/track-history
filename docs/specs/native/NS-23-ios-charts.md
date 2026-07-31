# NS-23 — Charts + trackmap (iOS)

**Phase:** 2 · **Platform:** iOS · **Depends on:** NS-06 · **Estimate:** 4–5 days

## Goal

The visualizations: progress line charts, the lap-overlay chart, and the
speed-painted GPS trackmap.

## Reference

- `public/js/chart.js` (248 lines) — hand-rolled SVG `lineChart` + `multiLineChart`
- `public/js/trackmap.js` (126 lines) — the speed-painted racing line
- `public/js/channel-graphs.js` (211 lines) — the lap overlay UI
- Tests: `test/unit/chart.test.js`, `test/unit/channel-graphs.test.js`

## Requirements

1. **Use Swift Charts for the standard charts** — progress over time, per-event
   bests. Do not hand-roll what the framework does well; that was a web
   constraint (no build step, no dependencies), not a design goal.
2. **Hand-roll only what is genuinely custom**, on `Canvas`:
   - The **GPS trackmap** — a polyline colored by a speed ramp
     (`--map-slow` → `--map-fast`) over a `--map-tarmac` base. Swift Charts has no
     good primitive for this.
   - The **start/finish line picker** used by NS-17, which needs hit-testing, pan,
     and zoom.
3. **The critical convention: lower lap times plot lower**, so improvement trends
   downward. This is inverted from a naive "bigger is up" axis and it is the whole
   point of the progress chart. Get it wrong and the chart tells the opposite
   story. Assert it in a test.
4. **Lap overlay.** Up to **three** laps highlighted at once, using the
   `--chart-line` / `-b` / `-c` slot colors in that order, with the remaining laps
   drawn as a dim envelope (`--chart-dim`). Best lap pre-selected. Shared
   driven-distance axis so laps compare corner-for-corner.
   - Note the underlying per-lap channel data comes from imported sessions
     (`sessions.channels`). Whether native **recordings** produce channels is
     decided in NS-17 — if they do not, this view simply has nothing to show for
     natively-recorded sessions, which is acceptable. Handle the empty case
     gracefully rather than assuming channels exist.
5. **Colors come from NS-06 tokens only.** No literal hex in chart code. Chart
   series colors differ between light and dark by *hue*, not just lightness, so
   hardcoding will break one theme.
6. **Interaction.** Tap/drag readouts on the progress chart and the lap overlay,
   with haptic detents on value changes. This is where native earns its keep over
   the web version — but keep it legible on a phone in daylight.
7. **Accessibility.** Charts need `accessibilityLabel` summaries and
   `AXChartDescriptor` support so VoiceOver can read the trend. A chart that is
   only visual is incomplete.
8. **Empty and degenerate states**: one data point, all-identical values, a single
   lap. The web charts handle these; port the behavior rather than crashing on a
   zero-range axis.

## Acceptance criteria

- [x] Progress chart plots **lower times lower**, verified by test (`ChartScaleTests`).
- [x] Lap overlay highlights up to 3 laps in the correct slot colors, rest dimmed, best pre-selected.
- [ ] Trackmap renders the speed ramp correctly and matches the web app for the same trace.
- [ ] All colors resolve from design tokens; both themes verified.
- [x] Single-point, identical-value, and empty datasets render without crashing
      (`ChartScaleTests`, `ChannelGraphsTests`).
- [ ] VoiceOver reads a meaningful summary of each chart.
- [x] Sessions with no channel data show no way in at all — the event page's row is
      absent rather than opening onto an empty panel.
- [x] `git diff --stat public/ src/` is empty.

## Verification

Render the same event side by side with https://trackevolution.app and compare
shape, ordering, and color. Use the NS-03 golden fixtures as chart inputs so the
data is identical.

## Notes

- Chart parity with Android (NS-24) is **not** required — each platform should
  look native. Parity of *meaning* is required: same data, same ordering, same
  downward-is-better convention, same color semantics.
- Resist adding chart types the web app doesn't have. Feature drift starts here.
- The lap overlay opens as a **sheet of its own** rather than the web version's
  collapsible panel. Three stacked charts want a phone's whole width, and — the
  load-bearing half — a Swift Charts chart of a few hundred marks per lap inside the
  event page's `List` row never settles: the row is measured over and over, the app
  stops idling, and the page stops scrolling with it.
- Two more Swift Charts behaviors cost a day between them, and are commented where
  they bite: accessibility has to be suppressed **per mark** (Charts publishes an
  element for every mark, and a snapshot of that hierarchy never returns — which is
  every UI test and VoiceOver), and the chart's content builder has to stay one
  homogeneous `ForEach` (a `RuleMark` or an `if` beside it wedges layout, so the
  read-out's rule is a two-point line in the same data).
- Channel data is written by the *web* importer only, so there is no native way to
  create it: `-channelGraphs` launches the panel on synthetic data, and
  `UITests/ChannelGraphsUITests` seeds a session over the dev API and deletes it again.
