# NS-32 — Subscriptions (Track Evolution Pro)

**Phase:** post-rewrite · **Platform:** Shared (server, iOS, Android, web) · **Depends on:** NS-25, NS-26, NS-27 · **Estimate:** 3–4 weeks, in four separately shippable phases

## Goal

Replace the $1 up-front app purchase with an auto-renewing subscription —
**$1.99/month or $19.99/year** — sold through the App Store and Google Play,
without breaking the promise the logbook already makes: one account, three
clients, your data is yours.

The subscription is an **account-level entitlement owned by the server**. The
native apps are purchase terminals for their store; the Worker is the only thing
that decides whether a user is Pro.

## Why this spec exists, and why it breaks a fixed decision

The rewrite programme (NS-01…NS-28, epic #63) fixed **`src/` must not change**.
That rule was scoped to the rewrite — it kept the port honest by forbidding the
backend from bending to fit a client — and the programme is closed. This is a
*product* change, not a port, and the whole point is that it lands in `src/`
first. Every later NS spec still asserts an empty `src/` diff; this one is the
deliberate exception and says so here so nobody reads the diff as a mistake.

It is one spec rather than four (server / iOS / Android / web) because the tier
boundary and the entitlement rule have to be decided *once*. The platforms are
phases of the same spec, each with its own issue under the epic, and a phase can
ship alone — phase A on its own changes nothing a user can see.

## Fixed decisions

| | |
|---|---|
| Model | Freemium: **Free** is the logbook, **Pro** is the analysis. Not a hard paywall. |
| Price | $1.99/month, $19.99/year (USD; store-tiered elsewhere). One subscription group, two products, so the stores handle upgrade/downgrade. Optional 14-day introductory free trial on both. |
| Where the entitlement lives | The server. `users.entitled_until` + a `subscriptions` table. Clients never decide tier from a local receipt. |
| Purchase surfaces | iOS: StoreKit 2. Android: Play Billing Library. Web: **none in this spec** — the web app shows tier and says "subscribe in the phone app". Stripe is a documented follow-up, not a phase. |
| Existing $1 buyers | **Pro for life** (`provider = 'legacy'`). Nobody who paid loses a feature. |
| Lapse | Loses Pro *reads and features*. **Never loses data, and never has a write rejected** — see rule 5. |
| App prices | Both stores flip to **free** at phase D, not before. On Google Play this is permanent. |

## The tier boundary

The free tier is exactly what the web app is today for someone with no
telemetry: a logbook that fills up and is worth sharing. Pro is everything that
turns lap times into analysis.

| Feature | Tier | Where it is enforced |
|---|---|---|
| Tracks, events, sessions, manual lap times (unlimited) | Free | — |
| Best lap per track, progress chart, consistency, per-session stats | Free | — |
| Public share pages, per-track leaderboards | Free | — (share is unauthenticated; a leaderboard behind a paywall is empty) |
| Offline reads and writes, prep checklist, themes, Settings | Free | — |
| The garage's **vehicle list** (pre-fills the car field) | Free | — |
| GPS lap recorder, live timing, predictive delta | **Pro** | Client, at *start* (rule 5) |
| Telemetry import — video on iOS, video + `.vbo` on web | **Pro** | Client, at the point of import |
| Channel graphs, lap delta chart, two-lap compare | **Pro** | Server: `channels` stripped from session payloads (rule 4) |
| Two-event lap overlay (web) | **Pro** | Client |
| Garage **consumables**: parts, wear, measurements, refresh, ledger | **Pro** | Server: `requireEntitlement` on the parts/measurements routes and `GET /garage` |
| Setup notebook + setup-vs-lap-times diff (web) | **Pro** | Server: `requireEntitlement` on the setups routes |
| Year in review (web) | **Pro** | Client |

Two consequences of that table are the reason it is shaped this way:

- **The paid features live where the purchase happens.** Recording, import and
  the garage are what the phone is for, and the phone is where the store is.
- **The gates fall on whole routers or one field.** No route needs a per-branch
  tier decision. `requireEntitlement` sits in front of three routers, and one
  helper strips one field. Anything harder than that is a sign the boundary is
  in the wrong place.

Every feature added after this ships gets a row in this table **before** it
merges — the same discipline the README's "post-rewrite feature decisions"
section applies to the web/native split.

## Requirements

### 1. The server owns the entitlement

- Migration `0017_subscriptions.sql`:
  - `subscriptions (id, user_id, provider, product_id, external_id, status,
    expires_at, auto_renew, environment, raw, created_at, updated_at)`.
    `provider ∈ {apple, google, legacy}` (room for `stripe`). `external_id` is
    Apple's `originalTransactionId` or Google's `purchaseToken`, **unique per
    provider** — the same purchase posted from a second device or a second
    account must update the row, never duplicate it, and a token already bound
    to a different `user_id` is a 409, not a transfer.
  - `users.entitled_until INTEGER` — the denormalised answer, recomputed from the
    user's subscriptions on every write to the table. `NULL` is free; a far-future
    sentinel is legacy; otherwise it is the latest `expires_at` plus the grace
    below.
- **Zero extra round trips.** `sessionUserId` in `src/lib/session.ts` already
  runs one D1 statement per request; it joins `users` and returns
  `entitled_until` with the id, and `requireSession` sets both on the context.
  `requireEntitlement` is then a pure comparison against `Date.now()`, and D1
  pays nothing for it.
- **Grace.** The stores report their own billing-retry / grace states
  (Apple's grace period, Play's `IN_GRACE_PERIOD`) — honour them as entitled.
  On top, add **3 days** of server-side slack to `entitled_until` for webhook
  lag: a renewal Apple has already charged must not read as a lapse because a
  notification took an hour.
- `GET /api/me` gains:

  ```json
  "entitlement": {
    "tier": "free" | "pro",
    "source": null | "legacy" | "apple" | "google",
    "expires_at": null | 1767225600000,
    "auto_renew": null | true | false
  }
  ```

  `expires_at` is `null` for free *and* legacy. Contract fixtures regenerate,
  and **both native `User`/`Me` models gain the field in the same PR** —
  Android decodes with `ignoreUnknownKeys = false`, so this is not optional.
- **Cron trigger** (`triggers.crons` in `wrangler.jsonc`, a `scheduled`
  handler): once a day, re-verify every `apple`/`google` row expiring in the
  next 48 h or expired in the last 7 days against the store API. Webhooks are
  the fast path; this is the one that makes a missed webhook cost a day rather
  than a customer.

### 2. Apple: verify, then listen

- `POST /api/billing/apple` — body `{ jws }`, StoreKit 2's
  `jwsRepresentation`. The Worker **verifies the JWS itself**: x5c chain to the
  Apple Root CA G3 (pinned in `src/lib/billing/apple-roots.ts`), ES256
  signature via WebCrypto, `bundleId == "app.trackevolution"`, and `environment`
  recorded. Verification is local and free; the App Store Server API is used
  only by the cron re-check (`GET /inApps/v1/subscriptions/{originalTransactionId}`).
- The Server API JWT is ES256 with `kid`/`iss`/`aud: appstoreconnect-v1`/`bid`
  — `src/lib/apple.ts` already builds exactly this shape for Sign in with Apple;
  factor `signES256` out and reuse it rather than adding a JWT dependency. New
  secrets: `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY`
  (distinct from the Sign in with Apple key — different key, different role).
- `POST /billing/apple/notifications` — App Store Server Notifications V2. Public
  route, **outside `/api`** (no session), added to `run_worker_first`. The
  `signedPayload` is verified with the same chain code; unknown notification
  types are logged and acked with 200. Handled: `SUBSCRIBED`, `DID_RENEW`,
  `DID_CHANGE_RENEWAL_STATUS`, `EXPIRED`, `GRACE_PERIOD_EXPIRED`, `REFUND`,
  `REVOKE`, `DID_FAIL_TO_RENEW`. Sandbox and production notification URLs both
  point at this route; `environment` on the row keeps them from colliding.

### 3. Google: verify, then listen

- `POST /api/billing/google` — body `{ purchase_token, product_id }`. The Worker
  calls `purchases.subscriptionsv2.get` with a service-account access token
  (RS256 JWT → OAuth token exchange, WebCrypto again; secret
  `GOOGLE_PLAY_SERVICE_ACCOUNT` holding the JSON key). Reads
  `subscriptionState` and the line item's `expiryTime`; `linkedPurchaseToken`
  (an upgrade/downgrade) retires the old row.
- **The client acknowledges only after this route returns 200.** Play refunds
  an unacknowledged subscription after three days, so acknowledging before the
  server has the token is how a paying user ends up free, and acknowledging
  never is how they end up refunded.
- `POST /billing/google/rtdn` — Real-Time Developer Notifications delivered as a
  Pub/Sub **push** subscription. Verify the push's OIDC bearer token (Google's
  JWKS, `aud` = this URL, `email` = the push service account) before decoding
  the base64 `subscriptionNotification`; on any notification, re-fetch the
  token's state from the API rather than trusting the notification's type —
  RTDN tells you *something changed*, the API tells you *what*.

