// Stripe: Track Evolution Pro bought on the web (NS-49). Dependency-free, the
// same way the Google path is: the Stripe REST API is form-encoded HTTPS with a
// bearer key, and a webhook signature is one HMAC-SHA256 — neither is worth a
// dependency tree in a Worker.
//
// Two rules shape everything here. The Worker mints the Checkout Session for
// the signed-in user, so a purchase is bound to the account *before* payment;
// and every write derives from a fresh API read, never from a webhook's
// embedded object, because Stripe does not deliver events in order and an
// event's copy of the subscription can be older than the row already holds.

import type { Env } from "../../types";
import type { SubscriptionStatus } from "../entitlement";

export const STRIPE_API = "https://api.stripe.com";

// Pinned on every request so a change to the account's default version in the
// dashboard cannot move a field under us. The last version before 2025-03-31
// ("basil"), which moved the period off the subscription onto its items and
// the subscription and charge off the invoice: the shapes below are this
// version's. `stripePeriod` reads both places anyway, so a later bump of this
// constant is a one-line change for the period and a reviewed one for the rest.
export const STRIPE_API_VERSION = "2025-02-24.acacia";

// The trial the stores offer, offered here once per account (see
// trialDaysFor in routes/billing.ts).
export const STRIPE_TRIAL_DAYS = 14;

// How long a `past_due` subscription keeps Pro. When a renewal's payment fails
// Stripe has already advanced the period, so current_period_end alone would
// hand a yearly subscriber a year on a dead card; the dashboard's retry
// schedule is set to cancel inside this window (README, Stripe dashboard).
export const STRIPE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// A captured webhook delivery is refused once its timestamp is this old.
export const STRIPE_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

// The two plans and the env var holding each one's price id.
export const STRIPE_PLANS = ["monthly", "yearly"] as const;
export type StripePlan = (typeof STRIPE_PLANS)[number];

export type StripeConfig = { secretKey: string; prices: Record<StripePlan, string> };

// Null — every Stripe route a 503, `/plans` `{ enabled: false }` — until the
// key and both price ids are set. The webhook secret is read separately: the
// webhook is the one route that needs it, and the rest work without it.
export function stripeConfig(env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_PRICE_MONTHLY" | "STRIPE_PRICE_YEARLY">): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const monthly = env.STRIPE_PRICE_MONTHLY?.trim();
  const yearly = env.STRIPE_PRICE_YEARLY?.trim();
  if (!secretKey || !monthly || !yearly) return null;
  return { secretKey, prices: { monthly, yearly } };
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

// Stripe's nested form encoding: { a: { b: [x] } } → a[b][0]=x. Nulls and
// undefineds are left out rather than sent as empty strings, which Stripe reads
// as "unset this field".
export function stripeForm(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    else if (typeof v === "object") for (const [k, inner] of Object.entries(v)) walk(`${prefix}[${k}]`, inner);
    else out.append(prefix, String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

// One request. A 404 answers null (an object Stripe doesn't know — the caller
// decides what that means); any other failure throws with Stripe's own message.
export async function stripeRequest<T>(
  cfg: StripeConfig,
  method: "GET" | "POST",
  path: string,
  opts: { params?: Record<string, unknown>; idempotencyKey?: string } = {}
): Promise<T | null> {
  const form = opts.params ? stripeForm(opts.params) : null;
  const url = method === "GET" && form && [...form.keys()].length ? `${STRIPE_API}${path}?${form}` : `${STRIPE_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.secretKey}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(url, { method, headers, body: method === "POST" ? (form ?? new URLSearchParams()).toString() : undefined });
  if (res.status === 404) return null;
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
  if (!res.ok) throw new StripeError(res.status, body?.error?.message ?? `stripe ${method} ${path} failed: ${res.status}`, body?.error?.code);
  return body as T;
}

// Ids arrive from request bodies and webhook payloads and go into URL paths,
// so they are held to Stripe's alphabet (letters, digits, underscore — the
// hyphen too, which no Stripe id uses but costs nothing to allow) and their
// expected prefix. The length bound is only a sanity limit, far above any id
// Stripe issues (the test mock's ids carry a whole object).
export function isStripeId(v: unknown, prefix: string): v is string {
  return typeof v === "string" && v.length <= 4096 && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(v);
}

// --- the objects, as much of them as this file reads ---------------------------

export type StripePrice = {
  id: string;
  active?: boolean;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string; interval_count?: number } | null;
};

export type StripeCharge = {
  id: string;
  object?: "charge";
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  customer?: string | null;
  invoice?: string | { id: string; subscription?: string | { id: string } | null } | null;
};

export type StripeInvoice = {
  id: string;
  subscription?: string | { id: string } | null;
  // 2025-03-31 and later: the subscription moved under `parent`.
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  charge?: string | StripeCharge | null;
};

export type StripeSubscription = {
  id: string;
  object?: "subscription";
  customer: string | { id: string };
  status: string;
  livemode: boolean;
  cancel_at_period_end: boolean;
  current_period_start?: number;
  current_period_end?: number;
  ended_at?: number | null;
  metadata?: Record<string, string> | null;
  items?: { data?: { price?: { id?: string } | null; current_period_start?: number; current_period_end?: number }[] };
  latest_invoice?: string | StripeInvoice | null;
};

export type StripeCheckoutSession = {
  id: string;
  mode: string;
  status: string | null;
  livemode: boolean;
  client_reference_id: string | null;
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
  url?: string | null;
};

export type StripeEvent = { id: string; type: string; livemode?: boolean; data?: { object?: Record<string, unknown> } };

export const idOf = (v: string | { id: string } | null | undefined): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v.id === "string" ? v.id : null;

// --- calls ---------------------------------------------------------------------

export async function fetchStripePrice(cfg: StripeConfig, priceId: string): Promise<StripePrice | null> {
  return stripeRequest<StripePrice>(cfg, "GET", `/v1/prices/${encodeURIComponent(priceId)}`);
}

// The customer for an account, created on first use. The idempotency key makes
// two tabs racing a first checkout create one customer, not two; the caller
// stores the id only where none is stored yet.
export async function createCustomer(cfg: StripeConfig, user: { id: number; email: string | null }): Promise<string> {
  const customer = await stripeRequest<{ id: string }>(cfg, "POST", "/v1/customers", {
    params: { email: user.email ?? undefined, metadata: { user_id: user.id } },
    idempotencyKey: `customer:${user.id}`,
  });
  if (!customer?.id) throw new StripeError(502, "stripe created no customer");
  return customer.id;
}

export async function createCheckoutSession(
  cfg: StripeConfig,
  opts: { userId: number; customerId: string; priceId: string; trialDays: number; origin: string }
): Promise<StripeCheckoutSession> {
  const session = await stripeRequest<StripeCheckoutSession>(cfg, "POST", "/v1/checkout/sessions", {
    params: {
      mode: "subscription",
      customer: opts.customerId,
      client_reference_id: String(opts.userId),
      line_items: [{ price: opts.priceId, quantity: 1 }],
      metadata: { user_id: opts.userId },
      subscription_data: {
        metadata: { user_id: opts.userId },
        trial_period_days: opts.trialDays > 0 ? opts.trialDays : undefined,
      },
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      // Automatic tax on an existing customer needs the address Checkout
      // collects saved back to that customer.
      customer_update: { address: "auto" },
      allow_promotion_codes: true,
      // Stripe substitutes the literal {CHECKOUT_SESSION_ID}.
      success_url: `${opts.origin}/#/settings?checkout={CHECKOUT_SESSION_ID}`,
      cancel_url: `${opts.origin}/#/settings`,
    },
  });
  if (!session?.url) throw new StripeError(502, "stripe returned no checkout url");
  return session;
}

