# NS-33 — Stripe: Track Evolution Pro on the web

**Phase:** post-rewrite · **Platform:** Shared (server, web; the native clients are deliberately untouched) · **Depends on:** NS-32 (all four phases in production) · **Estimate:** 1–2 weeks, in two separately shippable phases

## Goal

Sell **Track Evolution Pro** on the web app — the same $1.99/month or
$19.99/year, the same account-level entitlement — through **Stripe Checkout**
and the **Stripe customer portal**, so a driver who lives in the web app never
has to install a phone app to subscribe.

Nothing about *what* Pro is changes. NS-32's tier table, its entitlement rule
(`users.entitled_until`, trigger-maintained), its "no write route checks
entitlement" rule and its 402-is-an-offer rule all stand. Stripe is a fourth
`provider` value and one more `src/lib/billing/*.ts`, which is exactly the shape
NS-32's *Why not Stripe now* note said it would be.

## Why this spec exists

NS-32 left the web app as the one client with no purchase surface: it shows the
tier and points at the phone apps. That was the right call for shipping the
subscription — a third provider is a third webhook, a third verification path
and a customer portal — but it leaves the web app, which NS-32 itself calls
*the feature frontier* and which owns the desk-bound Pro features (the setup
notebook, year in review, the two-event overlay, `.vbo` import's channel
data), unable to sell the thing it is best at. Every web-only Pro surface today
renders `proPanelHtml`, whose call to action is "install an app you may not
want".

The economics also favour it. Both stores take 15%; Stripe takes 2.9% + 30¢,
which is a wash on the monthly plan and roughly **$2 more per year** on the
yearly one — see *Notes*.

## Fixed decisions

| | |
|---|---|
| Provider | `stripe`. One Stripe **product** ("Track Evolution Pro") with two recurring **prices**, monthly and yearly, so the customer portal handles the switch between them. |
| Price | Identical to the stores: $1.99/month, $19.99/year, USD. A price that differs by client is a support question, not a growth lever. The 14-day trial the stores offer is offered here too, **once per account** (rule 2). |
| Purchase surface | **Web only.** Stripe Checkout (hosted page, redirect and return) and the Stripe customer portal for manage/cancel/switch/receipts. Neither phone app links to, mentions, or knows about web billing — see rule 4 for why that is a hard rule and not a preference. |
| Binding | The Worker creates the Checkout Session for the signed-in user, so the purchase is bound to the account **before** payment, never by whoever posts an id afterwards. This closes the gap NS-32's phase B acceptance list left open (`appAccountToken`). |
| Where the entitlement lives | Unchanged: the server. A Stripe subscription is a `subscriptions` row like any other; `entitled_until` is recomputed by the same triggers. |
| Tax | Stripe Tax (`automatic_tax`) with the billing address collected at Checkout. The stores were the merchant of record and hid this cost; on the web it is ours. See *Notes* for the merchant-of-record alternative that was considered. |
| Refunds | Ours to issue, from the Stripe dashboard, for web subscriptions only. The terms page says so. A full refund revokes the entitlement (rule 3). |
| Dependencies | **None.** No `stripe` npm package: the Stripe REST API is form-encoded HTTPS with a bearer key, and the webhook signature is one HMAC-SHA256. The Google path is already hand-rolled the same way, and a Worker with no dependency tree is one that runs the same in `vitest-pool-workers`. |
| Ships dark | Without `STRIPE_SECRET_KEY` every Stripe route answers `503 { error: "billing not configured" }`, `GET /api/billing/stripe/plans` answers `{ enabled: false }`, and the web app renders exactly what it renders today. |

## Requirements

### 1. Stripe is a provider

- **Migration `0018_stripe.sql`.** `subscriptions.provider` carries a `CHECK
  (provider IN ('apple', 'google', 'legacy'))`, and SQLite cannot alter a
  constraint — so the migration **rebuilds the table**: create
  `subscriptions_new` with `'stripe'` in the set, copy every row, drop the
  old table, rename, and re-create **both indexes and all three
  `subscriptions_entitled_*` triggers verbatim**, because triggers die with the
  table they are on. A test asserts that inserting a row after the migration
  still recomputes `users.entitled_until` — the trigger re-creation is the
  part of this migration that fails silently if forgotten.
