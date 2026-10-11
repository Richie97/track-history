# NS-40 — The paddock loop on the phones

**Phase:** post-rewrite · **Platform:** Shared (one server fix, web, iOS, Android) · **Depends on:** NS-29 / NS-31 (the garage), NS-32 (tier), the Car tab (#190), #147 (costs), NS-34 (large screens) · **Estimate:** 2–3 weeks across three PRs: shared logic + server + web, then iOS, then Android · **Issue:** [#369](https://github.com/Richie97/track-history/issues/369)

## Goal

Between sessions a driver is at the car with a pressure gauge, a fuel receipt
and a phone. Three things they would write down right then exist only on the
web or not at all. This spec brings all three to both phones:

1. **The setup notebook.** Log, edit and copy forward the day's setup sheet,
   with changed values highlighted against the day before. Also the
   **tire-pressure loop**: the Car tab's hot pressures become a recorded `tp_hot`
   and a suggested cold pressure for the next day.
2. **Track-day costs.** The four line items on the event form, plus the
   event's total and breakdown on its page.
3. **Session notes**, editable on every client after the session is saved
   ("brake later into T5, drop 2 psi rear").

```
Event page (phone)
┌─────────────────────────────────────┐
│ VIR (Full) · Sat 12 Oct · 2 days    │
│ Cost  $640   entry 450 · fuel 190   │
│ ┌ Day 1 setup ──────────── Edit ┐   │
│ │ Cold  FL 26  FR 26  RL 24  RR 24│  │
│ │ Hot   FL 34  FR 35  RL 31  RR 31│  │
│ │ Camber F −3.5 (was −3.2)  R −2.1│  │  ← changed values marked
│ └─────────────────────────────────┘ │
│ [ Log day 2 setup ]  copies day 1   │
│ Session 2 · 8 laps · 2:01.344       │
│   "Brake later into T5" ✎           │
└─────────────────────────────────────┘
```

## Why

The setup notebook was deferred as "desk-bound long tail"
([README](README.md#the-product-split)). That call put it in the wrong group.
A sheet is filled in **at the car**, between sessions, with a gauge in one hand.
The phones already do the arithmetic behind it: `Health.hotPressures` and
`Health.suggestCold` are ported and pinned, and the Car tab shows them. But
the result has nowhere to go, so the most useful number on the tab ends up
copied onto paper.

Costs were "web first" by the frontier rule (#147), and the web has now proven
them. Both native models already decode, patch and recompute the four line
items, so a phone edit never drops one. What's missing is the form.

Session notes are half-built: the column has existed since 0001, and iOS
edits it, but the web never calls `PUT /sessions/:id` and Android's
`EventModel.updateSession` has no caller.

## Fixed decisions

| | |
|---|---|
| Setup-notebook scope | **The per-day notebook and the pressure loop come to both phones.** The track page's **setup-vs-lap-times table** (`setupHistoryHtml` over `GET /tracks/:id/setups`) stays web-only. It is a season-review tool, like the two-event overlay. The README's deferred list loses the notebook and keeps the diff table. |
| Tier | Setups stay **Pro**, enforced by the server (`requireEntitlement` on every setups route, unchanged). The phones read `canUseSetups`, already ported and pinned but never yet called, and a free account sees the notebook **locked in place** (`ProUpsellCard` / `TEProLocked`), never missing. Cost entry and one event's total stay **free**, and so do session notes. The cost roll-ups stay Pro behind `canViewSpend`. |
| Units | Sheets are stored in psi and gallons, as today. The phones convert only at the edges, through ports of `setupToDisplay` / `setupToStored`, exactly as `garage.js` does. `diffSetups` runs on stored values. |
| Offline | Setup `PUT` / `DELETE` are **already queueable** on all three clients (`QUEUEABLE`; both native `isQueueable`). The sheet form works offline. Copy-forward prefill is a `GET`. Offline it falls back to the cached response, else to `previousSheet` over the cached event detail. That is the first half of the server's prefill rule; the other car's last event needs the server. Cost fields ride the event `PUT`, which is queueable. A session-notes `PUT` is queueable too. |
| Part refs | The sheet's five part refs (`tires_id`, `tires_f_id`, `tires_r_id`, `pads_f_id`, `pads_r_id`) are picked from the event's vehicle's parts in `GET /garage` (Pro, the same tier as the sheet). With no vehicle linked, or `/garage` not cached offline, the pickers are hidden and **any refs already on the sheet are kept as they are**. |
| Round-trips never lose a key | Neither native `SetupSheet` has `tires_f_id` / `tires_r_id` today, so a phone that saved a sheet the web wrote would erase them. Ticket 1 adds both to the two models and both `OfflinePatch` decoders before any phone writes a sheet. It also enriches a golden sheet so Android's strict decode fails if a key goes missing again. |
| Session `PUT` semantics | **Present keys only.** `PUT /sessions/:id` currently writes `label = body.label ?? null, notes = body.notes ?? null`, so a body without `label` clears it. It becomes the events rule: only the keys present are written, and an explicit `null` clears. iOS sends both today, so nothing breaks. |
| Where the form lives | A **pushed destination** on both phones, never a sheet or dialog. On iOS that's `Route.setupForm(eventId:day:)` (the event page already presents a modal, and two presentations on one view is the watchdog crash), with typed state on `AppRouter.heldFields` so the open Duo's rotation keeps it. On Android it's `Route.SetupForm(eventId, day)` with its draft in `SavedStateHandle` under the event form's `hydrated` rule (an `OutlinedTextField` in an `AlertDialog` never lets Robolectric idle). |
| Coach view | Unchanged. Setups and session notes are never shared (NS-38). Every new control hides under `readOnly` / `owner.isReadOnly`. |

## Requirements

### 1. Server (ticket 1)

- `PUT /sessions/:id`: build the `SET` list from the keys present, as
  `PUT /events/:id` does. An empty body is a 400 (`"nothing to update"`), and
  `label` / `notes` are trimmed, with `""` stored as null. Tests: notes-only
  keeps the label; label-only keeps the notes; an explicit null clears;
  another user's session is a 404.
- No change to the setups routes.

### 2. Shared pure logic (ticket 1, web; ported in 2 and 3)

**From `public/js/garage.js`**, ported to `Garage` in the Kit and `:core`
under the same names: `SETUP_FIELDS`, `CORNER_KEYS`, `AXLE_KEYS`,
`PART_REFS`, `setupFieldFor`, `setupUnit`, `setupStep`, `setupToDisplay`,
`setupToStored`, `flattenSetup`, `flatLabel`, `flatUnit`, `fmtSetupValue`,
`diffSetups`.

**New in `garage.js`**: `previousSheet(setups, day)`, the latest sheet with
`day < N`, or null. It is the comparison base for highlighting (today
`prevSheetFor` inside `viewEvent`) and the offline prefill. `viewEvent` calls
it in place of its local closure.

**From `public/js/health.js`**, ported to `Health` beside the existing
`hotPressures` / `suggestCold`: `pressureLoop(channels, sheet, targetPsi)`
and `nextTimeNote(loop)`. These were left web-only only because the notebook
was. **New in `health.js`**: the two writes `app.js` builds inline today,
extracted so the ports share them:
- `recordHotSheet(sheet, loop)`: the sheet with `tp_hot` merged from
  `loop.hotSheet`, plus the `nextTimeNote` line appended to `notes` (once; a
  sheet whose notes already contain that line isn't extended again — the web's existing `includes` rule).
- `nextDaySheet(nextSheet, todaySheet, loop)`: the next day's starting
  sheet, which is `nextSheet` if there is one, else today's sheet without
  `tp_hot`, with `tp_cold` from `loop.coldSheet`.

**From `public/js/costs.js`**, ported to a `Costs` namespace under the same
names: `COST_FIELDS`, `dollarsToCents`, `centsToDollars`, `fmtSpend`.
`eventCostCents` is already mirrored in both `OfflineMirrors`. The ports
re-point it at `Costs` rather than keeping a second copy.

**Fixtures**, committed with ticket 1:
- `contracts/logic/setups.json`: every field's display ↔ stored round-trip
  in both unit systems, including a bar value that doesn't land on the psi
  step. `flattenSetup` / `diffSetups` over a sheet with every key present.
  `previousSheet` with gaps (days 1 and 3). The loop over the `health.json`
  sessions plus a sheet, `recordHotSheet` twice (the note must not double),
  and `nextDaySheet` with and without an existing next-day sheet.
- `contracts/logic/costs.json`: `dollarsToCents` on `"12.5"`, `""`, `"-1"`,
  `"1,200"` (null: `Number` refuses the comma), and `"12.345"` (1235) and
  `"0.285"` (28, not 29). The second is the port trap: `Math.round(n * 100)`
  rounds the binary product, `28.499999999999996`, so a port that rounds the
  decimal string is a cent out. Also `centsToDollars` on 38950, 38900 and
  5 (the `toFixed` trap `units.json` already pins), and `fmtSpend` on 0, 99,
  123456 and null.

### 3. Web (ticket 1)

- **Session notes**: an *Edit* control on each session card opens an inline
  form (label + notes) and saves through `PUT /sessions/:id` with only the
  changed keys. It's hidden under `readOnly()`. The placeholder is
  *"What to change next session — brake later into T5…"*.
- `viewEvent` reads `previousSheet` and the loop's two buttons read
  `recordHotSheet` / `nextDaySheet`. Behaviour is unchanged, and the extraction
  is the deliverable.

### 4. The goldens and native models (ticket 1)

- `contracts/generate.mjs`: the rich event's day-2 sheet carries **every**
  key `sanitizeSetup` accepts. That's `tp_hot`, `toe`, `caster`,
  `compression`, `sway`, `fuel`, `notes`, and the part refs pointing at the
  fixture vehicle's parts, so `tires_f_id` / `tires_r_id` are non-null (iOS's
  golden check drops nulls before diffing). One session in the rich event
  gains notes edited through `PUT`, and a `session-update` capture records the
  present-keys body.
- Swift `SetupSheet` and Kotlin `SetupSheet` gain `tiresFId` / `tiresRId`.
  Both `OfflinePatch` setup decoders carry them. A test on each platform
  round-trips the golden sheet through the offline patch and asserts no key
  is lost.

### 5. iOS (ticket 2)

- **Event page**: a *Setup* card per event day, in the web's place (above the
  sessions). It shows the stored sheet (`fmtSetupValue` in the user's units,
  the part names, the notes), marks values changed against `previousSheet`,
  and offers *Log day N setup* / *Edit*. *Log* fetches the prefill
  (`APIClient.setupPrefill(eventId:day:)`, new) and opens the form pre-filled
  and labelled *"Copied from day 1"* / *"Copied from your last event in this
  car"*. Free accounts see one locked `ProUpsellCard` in the card's place.
- **Setup form** (`Route.setupForm`): built from `SETUP_FIELDS`, with corner
  and axle groups as rows of four or two numeric fields, then the part pickers,
  the notes and Save / Delete. It writes through new
  `APIClient.putSetup` / `deleteSetup`, which are queueable. Empty sheets
  can't be saved (the server's 400 says why). The form's `analyticsPath` is
  `/event/:id/setup/:day`.
- **Pressure loop on the Car tab**: `LapChannelPanel` takes an optional
  `PressureLoopContext` (the event's days and setups, the vehicle's
  `target_hot_psi`, and a save callback). `EventScreen` and `AnalysisColumn`
  supply it. Lap detail, the compares, the leaderboard lap and a coach's view
  pass nil, and the loop isn't drawn there. With a context and
  `canUseSetups`, `HealthStrip` gains the loop card: a hot / target / suggested
  cold row per corner, the day picker, *Record hot pressures* (`recordHotSheet`
  → `putSetup`), and *Set day N+1 cold* (`nextDaySheet` → pushes the form
  pre-filled). With no target set, it links to the car's form. It is one
  accessibility element with both buttons as named actions (the NS-34 rule).
- **Costs**: a collapsed *What it cost* section on `EventFormScreen` (and on
  the new-event form), with four dollar fields through `dollarsToCents`,
  carried in `EventFormDraft`. On the event page, a *Cost* tile plus a
  breakdown line, shown only when `costCents` is non-nil. Behind
  `canViewSpend`, the track page's *"$N spent"* and the vehicle page's spent
  figures (`event_cost_cents` / `parts_cost_cents`, already decoded) appear
  where the web shows them.
- **Session notes**: unchanged (`SessionEditSheet` already exists). It now
  sends only changed keys.

### 6. Android (ticket 3)

The same screens as iOS, the Android way:
- The setup card on `EventScreen`, `Route.SetupForm` as a `pageComposable`
  destination, `ApiClient.setupPrefill` / `putSetup` / `deleteSetup`, and the
  loop card in `HealthStrip` with its `customActions`.
- Cost fields in `EventFormModel`'s `SavedState`, with the `hydrated` rule
  holding. Tile, breakdown and the `canViewSpend` roll-ups as on iOS.
- **Session notes**: an *Edit label & notes* item in the session card's menu,
  wiring the unused `EventModel.updateSession`, with its typing in
  `SavedStateHandle`.
- `Route.analyticsPath` names `SetupForm`. `remapTempId` follows its
  `eventId`, since an offline-created event can carry a sheet before it
  syncs.

## Docs owed (in the same PRs)

- `docs/specs/native/README.md`: the product split, the deferred list (the
  notebook leaves it; the diff table stays) and the post-rewrite decisions
  entry, plus the costs paragraph ("neither phone shows one yet").
- NS-32's tier table: the setup-notebook row loses *(web)*; the pressure-loop
  row likewise; *Session notes* joins the free rows.
- `AGENTS.md`: the new `garage.js` / `health.js` / `costs.js` exports and their
  ports, the two fixtures, `Route.setupForm` / `Route.SetupForm`, the
  present-keys `PUT /sessions/:id`, and the sentence that calls the setup
  notebook web-only.
- `site/docs/garage.html` (the setup notebook and the pressure loop are on
  the phones), `site/docs/data-model.html` (costs entry on every client),
  `site/index.html`'s features grid if it says "on the web".
- No privacy-policy change: no new data, and nothing new is shared.

## Tickets

1. **Shared logic + server + web** ([#370](https://github.com/Richie97/track-history/issues/370)): the session `PUT`, the extractions and
   new functions, `setups.json` / `costs.json`, web session-notes editing, the
   enriched goldens, and the two native `SetupSheet` fields plus offline-patch
   tests. **3–4 days.**
2. **iOS** ([#371](https://github.com/Richie97/track-history/issues/371)): the ports, setup card and form, the loop on the Car tab, costs
   on the form and pages, UI test. **5–7 days.**
3. **Android** ([#372](https://github.com/Richie97/track-history/issues/372)): likewise, plus session-notes editing. **5–7 days.**

## Acceptance criteria

- [ ] On both phones a Pro user logs a day's setup, edits it, deletes it and copies it forward from the day before and from the car's last event, in either unit system. Changed values are marked against the previous day.
- [ ] A free account sees the notebook locked in place on both phones, never a "couldn't load" state.
- [ ] A sheet saved on a phone keeps every key the web wrote, including `tires_f_id` / `tires_r_id` and the notes. A test on each platform proves it over the golden sheet.
- [ ] Offline, a sheet saves into the queue, shows immediately, and replays on reconnect. The prefill falls back to `previousSheet` over the cached detail.
- [ ] The Car tab's loop records hot pressures (the note is appended once) and sets the next day's cold, on all three clients from the same pinned functions.
- [ ] Costs entered on a phone appear on the web and vice versa. The event page shows the total and breakdown when one is entered and nothing when none is.
- [ ] Session notes are editable on all three clients. A notes-only `PUT` leaves the label alone.
- [ ] A coach's view of a student shows none of it.
- [ ] `npm test`, `npm run typecheck`, `npm run contracts:check`, `swift test`, `:core:check`, `:app:testDebugUnitTest` pass.

## Follow-ups, deliberately not here

- **The setup-vs-lap-times table on the phones.** It joins the native track
  page if the paddock version earns it.
- **A session-level "next time" field** separate from notes, carried
  forward to the next event at the track. Today's notes plus the sheet's
  `nextTimeNote` cover it; a field of its own is the next ask if drivers use
  notes that way.
- **Currency.** Costs are formatted in dollars everywhere. A non-US user's
  currency symbol is a display change on all three clients and a units-style
  account preference.
