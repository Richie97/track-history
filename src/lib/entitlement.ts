// The entitlement rule (NS-32 requirement 1), pure and unit-tested. The
// database truth is users.entitled_until; everything here either derives from
// it or is the SQL that recomputes it.

// Legacy ($1 paid-app) grants are Pro for life. Stored as a far-future
// entitled_until so nothing downstream special-cases them: 2100-01-01.
export const LEGACY_ENTITLED_UNTIL_MS = 4_102_444_800_000;

// Server-side slack on top of the store's expiry, for webhook lag: a renewal
// Apple has already charged must not read as a lapse because a notification
// took an hour.
export const ENTITLEMENT_SLACK_MS = 3 * 24 * 60 * 60 * 1000;

export type Provider = "apple" | "google" | "legacy";

// Normalised across stores. Only the first three entitle:
//   active        paid up, expires_at in the future (or recently past — slack)
//   grace         the store's own grace period; expires_at is its end
//   legacy        the paid-app grant
//   billing_retry the store is retrying the card with no grace (Apple billing
//                 retry without grace, Play ON_HOLD) — not entitled
//   expired       ran out and the store told us so — no slack
//   revoked       refunded or revoked — immediate
//   paused        Play's pause
//   pending       Play's pending transaction, never completed
export type SubscriptionStatus =
  | "active"
  | "grace"
  | "legacy"
  | "billing_retry"
  | "expired"
  | "revoked"
  | "paused"
  | "pending";

export type SubscriptionRow = {
  provider: Provider;
  status: SubscriptionStatus | string;
  expires_at: number | null;
  auto_renew: number | boolean | null;
};

// What one row contributes to entitled_until, or null for nothing. The
// database computes this itself, in the triggers migration 0017 installs — this
// is the readable statement of the same rule, and what the unit tests pin.
// Keep the two in step.
export function entitledUntilContribution(row: SubscriptionRow): number | null {
  if (row.status === "legacy") return LEGACY_ENTITLED_UNTIL_MS;
  if (row.status === "active" || row.status === "grace") {
    return row.expires_at == null ? null : row.expires_at + ENTITLEMENT_SLACK_MS;
  }
  return null;
}

export function isEntitled(entitledUntil: number | null | undefined, nowMs: number): boolean {
  return entitledUntil != null && entitledUntil > nowMs;
}

export type EntitlementResponse = {
  tier: "free" | "pro";
  source: Provider | null;
  expires_at: number | null;
  auto_renew: boolean | null;
};

// The `entitlement` object on GET /api/me. Tier comes from entitled_until (the
// DB truth, already on the request context); source/expiry/auto-renew come from
// the row that produced it — or, for a lapsed user, from their most recent row,
// so the client can still say "your Apple subscription ended on …" and point
// Manage at the right store. Legacy shows no expiry: it has none.
export function entitlementResponse(
  entitledUntil: number | null | undefined,
  rows: readonly SubscriptionRow[],
  nowMs: number
): EntitlementResponse {
  const tier = isEntitled(entitledUntil, nowMs) ? "pro" : "free";
  // Rank each row as [tier of answer, tie-break]. An entitling *store* row
  // outranks legacy deliberately: a grandfathered user who also subscribed is
  // being charged, and reporting `legacy` would leave the client with no store
  // to point "Manage" at and no way to cancel from the app. Among lapsed rows
  // the one that ran out most recently wins, so a lapsed subscriber still
  // learns which store to manage.
  const rank = (row: SubscriptionRow): [number, number] => {
    const contribution = entitledUntilContribution(row);
    if (contribution == null) return [0, row.expires_at ?? -Infinity];
    return row.provider === "legacy" ? [1, 0] : [2, contribution];
  };
  let winner: SubscriptionRow | null = null;
  let best: [number, number] = [-1, -Infinity];
  for (const row of rows) {
    const score = rank(row);
    if (score[0] > best[0] || (score[0] === best[0] && score[1] > best[1])) {
      best = score;
      winner = row;
    }
  }
  if (!winner) return { tier, source: null, expires_at: null, auto_renew: null };
  const legacy = winner.provider === "legacy";
  return {
    tier,
    source: winner.provider,
    expires_at: legacy ? null : winner.expires_at,
    auto_renew: legacy || winner.auto_renew == null ? null : Boolean(winner.auto_renew),
  };
}

// The Pro field (NS-32 rule 4): `channels` is nulled for a free account,
// `trace` is kept — the track map is part of the free logbook, and a session
// with a trace and no channels is exactly what a recorder save looks like.
// Written in phase A, wired to the event detail and the compare read in phase D.
export function stripProFields<T extends { channels?: unknown }>(row: T, entitled: boolean): T {
  if (entitled || row.channels == null) return row;
  return { ...row, channels: null };
}

// Android's transitional legacy claim (NS-32 requirement 6) is honoured only
// before LEGACY_CUTOFF. Unset ⇒ open. A value that doesn't parse is treated as
// closed — a misconfigured cutoff must fail towards *not* granting lifetime Pro.
export function legacyClaimOpen(cutoff: string | undefined, nowMs: number): boolean {
  if (cutoff == null || cutoff.trim() === "") return true;
  const trimmed = cutoff.trim();
  // Digits are ambiguous, so each form is read as what an operator can only
  // have meant. Epoch milliseconds are 13 digits; a basic ISO date like
  // "20261231" is 20,261,231 ms after 1970 — read as epoch it would slam the
  // window shut the moment it was set, and Date.parse rejects it outright.
  const basicDate = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  const at = /^\d{12,}$/.test(trimmed)
    ? Number(trimmed)
    : Date.parse(basicDate ? `${basicDate[1]}-${basicDate[2]}-${basicDate[3]}` : trimmed);
  if (!Number.isFinite(at)) return false;
  return nowMs < at;
}

// `X-TE-Client: android/<versionCode>` — the transitional Android build names
// itself on every request; the legacy claim requires it.
export function parseClientHeader(header: string | undefined): { platform: string; version: number } | null {
  const m = /^([a-z]+)\/(\d{1,9})$/.exec(header?.trim() ?? "");
  return m ? { platform: m[1], version: Number(m[2]) } : null;
}