- `users.stripe_customer_id TEXT` (unique index, nullable): one Stripe Customer
  per account, created lazily by the first checkout (rule 2) with
  `metadata.user_id` set to our id. Every retrieve of a customer, session or
  subscription **checks that metadata against the signed-in user** before
  writing anything — the id in a URL is not proof of ownership.
- `external_id` is the Stripe **subscription id** (`sub_…`), unique per
  provider like every other row; `product_id` is the **price id** the
  subscription is currently on (so a portal plan switch shows up in the row);
  `environment` is `live` or `test` from the object's `livemode`;
  `signed_date` is **null** — every Stripe write derives from a fresh API read
  (rule 3), so there is no stale-payload case, the same as Google.
- `Provider` in `src/lib/entitlement.ts` gains `"stripe"`;
  `entitlementResponse` needs no change — a Stripe row ranks as a store row,
  above legacy, for the same reason an Apple one does: the user is being
  charged and needs a Manage target.
- `subscriptionsToReverify` and the cron's provider branch gain `stripe`, and
  `src/lib/billing/sync.ts` gains `syncStripeRow` — the webhook and the cron
  share it, as they do for the other two providers.
- **New secrets:** `STRIPE_SECRET_KEY` (a *restricted* key: write on Checkout
  Sessions, Customers and Billing Portal sessions; read on Subscriptions,
  Prices and Invoices — nothing else), `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` (price ids). The price ids
  are not secret, but they differ between test and live mode and belong with
  the key that selects the mode; making them `wrangler.jsonc` vars would also
  put a live price id in the file the contract harness starts from.
  `src/lib/billing/stripe.ts` pins `Stripe-Version` explicitly on every
  request, so a dashboard default-version change cannot move a field under us.

### 2. Checkout: the server mints the session

All four routes are authed, under `/api`, in `src/routes/billing.ts`:

- `GET /api/billing/stripe/plans` → `{ enabled: false }` when unconfigured,
  else `{ enabled: true, plans: [{ plan: "monthly", price_id, amount, currency,
  interval, trial_days }, { plan: "yearly", … }] }`, read from Stripe's Prices
  API and cached in the isolate for an hour. The web app shows **Stripe's
  price**, the way both paywalls show their store's — the `PRO_PRICE` string in
  `app.js` is copy, not a source of truth. `trial_days` is `14` or `0` per
  the once-per-account rule below, decided by the server per user.
- `POST /api/billing/stripe/checkout` `{ plan: "monthly" | "yearly" }` →
  `{ url }`. The Worker: ensures the customer (create with `email`,
  `metadata.user_id`, idempotency key `customer:<userId>` so two tabs cannot
  make two); creates a Checkout Session in `mode: subscription` with
  `customer`, `client_reference_id = <userId>`, `subscription_data.metadata
  .user_id`, `automatic_tax`, `billing_address_collection: required`,
  `allow_promotion_codes`, and `subscription_data.trial_period_days: 14`
  **only if the account has no `stripe` row of any status** — Stripe's trial
  is per subscription, and without this rule cancel-and-resubscribe is a free
  Pro loop. `success_url` is
  `<origin>/#/settings?checkout={CHECKOUT_SESSION_ID}`, `cancel_url` is
  `<origin>/#/settings`; the origin is the request's own, never a config
  value. **Refused with `409 { error: "already subscribed" }`** when the
  account is currently entitled by any row — Stripe will happily sell a second
  subscription to someone already paying Apple, and a double charge is a
  refund and an apology.
