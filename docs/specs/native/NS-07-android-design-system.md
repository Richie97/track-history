# NS-07 — Design system tokens (Android)

**Phase:** 0 · **Platform:** Android · **Depends on:** NS-02 · **Estimate:** 2–3 days

## Goal

Port the Track Evolution design system from `public/style.css` into a Compose
theme, so every later screen spec composes from tokens.

**Read `NS-06-ios-design-system.md` first** — the token inventory, the light/dark
warnings, and the design intent are identical and not repeated in full here.

## Requirements

1. **A custom token layer, not bare Material 3.** The palette is semantic
   (`surfaceCard`, `textMuted`, `accentInk`, `chartLineB`, `mapSlow`) and does not
   map cleanly onto Material's `primary`/`secondary`/`tertiary` roles. Define an
   immutable `TrackTheme` token class exposed via `CompositionLocalProvider`, and
   supply a Material `ColorScheme` derived from it only where Material components
   need one.
   - **Disable dynamic color (Material You).** The lime accent is brand identity;
     letting the OS wallpaper recolor the app would break the "faster = accent"
     signal the charts rely on.
2. **Light and dark schemes** ported token-for-token from `public/style.css`.
   The pairs are not lightness flips — `accentInk` is `#c8f24e` dark vs `#4c6a00`
   light, and chart series colors change hue entirely (`#6ea8ff` → `#2f6fd6`,
   `#f49ac0` → `#b0348f`).
3. **Theme override** — system/light/dark, persisted in DataStore, defaulting to
   system. Mirrors `public/js/theme.js`.
4. **Typography.** Bundle **Geist** and **Geist Mono** as font resources. Define a
   `Typography` covering the scale: hero 34sp, h1 26sp, h2 17sp, h3 15sp, body
   14.5sp, sm 13.5sp, xs 12.5sp, 2xs 11sp, weights 500/600, with the letter
   spacing values.
   - Sizes in **sp**, so system font scaling works. Verify the dashboard and event
     screens at the largest font-size setting.
   - Lap times in Geist Mono with tabular figures so lists align on the decimal.
5. **Shape and motion.** Radii xs 7 / sm 9 / md 11 / lg 14 / xl 20 / pill 999 dp.
   One standard easing approximating `cubic-bezier(0.22, 1, 0.36, 1)`. Depth is
   flat: **hairline border plus one surface step, not elevation shadows** — resist
   Material's default elevation on cards and surfaces.
6. **A token gallery screen**, debug-only, showing swatches in both themes, the
   type scale, and radii.

## Acceptance criteria

- [ ] Every token in `public/style.css` has a named counterpart; none missing, none invented.
- [ ] Dynamic color is off; the accent is the brand lime regardless of wallpaper.
- [ ] Light and dark verified side by side against the web app.
- [ ] Theme override works and persists.
- [ ] Geist / Geist Mono render; lap times monospaced and tabular.
- [ ] Layout survives the largest system font scale without clipping.
- [ ] Material cards do not render drop shadows.
- [ ] iOS and Android token values agree — diff the two ports deliberately.
- [ ] `git diff --stat public/` is empty.

## Verification

Run the gallery on an emulator in both themes and at max font scale, alongside
https://trackevolution.app, and compare.

## Notes

- The accent is used sparingly — the lime CTA and the "faster/improvement" signal,
  not decoration.
- Chart convention from NS-24 onward: **lower lap times plot lower.**
