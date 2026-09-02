// The tier predicates (NS-32 requirement 8), the one place the client-side
// half of the tier table lives. Every decision a client makes from
// `entitlement` on GET /api/me goes through these, and the iOS Kit and Android
// :core carry ports under the same names, pinned to
// contracts/logic/entitlement.json — so add a predicate here first.
//
// Offline, the cached /api/me answer stands: a driver who was Pro at the last
// sync records (rule 5). That is why these take the entitlement object and
// never consult the clock — expiry is the server's call, made when it answered.

// Free: what the logbook is today. Pro: the analysis. The web and both apps
// gate at the point of use, never on a write.
export const FREE_ENTITLEMENT = Object.freeze({
  tier: "free",
  source: null,
  expires_at: null,
  auto_renew: null,
});

// An entitlement object, or nothing at all (not signed in, never fetched) —
// the latter is free, never Pro.
export function isPro(entitlement) {
  return !!entitlement && entitlement.tier === "pro";
}

// The GPS lap recorder, live timing and predictive delta (native only).
export const canRecord = (entitlement) => isPro(entitlement);

// Telemetry import — video on the phones, video + .vbo on the web.
export const canImport = (entitlement) => isPro(entitlement);

// Channel graphs, the lap delta chart, the two-lap compare and sector splits
// all read `channels`, which the server strips for a free account (rule 4); the
// client-side check only decides whether to show the paywall copy on the
// resulting empty state.
export const canViewChannels = (entitlement) => isPro(entitlement);

// Garage consumables, the setup notebook and year in review.
export const canUseGarage = (entitlement) => isPro(entitlement);
export const canUseSetups = (entitlement) => isPro(entitlement);
export const canViewYearInReview = (entitlement) => isPro(entitlement);

// Where "Manage subscription" goes, by the store that sold it. Legacy has no
// subscription to manage; free has nothing yet — both return null.
export const APPLE_MANAGE_URL = "https://apps.apple.com/account/subscriptions";
export const GOOGLE_MANAGE_URL =
  "https://play.google.com/store/account/subscriptions?package=app.trackevolution";

export function manageUrl(entitlement) {
  if (!entitlement) return null;
  if (entitlement.source === "apple") return APPLE_MANAGE_URL;
  if (entitlement.source === "google") return GOOGLE_MANAGE_URL;
  return null;
}

// One line for Settings: "Pro · renews Mar 4, 2027", "Pro · ends Mar 4, 2027",
// "Pro · lifetime", "Free". `fmtDate` is injected so the module stays free of
// locale/Intl and the ports can pin the shape without the date text.
export function entitlementSummary(entitlement, fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10)) {
  if (!isPro(entitlement)) return "Free";
  if (entitlement.source === "legacy" || entitlement.expires_at == null) return "Pro · lifetime";
  const when = fmtDate(entitlement.expires_at);
  return entitlement.auto_renew === false ? `Pro · ends ${when}` : `Pro · renews ${when}`;
}
