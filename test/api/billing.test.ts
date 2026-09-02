import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  type Chain,
  TEST_PLAY_SERVICE_ACCOUNT_EMAIL,
  appleMockId,
  b64urlDecodeJson,
  b64urlJson,
  googleMockToken,
  signFixtureJws,
  signRS256Jwt,
} from "../billing-helpers";
import { ENTITLEMENT_SLACK_MS, LEGACY_ENTITLED_UNTIL_MS } from "../../src/lib/entitlement";
import { reverifyExpiring } from "../../src/cron";
import { apiClient, createEvent, createUser, sessionFor, signedInUser } from "./helpers";

// NS-32 phase A: the server owns the entitlement. Store payloads are signed
// with the synthetic chain from test/fixtures/billing (the Worker trusts its
// root under DEV_MODE via APPLE_IAP_TEST_ROOT_PEM); the App Store Server API
// and Play Developer API are the mocks in vitest.workers.config.mts.

const chain: Chain = JSON.parse(env.TEST_APPLE_CHAIN);
const BUNDLE = "app.trackevolution";
const DAY = 86_400_000;
const SIGNED = 1_800_000_000_000; // inside the fixture certificates' validity

let txSeq = 0;
const nextId = () => `${Date.now()}-${++txSeq}`;

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    bundleId: BUNDLE,
    originalTransactionId: nextId(),
    transactionId: nextId(),
    productId: "app.trackevolution.pro.monthly",
    type: "Auto-Renewable Subscription",
    environment: "Sandbox",
    purchaseDate: Date.now() - 1000,
    expiresDate: Date.now() + 30 * DAY,
    signedDate: SIGNED,
    ...overrides,
  };
}
const renewal = (originalTransactionId: string, overrides: Record<string, unknown> = {}) => ({
  originalTransactionId,
  autoRenewStatus: 1,
  signedDate: SIGNED,
  ...overrides,
});

