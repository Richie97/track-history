import { describe, expect, it } from "vitest";
import {
  STRIPE_GRACE_MS,
  STRIPE_SIGNATURE_TOLERANCE_MS,
  type StripeSubscription,
  latestInvoiceRefunded,
  stripeConfig,
  stripeEventRef,
  stripeForm,
  stripePeriod,
  stripeSignatureHex,
  stripeSubscriptionState,
  verifyStripeSignature,
} from "../../src/lib/billing/stripe";

// NS-49: the pure half of src/lib/billing/stripe.ts.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const sec = (ms: number) => Math.floor(ms / 1000);
const START = NOW - 2 * DAY;
const END = NOW + 28 * DAY;

function sub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    livemode: true,
    cancel_at_period_end: false,
    current_period_start: sec(START),
    current_period_end: sec(END),
    items: { data: [{ price: { id: "price_monthly" } }] },
    ...overrides,
  };
}

describe("stripeConfig", () => {
  it("is null until the key and both prices are set", () => {
    expect(stripeConfig({})).toBeNull();
    expect(stripeConfig({ STRIPE_SECRET_KEY: "rk_live_x", STRIPE_PRICE_MONTHLY: "price_m" })).toBeNull();
    expect(stripeConfig({ STRIPE_SECRET_KEY: " ", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y" })).toBeNull();
    expect(stripeConfig({ STRIPE_SECRET_KEY: "rk_live_x", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y" })).toEqual({
      secretKey: "rk_live_x",
      prices: { monthly: "price_m", yearly: "price_y" },
    });
  });
});

describe("stripeForm", () => {
  it("encodes nesting and arrays the way Stripe reads them, leaving nulls out", () => {
    const form = stripeForm({
      mode: "subscription",
      line_items: [{ price: "price_m", quantity: 1 }],
      subscription_data: { metadata: { user_id: 7 }, trial_period_days: undefined },
      automatic_tax: { enabled: true },
      customer: null,
    });
    expect([...form]).toEqual([
      ["mode", "subscription"],
      ["line_items[0][price]", "price_m"],
      ["line_items[0][quantity]", "1"],
      ["subscription_data[metadata][user_id]", "7"],
      ["automatic_tax[enabled]", "true"],
    ]);
  });
});

describe("stripeSubscriptionState — one test per row of NS-49's table", () => {
  it("active and trialing: active until the period end, renewing unless cancelled at period end", () => {
    for (const status of ["active", "trialing"]) {
      expect(stripeSubscriptionState(sub({ status }))).toEqual({
        status: "active",
        expiresAt: sec(END) * 1000,
        autoRenew: true,
        productId: "price_monthly",
        environment: "live",
      });
    }
    expect(stripeSubscriptionState(sub({ cancel_at_period_end: true })).autoRenew).toBe(false);
  });

  it("past_due: grace, bounded by STRIPE_GRACE_MS past the period start", () => {
    // A yearly renewal that failed: Stripe has already advanced the period.
    const yearly = sub({ status: "past_due", current_period_end: sec(START + 365 * DAY) });
    const state = stripeSubscriptionState(yearly);
    expect(state.status).toBe("grace");
    expect(state.expiresAt).toBe(sec(START) * 1000 + STRIPE_GRACE_MS);
    // A period shorter than the bound keeps its own end.
    const short = stripeSubscriptionState(sub({ status: "past_due", current_period_end: sec(START + DAY) }));
    expect(short.expiresAt).toBe(sec(START + DAY) * 1000);
  });

  it("unpaid: billing_retry, not renewing", () => {
    expect(stripeSubscriptionState(sub({ status: "unpaid" }))).toMatchObject({ status: "billing_retry", expiresAt: sec(END) * 1000, autoRenew: false });
  });

  it("canceled and incomplete_expired: expired at ended_at, else the period end", () => {
    expect(stripeSubscriptionState(sub({ status: "canceled", ended_at: sec(NOW) }))).toMatchObject({ status: "expired", expiresAt: sec(NOW) * 1000, autoRenew: false });
    expect(stripeSubscriptionState(sub({ status: "incomplete_expired" }))).toMatchObject({ status: "expired", expiresAt: sec(END) * 1000 });
  });

  it("incomplete: pending, with nothing to say about expiry or renewal", () => {
    expect(stripeSubscriptionState(sub({ status: "incomplete" }))).toMatchObject({ status: "pending", expiresAt: null, autoRenew: null });
  });

  it("paused: paused, not renewing", () => {
    expect(stripeSubscriptionState(sub({ status: "paused" }))).toMatchObject({ status: "paused", expiresAt: sec(END) * 1000, autoRenew: false });
  });

  it("any status, after a full refund of the latest invoice: revoked at once", () => {
    const refunded = { id: "in_1", charge: { id: "ch_1", amount: 1999, amount_refunded: 1999, refunded: true } };
    for (const status of ["active", "past_due", "canceled"]) {
      expect(stripeSubscriptionState(sub({ status, latest_invoice: refunded }))).toMatchObject({ status: "revoked", expiresAt: null, autoRenew: false });
    }
    // A partial refund changes nothing.
    const partial = { id: "in_1", charge: { id: "ch_1", amount: 1999, amount_refunded: 500, refunded: false } };
    expect(stripeSubscriptionState(sub({ latest_invoice: partial })).status).toBe("active");
    // An unexpanded invoice, or one with no charge (a $0 trial invoice), is not a refund.
    expect(latestInvoiceRefunded(sub({ latest_invoice: "in_1" }))).toBe(false);
    expect(latestInvoiceRefunded(sub({ latest_invoice: { id: "in_1", charge: null } }))).toBe(false);
  });

  it("a status Stripe adds later entitles nothing", () => {
    expect(stripeSubscriptionState(sub({ status: "something_new" })).status).toBe("pending");
  });

  it("says test for a test-mode object", () => {
    expect(stripeSubscriptionState(sub({ livemode: false })).environment).toBe("test");
  });

  it("reads the period off the item when the subscription doesn't carry it (2025-03-31 and later)", () => {
    const moved = sub({
      current_period_start: undefined,
      current_period_end: undefined,
      items: { data: [{ price: { id: "price_y" }, current_period_start: sec(START), current_period_end: sec(END) }] },
    });
    expect(stripePeriod(moved)).toEqual({ start: sec(START) * 1000, end: sec(END) * 1000 });
    expect(stripeSubscriptionState(moved)).toMatchObject({ expiresAt: sec(END) * 1000, productId: "price_y" });
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_unit";
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  const header = async (t: number, s = secret, b = body) => `t=${t},v1=${await stripeSignatureHex(s, `${t}.${b}`)}`;

  it("accepts Stripe's signature over t.body", async () => {
    expect(await verifyStripeSignature(await header(sec(NOW)), body, secret, NOW)).toBe(true);
  });

  it("accepts a header carrying several v1s while the secret rolls", async () => {
    const t = sec(NOW);
    const old = await stripeSignatureHex("whsec_old", `${t}.${body}`);
    const current = await stripeSignatureHex(secret, `${t}.${body}`);
    expect(await verifyStripeSignature(`t=${t},v1=${old},v1=${current},v0=deadbeef`, body, secret, NOW)).toBe(true);
  });

  it("refuses another secret, a changed body, a stale or future t, and a malformed header", async () => {
    expect(await verifyStripeSignature(await header(sec(NOW), "whsec_other"), body, secret, NOW)).toBe(false);
    expect(await verifyStripeSignature(await header(sec(NOW)), body.replace("paid", "void"), secret, NOW)).toBe(false);
    const stale = sec(NOW - STRIPE_SIGNATURE_TOLERANCE_MS - 1000);
    expect(await verifyStripeSignature(await header(stale), body, secret, NOW)).toBe(false);
    const future = sec(NOW + STRIPE_SIGNATURE_TOLERANCE_MS + 1000);
    expect(await verifyStripeSignature(await header(future), body, secret, NOW)).toBe(false);
    for (const bad of [undefined, "", "v1=abc", `t=${sec(NOW)}`, `t=${sec(NOW)},v0=${"a".repeat(64)}`]) {
      expect(await verifyStripeSignature(bad, body, secret, NOW), String(bad)).toBe(false);
    }
    expect(await verifyStripeSignature(await header(sec(NOW)), body, "", NOW)).toBe(false);
  });
});

describe("stripeEventRef", () => {
  it("resolves every handled event to a subscription, or to the object to read one from", () => {
    const ev = (type: string, object: Record<string, unknown>) => stripeEventRef({ id: "evt", type, data: { object } });
    expect(ev("customer.subscription.updated", { id: "sub_a" })).toEqual({ kind: "subscription", id: "sub_a" });
    expect(ev("customer.subscription.deleted", { id: "sub_a" })).toEqual({ kind: "subscription", id: "sub_a" });
    expect(ev("checkout.session.completed", { id: "cs_1", subscription: "sub_b" })).toEqual({ kind: "subscription", id: "sub_b" });
    expect(ev("checkout.session.completed", { id: "cs_1", subscription: { id: "sub_b" } })).toEqual({ kind: "subscription", id: "sub_b" });
    expect(ev("checkout.session.completed", { id: "cs_1", subscription: null })).toBeNull();
    expect(ev("invoice.paid", { id: "in_1", subscription: "sub_c" })).toEqual({ kind: "subscription", id: "sub_c" });
    expect(ev("invoice.payment_failed", { id: "in_1", parent: { subscription_details: { subscription: "sub_d" } } })).toEqual({
      kind: "subscription",
      id: "sub_d",
    });
    expect(ev("invoice.paid", { id: "in_1" })).toEqual({ kind: "invoice", id: "in_1" });
    expect(ev("charge.refunded", { id: "ch_1", invoice: "in_1" })).toEqual({ kind: "charge", id: "ch_1" });
  });

  it("refuses an id that isn't one, rather than putting it in a URL", () => {
    expect(stripeEventRef({ id: "evt", type: "customer.subscription.updated", data: { object: { id: "sub_../../v1/customers" } } })).toBeNull();
    expect(stripeEventRef({ id: "evt", type: "charge.refunded", data: { object: { id: "in_1" } } })).toBeNull();
  });
});
