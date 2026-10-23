// Authed billing routes (under /api): the native apps post what their store
// gave them, the Worker verifies it and records the entitlement. Every route
// answers with the fresh `entitlement` object so the client can update at once.
//
// NS-32 rule 5 applies here in the negative: nothing in this file gates a
// write to the logbook, and nothing elsewhere may.

import { Hono } from "hono";
import type { AppContext, Ctx } from "../types";
import { JwsError } from "../lib/billing/jws";
import {
  APPLE_SUBSCRIPTION_TYPE,
  appleBundleId,
  appleEnvironment,
  appleRootsDer,
  appleSignedDate,
  verifyAppleAppTransaction,
  verifyAppleTransactionPair,
} from "../lib/billing/apple";
import { isDevHost } from "../lib/dev";
import { fetchGoogleSubscription, googleSubscriptionState, parseServiceAccount } from "../lib/billing/google";
import { SubscriptionConflict, retireSubscription, subscriptionsForUserStmt, upsertSubscription } from "../lib/billing/store";
import {
  STRIPE_PLANS,
  STRIPE_TRIAL_DAYS,
  type StripeConfig,
  StripeError,
  type StripePlan,
  type StripePrice,
  createCheckoutSession,
  createCustomer,
  createPortalSession,
  fetchStripePrice,
  fetchStripeSubscription,
  idOf,
  isStripeId,
  retrieveCheckoutSession,
  stripeConfig,
} from "../lib/billing/stripe";
import { adoptStripeSubscription } from "../lib/billing/sync";
import {
  entitlementResponse,
  isEntitled,
  legacyClaimOpen,
  maskEntitlementSource,
  parseClientHeader,
  type SubscriptionRow,
} from "../lib/entitlement";

export const billing = new Hono<AppContext>();

// Re-reads the user's entitlement after a write. The request context's
// entitledUntil predates the write, so this is the one place it is re-fetched.
// Masked by transport like GET /me: a phone posting an Apple receipt for an
// account that also pays on the web must not be answered with a source its
// decoder doesn't know (NS-49 rule 4).
export async function freshEntitlement(c: Ctx, nowMs: number) {
  const userId = c.get("userId");
  const [userRes, subsRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT entitled_until FROM users WHERE id = ?").bind(userId),
    subscriptionsForUserStmt(c.env.DB, userId),
  ]);
  const user = userRes.results[0] as { entitled_until: number | null } | undefined;
  return maskEntitlementSource(
    entitlementResponse(user?.entitled_until ?? null, subsRes.results as SubscriptionRow[], nowMs),
    c.get("authTransport")
  );
}

async function jsonBody(c: Ctx): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

// A Stripe return leg that names something unusable (an unknown or unfinished
// checkout, a test-mode one in production): a 400 carrying the reason.
class StripeInputError extends Error {}

// Runs a verified write and maps its failure modes to statuses: a bad payload
// is the client's problem (400), a purchase owned by another account is a
// conflict (409), anything else is a 500 with the message kept out of the body.
async function recordPurchase(c: Ctx, nowMs: number, work: () => Promise<void>) {
  try {
    await work();
  } catch (err) {
    if (err instanceof JwsError) return c.json({ error: `invalid receipt: ${err.message}` }, 400);
    if (err instanceof StripeInputError) return c.json({ error: err.message }, 400);
    if (err instanceof SubscriptionConflict) return c.json({ error: err.message }, 409);
    if (err instanceof StripeError) return stripeFailure(c, err);
    throw err;
  }
  return c.json({ ok: true, entitlement: await freshEntitlement(c, nowMs) });
}

// StoreKit 2: { jws: transaction.jwsRepresentation, renewal_jws?: renewalInfo.jwsRepresentation }
billing.post("/billing/apple", async (c) => {
  const body = await jsonBody(c);
  if (!body || typeof body.jws !== "string") return c.json({ error: "jws required" }, 400);
  const bundleId = appleBundleId(c.env);
  if (!bundleId) return c.json({ error: "billing not configured" }, 503);
  const nowMs = Date.now();
  const rootsDer = appleRootsDer(c.env, c.req.url);
  return recordPurchase(c, nowMs, async () => {
    const { tx, renewal, state, signedDate } = await verifyAppleTransactionPair(body.jws, body.renewal_jws, {
      bundleId,
      rootsDer,
      nowMs,
    });
    if (tx.type != null && tx.type !== APPLE_SUBSCRIPTION_TYPE) throw new JwsError("not a subscription");
    await upsertSubscription(
      c.env.DB,
      {
        userId: c.get("userId"),
        provider: "apple",
        productId: tx.productId,
        externalId: tx.originalTransactionId,
        status: state.status,
        expiresAt: state.expiresAt,
        autoRenew: state.autoRenew,
        environment: appleEnvironment(tx.environment),
        // Ordering guard: a client can re-post any JWS it still holds, and a
        // pre-refund transaction re-posted after a REVOKE would otherwise
        // restore the entitlement Apple just took away.
        signedDate,
        raw: { transaction: tx, renewal },
      },
      nowMs
    );
  });
});