async function entitledUntil(userId: number) {
  const row = await env.DB.prepare("SELECT entitled_until FROM users WHERE id = ?").bind(userId).first<{ entitled_until: number | null }>();
  return row!.entitled_until;
}
async function subscriptionRow(provider: string, externalId: string) {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE provider = ? AND external_id = ?").bind(provider, externalId).first<any>();
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("GET /api/me entitlement", () => {
  it("is free with no source for a new user", async () => {
    const { api } = await signedInUser();
    const res = await api("GET", "/me");
    expect(res.body.entitlement).toEqual({ tier: "free", source: null, expires_at: null, auto_renew: null });
  });
});

describe("POST /api/billing/apple", () => {
  it("verifies the JWS, records the row and returns Pro with three days of slack", async () => {
    const { api, id } = await signedInUser();
    const tx = transaction();
    const res = await api("POST", "/billing/apple", {
      jws: await signFixtureJws(tx, chain),
      renewal_jws: await signFixtureJws(renewal(tx.originalTransactionId), chain),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.entitlement).toEqual({ tier: "pro", source: "apple", expires_at: tx.expiresDate, auto_renew: true });
    expect(await entitledUntil(id)).toBe(tx.expiresDate + ENTITLEMENT_SLACK_MS);
    const row = await subscriptionRow("apple", tx.originalTransactionId);
    expect(row).toMatchObject({ user_id: id, status: "active", product_id: tx.productId, environment: "sandbox", auto_renew: 1 });
    expect((await api("GET", "/me")).body.entitlement.tier).toBe("pro");
  });

  it("rejects a wrong bundle id, a chain to another root, and a tampered payload", async () => {
    const { api } = await signedInUser();
    const wrongBundle = await signFixtureJws(transaction({ bundleId: "com.other.app" }), chain);
    expect((await api("POST", "/billing/apple", { jws: wrongBundle })).status).toBe(400);

    const good = await signFixtureJws(transaction(), chain);
    const [h, , s] = good.split(".");
    const tampered = `${h}.${b64urlJson(transaction({ expiresDate: Date.now() + 365 * DAY }))}.${s}`;
    expect((await api("POST", "/billing/apple", { jws: tampered })).status).toBe(400);

    expect((await api("POST", "/billing/apple", { jws: "nope" })).status).toBe(400);
    expect((await api("POST", "/billing/apple", {})).status).toBe(400);
  });

  it("the same purchase from a second device updates, from a second account is a 409", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const tx = transaction();
    expect((await a.api("POST", "/billing/apple", { jws: await signFixtureJws(tx, chain) })).status).toBe(200);
    // Same original transaction, later renewal: same row, new expiry.
    const renewed = { ...tx, transactionId: nextId(), expiresDate: tx.expiresDate + 30 * DAY };
    expect((await a.api("POST", "/billing/apple", { jws: await signFixtureJws(renewed, chain) })).status).toBe(200);
    expect((await subscriptionRow("apple", tx.originalTransactionId)).expires_at).toBe(renewed.expiresDate);

    const res = await b.api("POST", "/billing/apple", { jws: await signFixtureJws(renewed, chain) });
    expect(res.status).toBe(409);
    expect((await subscriptionRow("apple", tx.originalTransactionId)).user_id).toBe(a.id);
    expect(await entitledUntil(b.id)).toBeNull();
    expect((await b.api("GET", "/me")).body.entitlement.tier).toBe("free");
  });

  it("honours the store's grace period as entitled, and a revocation as not", async () => {
    const { api, id } = await signedInUser();
    const tx = transaction({ expiresDate: Date.now() - DAY });
    const graceEnd = Date.now() + 2 * DAY;
    const res = await api("POST", "/billing/apple", {
      jws: await signFixtureJws(tx, chain),
      renewal_jws: await signFixtureJws(renewal(tx.originalTransactionId, { gracePeriodExpiresDate: graceEnd }), chain),
    });
    expect(res.body.entitlement).toMatchObject({ tier: "pro", expires_at: graceEnd });
    expect((await subscriptionRow("apple", tx.originalTransactionId)).status).toBe("grace");

    const revoked = await api("POST", "/billing/apple", {
      jws: await signFixtureJws({ ...tx, revocationDate: Date.now() }, chain),
    });
    expect(revoked.body.entitlement.tier).toBe("free");
    expect(await entitledUntil(id)).toBeNull();
  });

  it("an expired transaction with no renewal info is a lapse", async () => {
    const { api } = await signedInUser();
    const res = await api("POST", "/billing/apple", { jws: await signFixtureJws(transaction({ expiresDate: Date.now() - 5 * DAY }), chain) });
    expect(res.status).toBe(200);
    expect(res.body.entitlement).toMatchObject({ tier: "free", source: "apple", auto_renew: null });
  });
});

describe("POST /api/billing/apple/legacy", () => {
  const appTransaction = (overrides: Record<string, unknown> = {}) => ({
    bundleId: BUNDLE,
    appTransactionId: nextId(),
    originalApplicationVersion: "12",
    applicationVersion: "40",
    originalPurchaseDate: Date.UTC(2025, 2, 1),
    receiptType: "Production",
    signedDate: SIGNED,
    ...overrides,
  });

  it("grants Pro for life from a verified AppTransaction", async () => {
    const { api, id } = await signedInUser();
    const res = await api("POST", "/billing/apple/legacy", { jws: await signFixtureJws(appTransaction(), chain) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.entitlement).toEqual({ tier: "pro", source: "legacy", expires_at: null, auto_renew: null });
    expect(await entitledUntil(id)).toBe(LEGACY_ENTITLED_UNTIL_MS);
  });

  it("is idempotent, and one app transaction cannot grant two accounts", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    const app = appTransaction();
    expect((await a.api("POST", "/billing/apple/legacy", { jws: await signFixtureJws(app, chain) })).status).toBe(200);
    expect((await a.api("POST", "/billing/apple/legacy", { jws: await signFixtureJws(app, chain) })).status).toBe(200);
    expect((await b.api("POST", "/billing/apple/legacy", { jws: await signFixtureJws(app, chain) })).status).toBe(409);
    expect(await entitledUntil(b.id)).toBeNull();
  });

  it("a legacy user who later subscribes has two rows and stays on the sentinel", async () => {
    const { api, id } = await signedInUser();
    await api("POST", "/billing/apple/legacy", { jws: await signFixtureJws(appTransaction(), chain) });
    await api("POST", "/billing/apple", { jws: await signFixtureJws(transaction(), chain) });
    expect(await entitledUntil(id)).toBe(LEGACY_ENTITLED_UNTIL_MS);
    expect((await api("GET", "/me")).body.entitlement.source).toBe("legacy");
  });

  it("rejects a JWS that is not an app transaction, or for another app", async () => {
    const { api } = await signedInUser();
    expect((await api("POST", "/billing/apple/legacy", { jws: await signFixtureJws(transaction(), chain) })).status).toBe(400);
    expect((await api("POST", "/billing/apple/legacy", { jws: await signFixtureJws(appTransaction({ bundleId: "x.y" }), chain) })).status).toBe(400);
  });
});

describe("POST /api/billing/google", () => {
  const purchase = (overrides: Record<string, unknown> = {}, expiryMs = Date.now() + 30 * DAY) => ({
    kind: "androidpublisher#subscriptionPurchaseV2",
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    lineItems: [{ productId: "pro", expiryTime: new Date(expiryMs).toISOString(), autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId: "monthly" } }],
    testPurchase: {},
    ...overrides,
  });

  it("reads the purchase from Play and records it", async () => {
    const { api, id } = await signedInUser();
    const expiry = Date.now() + 30 * DAY;
    // A purchase token is opaque; ours carries the mocked API answer.
    const token = googleMockToken({ ...purchase({}, expiry), nonce: nextId() });
    const res = await api("POST", "/billing/google", { purchase_token: token, product_id: "pro" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.entitlement).toEqual({ tier: "pro", source: "google", expires_at: expiry, auto_renew: true });
    expect(await subscriptionRow("google", token)).toMatchObject({ user_id: id, status: "active", product_id: "pro", environment: "sandbox" });
    expect(await entitledUntil(id)).toBe(expiry + ENTITLEMENT_SLACK_MS);
  });

  it("an upgrade retires the token it replaces", async () => {
    const { api, id } = await signedInUser();
    const old = googleMockToken({ ...purchase(), nonce: nextId() });
    await api("POST", "/billing/google", { purchase_token: old });
    const yearly = googleMockToken({ ...purchase({ linkedPurchaseToken: old }, Date.now() + 365 * DAY), nonce: nextId() });
    expect((await api("POST", "/billing/google", { purchase_token: yearly })).status).toBe(200);
    expect((await subscriptionRow("google", old)).status).toBe("expired");
    expect(await entitledUntil(id)).toBe(Date.parse(b64urlDecodeJson(yearly).lineItems[0].expiryTime) + ENTITLEMENT_SLACK_MS);
  });

  it("a token Play does not know is a 400; a second account is a 409; a missing token is a 400", async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    expect((await a.api("POST", "/billing/google", { purchase_token: "google-404" })).status).toBe(400);
    const token = googleMockToken({ ...purchase(), nonce: nextId() });
    expect((await a.api("POST", "/billing/google", { purchase_token: token })).status).toBe(200);
    expect((await b.api("POST", "/billing/google", { purchase_token: token })).status).toBe(409);
    expect((await a.api("POST", "/billing/google", {})).status).toBe(400);
  });
});