export async function retrieveCheckoutSession(cfg: StripeConfig, id: string): Promise<StripeCheckoutSession | null> {
  return stripeRequest<StripeCheckoutSession>(cfg, "GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);
}

// The subscription with its latest invoice's charge expanded — the refund
// check in stripeSubscriptionState reads it.
export async function fetchStripeSubscription(cfg: StripeConfig, id: string): Promise<StripeSubscription | null> {
  return stripeRequest<StripeSubscription>(cfg, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`, {
    params: { expand: ["latest_invoice.charge"] },
  });
}

export async function createPortalSession(cfg: StripeConfig, customerId: string, origin: string): Promise<string> {
  const session = await stripeRequest<{ url?: string }>(cfg, "POST", "/v1/billing_portal/sessions", {
    params: { customer: customerId, return_url: `${origin}/#/settings` },
  });
  if (!session?.url) throw new StripeError(502, "stripe returned no portal url");
  return session.url;
}

// --- the state mapping -----------------------------------------------------------

// The period, wherever the API version puts it: on the subscription before
// 2025-03-31, on its item from then on. Seconds → ms.
export function stripePeriod(sub: StripeSubscription): { start: number | null; end: number | null } {
  const item = sub.items?.data?.[0];
  const start = sub.current_period_start ?? item?.current_period_start;
  const end = sub.current_period_end ?? item?.current_period_end;
  return { start: start == null ? null : start * 1000, end: end == null ? null : end * 1000 };
}

// A refund does not cancel a Stripe subscription by itself, so it is read off
// the latest invoice's charge rather than the status: fully refunded is
// `revoked`, a partial refund changes nothing.
export function latestInvoiceRefunded(sub: StripeSubscription): boolean {
  const invoice = sub.latest_invoice;
  if (!invoice || typeof invoice === "string") return false;
  const charge = invoice.charge;
  if (!charge || typeof charge === "string") return false;
  return charge.refunded === true || (charge.amount > 0 && charge.amount_refunded >= charge.amount);
}

export type StripeState = {
  status: SubscriptionStatus;
  expiresAt: number | null;
  autoRenew: boolean | null;
  productId: string | null;
  environment: "live" | "test";
};

