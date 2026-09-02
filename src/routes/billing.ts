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
import { entitlementResponse, legacyClaimOpen, parseClientHeader, type SubscriptionRow } from "../lib/entitlement";

export const billing = new Hono<AppContext>();

// Re-reads the user's entitlement after a write. The request context's
// entitledUntil predates the write, so this is the one place it is re-fetched.
export async function freshEntitlement(c: Ctx, nowMs: number) {
  const userId = c.get("userId");
  const [userRes, subsRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT entitled_until FROM users WHERE id = ?").bind(userId),
    subscriptionsForUserStmt(c.env.DB, userId),
  ]);
  const user = userRes.results[0] as { entitled_until: number | null } | undefined;
  return entitlementResponse(user?.entitled_until ?? null, subsRes.results as SubscriptionRow[], nowMs);
}

async function jsonBody(c: Ctx): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

// Runs a verified write and maps its failure modes to statuses: a bad payload
// is the client's problem (400), a purchase owned by another account is a
// conflict (409), anything else is a 500 with the message kept out of the body.
async function recordPurchase(c: Ctx, nowMs: number, work: () => Promise<void>) {
  try {
    await work();
  } catch (err) {
    if (err instanceof JwsError) return c.json({ error: `invalid receipt: ${err.message}` }, 400);
    if (err instanceof SubscriptionConflict) return c.json({ error: err.message }, 409);
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
