import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { reverifyExpiring } from "../../src/cron";
import { ENTITLEMENT_SLACK_MS } from "../../src/lib/entitlement";
import { STRIPE_GRACE_MS, STRIPE_TRIAL_DAYS, stripeSignatureHex } from "../../src/lib/billing/stripe";
import {
  TEST_STRIPE_PRICE_MONTHLY,
  TEST_STRIPE_PRICE_YEARLY,
  TEST_STRIPE_WEBHOOK_SECRET,
  stripeEchoedForm,
  stripeMockId,
} from "../billing-helpers";
import { DEV_ORIGIN, apiClient, createEvent, sessionFor, signedInProUser, signedInUser } from "./helpers";

// NS-49 phase A: Stripe as a fourth provider. api.stripe.com is the mock in
// vitest.workers.config.mts (contract in test/billing-helpers.ts): a Stripe id
// that is "<prefix>_<base64url JSON>" is answered with that JSON, so a test
// writes the subscription it wants Stripe to report into the id itself.

const DAY = 86_400_000;
const sec = (ms: number) => Math.floor(ms / 1000);

let seq = 0;
// A subscription as Stripe would report it, for the user it was bound to.
function subscription(userId: number, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    object: "subscription",
    customer: `cus_test_${userId}`,
    status: "active",
    livemode: false,
    cancel_at_period_end: false,
    current_period_start: sec(now - DAY),
    current_period_end: sec(now + 30 * DAY),
    metadata: { user_id: String(userId) },
    items: { data: [{ price: { id: TEST_STRIPE_PRICE_MONTHLY } }] },
    latest_invoice: { id: "in_latest", charge: { id: "ch_latest", amount: 199, amount_refunded: 0, refunded: false } },
    nonce: ++seq, // each test's id is its own row
    ...overrides,
  };
}
const subId = (userId: number, overrides: Record<string, unknown> = {}) => stripeMockId("sub", subscription(userId, overrides));
const checkoutId = (body: Record<string, unknown>) =>
  stripeMockId("cs", { mode: "subscription", status: "complete", livemode: false, ...body, nonce: ++seq });

