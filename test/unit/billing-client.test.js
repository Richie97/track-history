import { describe, expect, it } from "vitest";
import {
  PLANS_DISABLED,
  billedText,
  checkoutIdFrom,
  endedText,
  fmtPlanPrice,
  plansEnabled,
  sourceName,
  subscribeLabel,
  trialLine,
} from "../../public/js/billing.js";

// NS-49 phase B: the pure half of the web's plan chooser (public/js/billing.js).

const plans = (trial = 14) => ({
  enabled: true,
  plans: [
    { plan: "monthly", price_id: "price_m", amount: 199, currency: "usd", interval: "month", trial_days: trial },
    { plan: "yearly", price_id: "price_y", amount: 1999, currency: "usd", interval: "year", trial_days: trial },
  ],
});

describe("plansEnabled", () => {
  it("is true only for an enabled answer that carries plans", () => {
    expect(plansEnabled(plans())).toBe(true);
    expect(plansEnabled(PLANS_DISABLED)).toBe(false);
    expect(plansEnabled({ enabled: true, plans: [] })).toBe(false);
    expect(plansEnabled(null)).toBe(false);
    expect(plansEnabled(undefined)).toBe(false);
  });
});

describe("fmtPlanPrice", () => {
  it("says Stripe's price per interval, in the currency charged", () => {
    expect(fmtPlanPrice(plans().plans[0])).toBe("$1.99/month");
    expect(fmtPlanPrice(plans().plans[1])).toBe("$19.99/year");
    expect(fmtPlanPrice({ amount: 199, currency: "eur", interval: "month" })).toBe("€1.99/month");
  });
  it("still says something for a currency code Intl doesn't know", () => {
    expect(fmtPlanPrice({ amount: 500, currency: "zz1", interval: "month" })).toBe("5.00 ZZ1/month");
  });
});

describe("subscribeLabel and trialLine", () => {
  it("leads with the monthly price, and is null when the web isn't selling", () => {
    expect(subscribeLabel(plans())).toBe("Subscribe — from $1.99/month");
    expect(subscribeLabel({ enabled: true, plans: [plans().plans[1]] })).toBe("Subscribe — from $19.99/year");
    expect(subscribeLabel(PLANS_DISABLED)).toBeNull();
  });
  it("offers the trial only to an account that still has one", () => {
    expect(trialLine(plans(14))).toMatch(/^14-day free trial, once per account/);
    expect(trialLine(plans(0))).toBeNull();
    expect(trialLine(PLANS_DISABLED)).toBeNull();
  });
});

describe("sourceName, billedText, endedText", () => {
  it("names every source — a web subscription is never called Google Play", () => {
    expect(sourceName("apple")).toBe("App Store");
    expect(sourceName("google")).toBe("Google Play");
    expect(sourceName("stripe")).toBe("web");
    expect(sourceName("legacy")).toBeNull();
    expect(sourceName(null)).toBeNull();
    expect(billedText("stripe")).toBe("Billed on the web.");
    expect(billedText("apple")).toBe("Billed through the App Store.");
    expect(billedText("google")).toBe("Billed through Google Play.");
    expect(billedText("legacy")).toBeNull();
  });
  it("points a lapsed web subscriber at the chooser and a lapsed store one at the app", () => {
    expect(endedText("stripe")).toMatch(/^Your web subscription has ended\. Subscribe again below/);
    expect(endedText("google")).toMatch(/^Your Google Play subscription has ended\. Resubscribe in the app/);
    expect(endedText(null)).toBeNull();
  });
});

describe("checkoutIdFrom", () => {
  it("takes a Checkout Session id from the return leg's query and nothing else", () => {
    expect(checkoutIdFrom(new URLSearchParams("checkout=cs_test_a1B2c3"))).toBe("cs_test_a1B2c3");
    expect(checkoutIdFrom(new URLSearchParams("checkout={CHECKOUT_SESSION_ID}"))).toBeNull();
    expect(checkoutIdFrom(new URLSearchParams("checkout=sub_123"))).toBeNull();
    expect(checkoutIdFrom(new URLSearchParams("checkout=cs_../../v1"))).toBeNull();
    expect(checkoutIdFrom(new URLSearchParams(""))).toBeNull();
    expect(checkoutIdFrom(undefined)).toBeNull();
  });
});
