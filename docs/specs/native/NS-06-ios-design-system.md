# NS-06 — Design system tokens (iOS)

**Phase:** 0 · **Platform:** iOS · **Depends on:** NS-01 · **Estimate:** 2–3 days

## Goal

Port the Track Evolution design system from `public/style.css` into native iOS
primitives, so every later screen spec composes from tokens instead of
hand-picking colors.

## Source of truth

`public/style.css` lines 1–180 define the whole system: dual-theme semantic color
tokens (dark default, light variant, plus a `prefers-color-scheme` block that
follows the device when no theme is forced), a type scale, radii, easing, and
shadows. `site/site.css` mirrors the same tokens for the docs site.

**These stay the source of truth.** If the app's tokens change, the port is
updated to match — not the other way round.

## Requirements

1. **Colors → asset catalog** with light/dark variants per semantic name, so the
   system handles theme switching for free. Port every token, keeping the names
   recognizable (`bgPage`, `surfaceCard`, `textStrong`, `accentInk`, …):
   - Surfaces: `bg-page`, `bg-subtle`, `surface-card`, `surface-raised`,
     `surface-input`, `surface-hover`
   - Borders: `border-hairline`, `border-strong`
   - Text: `text-strong`, `text-body`, `text-muted`, `text-faint`
   - Accent: `accent`, `accent-hover`, `accent-contrast`, `accent-ink`,
     `accent-tint`, `accent-ring`
   - Semantic: `danger`, `danger-ink`, `danger-tint`, `positive`
   - Charts: `chart-line`, `chart-line-b`, `chart-line-c`, `chart-dim`, `chart-grid`
   - Map: `map-slow`, `map-fast`, `map-tarmac`
   - `shadow-color`
2. **Do not collapse the light/dark pairs.** Several are genuinely different hues,
   not lightness flips — `accent-ink` is `#c8f24e` in dark but `#4c6a00` in light,
   and the chart series colors change entirely (`#6ea8ff` → `#2f6fd6`,
   `#f49ac0` → `#b0348f`). Getting this wrong makes light mode unreadable.
3. **Theme override.** The web app supports forcing a theme via `<html data-theme>`
   (`public/js/theme.js`), persisted as a user preference. Mirror that: a
   `.system / .light / .dark` setting applied with `preferredColorScheme`, stored
   in `UserDefaults`, defaulting to system.
4. **Typography.** Bundle **Geist** and **Geist Mono** (the web loads them from
   Google Fonts; native must bundle them — check the license permits it, it does
   for Geist). Define a `Font` extension for the scale: `hero` 34, `h1` 26,
   `h2` 17, `h3` 15, `body` 14.5, `sm` 13.5, `xs` 12.5, `2xs` 11, with weights
   medium 500 / semibold 600 and the tracking values.
   - **Support Dynamic Type.** The web scale is fixed px; a native app that
     ignores accessibility text sizes is not a native app. Map the scale onto
     relative sizing so it grows, and verify the dashboard and event screens at
     the largest accessibility size.
   - Lap times must render in **Geist Mono** with tabular figures — times in a
     list have to align on the decimal.
5. **Shape and motion.** Radii `xs` 7 / `sm` 9 / `md` 11 / `lg` 14 / `xl` 20 /
   `pill` 999. Easing `cubic-bezier(0.22, 1, 0.36, 1)` ≈ a spring; define one
   standard `Animation` and use it rather than ad-hoc values. Depth is
   deliberately flat — **hairline border plus one surface step, not stacked
   shadows.** `shadow-pop` exists for popovers only.
6. **A token gallery view**, debug-only, showing every color swatch in both themes,
   the type scale, and the radii. This is how the port gets reviewed without
   diffing hex codes by eye.

## Acceptance criteria

- [ ] Every token in `public/style.css` has a named counterpart; none missing, none invented.
- [ ] Light and dark both render correctly, verified against the web app side by side.
- [ ] Theme override (system/light/dark) works and persists across launch.
- [ ] Geist and Geist Mono render; lap times are monospaced and tabular.
- [ ] Layout survives the largest Dynamic Type size without clipping or overlap.
- [ ] The gallery view compiles under a debug flag and is excluded from release.
- [ ] `git diff --stat public/` is empty — this spec reads `style.css`, never edits it.

## Verification

Run the gallery in the simulator in both themes and at max Dynamic Type,
alongside https://trackevolution.app in Safari, and compare.

## Notes

- The accent is deliberately used **sparingly** — it is the lime call-to-action
  and the "faster/improvement" signal, not a decorative wash. Reproduce that
  restraint; a screen where everything is lime is a mis-port.
- `--positive` and `--chart-line` being the same lime in dark mode is intentional:
  improvement reads as accent.
- Chart convention, relevant from NS-23 onward: **lower lap times plot lower**, so
  improvement trends downward.
