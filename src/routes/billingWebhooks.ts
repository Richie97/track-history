// Store webhooks — public routes outside /api (no session; the store is the
// caller). Both verify the sender before touching the database: Apple by the
// signature on its payload, Google by the OIDC token on Pub/Sub's push. A
// request that doesn't verify is a 401 and nothing else happens.
//
// Both are idempotent and re-derive state from the store's own payload (Apple)
// or a fresh API read (Google) rather than from the notification's type: the
// type says something changed, the payload says what.

import { Hono } from "hono";
import type { AppContext, Env } from "../types";
import { JwsError, peekJwsPayload, verifyX5cJws } from "../lib/billing/jws";
import {
  APPLE_HANDLED_NOTIFICATIONS,
  type AppleRenewalInfo,
  appleBundleId,
  appleRootsDer,
  appleSubscriptionState,
  verifyAppleRenewalInfo,
  verifyAppleTransaction,
} from "../lib/billing/apple";
import {
  decodePubSubMessage,
  fetchGoogleSubscription,
  googleSubscriptionState,
  parseServiceAccount,
  verifyGoogleOidcToken,
} from "../lib/billing/google";
import { applyStoreState, findSubscription, retireSubscription } from "../lib/billing/store";

export const billingWebhooks = new Hono<AppContext>();

// App Store Server Notifications V2: { signedPayload }.
billingWebhooks.post("/billing/apple/notifications", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { signedPayload?: unknown } | null;
  if (!body || typeof body.signedPayload !== "string") return c.json({ error: "signedPayload required" }, 400);
  const nowMs = Date.now();
  const rootsDer = appleRootsDer(c.env);

  let payload: Record<string, unknown>;
  try {
    payload = await verifyX5cJws(body.signedPayload, { rootsDer });
  } catch (err) {
    console.warn("apple notification rejected:", err instanceof Error ? err.message : err, peekJwsPayload(body.signedPayload)?.notificationType);
    return c.json({ error: "unverified" }, 401);
  }

  const type = String(payload.notificationType ?? "");
  const data = (payload.data ?? {}) as { bundleId?: string; signedTransactionInfo?: string; signedRenewalInfo?: string };
  if (!APPLE_HANDLED_NOTIFICATIONS.has(type) || !data.signedTransactionInfo) {
    console.log("apple notification ignored:", type, payload.subtype);
    return c.json({ ok: true, handled: false });
  }
  if (data.bundleId !== appleBundleId(c.env)) return c.json({ error: "wrong bundle id" }, 401);

  try {
    const tx = await verifyAppleTransaction(data.signedTransactionInfo, { bundleId: appleBundleId(c.env), rootsDer });
    const renewal: AppleRenewalInfo | null = data.signedRenewalInfo
      ? await verifyAppleRenewalInfo(data.signedRenewalInfo, { rootsDer, originalTransactionId: tx.originalTransactionId })
      : null;
    const row = await findSubscription(c.env.DB, "apple", tx.originalTransactionId);
    if (!row) {
      // The client's own POST attributes a purchase to a user; a notification
      // that arrives first has nobody to attach to yet, and the POST will.
      console.log("apple notification for unknown transaction:", type, tx.originalTransactionId);
      return c.json({ ok: true, handled: false });
    }
    const state = appleSubscriptionState(tx, renewal, nowMs);
    await applyStoreState(c.env.DB, row, { ...state, productId: tx.productId, raw: { transaction: tx, renewal, notificationType: type } }, nowMs);
    return c.json({ ok: true, handled: true });
  } catch (err) {
    if (err instanceof JwsError) return c.json({ error: "unverified" }, 401);
    throw err;
  }
});

// Real-Time Developer Notifications via a Pub/Sub push subscription.
billingWebhooks.post("/billing/google/rtdn", async (c) => {
  const sa = parseServiceAccount(c.env.GOOGLE_PLAY_SERVICE_ACCOUNT);
  if (!sa) return c.json({ error: "billing not configured" }, 401);
  const nowMs = Date.now();
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  try {
    await verifyGoogleOidcToken(bearer, {
      audience: rtdnAudience(c.env, c.req.url),
      email: c.env.GOOGLE_RTDN_EMAIL || sa.client_email,
      nowMs,
    });
  } catch (err) {
    console.warn("rtdn rejected:", err instanceof Error ? err.message : err);
    return c.json({ error: "unverified" }, 401);
  }

  const note = decodePubSubMessage(await c.req.json().catch(() => null));
  if (!note) return c.json({ error: "not a Pub/Sub message" }, 400);
  const token = note.subscriptionNotification?.purchaseToken;
  if (!token) return c.json({ ok: true, handled: false }); // test notification or a one-time product

  const row = await findSubscription(c.env.DB, "google", token);
  if (!row) {
    console.log("rtdn for unknown purchase token:", note.subscriptionNotification?.notificationType);
    return c.json({ ok: true, handled: false });
  }
  const sub = await fetchGoogleSubscription(sa, token, nowMs);
  if (!sub) return c.json({ ok: true, handled: false });
  const state = googleSubscriptionState(sub, nowMs);
  await applyStoreState(c.env.DB, row, { ...state, raw: { purchase: sub, notificationType: note.subscriptionNotification?.notificationType } }, nowMs);
  if (state.linkedPurchaseToken) await retireSubscription(c.env.DB, row.user_id, "google", state.linkedPurchaseToken, nowMs);
  return c.json({ ok: true, handled: true });
});

// The OIDC audience Pub/Sub was configured with is this route's public URL.
// Cloudflare hands the Worker the original https URL, so the request's own is
// right in production; without a scheme rewrite there's nothing to configure.
export function rtdnAudience(_env: Env, requestUrl: string): string {
  const u = new URL(requestUrl);
  return `${u.origin}${u.pathname}`;
}
