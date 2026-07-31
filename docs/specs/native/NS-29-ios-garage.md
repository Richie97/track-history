# NS-29 — Garage (iOS)

**Phase:** 2 · **Platform:** iOS · **Depends on:** NS-25 · **Estimate:** 1 week

## Goal

Consumable wear tracking on the phone: what's fitted to the car, how much life is
left in it, and the reminder that it's due — where the car is.

This spec exists because the garage came **off** the deferred list. The product
split (`README.md` in this directory) puts the desk-bound long tail on the web and
the on-track path on native, and deciding whether the pads will last the weekend
turned out to sit on the native side of that line: it is a question you ask in the
garage or the paddock, with a phone. Its **analysis** half — the setup notebook and
the setup-vs-lap-times diff — stays deferred, and that is a division rather than a
stopping point.

## Scope

**In scope**, mirroring `public/app.js`:

| Screen | Web reference | Route |
|---|---|---|
| Vehicle / garage page | `viewVehicle` (1792) | `#/vehicle/:id` |
| Dashboard maintenance strip + garage cards | `alertStripHtml`, `viewDashboard` | `#/` |
| Vehicle management | `viewSettings` (1676) | `#/settings` |

**Out of scope, still deferred:** the per-day setup notebook, the
setup-vs-lap-times diff, year in review, compare, telemetry file import.

## Requirements

1. **Nothing computes wear.** `GET /api/garage` returns every part with its
   estimate already computed by `src/lib/wear.ts`. The client renders it. A
   client-side reimplementation would be a third copy of that math (server, web
   mirror, native) and would be wrong in the paddock, where the client has stale
   events and the server does not.
2. **The presentation logic *is* ported**, and pinned. The due/low/ok thresholds
   and the "≈2 track days" phrasing (`partStatus`, `fmtRemaining`, `fmtHours`,
   `fmtCost` in `public/js/garage.js`) go in the Kit under the same names, with a
   `contracts/logic/` fixture generated from the JS. A threshold an hour out still
   looks plausible on screen, which is exactly why it needs pinning rather than
   eyeballing.
3. **Garage writes stay off the offline queue.** They are deliberately absent from
   `QUEUEABLE` and must remain so: retiring a part rewrites the wear of every other
   part on the car, a new part's expected life is *defaulted server-side* from
   retired lifecycles, and a refresh is a retire-plus-create whose successor id the
   client cannot invent. Reads still come through the cache — the garage is
   readable offline, not writable.
4. **The vehicle page** carries: accrued hours / days / events / parts spend, the
   maintenance strip, a card per consumable in service (wear bar, the one-line wear
   story, measurements), add/edit/retire/refresh/delete, measurement logging and
   deletion, the retired-parts list with cost per hour, and the track-hours ledger
   linking back to the events that produced them.
5. **The dashboard** carries the collapsed maintenance strip and a card per
   vehicle. `GET /api/garage` is fetched independently of the rest of the
   dashboard's data and its failure is swallowed — the garage is a section, not
   the screen, and an empty or failing garage must not cost the user their logbook.
6. **Settings owns the vehicle list** — add, make default, delete — because the
   default vehicle pre-fills new events. The event form's Car field stays free
   text: no vehicle picker (see NS-25), since a car that isn't in the garage has to
   keep working.
7. `#/vehicle/:id` resolves as a deep link, so a maintenance chip shared from a
   desk browser lands on the same car.

## Acceptance criteria

- [x] Every garage endpoint has a client method, and the golden contracts decode.
- [x] `partStatus`/`fmtRemaining`/`fmtHours`/`fmtCost` match the JS byte for byte
      on a committed fixture, boundary cases included.
- [x] Wear math is not reimplemented anywhere in the client.
- [x] Garage writes are absent from the queueable whitelist and fail offline with
      the server's own message.
- [x] A dashboard whose `/garage` call fails still renders the logbook.
- [x] A part with no expected life and fewer than two measurements says it has no
      estimate rather than showing an empty bar that reads as "new".
- [x] `#/vehicle/:id` deep-links; an unparseable id falls back to the dashboard.
- [x] A UI test walks add vehicle → add part → measure → delete, and cleans up
      after itself.

## Notes for whoever ports this to Android (NS-30?)

The three SwiftUI bugs this shook out are all layout-engine hazards with no
equivalent in Compose, but the *shape* of the mistakes generalises: one modal
presentation per view, no contradictory sizing on a full-width button, and pin the
style of any control whose default depends on context. The parts worth carrying
over are the data decisions — server-computed wear, writes that need a live
server, a garage section that fails independently of the screen it's on.