describe("POST /api/billing/google/legacy", () => {
  it("needs the X-TE-Client header, then grants legacy once per account", async () => {
    const { token, id } = await signedInUser();
    const noHeader = await post("/api/billing/google/legacy", {}, { Cookie: `session=${token}` });
    expect(noHeader.status).toBe(400);
    const claim = () => post("/api/billing/google/legacy", {}, { Cookie: `session=${token}`, "X-TE-Client": "android/57" });
    const res = await claim();
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).entitlement).toEqual({ tier: "pro", source: "legacy", expires_at: null, auto_renew: null });
    expect((await claim()).status).toBe(200);
    expect(await entitledUntil(id)).toBe(LEGACY_ENTITLED_UNTIL_MS);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?").bind(id).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });
});

describe("billing routes need a session", () => {
  it("401 without one", async () => {
    const anon = apiClient();
    for (const path of ["/billing/apple", "/billing/apple/legacy", "/billing/google", "/billing/google/legacy"]) {
      expect((await anon("POST", path, {})).status, path).toBe(401);
    }
  });
});

describe("POST /billing/apple/notifications", () => {
  async function notification(type: string, tx: Record<string, unknown>, renewalInfo: Record<string, unknown> | null) {
    const signedPayload = await signFixtureJws(
      {
        notificationType: type,
        notificationUUID: nextId(),
        signedDate: SIGNED,
        data: {
          bundleId: BUNDLE,
          environment: "Sandbox",
          signedTransactionInfo: await signFixtureJws(tx, chain),
          signedRenewalInfo: renewalInfo ? await signFixtureJws(renewalInfo, chain) : undefined,
        },
      },
      chain
    );
    return post("/billing/apple/notifications", { signedPayload });
  }

  it("rejects an unsigned or foreign-signed payload with 401 before touching the database", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>();
    expect((await post("/billing/apple/notifications", { signedPayload: "a.b.c" })).status).toBe(401);
    expect((await post("/billing/apple/notifications", {})).status).toBe(400);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it("applies a renewal, a cancellation and an expiry to the owning user's row", async () => {
    const { api, id } = await signedInUser();
    const tx = transaction();
    await api("POST", "/billing/apple", { jws: await signFixtureJws(tx, chain) });

    const renewedTx = { ...tx, transactionId: nextId(), expiresDate: tx.expiresDate + 30 * DAY };
    expect((await notification("DID_RENEW", renewedTx, renewal(tx.originalTransactionId))).status).toBe(200);
    expect((await subscriptionRow("apple", tx.originalTransactionId)).expires_at).toBe(renewedTx.expiresDate);
    expect(await entitledUntil(id)).toBe(renewedTx.expiresDate + ENTITLEMENT_SLACK_MS);

    await notification("DID_CHANGE_RENEWAL_STATUS", renewedTx, renewal(tx.originalTransactionId, { autoRenewStatus: 0 }));
    expect((await api("GET", "/me")).body.entitlement).toMatchObject({ tier: "pro", auto_renew: false });

    await notification("EXPIRED", { ...renewedTx, expiresDate: Date.now() - 1000 }, renewal(tx.originalTransactionId, { autoRenewStatus: 0 }));
    expect((await subscriptionRow("apple", tx.originalTransactionId)).status).toBe("expired");
    expect(await entitledUntil(id)).toBeNull();
    expect((await api("GET", "/me")).body.entitlement.tier).toBe("free");
  });

  it("acks a notification for a transaction nobody has posted yet, and unknown types", async () => {
    const res = await notification("SUBSCRIBED", transaction(), null);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).handled).toBe(false);
    const test = await post("/billing/apple/notifications", {
      signedPayload: await signFixtureJws({ notificationType: "TEST", signedDate: SIGNED }, chain),
    });
    expect(test.status).toBe(200);
  });
});