async function stripeRow(externalId: string) {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE provider = 'stripe' AND external_id = ?").bind(externalId).first<any>();
}
async function entitledUntil(userId: number) {
  return (await env.DB.prepare("SELECT entitled_until FROM users WHERE id = ?").bind(userId).first<{ entitled_until: number | null }>())!
    .entitled_until;
}
async function setCustomer(userId: number) {
  await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(`cus_test_${userId}`, userId).run();
}
async function insertStripeRow(userId: number, externalId: string, status = "active", expiresAt = Date.now() + 30 * DAY) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at)
     VALUES (?, 'stripe', ?, ?, ?, ?, 1, 'test', ?, ?)`
  )
    .bind(userId, TEST_STRIPE_PRICE_MONTHLY, externalId, status, expiresAt, now, now)
    .run();
}

async function webhook(event: Record<string, unknown>, opts: { t?: number; secret?: string; tamper?: (body: string) => string } = {}) {
  const body = JSON.stringify({ id: `evt_${++seq}`, object: "event", ...event });
  const t = opts.t ?? sec(Date.now());
  const sig = await stripeSignatureHex(opts.secret ?? TEST_STRIPE_WEBHOOK_SECRET, `${t}.${body}`);
  const res = await SELF.fetch(`${DEV_ORIGIN}/billing/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${sig}` },
    body: opts.tamper ? opts.tamper(body) : body,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("migration 0034: subscriptions rebuilt for stripe", () => {
  it("keeps both indexes and all three entitlement triggers", async () => {
    const res = await env.DB.prepare(
      "SELECT type, name FROM sqlite_master WHERE tbl_name = 'subscriptions' AND type IN ('index', 'trigger') ORDER BY name"
    ).all<{ type: string; name: string }>();
    const names = res.results.map((r) => r.name);
    for (const name of [
      "idx_subscriptions_user",
      "idx_subscriptions_expires",
      "subscriptions_entitled_ai",
      "subscriptions_entitled_au",
      "subscriptions_entitled_ad",
    ])
      expect(names).toContain(name);
  });

  it("accepts a stripe row, recomputes entitled_until on insert, update and delete, and still refuses a typo", async () => {
    const { id } = await signedInUser();
    const expires = Date.now() + 10 * DAY;
    await insertStripeRow(id, "sub_trigger_check", "active", expires);
    expect(await entitledUntil(id)).toBe(expires + ENTITLEMENT_SLACK_MS);
    await env.DB.prepare("UPDATE subscriptions SET status = 'revoked' WHERE external_id = 'sub_trigger_check'").run();
    expect(await entitledUntil(id)).toBeNull();
    await env.DB.prepare("UPDATE subscriptions SET status = 'active' WHERE external_id = 'sub_trigger_check'").run();
    await env.DB.prepare("DELETE FROM subscriptions WHERE external_id = 'sub_trigger_check'").run();
    expect(await entitledUntil(id)).toBeNull();
    await expect(
      env.DB.prepare(
        "INSERT INTO subscriptions (user_id, provider, external_id, status, created_at, updated_at) VALUES (?, 'strip', 'x', 'active', 0, 0)"
      )
        .bind(id)
        .run()
    ).rejects.toThrow(/CHECK/);
  });

  it("gives every account at most one Stripe customer", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await setCustomer(a.id);
    await expect(
      env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(`cus_test_${a.id}`, b.id).run()
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe("GET /api/billing/stripe/plans", () => {
  it("answers both plans with Stripe's price and the trial for an account that has never had one", async () => {
    const { api } = await signedInUser();
    const res = await api("GET", "/billing/stripe/plans");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      plans: [
        { plan: "monthly", price_id: TEST_STRIPE_PRICE_MONTHLY, amount: 199, currency: "usd", interval: "month", trial_days: STRIPE_TRIAL_DAYS },
        { plan: "yearly", price_id: TEST_STRIPE_PRICE_YEARLY, amount: 1999, currency: "usd", interval: "year", trial_days: STRIPE_TRIAL_DAYS },
      ],
    });
  });

  it("offers no trial to an account with any earlier stripe row", async () => {
    const { api, id } = await signedInUser();
    await insertStripeRow(id, `sub_old_${id}`, "expired", Date.now() - 90 * DAY);
    const res = await api("GET", "/billing/stripe/plans");
    expect(res.body.plans.map((p: any) => p.trial_days)).toEqual([0, 0]);
  });
});

describe("POST /api/billing/stripe/checkout", () => {
  it("creates the customer once, binds the session to the user and offers the trial", async () => {
    const { api, id, email } = await signedInUser();
    const res = await api("POST", "/billing/stripe/checkout", { plan: "yearly" });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const form = stripeEchoedForm(res.body.url);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("customer")).toBe(`cus_test_${id}`);
    expect(form.get("client_reference_id")).toBe(String(id));
    expect(form.get("line_items[0][price]")).toBe(TEST_STRIPE_PRICE_YEARLY);
    expect(form.get("subscription_data[metadata][user_id]")).toBe(String(id));
    expect(form.get("subscription_data[trial_period_days]")).toBe(String(STRIPE_TRIAL_DAYS));
    expect(form.get("automatic_tax[enabled]")).toBe("true");
    expect(form.get("billing_address_collection")).toBe("required");
    // The origin is the request's own.
    expect(form.get("success_url")).toBe("https://example.com/#/settings?checkout={CHECKOUT_SESSION_ID}");
    expect(form.get("cancel_url")).toBe("https://example.com/#/settings");

    const user = await env.DB.prepare("SELECT email, stripe_customer_id FROM users WHERE id = ?").bind(id).first<any>();
    expect(user).toEqual({ email, stripe_customer_id: `cus_test_${id}` });

    // A second checkout reuses the stored customer rather than making another.
    await env.DB.prepare("UPDATE users SET stripe_customer_id = 'cus_test_kept' WHERE id = ?").bind(id).run();
    const again = await api("POST", "/billing/stripe/checkout", { plan: "monthly" });
    expect(stripeEchoedForm(again.body.url).get("customer")).toBe("cus_test_kept");
  });

  it("offers no trial to an account that has had a web subscription", async () => {
    const { api, id } = await signedInUser();
    await insertStripeRow(id, `sub_lapsed_${id}`, "expired", Date.now() - DAY);
    const res = await api("POST", "/billing/stripe/checkout", { plan: "monthly" });
    expect(stripeEchoedForm(res.body.url).has("subscription_data[trial_period_days]")).toBe(false);
  });

  it("refuses an account that is already entitled, whatever sold it", async () => {
    const { api } = await signedInProUser();
    const res = await api("POST", "/billing/stripe/checkout", { plan: "monthly" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already subscribed" });
  });

  it("refuses an unknown plan", async () => {
    const { api } = await signedInUser();
    expect((await api("POST", "/billing/stripe/checkout", { plan: "lifetime" })).status).toBe(400);
  });
});

describe("POST /api/billing/stripe (the return leg)", () => {
  it("records the subscription from a fresh read and answers Pro", async () => {
    const { api, id } = await signedInUser(DEV_ORIGIN);
    await setCustomer(id);
    const sub = subId(id);
    const res = await api("POST", "/billing/stripe", {
      checkout_session_id: checkoutId({ client_reference_id: String(id), customer: `cus_test_${id}`, subscription: sub }),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entitlement).toMatchObject({ tier: "pro", source: "stripe", auto_renew: true });
    const row = await stripeRow(sub);
    expect(row).toMatchObject({ user_id: id, status: "active", product_id: TEST_STRIPE_PRICE_MONTHLY, environment: "test", signed_date: null });
    expect(await entitledUntil(id)).toBe(row.expires_at + ENTITLEMENT_SLACK_MS);
  });

  it("is a 409 for another user's checkout session and leaves their row alone", async () => {
    const owner = await signedInUser(DEV_ORIGIN);
    const sub = subId(owner.id);
    const session = checkoutId({ client_reference_id: String(owner.id), customer: `cus_test_${owner.id}`, subscription: sub });
    expect((await owner.api("POST", "/billing/stripe", { checkout_session_id: session })).status).toBe(200);

    const thief = await signedInUser(DEV_ORIGIN);
    const res = await thief.api("POST", "/billing/stripe", { checkout_session_id: session });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "purchase belongs to another account" });
    expect((await stripeRow(sub)).user_id).toBe(owner.id);
    expect(await entitledUntil(thief.id)).toBeNull();
  });

  it("is a 409 when the subscription itself names another account", async () => {
    const { api, id } = await signedInUser(DEV_ORIGIN);
    const res = await api("POST", "/billing/stripe", {
      checkout_session_id: checkoutId({ client_reference_id: String(id), customer: `cus_test_${id}`, subscription: subId(id, { metadata: { user_id: "999999" } }) }),
    });
    expect(res.status).toBe(409);
  });

  it("refuses a test-mode checkout off a dev host", async () => {
    const { api, id } = await signedInUser();
    const res = await api("POST", "/billing/stripe", {
      checkout_session_id: checkoutId({ client_reference_id: String(id), customer: `cus_test_${id}`, subscription: subId(id) }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "test-mode checkout" });
  });

  it("refuses an unfinished or unknown session and a malformed id", async () => {
    const { api, id } = await signedInUser(DEV_ORIGIN);
    const unfinished = await api("POST", "/billing/stripe", {
      checkout_session_id: checkoutId({ client_reference_id: String(id), customer: `cus_test_${id}`, subscription: null, status: "open" }),
    });
    expect(unfinished.status).toBe(400);
    expect((await api("POST", "/billing/stripe", { checkout_session_id: "cs_missing" })).status).toBe(400);
    expect((await api("POST", "/billing/stripe", { checkout_session_id: "../v1/customers" })).status).toBe(400);
  });
});

describe("POST /api/billing/stripe/portal", () => {
  it("opens the portal for the account's customer, returning to Settings", async () => {
    const { api, id } = await signedInUser();
    await setCustomer(id);
    const res = await api("POST", "/billing/stripe/portal");
    expect(res.status).toBe(200);
    const form = stripeEchoedForm(res.body.url);
    expect(form.get("customer")).toBe(`cus_test_${id}`);
    expect(form.get("return_url")).toBe("https://example.com/#/settings");
  });

  it("is a 404 for an account with no customer", async () => {
    const { api } = await signedInUser();
    expect((await api("POST", "/billing/stripe/portal")).status).toBe(404);
  });
});

describe("POST /billing/stripe/webhook", () => {
  it("rejects a bad signature, a stale timestamp and a tampered body without touching D1", async () => {
    const { id } = await signedInUser();
    await setCustomer(id);
    const sub = subId(id);
    const event = { type: "customer.subscription.created", data: { object: { id: sub, object: "subscription" } } };
    expect((await webhook(event, { secret: "whsec_wrong" })).status).toBe(401);
    expect((await webhook(event, { t: sec(Date.now() - 10 * 60_000) })).status).toBe(401);
    expect((await webhook(event, { tamper: (b) => b.replace("created", "updated") })).status).toBe(401);
    const unsigned = await SELF.fetch(`${DEV_ORIGIN}/billing/stripe/webhook`, { method: "POST", body: JSON.stringify(event) });
    expect(unsigned.status).toBe(401);
    expect(await stripeRow(sub)).toBeNull();
  });

  it("inserts a subscription with no row when our customer and its metadata agree", async () => {
    const { id } = await signedInUser();
    await setCustomer(id);
    const sub = subId(id);
    // The embedded object says canceled; the fresh read says active — the read wins.
    const res = await webhook({ type: "checkout.session.completed", data: { object: { id: "cs_x", subscription: sub, status: "canceled" } } });
    expect(res).toEqual({ status: 200, body: { ok: true, handled: true } });
    expect(await stripeRow(sub)).toMatchObject({ user_id: id, status: "active" });
    expect(await entitledUntil(id)).not.toBeNull();
  });

  it("acks and ignores a subscription whose customer and metadata disagree", async () => {
    const { id } = await signedInUser();
    await setCustomer(id);
    const other = await signedInUser();
    const sub = subId(id, { metadata: { user_id: String(other.id) } });
    const res = await webhook({ type: "customer.subscription.created", data: { object: { id: sub } } });
    expect(res.body).toEqual({ ok: true, handled: false });
    expect(await stripeRow(sub)).toBeNull();
    // …and one whose customer is nobody's.
    const orphan = subId(id, { customer: "cus_nobody" });
    expect((await webhook({ type: "customer.subscription.created", data: { object: { id: orphan } } })).body.handled).toBe(false);
  });

  it("re-reads a known row on every event: a cancel at period end, a lapse, a plan switch", async () => {
    const { id } = await signedInUser();
    await setCustomer(id);
    // The mock answers from the id, so one row's changing state is three ids
    // rewritten in turn onto the same row.
    const base = subId(id);
    await insertStripeRow(id, base);
    const update = async (overrides: Record<string, unknown>) => {
      const next = subId(id, overrides);
      await env.DB.prepare("UPDATE subscriptions SET external_id = ? WHERE external_id = ?").bind(next, current).run();
      current = next;
      return webhook({ type: "customer.subscription.updated", data: { object: { id: next } } });
    };
    let current = base;

    expect((await update({ cancel_at_period_end: true })).body.handled).toBe(true);
    expect(await stripeRow(current)).toMatchObject({ status: "active", auto_renew: 0 });

    await update({ items: { data: [{ price: { id: TEST_STRIPE_PRICE_YEARLY } }] } });
    expect((await stripeRow(current)).product_id).toBe(TEST_STRIPE_PRICE_YEARLY);

    const start = Date.now() - DAY;
    await update({ status: "past_due", current_period_start: sec(start), current_period_end: sec(start + 365 * DAY) });
    const grace = await stripeRow(current);
    expect(grace.status).toBe("grace");
    expect(grace.expires_at).toBeLessThanOrEqual(start + STRIPE_GRACE_MS);

    const ended = Date.now() - 1000;
    await update({ status: "canceled", ended_at: sec(ended) });
    expect(await stripeRow(current)).toMatchObject({ status: "expired", auto_renew: 0 });
    expect(await entitledUntil(id)).toBeNull();
  });

  it("revokes on a full refund of the latest invoice, reached through the charge", async () => {
    const { id } = await signedInUser();
    await setCustomer(id);
    const sub = subId(id, { latest_invoice: { id: "in_x", charge: { id: "ch_x", amount: 199, amount_refunded: 199, refunded: true } } });
    await insertStripeRow(id, sub);
    expect(await entitledUntil(id)).not.toBeNull();
    const charge = stripeMockId("ch", { amount: 199, amount_refunded: 199, refunded: true, invoice: { id: "in_x", subscription: sub } });
    const res = await webhook({ type: "charge.refunded", data: { object: { id: charge, object: "charge" } } });
    expect(res.body).toEqual({ ok: true, handled: true });
    expect(await stripeRow(sub)).toMatchObject({ status: "revoked", expires_at: null });
    expect(await entitledUntil(id)).toBeNull();
  });

  it("finds the subscription from an invoice event in either API version's shape", async () => {
    const { id } = await signedInUser();
    await setCustomer(id);
    const older = subId(id);
    const newer = subId(id);
    await insertStripeRow(id, older, "pending", Date.now());
    await insertStripeRow(id, newer, "pending", Date.now());
    await webhook({ type: "invoice.paid", data: { object: { id: "in_a", subscription: older } } });
    await webhook({ type: "invoice.paid", data: { object: { id: "in_b", parent: { subscription_details: { subscription: newer } } } } });
    expect((await stripeRow(older)).status).toBe("active");
    expect((await stripeRow(newer)).status).toBe("active");
  });

  it("acks events it doesn't handle", async () => {
    const res = await webhook({ type: "customer.created", data: { object: { id: "cus_x" } } });
    expect(res).toEqual({ status: 200, body: { ok: true, handled: false } });
  });
});

describe("the daily re-verification", () => {
  it("re-reads a stripe row in the window", async () => {
    const { id } = await signedInUser();
    const renewed = Date.now() + 30 * DAY;
    const sub = subId(id, { current_period_end: sec(renewed) });
    await insertStripeRow(id, sub, "active", Date.now() + DAY);
    const report = await reverifyExpiring(env, Date.now());
    expect(report.updated).toBeGreaterThanOrEqual(1);
    expect((await stripeRow(sub)).expires_at).toBe(sec(renewed) * 1000);
  });
});

describe("the entitlement source on /me (NS-49 rule 4)", () => {
  it("is stripe over the web's cookie and withheld over a native bearer token, tier and expiry intact", async () => {
    const { token, id } = await signedInUser();
    const expires = Date.now() + 20 * DAY;
    await insertStripeRow(id, `sub_mask_${id}`, "active", expires);

    const web = await apiClient(token)("GET", "/me");
    expect(web.body.entitlement).toEqual({ tier: "pro", source: "stripe", expires_at: expires, auto_renew: true });

    const res = await SELF.fetch("https://example.com/api/me", { headers: { Authorization: `Bearer ${token}` } });
    const native = ((await res.json()) as any).entitlement;
    expect(native).toEqual({ tier: "pro", source: null, expires_at: expires, auto_renew: true });
  });

  it("withholds it from a billing route's answer to a phone too", async () => {
    const { id } = await signedInUser(DEV_ORIGIN);
    await insertStripeRow(id, `sub_mask_billing_${id}`, "active", Date.now() + 20 * DAY);
    const token = await sessionFor(id);
    const res = await SELF.fetch(`${DEV_ORIGIN}/api/billing/google/legacy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-TE-Client": "android/100" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).entitlement.source).toBeNull();
  });
});