// A Stripe subscription → our row (NS-49 rule 3's table).
export function stripeSubscriptionState(sub: StripeSubscription): StripeState {
  const { start, end } = stripePeriod(sub);
  const productId = sub.items?.data?.[0]?.price?.id ?? null;
  const environment = sub.livemode ? "live" : "test";
  const renews = !sub.cancel_at_period_end;
  const base = { productId, environment } as const;
  if (latestInvoiceRefunded(sub)) return { ...base, status: "revoked", expiresAt: null, autoRenew: false };
  switch (sub.status) {
    case "active":
    case "trialing":
      return { ...base, status: "active", expiresAt: end, autoRenew: renews };
    case "past_due": {
      const bound = start == null ? null : start + STRIPE_GRACE_MS;
      const expiresAt = end == null ? bound : bound == null ? end : Math.min(end, bound);
      return { ...base, status: "grace", expiresAt, autoRenew: renews };
    }
    case "unpaid":
      return { ...base, status: "billing_retry", expiresAt: end, autoRenew: false };
    case "canceled":
    case "incomplete_expired":
      return { ...base, status: "expired", expiresAt: sub.ended_at != null ? sub.ended_at * 1000 : end, autoRenew: false };
    case "incomplete":
      return { ...base, status: "pending", expiresAt: null, autoRenew: null };
    case "paused":
      return { ...base, status: "paused", expiresAt: end, autoRenew: false };
    default:
      // A status Stripe adds later entitles nothing until it is mapped.
      return { ...base, status: "pending", expiresAt: null, autoRenew: null };
  }
}

// --- webhooks --------------------------------------------------------------------

export const STRIPE_HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
]);

// Where an event points. Every handled event comes down to a subscription id,
// but an invoice or a charge may need one read to get there: the embedded
// object is rendered in the webhook endpoint's API version, not the pinned one,
// so it is read tolerantly and anything it doesn't say is fetched.
export type StripeEventRef =
  | { kind: "subscription"; id: string }
  | { kind: "invoice"; id: string }
  | { kind: "charge"; id: string }
  | null;

export function stripeEventRef(event: StripeEvent): StripeEventRef {
  const obj = (event.data?.object ?? {}) as Record<string, unknown>;
  const sub = (v: unknown) => {
    const id = idOf(v as string | { id: string } | null | undefined);
    return isStripeId(id, "sub") ? id : null;
  };
  switch (event.type) {
    case "checkout.session.completed": {
      const id = sub(obj.subscription);
      return id ? { kind: "subscription", id } : null; // a payment-mode session has none
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const parent = obj.parent as StripeInvoice["parent"];
      const id = sub(obj.subscription) ?? sub(parent?.subscription_details?.subscription);
      if (id) return { kind: "subscription", id };
      return isStripeId(obj.id, "in") ? { kind: "invoice", id: obj.id } : null;
    }
    case "charge.refunded":
      return isStripeId(obj.id, "ch") ? { kind: "charge", id: obj.id } : null;
    default:
      if (event.type.startsWith("customer.subscription.")) {
        const id = sub(obj.id);
        return id ? { kind: "subscription", id } : null;
      }
      return null;
  }
}

// Follows an invoice or charge reference to its subscription id, in the pinned
// API version. Null when there is none (a one-off invoice, a charge with no
// invoice) or Stripe doesn't know the object.
export async function resolveStripeSubscriptionId(cfg: StripeConfig, ref: StripeEventRef): Promise<string | null> {
  if (!ref) return null;
  if (ref.kind === "subscription") return ref.id;
  if (ref.kind === "invoice") {
    const invoice = await stripeRequest<StripeInvoice>(cfg, "GET", `/v1/invoices/${encodeURIComponent(ref.id)}`);
    const id = idOf(invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription);
    return isStripeId(id, "sub") ? id : null;
  }
  const charge = await stripeRequest<StripeCharge>(cfg, "GET", `/v1/charges/${encodeURIComponent(ref.id)}`, {
    params: { expand: ["invoice"] },
  });
  const invoice = charge?.invoice;
  if (!invoice) return null;
  if (typeof invoice === "string") return resolveStripeSubscriptionId(cfg, isStripeId(invoice, "in") ? { kind: "invoice", id: invoice } : null);
  const id = idOf(invoice.subscription);
  return isStripeId(id, "sub") ? id : null;
}

// `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>…]` — an HMAC-SHA256 over
// "<t>.<raw body>" with the endpoint's signing secret. True only when one v1
// matches and t is within the tolerance either side of now, so a captured
// delivery cannot be replayed later. The body must be the exact bytes Stripe
// sent: read as text before any JSON parse.
export async function verifyStripeSignature(
  header: string | null | undefined,
  body: string,
  secret: string,
  nowMs: number,
  toleranceMs = STRIPE_SIGNATURE_TOLERANCE_MS
): Promise<boolean> {
  if (!header || !secret) return false;
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) t = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (t == null || !signatures.length) return false;
  if (Math.abs(nowMs - t * 1000) > toleranceMs) return false;
  const expected = await stripeSignatureHex(secret, `${t}.${body}`);
  // Every candidate is compared in full; no early exit on a match.
  let ok = false;
  for (const sig of signatures) ok = equalHex(sig, expected) || ok;
  return ok;
}

export async function stripeSignatureHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time over the hex digests, as lib/clips.ts compares its signatures.
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