// Grandfathering, iOS (NS-32 requirement 6): the AppTransaction proves the
// app was bought before subscriptions existed. Permanent and authoritative —
// no LEGACY_CUTOFF here.
billing.post("/billing/apple/legacy", async (c) => {
  const body = await jsonBody(c);
  if (!body || typeof body.jws !== "string") return c.json({ error: "jws required" }, 400);
  const bundleId = appleBundleId(c.env);
  if (!bundleId) return c.json({ error: "billing not configured" }, 503);
  const nowMs = Date.now();
  const rootsDer = appleRootsDer(c.env, c.req.url);
  // A sandbox AppTransaction is signed by the same real Apple chain, and in
  // the sandbox originalApplicationVersion is always "1.0" — so without this
  // every TestFlight tester would claim a permanent lifetime entitlement for
  // an app they never bought. Sandbox receipts are honoured only on a dev
  // host, where the whole point is to exercise the flow.
  const sandboxOk = isDevHost(c.env, c.req.url);
  return recordPurchase(c, nowMs, async () => {
    const app = await verifyAppleAppTransaction(body.jws, { bundleId, rootsDer });
    if (!sandboxOk && appleEnvironment(app.receiptType) !== "production")
      throw new JwsError("app transaction is not from the App Store");
    const firstSubscriptionBuild = c.env.APPLE_FIRST_SUBSCRIPTION_BUILD;
    if (firstSubscriptionBuild && compareVersions(app.originalApplicationVersion, firstSubscriptionBuild) >= 0)
      throw new JwsError("app was first bought after subscriptions launched");
    const userId = c.get("userId");
    await upsertSubscription(
      c.env.DB,
      {
        userId,
        provider: "legacy",
        productId: "apple-paid-app",
        // The app transaction id is unique per Apple ID + app; older payloads
        // lack it, and then one grant per account is the best we can do.
        externalId: app.appTransactionId ? `apple:${app.appTransactionId}` : `apple-user:${userId}`,
        status: "legacy",
        expiresAt: null,
        autoRenew: null,
        environment: appleEnvironment(app.receiptType),
        signedDate: appleSignedDate(app),
        raw: app,
      },
      nowMs
    );
  });
});