- `POST /api/billing/stripe` `{ checkout_session_id }` → `{ ok, entitlement }`,
  the return leg. The Worker retrieves the session, requires
  `client_reference_id` to be the signed-in user (else `409 purchase belongs
  to another account`, the same `SubscriptionConflict` the store routes use),
  retrieves its subscription, and upserts the row. This is what makes Pro
  appear **the moment the user lands back on Settings** rather than whenever
  the webhook arrives — the same "client posts an id, server reads the truth
  from the API" shape as `POST /api/billing/google`. A `livemode: false`
  object is refused outside a dev host, exactly as a sandbox `AppTransaction`
  is: a test-mode subscription against a production database would grant real
  Pro for a $0 test card.
- `POST /api/billing/stripe/portal` → `{ url }`, a Billing Portal session for
  the user's customer with `return_url = <origin>/#/settings`. `404` when the
  account has no customer. The portal's configuration is dashboard state
  (rule 6): cancel at period end, switch between the two prices, update the
  payment method, invoice history. **No cancel or plan-change route of our
  own** — the portal is the whole point of paying Stripe.

None of these are queueable offline (`QUEUEABLE` in `public/js/offline.js` is
an explicit whitelist, so nothing needs adding; a test asserts they are not
matched). Every write answers `{ ok, entitlement }` like the store routes.

### 3. Webhook and cron: an event says something changed, the API says what

- `POST /billing/stripe/webhook` — public, outside `/api`, in
  `src/routes/billingWebhooks.ts`; `/billing/*` is already in
  `run_worker_first`. Verify the `Stripe-Signature` header **before touching
  D1**: HMAC-SHA256 over `<t>.<raw body>` with `STRIPE_WEBHOOK_SECRET`,
  constant-time compare against every `v1` signature in the header, and a
  5-minute tolerance on `t` (`STRIPE_SIGNATURE_TOLERANCE_MS`) so a captured
  delivery cannot be replayed a week later. Unverified is a 401 and nothing
  else happens. The raw body must be read before any JSON parse — the
  signature is over the bytes.
- Handled: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `customer.subscription.paused`, `customer.subscription.resumed`,
  `invoice.paid`, `invoice.payment_failed`, `charge.refunded`. Every one
  resolves to a **subscription id**, and every one then does the same thing:
  `syncStripeRow` re-reads the subscription from the API and applies it.
  Stripe does not deliver events in order, and the event's embedded object can
  be older than the row already holds; a fresh read is what makes ordering not
  matter. Unknown types are acked `{ ok, handled: false }` and logged.
- **A webhook for a subscription with no row inserts one** — the one way this
  differs from the Apple and Google webhooks, which have nobody to attach to.
  The customer is ours (`users.stripe_customer_id`) and the subscription
  carries `metadata.user_id`; when the two agree, the row is inserted for that
  user. When they disagree, or the customer is unknown (a live event reaching
  a dev database, a subscription created by hand in the dashboard), it is
  acked `handled: false` and logged — never guessed.
- A D1 failure is a 500 on purpose: Stripe retries for three days, and a retry
  is cheaper than a customer who paid and reads free.
- **State mapping** (`stripeSubscriptionState`, pure, unit-tested):

  | Stripe `status` | Row `status` | `expires_at` | `auto_renew` |
  |---|---|---|---|
  | `active`, `trialing` | `active` | `current_period_end` | `!cancel_at_period_end` |
  | `past_due` | `grace` | `min(current_period_end, current_period_start + STRIPE_GRACE_MS)` | `!cancel_at_period_end` |
  | `unpaid` | `billing_retry` | `current_period_end` | `false` |
  | `canceled`, `incomplete_expired` | `expired` | `ended_at ?? current_period_end` | `false` |
  | `incomplete` | `pending` | `null` | `null` |
  | `paused` | `paused` | `current_period_end` | `false` |
  | any, after a **full** refund of the latest invoice | `revoked` | `null` | `false` |

  `STRIPE_GRACE_MS` is **7 days**, and it is the reason `past_due` is bounded:
  when a renewal's payment fails Stripe has already advanced the period, so
  `current_period_end` alone would hand a yearly subscriber a year of Pro on a
  dead card. The dashboard's retry schedule is set to give up and **cancel**
  the subscription inside that window (rule 6), so the row reaches `expired`
  through `customer.subscription.deleted` before the grace runs out. The
  period fields are read from wherever the pinned API version puts them —
  the subscription item since `2025-03-31`, the subscription before it.