### 4. `channels` is the Pro field

Every response that carries `sessions.channels` — the event detail in
`routes/events.ts`, and whatever the two-lap compare reads — passes through
one helper, `stripProFields(row, entitled)`, that nulls `channels` for a free
account. `trace` is **not** stripped: the track map is part of the free
logbook, and a session with a trace and no channels is exactly what a recorder
save looks like today.

The clients already render "no channel data" for `channels: null`; the paywall
copy is layered on that state, not a new one. A Pro user who lapses keeps
seeing channels from the offline cache until the next successful fetch — that
is acceptable and not worth a cache purge.

### 5. A lapse never destroys laps

The offline layer on all three clients **drops** server-rejected writes and
surfaces them in the sync banner (`offline.js`, NS-21, NS-22). A recording made
under Pro and replayed after a lapse would meet a 402 and be *deleted*. It is
the one irreplaceable thing in the system. Therefore:

- **No write route checks entitlement.** `POST/PUT/DELETE` on events, sessions,
  laps, tracks stay free for every signed-in account, forever. `channels` on a
  session POST is accepted from anyone — an imported session that took an hour
  to line up is as irreplaceable as a recording.
- The recorder and importer are gated **at start**, client-side, against the
  cached `entitlement` from `/api/me`. Offline, the cached value stands: a
  driver who was Pro at the last sync records. The gate is a paywall sheet, not
  a disabled button — it names the price, the term, and the two legal links.