describe("Stripe unconfigured (ships dark)", () => {
  // The whole Worker with the key unset, the way production runs until phase B.
  async function darkFetch(path: string, init: RequestInit = {}) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://example.com${path}`, init), { ...env, STRIPE_SECRET_KEY: undefined }, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: (await res.json()) as any };
  }

  it("answers plans { enabled: false } and every other Stripe route 503", async () => {
    const { token } = await signedInUser();
    const headers = { Cookie: `session=${token}`, "Content-Type": "application/json" };
    expect(await darkFetch("/api/billing/stripe/plans", { headers })).toEqual({ status: 200, body: { enabled: false } });
    for (const path of ["/api/billing/stripe/checkout", "/api/billing/stripe", "/api/billing/stripe/portal", "/billing/stripe/webhook"]) {
      const res = await darkFetch(path, { method: "POST", headers, body: JSON.stringify({ plan: "monthly" }) });
      expect(res, path).toEqual({ status: 503, body: { error: "billing not configured" } });
    }
  });
});

describe("no write route changed", () => {
  it("still saves a lapsed web subscriber's event", async () => {
    const { api, id } = await signedInUser();
    await insertStripeRow(id, `sub_lapsed_write_${id}`, "expired", Date.now() - 10 * DAY);
    await createEvent(api);
  });
});