// Dotted build strings ("1.4.2" vs "2"), numerically per segment.
export function compareVersions(a: string, b: string): number {
  const as = a.split(".").map((n) => parseInt(n, 10) || 0);
  const bs = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Play Billing: { purchase_token, product_id }. The client acknowledges the
// purchase only after this returns 200 (Play refunds unacknowledged
// subscriptions after three days).
billing.post("/billing/google", async (c) => {
  const body = await jsonBody(c);
  if (!body || typeof body.purchase_token !== "string" || !body.purchase_token)
    return c.json({ error: "purchase_token required" }, 400);
  const sa = parseServiceAccount(c.env.GOOGLE_PLAY_SERVICE_ACCOUNT);
  if (!sa) return c.json({ error: "billing not configured" }, 503);
  const nowMs = Date.now();
  const purchaseToken = body.purchase_token;
  return recordPurchase(c, nowMs, async () => {
    const sub = await fetchGoogleSubscription(sa, purchaseToken, nowMs);
    if (!sub) throw new JwsError("unknown purchase token");
    const state = googleSubscriptionState(sub, nowMs);
    const userId = c.get("userId");
    await upsertSubscription(
      c.env.DB,
      {
        userId,
        provider: "google",
        productId: state.productId ?? (typeof body.product_id === "string" ? body.product_id : null),
        externalId: purchaseToken,
        status: state.status,
        expiresAt: state.expiresAt,
        autoRenew: state.autoRenew,
        environment: state.environment,
        raw: sub,
      },
      nowMs
    );
    if (state.linkedPurchaseToken) await retireSubscription(c.env.DB, "google", state.linkedPurchaseToken, nowMs);
  });
});

// Grandfathering, Android: Play can't tell a client whether the app was
// bought, so the transitional release identifies itself (X-TE-Client) and
// claims once per install; honoured only before LEGACY_CUTOFF.
billing.post("/billing/google/legacy", async (c) => {
  const client = parseClientHeader(c.req.header("X-TE-Client"));
  if (!client || client.platform !== "android") return c.json({ error: "X-TE-Client: android/<versionCode> required" }, 400);
  const nowMs = Date.now();
  if (!legacyClaimOpen(c.env.LEGACY_CUTOFF, nowMs)) return c.json({ error: "legacy claim window closed" }, 403);
  const userId = c.get("userId");
  return recordPurchase(c, nowMs, () =>
    upsertSubscription(
      c.env.DB,
      {
        userId,
        provider: "legacy",
        productId: "google-paid-app",
        externalId: `google-user:${userId}`,
        status: "legacy",
        expiresAt: null,
        autoRenew: null,
        environment: "production",
        raw: { client: `android/${client.version}` },
      },
      nowMs
    )
  );
});

// --- Stripe: the web's purchase surface (NS-49) ------------------------------
//
// Four routes, none entitlement-gated and none queueable offline. The Worker
// mints every Checkout Session for the signed-in user, so a purchase is bound
// to the account before payment; the return leg and the webhook then only ever
// write what a fresh API read says.

const STRIPE_UNCONFIGURED = { error: "billing not configured" } as const;

// Stripe refused or failed. Its message is about our request (a price id, the
// tax setup), not the user's — logged, and said as a 502.
function stripeFailure(c: Ctx, err: StripeError) {
  console.error("stripe request failed:", err.status, err.code, err.message);
  return c.json({ error: "payment provider error" }, 502);
}

// The prices change only when the operator edits them in the dashboard, so an
// isolate reads them once an hour rather than on every Settings render.
const PLAN_CACHE_MS = 60 * 60 * 1000;
let planCache: { key: string; at: number; prices: Record<StripePlan, StripePrice> } | null = null;

async function stripePrices(cfg: StripeConfig, nowMs: number): Promise<Record<StripePlan, StripePrice> | null> {
  const key = `${cfg.prices.monthly}|${cfg.prices.yearly}`;
  if (planCache && planCache.key === key && nowMs - planCache.at < PLAN_CACHE_MS) return planCache.prices;
  const [monthly, yearly] = await Promise.all(STRIPE_PLANS.map((plan) => fetchStripePrice(cfg, cfg.prices[plan])));
  const usable = (p: StripePrice | null): p is StripePrice => !!p && p.active !== false && p.unit_amount != null && !!p.recurring;
  // A price id that doesn't resolve is an operator mistake; until it is fixed
  // the web renders as if Stripe were off, which is the safe way to be wrong.
  if (!usable(monthly) || !usable(yearly)) {
    console.error("stripe prices unusable:", cfg.prices.monthly, !!monthly, cfg.prices.yearly, !!yearly);
    return null;
  }
  planCache = { key, at: nowMs, prices: { monthly, yearly } };
  return planCache.prices;
}

// The trial is once per account. Stripe's is per subscription, so without this
// a cancel-and-resubscribe would be a free Pro loop; any `stripe` row, in any
// status, means the account has had its trial.
async function trialDaysFor(db: D1Database, userId: number): Promise<number> {
  const prior = await db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND provider = 'stripe' LIMIT 1").bind(userId).first();
  return prior ? 0 : STRIPE_TRIAL_DAYS;
}

// The account's Stripe customer, created on first checkout with our id in its
// metadata. Stored only where none is stored yet, and re-read afterwards, so
// two tabs racing a first checkout agree on one customer (the creation itself
// is idempotent on the user id).
async function ensureCustomer(db: D1Database, cfg: StripeConfig, userId: number): Promise<string> {
  const user = await db.prepare("SELECT email, stripe_customer_id FROM users WHERE id = ?").bind(userId).first<{ email: string | null; stripe_customer_id: string | null }>();
  if (user?.stripe_customer_id) return user.stripe_customer_id;
  const created = await createCustomer(cfg, { id: userId, email: user?.email ?? null });
  await db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(created, userId).run();
  const stored = await db.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(userId).first<{ stripe_customer_id: string | null }>();
  return stored?.stripe_customer_id ?? created;
}

// `{ enabled: false }` until Stripe is configured, so the web can ask without
// a failure to handle. Stripe's prices, not a constant in app.js, are what the
// plan buttons show — the way both paywalls show their store's.
billing.get("/billing/stripe/plans", async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg) return c.json({ enabled: false });
  const nowMs = Date.now();
  let prices: Record<StripePlan, StripePrice> | null;
  try {
    prices = await stripePrices(cfg, nowMs);
  } catch (err) {
    if (err instanceof StripeError) {
      console.error("stripe prices failed:", err.status, err.message);
      return c.json({ enabled: false });
    }
    throw err;
  }
  if (!prices) return c.json({ enabled: false });
  const trialDays = await trialDaysFor(c.env.DB, c.get("userId"));
  return c.json({
    enabled: true,
    plans: STRIPE_PLANS.map((plan) => ({
      plan,
      price_id: prices[plan].id,
      amount: prices[plan].unit_amount,
      currency: prices[plan].currency,
      interval: prices[plan].recurring!.interval,
      trial_days: trialDays,
    })),
  });
});