describe("POST /billing/google/rtdn", () => {
  const AUD = "https://example.com/billing/google/rtdn";
  const oidc = (overrides: Record<string, unknown> = {}) =>
    signRS256Jwt(
      { kid: "test-kid" },
      {
        iss: "https://accounts.google.com",
        aud: AUD,
        azp: "1234",
        email: TEST_PLAY_SERVICE_ACCOUNT_EMAIL,
        email_verified: true,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        ...overrides,
      },
      env.TEST_GOOGLE_RSA_PRIVATE_KEY_PEM
    );
  const envelope = (note: unknown) => ({
    message: { data: btoa(JSON.stringify(note)), messageId: "1", publishTime: new Date().toISOString() },
    subscription: "projects/x/subscriptions/y",
  });
  const rtdn = (bearer: string | null, body: unknown) =>
    post("/billing/google/rtdn", body, bearer ? { Authorization: `Bearer ${bearer}` } : {});

  it("rejects a missing, mis-audienced or wrong-account token with 401", async () => {
    expect((await rtdn(null, envelope({}))).status).toBe(401);
    expect((await rtdn(await oidc({ aud: "https://elsewhere.example/hook" }), envelope({}))).status).toBe(401);
    expect((await rtdn(await oidc({ email: "someone@else.example" }), envelope({}))).status).toBe(401);
    expect((await rtdn(await oidc({ exp: Math.floor(Date.now() / 1000) - 10 }), envelope({}))).status).toBe(401);
    // A valid token signed by a key Google doesn't publish.
    const [h, p] = (await oidc()).split(".");
    expect((await rtdn(`${h}.${p}.AAAA`, envelope({}))).status).toBe(401);
  });

  it("re-reads the purchase from Play and applies it", async () => {
    const { api, id } = await signedInUser();
    // The mock echoes whatever the token encodes, so a state change is a new
    // token; here the row's token itself encodes "expired" — the way a cached
    // active row learns it lapsed.
    const expiredBody = {
      subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
      lineItems: [{ productId: "pro", expiryTime: new Date(Date.now() - DAY).toISOString(), autoRenewingPlan: { autoRenewEnabled: false } }],
      nonce: nextId(),
    };
    const token = googleMockToken(expiredBody);
    // Seed the row as if it were active when the client posted it.
    await env.DB.prepare(
      "INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at) VALUES (?, 'google', 'pro', ?, 'active', ?, 1, 'production', ?, ?)"
    )
      .bind(id, token, Date.now() + DAY, Date.now(), Date.now())
      .run();
    await env.DB.prepare("UPDATE users SET entitled_until = ? WHERE id = ?").bind(Date.now() + DAY, id).run();
    expect((await api("GET", "/me")).body.entitlement.tier).toBe("pro");

    const res = await rtdn(await oidc(), envelope({ version: "1.0", packageName: "app.trackevolution", eventTimeMillis: String(Date.now()), subscriptionNotification: { version: "1.0", notificationType: 13, purchaseToken: token, subscriptionId: "pro" } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).handled).toBe(true);
    expect((await subscriptionRow("google", token)).status).toBe("expired");
    expect((await api("GET", "/me")).body.entitlement).toMatchObject({ tier: "free", source: "google", auto_renew: false });
  });

  it("acks test notifications and unknown tokens", async () => {
    expect((await rtdn(await oidc(), envelope({ testNotification: { version: "1.0" } }))).status).toBe(200);
    const unknown = await rtdn(await oidc(), envelope({ subscriptionNotification: { purchaseToken: googleMockToken({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", nonce: nextId() }), notificationType: 4 } }));
    expect(unknown.status).toBe(200);
    expect(((await unknown.json()) as any).handled).toBe(false);
    expect((await rtdn(await oidc(), { not: "pubsub" })).status).toBe(400);
  });
});

describe("the daily re-verification (cron)", () => {
  it("is a no-op with nothing in the window", async () => {
    expect(await reverifyExpiring(env, Date.UTC(1990, 0, 1))).toEqual({ checked: 0, updated: 0, skipped: 0, failed: 0 });
  });

  it("re-reads rows expiring soon or recently from their store and updates them", async () => {
    const apple = await signedInUser();
    const google = await signedInUser();
    const now = Date.now();
    // Apple: the row thinks it expires in an hour; the store says it renewed.
    const renewedTo = now + 31 * DAY;
    const appleId = appleMockId(nextId(), { status: 1, expiresDate: renewedTo, autoRenewStatus: 1 });
    await env.DB.prepare(
      "INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at) VALUES (?, 'apple', 'p', ?, 'active', ?, 1, 'sandbox', ?, ?)"
    ).bind(apple.id, appleId, now + 3600_000, now, now).run();
    // Google: expired two days ago by the row; Play agrees and says so.
    const googleToken = googleMockToken({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [{ productId: "pro", expiryTime: new Date(now - 2 * DAY).toISOString() }], nonce: nextId() });
    await env.DB.prepare(
      "INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at) VALUES (?, 'google', 'pro', ?, 'active', ?, 1, 'production', ?, ?)"
    ).bind(google.id, googleToken, now - 2 * DAY, now, now).run();
    await env.DB.prepare("UPDATE users SET entitled_until = ? WHERE id IN (?, ?)").bind(now + ENTITLEMENT_SLACK_MS, apple.id, google.id).run();
    // Out of the window: a row a year out, untouched.
    const far = await signedInUser();
    await env.DB.prepare(
      "INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at) VALUES (?, 'apple', 'p', 'apple-404-' || ?, 'active', ?, 1, 'sandbox', ?, ?)"
    ).bind(far.id, nextId(), now + 365 * DAY, now, now).run();

    const report = await reverifyExpiring(env, now);
    expect(report).toMatchObject({ checked: 2, updated: 2, failed: 0 });
    expect((await subscriptionRow("apple", appleId)).expires_at).toBe(renewedTo);
    expect(await entitledUntil(apple.id)).toBe(renewedTo + ENTITLEMENT_SLACK_MS);
    expect((await subscriptionRow("google", googleToken)).status).toBe("expired");
    expect(await entitledUntil(google.id)).toBeNull();
  });

  it("skips a row the store no longer knows rather than failing", async () => {
    const { id } = await signedInUser();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at) VALUES (?, 'apple', 'p', 'apple-404-' || ?, 'active', ?, 1, 'production', ?, ?)"
    ).bind(id, nextId(), now + DAY, now, now).run();
    const report = await reverifyExpiring(env, now);
    expect(report.skipped).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBe(0);
  });
});

describe("no write route checks entitlement (NS-32 rule 5)", () => {
  it("a lapsed user's session save with channels is a 201, and every logbook write stays open", async () => {
    const user = await createUser();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, created_at, updated_at) VALUES (?, 'apple', 'p', ?, 'expired', ?, 0, 'production', ?, ?)"
    ).bind(user.id, nextId(), now - 30 * DAY, now, now).run();
    const api = apiClient(await sessionFor(user.id));
    expect((await api("GET", "/me")).body.entitlement.tier).toBe("free");

    const eventId = await createEvent(api);
    const N = 12;
    const session = await api("POST", `/events/${eventId}/sessions`, {
      label: "Recorded after the lapse",
      laps: [95_000, 94_200],
      trace: Array.from({ length: N }, (_, i) => [i * 10, i * 5, 30 + i]),
      channels: { dStepM: 20, laps: [{ n: 1, timeMs: 95_000, speed: Array.from({ length: N }, (_, i) => 30 + i) }] },
    });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    expect((await api("POST", `/sessions/${session.body.id}/laps`, { laps: [93_900] })).status).toBe(201);
    expect((await api("PUT", `/sessions/${session.body.id}`, { label: "renamed" })).status).toBe(200);
    expect((await api("PUT", `/events/${eventId}`, { club: "NASA" })).status).toBe(200);
    expect((await api("POST", "/tracks", { name: "Lapsed Ring" })).status).toBe(201);
    // And the channels are still there for when they resubscribe.
    const detail = await api("GET", `/events/${eventId}`);
    expect(detail.body.sessions[0].channels.laps).toHaveLength(1);
  });
});