- `charge.refunded` is the one event that does not map from `status`: a
  refund does not cancel a Stripe subscription by itself. A **full** refund of
  the subscription's latest invoice marks the row `revoked`, and the operator
  issues refunds with *cancel subscription* ticked so the customer is not
  charged again for a thing just refunded. A partial refund changes nothing.
- The cron (`src/cron.ts`) re-verifies `stripe` rows in the same window as the
  other two, through `syncStripeRow`. A row Stripe no longer knows is
  `"unknown"` and skipped, not expired — the same rule as the stores.

### 4. The phone apps never learn the word "stripe"

`entitlement.source` on `GET /api/me` is decoded by a **closed enum on both
native clients** (`Entitlement.Source` in the Kit and in `:core`: `legacy`,
`apple`, `google`). A new value would make `/me` fail to decode on every
installed phone app — and an app that cannot load `/me` cannot sign in. That
cannot be fixed by shipping a new app version, because the installs that
matter are the old ones.

So the server **masks the source by auth transport**: `requireSession`
already knows whether it accepted the `session` cookie (web) or a bearer
token (native), and exposes that on the context. On a bearer-authenticated
request a Stripe-sourced entitlement is reported as
`{ tier, source: null, expires_at, auto_renew }` — tier, expiry and renewal
intact, the store withheld. Both native summaries already render that as
*Pro · renews <date>* (they check `legacy || expires_at == null` for the
lifetime wording), and `manageUrl` answers null, so the card shows the state
and no control — exactly what it shows for a legacy grant.

This is also the App Store rule, not only a decoding one. Guideline 3.1.3(b)
lets a multiplatform app honour a subscription bought on the web, and forbids
the app from *directly or indirectly* pointing users at any purchasing method
but IAP. An app that cannot tell a web subscription from any other cannot
mention one — no "billed on the web", no portal link, no copy to review. A
lapsed Stripe subscriber on the phone reads as free with a Subscribe button,
which is the in-app purchase Apple wants offered and is fine: the server
refuses nothing, and a second purchase from the store is a second row.

Consequences pinned by tests:

- `contracts/logic/entitlement.json` gains a case **"pro, source withheld"**
  (`tier: pro, source: null, expires_at set, auto_renew true`) so both ports
  are pinned for the shape the masking produces. It does **not** gain a
  `source: "stripe"` case — the ports could not decode it, and the fixture is
  asserted by the ports. The web-only `stripe` behaviour of `manageUrl`
  (null — the portal is a server-minted session, not a constant URL) and
  `entitlementSummary` is pinned in `test/unit/entitlement-client.test.js`.
- The golden contract's `/me` captures stay bearer-shaped as they are; a new
  API test asserts the same Stripe-entitled user reads `source: "stripe"` over
  the cookie and `source: null` over a bearer.
- Android's `GoldenContractTest` and the Kit's decoding tests pass with **zero
  native diffs** — that is the acceptance criterion, not a side effect. If a
  native surface ever needs to know, the path is: open both enums with an
  unknown-tolerant decoder, ship both apps, wait for adoption, then lift the
  mask — a separate spec, because it has a rollout.

### 5. The web sells, on two surfaces

- **Settings → Subscription** (`subscriptionPanelHtml`): when
  `/plans` is enabled and the account is free, the card offers the two plans
  as buttons with Stripe's price and interval, a *14-day free trial* line when
  `trial_days > 0`, and the privacy + terms links (the same 3.1.2 set the
  paywalls carry, because a checkout that names its terms is one that gets
  fewer refund requests). Clicking posts to `/checkout` and navigates to the
  returned URL. The store buttons stay beneath, demoted to a hint: Pro is
  still sold in the phone apps, the web is no longer the place that can't.
  When the source is `stripe`, the card says *Billed on the web* and offers
  **Manage billing** (posts to `/portal`, navigates) in place of the store
  Manage link; when the source is a store, nothing changes. A lapsed Stripe
  subscriber gets *Your web subscription has ended* and the plan buttons,
  since resubscribing is a new Checkout.
