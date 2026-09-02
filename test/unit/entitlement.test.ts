import { describe, expect, it } from "vitest";
import {
  ENTITLEMENT_SLACK_MS,
  LEGACY_ENTITLED_UNTIL_MS,
  entitledUntilContribution,
  entitlementResponse,
  isEntitled,
  legacyClaimOpen,
  parseClientHeader,
  stripProFields,
} from "../../src/lib/entitlement";
import { appleSubscriptionState } from "../../src/lib/billing/apple";
import { googleSubscriptionState } from "../../src/lib/billing/google";
import { compareVersions } from "../../src/routes/billing";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

describe("entitledUntilContribution / isEntitled", () => {
  it("adds three days of slack to an active or grace expiry", () => {
    expect(entitledUntilContribution({ provider: "apple", status: "active", expires_at: NOW, auto_renew: 1 })).toBe(NOW + ENTITLEMENT_SLACK_MS);
    expect(entitledUntilContribution({ provider: "google", status: "grace", expires_at: NOW, auto_renew: 1 })).toBe(NOW + ENTITLEMENT_SLACK_MS);
  });
  it("gives legacy the sentinel and everything else nothing", () => {
    expect(entitledUntilContribution({ provider: "legacy", status: "legacy", expires_at: null, auto_renew: null })).toBe(LEGACY_ENTITLED_UNTIL_MS);
    for (const status of ["expired", "revoked", "billing_retry", "paused", "pending"]) {
      expect(entitledUntilContribution({ provider: "apple", status, expires_at: NOW + DAY, auto_renew: 1 }), status).toBeNull();
    }
  });
  it("isEntitled is a strict future comparison", () => {
    expect(isEntitled(null, NOW)).toBe(false);
    expect(isEntitled(NOW, NOW)).toBe(false);
    expect(isEntitled(NOW + 1, NOW)).toBe(true);
  });
});

describe("entitlementResponse", () => {
  it("is free with nothing for a user with no rows", () => {
    expect(entitlementResponse(null, [], NOW)).toEqual({ tier: "free", source: null, expires_at: null, auto_renew: null });
  });
  it("reports an active store subscription", () => {
    expect(
      entitlementResponse(NOW + DAY + ENTITLEMENT_SLACK_MS, [{ provider: "apple", status: "active", expires_at: NOW + DAY, auto_renew: 1 }], NOW)
    ).toEqual({ tier: "pro", source: "apple", expires_at: NOW + DAY, auto_renew: true });
  });
  it("legacy has no expiry and beats a store row", () => {
    const rows = [
      { provider: "google" as const, status: "active", expires_at: NOW + DAY, auto_renew: 0 },
      { provider: "legacy" as const, status: "legacy", expires_at: null, auto_renew: null },
    ];
    expect(entitlementResponse(LEGACY_ENTITLED_UNTIL_MS, rows, NOW)).toEqual({ tier: "pro", source: "legacy", expires_at: null, auto_renew: null });
  });
  it("a lapsed user still learns which store to manage", () => {
    const rows = [
      { provider: "google" as const, status: "expired", expires_at: NOW - 30 * DAY, auto_renew: 0 },
      { provider: "apple" as const, status: "expired", expires_at: NOW - 5 * DAY, auto_renew: 0 },
    ];
    expect(entitlementResponse(null, rows, NOW)).toEqual({ tier: "free", source: "apple", expires_at: NOW - 5 * DAY, auto_renew: false });
  });
  it("tier follows entitled_until, not the rows — slack keeps a just-expired row Pro", () => {
    const rows = [{ provider: "apple" as const, status: "active", expires_at: NOW - DAY, auto_renew: 1 }];
    expect(entitlementResponse(NOW - DAY + ENTITLEMENT_SLACK_MS, rows, NOW).tier).toBe("pro");
    expect(entitlementResponse(NOW - 4 * DAY + ENTITLEMENT_SLACK_MS, rows, NOW).tier).toBe("free");
  });
});

describe("stripProFields", () => {
  const session = { id: 1, trace: [[0, 0, 30]], channels: { dStepM: 20, laps: [] }, laps: [] };
  it("nulls channels and keeps trace for a free account", () => {
    expect(stripProFields(session, false)).toEqual({ ...session, channels: null });
  });
  it("is a pass-through for Pro and for a session with no channels", () => {
    expect(stripProFields(session, true)).toBe(session);
    const bare = { ...session, channels: null };
    expect(stripProFields(bare, false)).toBe(bare);
  });
});

