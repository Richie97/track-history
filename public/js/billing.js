// Web billing (NS-49 phase B): the pure half of Settings' plan chooser and
// the Subscribe action on every gated surface. The web is the only client
// that sells through Stripe — neither phone app knows web billing exists
// (rule 4) — so nothing here is ported, and these helpers are web-only.

// What `GET /api/billing/stripe/plans` answers when Stripe is off, can't be
// reached, or hasn't been asked yet: the web then renders exactly as it did
// before Stripe, pointing at the phone apps.
export const PLANS_DISABLED = Object.freeze({ enabled: false });

export const plansEnabled = (plans) => !!plans?.enabled && Array.isArray(plans.plans) && plans.plans.length > 0;

// Stripe's own price, in the currency it is charged in. `amount` is the
// smallest unit (cents for USD), as Stripe's `unit_amount` is.
export function fmtPlanPrice(plan) {
  const currency = String(plan.currency || "usd").toUpperCase();
  let money;
  try {
    money = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(plan.amount / 100);
  } catch {
    money = `${(plan.amount / 100).toFixed(2)} ${currency}`;
  }
  return `${money}/${plan.interval}`;
}

// The button label on a gated surface: the cheapest way in, which is the
// monthly plan when there is one. Null when plans are off, so the caller
// keeps the store links.
export function subscribeLabel(plans) {
  if (!plansEnabled(plans)) return null;
  const monthly = plans.plans.find((p) => p.plan === "monthly") ?? plans.plans[0];
  return `Subscribe — from ${fmtPlanPrice(monthly)}`;
}

// The trial, said once for the chooser. Every plan carries the same
// `trial_days` (it is decided per account, not per plan), so the first says it.
export function trialLine(plans) {
  if (!plansEnabled(plans)) return null;
  const days = plans.plans[0].trial_days;
  return days > 0 ? `${days}-day free trial, once per account. Cancel any time before it ends and you won't be charged.` : null;
}

// Where an entitlement came from, as Settings words it. A two-way ternary is
// where "Google Play" would be printed for a web subscription, so every source
// is named here.
export function sourceName(source) {
  if (source === "apple") return "App Store";
  if (source === "google") return "Google Play";
  if (source === "stripe") return "web";
  return null;
}

export function billedText(source) {
  if (source === "stripe") return "Billed on the web.";
  if (source === "apple") return "Billed through the App Store.";
  if (source === "google") return "Billed through Google Play.";
  return null;
}

export function endedText(source) {
  if (source === "stripe") return "Your web subscription has ended. Subscribe again below to turn Pro back on — nothing was deleted.";
  const name = sourceName(source);
  return name ? `Your ${name} subscription has ended. Resubscribe in the app to turn Pro back on — nothing was deleted.` : null;
}

// The return leg's id from `#/settings?checkout=<id>`, or null. Held to the
// shape of a Checkout Session id before it is sent anywhere, as the server
// holds it (isStripeId in src/lib/billing/stripe.ts).
export function checkoutIdFrom(params) {
  const id = params?.get?.("checkout");
  return typeof id === "string" && /^cs_[A-Za-z0-9_-]{1,4000}$/.test(id) ? id : null;
}