- **Return leg.** `#/settings?checkout=<id>` — the hash router already parses
  `?query` in the hash — posts the id to `POST /api/billing/stripe`, writes the
  answer's `entitlement` into `state`, re-runs `ensureMe()`, strips the
  parameter from the hash and shows the card as Pro. A 409 (someone else's
  session id, or a replay) shows the server's string. A cancelled checkout
  lands on plain `#/settings` and nothing happens.
- **Every gated surface** (`proPanelHtml`, and `viewProGate` for the two
  compare routes): when `/plans` is enabled the primary action becomes
  **Subscribe — from $1.99/month** linking to `#/settings`, with the store
  links demoted beneath it; when disabled it renders as today. One place mints
  checkout sessions, so the plan chooser lives only in Settings.
- `public/js/entitlement.js`: `manageUrl` answers `null` for `source:
  "stripe"` (see rule 4); no other predicate changes — tier is tier. The
  `e.source === "apple" ? "App Store" : "Google Play"` ternaries in
  `subscriptionPanelHtml` become a `sourceName()` helper that knows all three,
  since a two-way ternary is where "Google Play" would be printed for a Stripe
  row.
- Offline: `/api/me` is cached as before, `entitlement` rides along, and
  nothing new about tier is persisted client-side.

### 6. Dashboard, legal and docs are part of the change

- **Stripe dashboard** (operator checklist, README): one product with two
  recurring prices; Stripe Tax enabled and the home-state registration made
  (further registrations are threshold-driven and a bookkeeping task, not a
  code one); the customer portal configured (cancel at period end, switch
  between the two prices, payment-method update, invoice history, and the
  business name shown as *Speedshift LLC*); Smart Retries set to cancel the
  subscription after retries are exhausted, **within 7 days** (rule 3's
  grace bound assumes it); a webhook endpoint for the handled events at
  `https://trackevolution.app/billing/stripe/webhook` with its signing secret
  in `STRIPE_WEBHOOK_SECRET`; a restricted API key with the permissions rule 1
  lists. Test mode gets the same setup, pointed at the dev origin, and
  `stripe listen` forwards to `wrangler dev` for local runs.
- `site/docs/terms.html` *Subscriptions and billing*: *Where you buy it* gains
  the web app; *Refunds* gains a web clause (issued by us, on request to
  `eric@speedshift.io`, at our discretion for the unused term; the stores'
  rules keep governing store purchases); *Cancelling* names the customer
  portal via Settings; the trial clause says once per account. Effective date
  bumped.
- `site/docs/privacy.html`: Stripe named as the payment processor for web
  purchases, with what it receives (email, billing address for tax, payment
  details **that never reach us**) and what we store (the Stripe customer and
  subscription identifiers, plan, status, renewal); the account-deletion
  paragraph says deleting the account also cancels a web subscription and
  deletes the Stripe customer (rule 7). Effective date bumped.
- `site/docs/account-deletion.html`: the same — a web subscription **is**
  cancelled by deletion, unlike a store one; the retention/deletion section of
  the privacy policy stays in step.
- Landing page pricing tier note and `site/docs/index.html` *Free and Pro*:
  "bought in the iPhone or Android app — the web app has no purchase page"
  becomes "bought in Settings on the web or in either phone app". No page on
  the site says Stripe, Cloudflare or anything about the mechanism — the site
  is for users.
- README: the four secrets, the webhook URL, the dashboard checklist, the
  fee/tax notes; AGENTS.md: the routes, the masking rule, the migration's
  rebuild-the-table note. `docs/specs/native/README.md` *Post-rewrite feature
  decisions* gains the entry: web checkout is **web-only**, and why.

### 7. Account deletion cancels a web subscription

