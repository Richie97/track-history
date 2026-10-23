// Store webhooks — public routes outside /api (no session; the store is the
// caller). All three verify the sender before touching the database: Apple by
// the signature on its payload, Google by the OIDC token on Pub/Sub's push,
// Stripe by the HMAC on its delivery. A request that doesn't verify is a 401
// and nothing else happens.
//
// All are idempotent and re-derive state from the store's own payload (Apple)
// or a fresh API read (Google, Stripe) rather than from the notification's
// type: the type says something changed, the payload says what.

import { Hono } from "hono";
import type { AppContext, Env } from "../types";
import { JwsError, peekJwsPayload, verifyX5cJws } from "../lib/billing/jws";
import { APPLE_HANDLED_NOTIFICATIONS, appleBundleId, appleRootsDer } from "../lib/billing/apple";
import { decodePubSubMessage, parseServiceAccount, verifyGoogleOidcToken } from "../lib/billing/google";
import { adoptStripeSubscription, syncAppleRow, syncGoogleRow, syncStripeRow } from "../lib/billing/sync";
import { SubscriptionConflict, findSubscription } from "../lib/billing/store";
import {
  STRIPE_HANDLED_EVENTS,
  type StripeEvent,
  fetchStripeSubscription,
  idOf,
  resolveStripeSubscriptionId,
  stripeConfig,
  stripeEventRef,
  verifyStripeSignature,
} from "../lib/billing/stripe";
import { isDevHost } from "../lib/dev";
import { bearerToken } from "../lib/session";

export const billingWebhooks = new Hono<AppContext>();

// App Store Server Notifications V2: { signedPayload }.
billingWebhooks.post("/billing/apple/notifications", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { signedPayload?: unknown } | null;
  if (!body || typeof body.signedPayload !== "string") return c.json({ error: "signedPayload required" }, 400);
  const nowMs = Date.now();
  const rootsDer = appleRootsDer(c.env, c.req.url);

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
    const claimed = peekJwsPayload(data.signedTransactionInfo)?.originalTransactionId;
    const row = typeof claimed === "string" ? await findSubscription(c.env.DB, "apple", claimed) : null;
    if (!row) {
      // The client's own POST attributes a purchase to a user; a notification
      // that arrives first has nobody to attach to yet, and the POST will.
      console.log("apple notification for unknown transaction:", type, claimed);
      return c.json({ ok: true, handled: false });
    }
    const outcome = await syncAppleRow(
      c.env.DB,
      row,
      { transactionJws: data.signedTransactionInfo, renewalJws: data.signedRenewalInfo, tag: { notificationType: type } },
      { bundleId: appleBundleId(c.env), rootsDer, nowMs }
    );
    if (outcome === "stale") {
      // Apple retries a failed delivery for days with its original payload.
      // The row already holds something signed later, so there is nothing to
      // correct — acking is what stops the retries.
      console.log("apple notification ignored as stale:", type, row.external_id);
      return c.json({ ok: true, handled: false });
    }
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
  const bearer = bearerToken(c.req.header("Authorization"));
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
  const outcome = await syncGoogleRow(c.env.DB, row, sa, {
    nowMs,
    tag: { notificationType: note.subscriptionNotification?.notificationType },
  });
  return c.json({ ok: true, handled: outcome === "updated" });
});

// Stripe webhook events (NS-49). Every handled event resolves to a
// subscription id and then does one thing — re-reads that subscription and
// applies it — because Stripe delivers out of order and an event's embedded
// object can be older than the row. The one way this differs from the store
// webhooks: a subscription with no row yet is inserted, since its customer is
// ours and it carries our user id; when the two disagree it is never guessed.
//
// A D1 failure is left to throw a 500 on purpose: Stripe retries for three
// days, and a retry is cheaper than a customer who paid and reads free.
billingWebhooks.post("/billing/stripe/webhook", async (c) => {
  const cfg = stripeConfig(c.env);
  const secret = c.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!cfg || !secret) return c.json({ error: "billing not configured" }, 503);
  const nowMs = Date.now();
  // The signature is over the bytes, so the body is read as text first.
  const raw = await c.req.text();
  if (!(await verifyStripeSignature(c.req.header("Stripe-Signature"), raw, secret, nowMs))) {
    console.warn("stripe webhook rejected: bad or stale signature");
    return c.json({ error: "unverified" }, 401);
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return c.json({ error: "not a Stripe event" }, 400);
  }
  if (!event || typeof event.type !== "string") return c.json({ error: "not a Stripe event" }, 400);
  if (!STRIPE_HANDLED_EVENTS.has(event.type)) {
    console.log("stripe event ignored:", event.type);
    return c.json({ ok: true, handled: false });
  }

  const subscriptionId = await resolveStripeSubscriptionId(cfg, stripeEventRef(event));
  if (!subscriptionId) {
    console.log("stripe event with no subscription:", event.type, event.id);
    return c.json({ ok: true, handled: false });
  }
  const tag = { event: event.type, event_id: event.id };
  const row = await findSubscription(c.env.DB, "stripe", subscriptionId);
  if (row) {
    const outcome = await syncStripeRow(c.env.DB, row, cfg, { nowMs, tag });
    return c.json({ ok: true, handled: outcome === "updated" });
  }

  // No row: the webhook beat the return leg, or the user never came back to
  // Settings. Insert only when our customer and the subscription's own
  // metadata name the same account.
  const sub = await fetchStripeSubscription(cfg, subscriptionId);
  if (!sub) return c.json({ ok: true, handled: false });
  const customerId = idOf(sub.customer);
  const owner = customerId
    ? await c.env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").bind(customerId).first<{ id: number }>()
    : null;
  if (!owner || sub.metadata?.user_id !== String(owner.id)) {
    // A live event reaching a dev database, or a subscription made by hand in
    // the dashboard: nobody to attach it to.
    console.log("stripe subscription with no matching account:", event.type, subscriptionId);
    return c.json({ ok: true, handled: false });
  }
  if (!sub.livemode && !isDevHost(c.env, c.req.url)) {
    console.log("stripe test-mode subscription ignored:", subscriptionId);
    return c.json({ ok: true, handled: false });
  }
  try {
    await adoptStripeSubscription(c.env.DB, owner.id, sub, nowMs, tag);
  } catch (err) {
    if (err instanceof SubscriptionConflict) return c.json({ ok: true, handled: false });
    throw err;
  }
  return c.json({ ok: true, handled: true });
});

// The OIDC audience Pub/Sub was configured with is this route's public URL.
// Cloudflare hands the Worker the original https URL, so the request's own is
// right in production; without a scheme rewrite there's nothing to configure.
export function rtdnAudience(_env: Env, requestUrl: string): string {
  const u = new URL(requestUrl);
  return `${u.origin}${u.pathname}`;
}