// { plan: "monthly" | "yearly" } → { url }, a Stripe Checkout page for the
// signed-in user. The origin is the request's own, never configuration.
billing.post("/billing/stripe/checkout", async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg) return c.json(STRIPE_UNCONFIGURED, 503);
  const body = await jsonBody(c);
  const plan = body?.plan;
  if (plan !== "monthly" && plan !== "yearly") return c.json({ error: "plan must be monthly or yearly" }, 400);
  const userId = c.get("userId");
  // Stripe would happily sell a second subscription to someone already paying
  // Apple, and a double charge is a refund and an apology.
  if (isEntitled(c.get("entitledUntil"), Date.now())) return c.json({ error: "already subscribed" }, 409);
  try {
    const customerId = await ensureCustomer(c.env.DB, cfg, userId);
    const trialDays = await trialDaysFor(c.env.DB, userId);
    const session = await createCheckoutSession(cfg, {
      userId,
      customerId,
      priceId: cfg.prices[plan],
      trialDays,
      origin: new URL(c.req.url).origin,
    });
    return c.json({ url: session.url });
  } catch (err) {
    if (err instanceof StripeError) return stripeFailure(c, err);
    throw err;
  }
});

// The return leg: { checkout_session_id } → { ok, entitlement }. What makes Pro
// appear the moment the user lands back on Settings rather than whenever the
// webhook arrives — the client posts an id, the server reads the truth.
billing.post("/billing/stripe", async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg) return c.json(STRIPE_UNCONFIGURED, 503);
  const body = await jsonBody(c);
  const sessionId = body?.checkout_session_id;
  if (!isStripeId(sessionId, "cs")) return c.json({ error: "checkout_session_id required" }, 400);
  const userId = c.get("userId");
  const nowMs = Date.now();
  return recordPurchase(c, nowMs, async () => {
    const session = await retrieveCheckoutSession(cfg, sessionId);
    if (!session) throw new StripeInputError("unknown checkout session");
    // The binding the checkout route made. Someone else's session id is a
    // conflict, never a transfer.
    if (session.client_reference_id !== String(userId)) throw new SubscriptionConflict();
    // A test-mode subscription against a production database would grant real
    // Pro for a $0 test card — the same rule as a sandbox AppTransaction.
    if (!session.livemode && !isDevHost(c.env, c.req.url)) throw new StripeInputError("test-mode checkout");
    const subscriptionId = idOf(session.subscription);
    if (session.mode !== "subscription" || !isStripeId(subscriptionId, "sub")) throw new StripeInputError("checkout not complete");
    const sub = await fetchStripeSubscription(cfg, subscriptionId);
    if (!sub) throw new StripeInputError("unknown subscription");
    if (sub.metadata?.user_id !== String(userId) || idOf(sub.customer) !== idOf(session.customer)) throw new SubscriptionConflict();
    await adoptStripeSubscription(c.env.DB, userId, sub, nowMs, { checkout_session: session.id });
  });
});

// → { url }, the Stripe customer portal: cancel at period end, switch plans,
// update the card, invoices. No cancel or plan-change route of our own — the
// portal is the point of paying Stripe.
billing.post("/billing/stripe/portal", async (c) => {
  const cfg = stripeConfig(c.env);
  if (!cfg) return c.json(STRIPE_UNCONFIGURED, 503);
  const user = await c.env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(c.get("userId")).first<{ stripe_customer_id: string | null }>();
  if (!user?.stripe_customer_id) return c.json({ error: "no web subscription" }, 404);
  try {
    return c.json({ url: await createPortalSession(cfg, user.stripe_customer_id, new URL(c.req.url).origin) });
  } catch (err) {
    if (err instanceof StripeError) return stripeFailure(c, err);
    throw err;
  }
});