Deleting a store subscriber's account cannot cancel their subscription — the
stores own it, and the docs say to cancel first. A Stripe subscription is
ours to cancel, and leaving one charging a deleted account is the one outcome
worse than a lapse. The deletion procedure (today a support-inbox request)
gains a step: cancel the customer's subscriptions immediately and delete the
Stripe customer, *then* delete the user row. `ON DELETE CASCADE` already
removes the rows. If deletion is ever automated, that step is the code's, not
the operator's.

## Phases

Each is its own PR and its own issue under epic
[#194](https://github.com/Richie97/track-history/issues/194) — A is
[#195](https://github.com/Richie97/track-history/issues/195), B is
[#196](https://github.com/Richie97/track-history/issues/196) — and each leaves
`main` shippable.

| Phase | Ships | User-visible? |
|---|---|---|
| **A — Server** | Migration `0018` (table rebuild + `stripe_customer_id`), `src/lib/billing/stripe.ts`, the four authed routes, the webhook, `syncStripeRow`, the cron branch, the transport mask on `/me`, tests with `api.stripe.com` mocked, README secrets. Ships dark behind `STRIPE_SECRET_KEY`. | No |
| **B — Web checkout** | Settings plan chooser and Manage billing, the return leg, the Subscribe action on every gated surface, `manageUrl`/summary for `stripe`, the fixture case, terms/privacy/deletion/site/docs, the dashboard configured in test mode then live. | Yes |

Phase A is reviewable without any dashboard state; phase B is where the
Stripe account, tax registration and portal configuration have to exist, and
is the one that changes what a user sees. Both are reversible by revert:
unsetting `STRIPE_SECRET_KEY` puts the web app back to today, and existing
Stripe rows keep entitling until they expire.

## Acceptance criteria

**Server (phase A)**

- [ ] `0018_stripe.sql` applies clean on a database with existing Apple,
      Google and legacy rows; every row survives, both indexes and all three
      triggers exist afterwards, and inserting a row still recomputes
      `users.entitled_until`.
- [ ] `POST /api/billing/stripe/checkout` creates the customer once per
      account (a second call reuses it), returns a Checkout URL, and answers
      409 for an already-entitled account. The trial is offered only to an
      account with no prior `stripe` row.
- [ ] `POST /api/billing/stripe` upserts the row from a fresh API read;
      another user's `checkout_session_id` is a 409 and leaves the row intact;
      a `livemode: false` object is a 400 off a dev host.
- [ ] `POST /billing/stripe/webhook` rejects a bad signature, a stale `t`, and
      a body that differs from the signed bytes with 401, and touches D1 in
      none of those cases. Every handled event ends in an API read, never a
      write from the event's embedded object. An unknown subscription with a
      matching customer + metadata is inserted; a mismatch is acked
      `handled: false`.
- [ ] `stripeSubscriptionState` is unit-tested per row of the mapping table;
      `past_due` never yields an `expires_at` more than `STRIPE_GRACE_MS`
      past `current_period_start`.
- [ ] The cron re-verifies a `stripe` row in the window and is a no-op with
      none.
- [ ] The same Stripe-entitled user reads `source: "stripe"` over the cookie
      and `source: null` (tier, expiry and renewal intact) over a bearer
      token; `contracts:check` is clean with **no change to the golden `/me`
      captures**.
- [ ] `test/api/entitlement-gates.test.ts` still enumerates exactly the NS-32
      set — no Stripe route is entitlement-gated, and **no write route is**.
- [ ] `swift test` and `:core:check :app:testDebugUnitTest` pass with **zero
      diffs under `apps/`**.
- [ ] With `STRIPE_SECRET_KEY` unset every Stripe route is a 503 (plans:
      `{ enabled: false }`) and the web renders as today.

**Web (phase B)**

- [ ] Settings shows the two plans with Stripe's price and interval, the trial
      line when offered, and both legal links; a click lands on Stripe
      Checkout and a completed purchase returns to Settings reading Pro
      **before the webhook has fired** (verified with `stripe listen` paused).
- [ ] A Stripe subscriber's Settings card says *Billed on the web* and
      *Manage billing* opens the portal; a store subscriber's card is unchanged.
- [ ] A cancel-at-period-end from the portal flips `auto_renew` via webhook
      and the card reads *Pro · ends <date>*; a plan switch updates
      `product_id`; a full refund from the dashboard reads free at once;
      a dead test card runs `past_due` → `expired` within the grace bound.
- [ ] Every gated web surface offers Subscribe when plans are enabled and
      renders as today when they are not.
- [ ] `manageUrl` is null and `entitlementSummary` correct for `stripe`;
      the *source withheld* fixture case is in `contracts/logic/entitlement.json`
      and both ports pass it.
- [ ] Terms, privacy, account-deletion, landing and docs updated per rule 6
      with bumped effective dates; README and AGENTS.md carry the routes,
      secrets, checklist and the masking rule; the specs README lists the
      decision.
- [ ] A lapsed Stripe subscriber's queued web writes (an event edit made
      offline) replay after the lapse and land — no write route changed.

## Verification

Test mode first, on the dev server:

```sh
npm test                                  # stripe routes, signature verification, state mapping, the transport mask
npm run contracts:check                   # golden /me captures unchanged; entitlement fixture gains the withheld case
cd apps/ios/Packages/TrackEvolutionKit && swift test          # zero native diffs, fixture still passes
cd apps/android && ./gradlew :core:check :app:testDebugUnitTest
stripe listen --forward-to localhost:8787/billing/stripe/webhook
```

Then by hand, on one account across all three clients: subscribe on the web
with a test card, confirm Pro on both phones within a minute **with the phones
showing no store and no manage control**; cancel from the portal, confirm
`auto_renew` flips; switch plans, confirm `product_id`; use the
`4000 0000 0000 0341` card to fail a renewal and watch `grace` → `expired`;
refund from the dashboard, confirm free at once; **save a session from a
lapsed phone and confirm it lands**. Delete what you create, customer
included.

## Notes

- **Why Stripe Checkout and the portal, not our own forms.** Card entry on our
  origin is PCI scope, SCA/3DS handling, a payment-method-update page, a
  cancel page, receipts and a tax-invoice format — every one of which Stripe
  hosts, and every one of which the stores hosted before. The Worker never
  sees a card number, which is also what keeps the privacy policy's "we never
  see payment details" sentence true.
- **Why not a merchant of record** (Paddle, Lemon Squeezy). They would carry
  tax the way the stores did, at roughly 5% + 50¢. Stripe plus Stripe Tax is
  about half that at these prices, and Stripe's Checkout is what the portal,
  the retry schedule and the webhook model are built around. The cost is the
  tax registration in rule 6 — one, at this volume. If the registrations ever
  multiply, an MoR is a provider swap behind the same `stripe.ts` seam, not a
  redesign; that is the same argument NS-32 made for adding Stripe.
- **Revenue.** Stripe: 2.9% + 30¢, plus Stripe Tax at 0.5%. Net about
  **$1.62/month** and **$18.94/year**, against **$1.69** and **$17.00**
  through the stores at 15%. Monthly is a wash; yearly is nearly $2 better,
  and the yearly plan is the one a web-first user picks.
- **Why the trial is once per account, not once per customer.** A customer is
  ours and reused, so "once per customer" would be the same rule — but the
  row check is the one the database enforces, and it holds even if a
  support script ever re-creates a customer.
- **Why no `stripe` value reaches the phones**, restated: it is a decoding
  hazard on every installed build *and* an App Review hazard on every future
  one, and masking by transport costs one conditional in `/me`. The one thing
  the mask gives up — a phone saying "billed on the web" — is copy an App
  Review could read as steering, and copy that does not exist cannot be.
- **Why the migration rebuilds the table** rather than dropping the `CHECK`:
  the constraint is what turns a typo in a support script into an error
  instead of a row that entitles nobody. The rebuild is fifty lines of SQL,
  once.
