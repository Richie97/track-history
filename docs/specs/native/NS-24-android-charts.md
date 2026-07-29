# NS-24 — Charts + trackmap (Android)

**Phase:** 2 · **Platform:** Android · **Depends on:** NS-07 · **Estimate:** 4–5 days

## Goal

Progress line charts, the lap-overlay chart, and the speed-painted GPS trackmap,
in Compose.

**Read `NS-23-ios-charts.md` first.** The conventions — lower lap times plot
lower, three highlight slots with a dim envelope, token-only colors, empty-state
handling — are identical and not repeated here.

## Android-specific requirements

1. **Vico** for the standard progress charts (it is the mature Compose charting
   library), or raw `Canvas` if Vico's axis inversion fights the
   lower-is-better convention. Try Vico first; if inverting the Y axis is awkward,
   hand-rolling a line chart is ~200 lines and entirely reasonable — `chart.js` is
   only 248 lines of SVG.
2. **Compose `Canvas` for the custom work**: the GPS trackmap speed ramp and the
   start/finish line picker (used by NS-18), including hit-testing, pan, and zoom.
3. **Performance.** A trace can carry thousands of points. Draw the polyline as a
   single `Path`, not per-segment draw calls, and downsample for display —
   `lapTrace` (NS-14) already caps at 300 points for stored traces, but a live
   recording's raw trace can hold 20,000 fixes. Profile the line picker with a
   full-length recording.
4. **Colors from NS-07 tokens only.** Chart series colors differ by hue between
   themes; no literal hex.
5. **Accessibility.** `contentDescription` summaries on charts; a chart that is
   only visual is incomplete.

## Acceptance criteria

- [ ] Progress chart plots **lower times lower**, verified by test.
- [ ] Lap overlay highlights up to 3 laps in the correct slot colors, rest dimmed, best pre-selected.
- [ ] Trackmap matches the web app for the same trace.
- [ ] All colors resolve from design tokens; both themes verified.
- [ ] Line picker stays responsive with a 20,000-fix trace (profile and report frame timing).
- [ ] Single-point, identical-value, and empty datasets render without crashing.
- [ ] TalkBack reads a meaningful summary of each chart.
- [ ] Sessions with no channel data show a clean empty state.
- [ ] `git diff --stat public/ src/` is empty.

## Verification

Render the same event side by side with https://trackevolution.app and with the
iOS app. Use the NS-03 golden fixtures as inputs. Profile the line picker with
Compose's recomposition tracing.

## Notes

- Visual parity with iOS is **not** required — each platform should look native.
  Parity of *meaning* is: same data, same ordering, same downward-is-better
  convention, same color semantics.
- Resist adding chart types the web app doesn't have.