describe("legacyClaimOpen", () => {
  it("is open when unset and until the cutoff", () => {
    expect(legacyClaimOpen(undefined, NOW)).toBe(true);
    expect(legacyClaimOpen("", NOW)).toBe(true);
    expect(legacyClaimOpen("2027-03-01", NOW)).toBe(true);
    expect(legacyClaimOpen(String(NOW + 1), NOW)).toBe(true);
  });
  it("closes at the cutoff and on a value it cannot parse", () => {
    expect(legacyClaimOpen("2026-01-01", NOW)).toBe(false);
    expect(legacyClaimOpen(String(NOW), NOW)).toBe(false);
    expect(legacyClaimOpen("soon", NOW)).toBe(false);
  });
});

describe("parseClientHeader", () => {
  it("reads android/<versionCode>", () => {
    expect(parseClientHeader("android/42")).toEqual({ platform: "android", version: 42 });
    expect(parseClientHeader(" ios/7 ")).toEqual({ platform: "ios", version: 7 });
  });
  it("rejects anything else", () => {
    for (const h of [undefined, "", "android", "android/", "android/x", "Android/1", "android/1/2"]) {
      expect(parseClientHeader(h), String(h)).toBeNull();
    }
  });
});

describe("appleSubscriptionState", () => {
  const tx = { bundleId: "app.trackevolution", originalTransactionId: "1", productId: "p", expiresDate: NOW + DAY };
  it("active while expiresDate is ahead", () => {
    expect(appleSubscriptionState(tx, { originalTransactionId: "1", autoRenewStatus: 1 }, NOW)).toEqual({ status: "active", expiresAt: NOW + DAY, autoRenew: true });
    expect(appleSubscriptionState(tx, null, NOW).autoRenew).toBeNull();
  });
  it("honours the store's grace period, then billing retry, then expired", () => {
    const past = { ...tx, expiresDate: NOW - DAY };
    expect(appleSubscriptionState(past, { originalTransactionId: "1", gracePeriodExpiresDate: NOW + 2 * DAY, autoRenewStatus: 1 }, NOW)).toEqual({ status: "grace", expiresAt: NOW + 2 * DAY, autoRenew: true });
    expect(appleSubscriptionState(past, { originalTransactionId: "1", isInBillingRetryPeriod: true, autoRenewStatus: 1 }, NOW).status).toBe("billing_retry");
    expect(appleSubscriptionState(past, { originalTransactionId: "1", autoRenewStatus: 0 }, NOW)).toEqual({ status: "expired", expiresAt: NOW - DAY, autoRenew: false });
  });
  it("a revocation wins regardless of expiry", () => {
    expect(appleSubscriptionState({ ...tx, revocationDate: NOW - 1 }, null, NOW).status).toBe("revoked");
  });
});

describe("googleSubscriptionState", () => {
  const item = (expiryMs: number, auto = true) => ({
    productId: "pro",
    expiryTime: new Date(expiryMs).toISOString(),
    autoRenewingPlan: { autoRenewEnabled: auto },
  });
  it("maps the Play states", () => {
    expect(googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", lineItems: [item(NOW + DAY)] }, NOW)).toMatchObject({ status: "active", expiresAt: NOW + DAY, autoRenew: true, productId: "pro", environment: "production" });
    expect(googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", lineItems: [item(NOW + DAY)] }, NOW).status).toBe("grace");
    expect(googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD", lineItems: [item(NOW - DAY)] }, NOW).status).toBe("billing_retry");
    expect(googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_PAUSED", lineItems: [item(NOW - DAY)] }, NOW).status).toBe("paused");
    expect(googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [item(NOW - DAY)] }, NOW).status).toBe("expired");
    expect(googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_PENDING" }, NOW)).toMatchObject({ status: "pending", expiresAt: null });
  });
  it("a cancelled subscription is paid up until expiry, with auto-renew off", () => {
    expect(googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", lineItems: [item(NOW + DAY)] }, NOW)).toMatchObject({ status: "active", autoRenew: false });
    expect(googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", lineItems: [item(NOW - DAY)] }, NOW).status).toBe("expired");
  });
  it("reads test purchases and linked tokens", () => {
    const s = googleSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", lineItems: [item(NOW + DAY)], testPurchase: {}, linkedPurchaseToken: "old" }, NOW);
    expect(s.environment).toBe("sandbox");
    expect(s.linkedPurchaseToken).toBe("old");
  });
});

describe("compareVersions", () => {
  it("compares dotted builds numerically", () => {
    expect(compareVersions("1.4.2", "2")).toBeLessThan(0);
    expect(compareVersions("10", "9.9")).toBeGreaterThan(0);
    expect(compareVersions("3.0", "3")).toBe(0);
  });
});
