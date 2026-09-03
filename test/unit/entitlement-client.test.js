import { describe, expect, it } from "vitest";
import {
  APPLE_MANAGE_URL,
  FREE_ENTITLEMENT,
  GOOGLE_MANAGE_URL,
  canCompareEvents,
  canRecord,
  canUseGarage,
  canUseSetups,
  canViewChannels,
  canViewYearInReview,
  entitlementSummary,
  isPro,
  manageUrl,
} from "../../public/js/entitlement.js";

const pro = (over = {}) => ({ tier: "pro", source: "apple", expires_at: 1_800_000_000_000, auto_renew: true, ...over });

describe("isPro and the feature predicates", () => {
  it("only a tier of pro is Pro; nothing, free and garbage are not", () => {
    expect(isPro(pro())).toBe(true);
    expect(isPro(FREE_ENTITLEMENT)).toBe(false);
    expect(isPro(null)).toBe(false);
    expect(isPro(undefined)).toBe(false);
    expect(isPro({ tier: "Pro" })).toBe(false);
  });
  it("every Pro feature follows the tier, not the clock", () => {
    // Expired by the wall clock but still `pro` — the cached answer stands offline.
    const stale = pro({ expires_at: 1 });
    const every = [canRecord, canViewChannels, canUseGarage, canUseSetups,
      canViewYearInReview, canCompareEvents];
    for (const can of every) {
      expect(can(stale)).toBe(true);
      expect(can(FREE_ENTITLEMENT)).toBe(false);
      expect(can(null)).toBe(false);
    }
  });
});

describe("manageUrl", () => {
  it("targets the store that sold the subscription", () => {
    expect(manageUrl(pro())).toBe(APPLE_MANAGE_URL);
    expect(manageUrl(pro({ source: "google" }))).toBe(GOOGLE_MANAGE_URL);
    expect(manageUrl(pro({ source: "legacy", expires_at: null, auto_renew: null }))).toBeNull();
    expect(manageUrl(FREE_ENTITLEMENT)).toBeNull();
    expect(manageUrl(null)).toBeNull();
  });
  it("a lapsed subscriber still gets their store", () => {
    expect(manageUrl({ tier: "free", source: "google", expires_at: 1, auto_renew: false })).toBe(GOOGLE_MANAGE_URL);
  });
});

describe("entitlementSummary", () => {
  const d = (ms) => `D${ms}`;
  it("reads the tier, the source and the renewal state", () => {
    expect(entitlementSummary(FREE_ENTITLEMENT, d)).toBe("Free");
    expect(entitlementSummary(null, d)).toBe("Free");
    expect(entitlementSummary(pro(), d)).toBe("Pro · renews D1800000000000");
    expect(entitlementSummary(pro({ auto_renew: false }), d)).toBe("Pro · ends D1800000000000");
    expect(entitlementSummary(pro({ auto_renew: null }), d)).toBe("Pro · renews D1800000000000");
    expect(entitlementSummary(pro({ source: "legacy", expires_at: null, auto_renew: null }), d)).toBe("Pro · lifetime");
  });
});