- The garage's Pro routes are all reads or live-server-only writes (already
  off the queue, NS-29/NS-31), so `requireEntitlement` on them cannot drop a
  queued write. The setups routes *are* queueable on the web; they stay
  queueable and get the entitlement check — a 402 on a setup sheet drops a
  form, not a session, and the web sync banner already says why.
- A `402 { error: "pro required" }` is its own `ApiException`/`APIError` case on
  both native clients, the way `Unauthorized` is: the UI shows the paywall
  rather than the sync banner's generic "server rejected".

### 6. Grandfathering

- **iOS** is authoritative and permanent: `AppTransaction.shared` →
  `originalAppVersion`. Anything **below the first subscription build** is
  posted to `POST /api/billing/apple/legacy` with the app transaction's JWS;
  the server verifies it exactly like a purchase and writes a `legacy` row.
  This works for a user who installs the app for the first time in two years
  from a purchase made today.

  > **Phase B deviation (2026-09): the cutoff is a nullable constant, and it
  > ships `nil`.** "The first subscription build" cannot be named by the phase
  > that ships the purchase flow, for two reasons found while building it. The
  > iOS build number is **Xcode Cloud's** (`CFBundleVersion` is overwritten per
  > archive — README → App version), so `CURRENT_PROJECT_VERSION` in
  > `project.yml` is not what any install's `originalAppVersion` reports, and
  > the number is only known once the build exists. And the app stays a paid
  > download through phases B and C — an install made from the phase B or C
  > build *also* paid, and grandfathering it is correct, not a leak. So the
  > constant is `Entitlement.APPLE_FIRST_SUBSCRIPTION_BUILD: String? = nil` in
  > the Kit, mirroring the Worker's already-optional
  > `APPLE_FIRST_SUBSCRIPTION_BUILD`: nil reads as "every install bought it" and
  > every install claims. **Phase D sets both to the first free build's Xcode
  > Cloud number**, in the same change that flips the price; until then the
  > server's rule and the app's are identical (`compareVersions` is ported), and
  > a claim from a not-yet-known build cannot happen because no such build
  > exists. The claim is skipped in the Xcode StoreKit environment (the Worker
  > can't verify its signatures) and is retried past its once-only flag by
  > Restore Purchases, so a paid-app buyer whose launch-time claim failed has a
  > button to press.
- **Android has no equivalent.** Play cannot tell a client whether the app was
  bought. The path is a **transitional release** (phase C, shipped *before* the
  price flips): the app sends `X-TE-Client: android/<versionCode>` and calls
  `POST /api/billing/google/legacy` once per install; the server writes a
  `legacy` row for any such call **before `LEGACY_CUTOFF`** (an env var, set to
  the flip date at phase D). Thirty-day sessions mean an already-signed-in
  user never re-exchanges a code, so the claim runs from the app on launch, not
  from `/auth/exchange`. Anyone who paid, never opened the transitional build,
  and shows up after the cutoff gets Pro from the support inbox
  (`eric@speedshift.io`) — say so on the account-deletion page's neighbour, a
  new *Subscription* section in the docs.
- Legacy is a row like any other, so a legacy user who later subscribes has two
  rows and `entitled_until` is the max. Nothing special-cases it downstream.

### 7. Store, legal and docs are part of the change

- **App Store Connect:** one subscription group ("Track Evolution Pro"), two
  products (`app.trackevolution.pro.monthly`, `.yearly`), review screenshot,
  localised display names, the optional introductory offer; Server Notifications
  V2 URL for sandbox and production; an In-App Purchase key. Guideline **3.1.2**:
  the paywall shows title, length, price, and links to the privacy policy and
  terms, and **both links also go in the App Store metadata**. A **Restore
  Purchases** control is mandatory (`AppStore.sync()`).
- **Play Console:** one subscription product with two base plans (monthly,
  yearly, auto-renewing), RTDN topic + push subscription, a service account
  with *View financial data* and *Manage orders and subscriptions*. The paywall
  shows price and billing period. Android Auto stays opted out (NS-20).
- `site/docs/terms.html` gains **Subscriptions and billing**: auto-renewal,
  cancellation through the store, refunds handled by the store under its
  policy, price changes with notice, what a lapse does and does not do (rule
  5). `site/docs/privacy.html` stops calling the app *free*, discloses that
  store transaction identifiers and subscription state are stored, and bumps
  its effective date; so does terms. `site/docs/account-deletion.html` says that
  deleting the account **does not cancel** the store subscription and how to.
- README: the new secrets, the cron, the two webhook URLs, the store setup
  checklist. `AGENTS.md`: the routes, the tier table's location, and the "no
  write route checks entitlement" rule as a convention. The landing page and
  `site/docs/index.html` gain a short pricing section — free tier, Pro tier,
  price — and the feature cards say which tier they belong to.

### 8. Platform conventions hold

- iOS: StoreKit code lives in `App/Billing/`; the `Entitlement` model,
  the `/billing` client methods and the tier-gating predicates live in the Kit
  and stay UIKit/StoreKit-free so `swift test` still runs on macOS. A
  `Configuration.storekit` file in the project drives local testing, and a Kit
  test pins `Entitlement` decoding to the golden fixture. `Transaction.updates`
  is listened to from app launch for the app's whole life, and every verified
  transaction — purchase, renewal, restore — is posted to the server before it
  is `finish()`ed.

  > **Phase B note.** CarPlay gets the same gate as the phone's Start button,
  > decided from the same cached entitlement, but a head unit can't present a
  > sheet — so `RemoteRecorder` answers with a `.pro` refusal whose message says
  > to subscribe on the phone. Both gates read `Entitlement.gatesEnabled`, which
  > ships `false`; the decision logic (`ProGate`) is tested in both states with
  > the constant injected, so phase D's flip is one line with green tests.
- Android: Play Billing goes in `:app` (`billing-ktx`); `:core` gets the
  `Entitlement` model, the client methods and the predicates, and
  `checkNoAndroidDependency` keeps it that way. `queryPurchasesAsync` runs on
  every cold start and re-posts anything the server doesn't yet know about.
  `BillingClient` reconnects on `SERVICE_DISCONNECTED`; a purchase the app
  learns about with no signed-in user is held until sign-in, not dropped.
- Web: `entitlement` in app state, tier badge + manage link in Settings, and
  the paywall copy on each Pro surface. "Manage" opens
  `https://apps.apple.com/account/subscriptions` or
  `https://play.google.com/store/account/subscriptions?sku=…&package=app.trackevolution`
  by `source`; native uses `showManageSubscriptions` / the same Play URL.
- Offline: the `/api/me` response is already cached; `entitlement` rides along.
  Nothing new is persisted client-side about tier.
- Ported logic keeps its JS names; every pure predicate (`isPro`, `canRecord`,
  `canImport`) exists once in `public/js/entitlement.js` and is pinned to both
  ports by `contracts/logic/entitlement.json`.

## Phases

Each is its own PR and its own issue under epic
[#170](https://github.com/Richie97/track-history/issues/170) — A is
[#171](https://github.com/Richie97/track-history/issues/171), B is
[#172](https://github.com/Richie97/track-history/issues/172), C is
[#173](https://github.com/Richie97/track-history/issues/173), D is
[#174](https://github.com/Richie97/track-history/issues/174) — and each
leaves `main` shippable.

| Phase | Ships | User-visible? |
|---|---|---|
| **A — Server entitlement** | Migration, `entitled_until` in the session lookup, `entitlement` on `/me`, both native models + golden regen, `requireEntitlement` **wired to no route yet**, Apple/Google verify + webhooks + cron behind secrets, `legacy` claim routes. `LEGACY_CUTOFF` unset ⇒ every claim succeeds. | No |
| **B — iOS purchase flow** | StoreKit 2 purchase/restore/listen, paywall sheet, Settings row, `AppTransaction` legacy claim on launch, `.storekit` config, App Store Connect products in sandbox. Gates still off. | Only as a Settings row saying *Pro (legacy)* |
| **C — Android purchase flow** | Play Billing purchase/ack/restore, paywall sheet, Settings row, `X-TE-Client` + legacy claim on launch, Play products in the internal track. Gates still off. | Same |
| **D — Flip** | Set `LEGACY_CUTOFF`; wire `requireEntitlement` and `stripProFields`; turn on the client gates; web tier UI; terms/privacy/docs/README/AGENTS; store prices → free; submit both. | Yes |

Phase D is the only irreversible step (Play's free-forever), and it is a
config-plus-wiring PR: everything it turns on was already shipped dark, which
is what lets it be small enough to review the day it matters.

## Acceptance criteria

**Server (phase A)**

- [ ] `0017_subscriptions.sql` applies clean on an existing database; `users`
      rows default to `entitled_until = NULL`.
- [ ] `sessionUserId` still issues exactly one D1 statement; `requireSession`
      exposes `entitledUntil`; `requireEntitlement` issues none.
- [ ] `GET /api/me` carries `entitlement` for free, legacy, active and lapsed
      users; golden fixtures regenerated; `swift test` and `:core:test` decode it.
- [ ] Apple JWS verification rejects a bad chain, a wrong bundle id, and a
      tampered payload, with fixtures under `test/fixtures/billing/`.
- [ ] Apple notification and Google RTDN routes reject an unsigned/mis-audienced
      request with 401 and never touch the database first.
- [ ] Posting the same `external_id` from a second account returns 409 and
      leaves the first account's row intact.
- [ ] `entitled_until` includes the 3-day slack and honours store grace states.
- [ ] The cron re-verifies the expiring window and is a no-op with no rows.
- [ ] **No `POST`/`PUT`/`DELETE` under `/api/events`, `/sessions`, `/laps`,
      `/tracks` checks entitlement** — a test asserts a lapsed user's session
      save with `channels` returns 201.
- [ ] `stripProFields` nulls `channels` and preserves `trace` for a free user,
      and is a pass-through for Pro; tested on the event detail and the compare
      read.

**iOS (phase B)**

- [ ] Purchase, restore and a sandbox renewal each produce a server row; the
      transaction is finished only after the server's 200.
- [ ] `originalAppVersion` below the subscription build yields a `legacy` row on
      first launch, once.
- [ ] Paywall shows product title, term, localised price, privacy + terms links,
      Restore. Both legal links are in the App Store metadata.
- [ ] Nothing StoreKit in the Kit; `swift test` passes on macOS.
- [ ] Recorder start and video import, when gated, show the paywall rather than
      a disabled control; offline with a cached Pro entitlement they proceed.
- [ ] Manage subscription opens the system sheet.

**Android (phase C)**

- [ ] Purchase and `queryPurchasesAsync` both post the token; acknowledgement
      happens only after the server's 200; an unacknowledged purchase on cold
      start is retried.
- [ ] Transitional build sends `X-TE-Client` and claims legacy once per
      install, before `LEGACY_CUTOFF`.
- [ ] Paywall shows price and billing period plus both legal links.
- [ ] `:core:check` still passes — no billing dependency in `:core`.
- [ ] `checkReleaseHasNoCarApp` still passes.
- [ ] Recorder start, when gated, shows the paywall; offline with a cached Pro
      entitlement it proceeds.

**Flip (phase D)**

- [ ] `requireEntitlement` guards `GET /garage`, the parts/measurements routes
      and the setups routes, and nothing else; a test enumerates the guarded
      routes so an accidental addition fails.
- [ ] A 402 renders the paywall on all three clients, not the sync banner.
- [ ] Web Settings shows tier, source and expiry; "Manage" targets the right
      store.
- [ ] Terms (new billing section), privacy (no longer "free", transaction data
      disclosed), account-deletion (does not cancel the sub) updated with bumped
      effective dates; landing + docs carry the tier table; README lists the
      secrets and store setup; AGENTS.md carries the routes and the
      no-write-gate convention.
- [ ] `LEGACY_CUTOFF` set in production **before** either store price changes.
- [ ] Both store prices set to free; both submissions reference the legal URLs.
- [ ] Every row in the tier table above is enforced where the table says.

## Verification

Sandbox first, on the dev server, with the price flip still weeks away:

```sh
npm test                                  # billing routes, JWS/RTDN verification, strip + no-write-gate assertions
npm run contracts:check                   # /me fixture regenerated, both clients still decode it
cd apps/ios/Packages/TrackEvolutionKit && swift test
cd apps/android && ./gradlew :core:check :app:testDebugUnitTest :app:checkReleaseHasNoCarApp
```

Then by hand, on one account across all three clients: subscribe in the iOS
sandbox, confirm Pro on Android and web within a minute; cancel in the sandbox,
confirm the renewal-status webhook lands and `auto_renew` flips; let a sandbox
subscription expire (minutes, in sandbox), confirm the account reads free,
channel data disappears from the event page on web, **and a recording saved
from the lapsed phone still lands in the logbook**. Repeat from Google's test
track with a licence-tester account. Delete what you create.

## Notes

- **Why not Stripe now.** The web app has no purchase surface in this spec on
  purpose: it is the only client with no store, and adding a third provider is
  a third webhook, a third verification path and a customer portal. The tier UI
  on web says where to subscribe. If web-only users turn out to exist in
  numbers, Stripe is a `provider` value and one more `src/lib/billing/*.ts`,
  not a redesign — the table was shaped to allow it.
- **Why freemium and not a hard paywall.** Share pages and leaderboards seeded
  by free users are the only marketing the app has, and the free tier above is
  exactly what every existing web user has today, so nobody loses anything at
  the flip. The cost is that every future feature needs a row in the tier table.
  A hard paywall with a trial would be one middleware line; it was considered and
  declined, not overlooked.
- **Why the server verifies Apple's JWS locally** rather than calling the
  Server API on every purchase: the chain check is a few WebCrypto calls with no
  network, the Server API has rate limits and an availability of its own, and a
  purchase must succeed in a paddock with one bar of signal. The API is for the
  cron, where latency is free.
- **Revenue.** Both stores take 15% on subscriptions at this volume (Apple via
  the Small Business Program, which must be enrolled in; Play by default), so
  net is about $1.69 and $17.00. The $1 up-front price was under the same cut.
- **Reversibility.** Phases A–C are reversible by revert. Phase D's price change
  is not on Play — a free app can never be made paid again — and Apple's
  refund of a *paid app* to a customer who then finds features gated is a
  support case, not a code path; grandfathering is what prevents it.
