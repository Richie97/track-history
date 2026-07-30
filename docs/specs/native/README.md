# Native stack rewrite — specifications

Work breakdown for replacing the Capacitor shells in `mobile/` with first-party
native apps: **SwiftUI (iOS)** and **Jetpack Compose (Android)**.

## Fixed decisions

These are settled. A spec that appears to require changing one of them is a spec
that needs rewriting, not a decision to revisit.

| | |
|---|---|
| Client stack | SwiftUI (iOS) + Jetpack Compose (Android) — two first-party native apps |
| Backend | **Unchanged.** Cloudflare Workers + Hono + D1, same `/api` and `/auth` |
| Web app (`public/`) | **Unchanged.** Stays as-is, maintained in parallel as a third platform |
| `mobile/` (Capacitor) | Retired at the end, replaced by the native projects |
| Priorities | 1. Background GPS + CarPlay reliability  2. Native feel/performance |

**`src/` must not change.** `npm test` and `npm run typecheck` stay green with
zero backend diffs throughout. NS-03 adds test-side output only. If a spec seems
to need a backend change, stop and raise it.

## The product split

The three clients are deliberately **not** at parity:

- **Native apps own the on-track critical path** — recording, the logbook you
  check between sessions, CarPlay/Android Auto. Fast, offline, reliable with the
  screen off.
- **The web app owns the desk-bound long tail** — telemetry file import, year in
  review, deep garage/setup analysis. Big screen, file drag-and-drop, ships
  instantly.
- **The web app stays the feature frontier.** New ideas land there first and
  graduate to native once proven.

Consequence: **the telemetry parsers (`public/pdr.js`, `js/import/gpmf.js`,
`vbo.js`, `pdr-laps.js`, `channels.js`) are never ported.** That is the design,
not a gap. `js/import/geo.js` *is* ported (NS-13/NS-14) because the live recorder
needs start/finish line crossing to time laps.

## Specs

### Phase 0 — Foundations

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-01 | [Monorepo layout + iOS project scaffold](NS-01-ios-scaffold.md) | iOS | — |
| NS-02 | [Android project scaffold](NS-02-android-scaffold.md) | Android | — |
| NS-03 | [Golden-JSON API contract harness](NS-03-contract-harness.md) | Shared | — |
| NS-04 | [Domain models + API client — iOS](NS-04-ios-api-client.md) | iOS | NS-01, NS-03 |
| NS-05 | [Domain models + API client — Android](NS-05-android-api-client.md) | Android | NS-02, NS-03 |
| NS-06 | [Design system tokens — iOS](NS-06-ios-design-system.md) | iOS | NS-01 |
| NS-07 | [Design system tokens — Android](NS-07-android-design-system.md) | Android | NS-02 |
| NS-08 | [Auth — iOS](NS-08-ios-auth.md) | iOS | NS-04 |
| NS-09 | [Auth — Android](NS-09-android-auth.md) | Android | NS-05 |
| NS-10 | [Native CI](NS-10-native-ci.md) | Shared | NS-01, NS-02 |

### Phase 1 — The recorder

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-11 | [RecorderCore port — iOS](NS-11-ios-recorder-core.md) | iOS | NS-01 |
| NS-12 | [RecorderCore port — Android](NS-12-android-recorder-core.md) | Android | NS-02 |
| NS-13 | [Lap geometry port — iOS](NS-13-ios-lap-geometry.md) | iOS | NS-01 |
| NS-14 | [Lap geometry port — Android](NS-14-android-lap-geometry.md) | Android | NS-02 |
| NS-15 | [Background location + durable fix store — iOS](NS-15-ios-location-service.md) | iOS | NS-11 |
| NS-16 | [Foreground location service — Android](NS-16-android-location-service.md) | Android | NS-12 |
| NS-17 | [Recording UI + review/save — iOS](NS-17-ios-recording-ui.md) | iOS | NS-15, NS-13, NS-08 |
| NS-18 | [Recording UI + review/save — Android](NS-18-android-recording-ui.md) | Android | NS-16, NS-14, NS-09 |
| NS-19 | [CarPlay driving-task scene](NS-19-carplay.md) | iOS | NS-15 |
| NS-20 | [Android Auto](NS-20-android-auto.md) | Android | NS-16 |

### Phase 2 — Logbook + offline

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-21 | [Offline cache + write queue — iOS](NS-21-ios-offline.md) | iOS | NS-04 |
| NS-22 | [Offline cache + write queue — Android](NS-22-android-offline.md) | Android | NS-05 |
| NS-23 | [Charts + trackmap — iOS](NS-23-ios-charts.md) | iOS | NS-06 |
| NS-24 | [Charts + trackmap — Android](NS-24-android-charts.md) | Android | NS-07 |
| NS-25 | [Core screens — iOS](NS-25-ios-screens.md) | iOS | NS-21, NS-23, NS-08 |
| NS-26 | [Core screens — Android](NS-26-android-screens.md) | Android | NS-22, NS-24, NS-09 |

### Phase 3 — Ship

| ID | Spec | Platform | Depends on |
|---|---|---|---|
| NS-27 | [Store rollout + Capacitor retirement](NS-27-rollout.md) | Shared | NS-25, NS-26 |
| NS-28 | [Documentation update](NS-28-docs.md) | Shared | NS-27 |

## Deferred — not in this programme

Available on web throughout, ported to native later or never: garage (vehicles,
parts, wear, measurements), setup notebook, setup-vs-lap-times diff, year in
review, compare view, and **all telemetry file import**.

## Conventions for every spec

- Lap times are integer milliseconds everywhere; format/parse `m:ss.fff`.
- API errors are `{ error: string }` with a meaningful status; surface that string.
- Ported logic keeps the **same function names and constants** as its JS original
  so the two can be diffed by eye.
- Every ported pure function ports its JS test cases with it, same inputs, same
  expectations.
- Per `AGENTS.md`, documentation changes ship in the same change as the code.
