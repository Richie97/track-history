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

export const ENTITLING_STATUSES: readonly SubscriptionStatus[] = ["active", "grace", "legacy"];

export type SubscriptionRow = {
  provider: Provider;
  status: SubscriptionStatus | string;
  expires_at: number | null;
  auto_renew: number | boolean | null;
};

// What one row contributes to entitled_until, or null for nothing. The SQL in
// ENTITLED_UNTIL_SUBQUERY is the same rule; keep the two in step.
export function entitledUntilContribution(row: SubscriptionRow): number | null {
  if (row.status === "legacy") return LEGACY_ENTITLED_UNTIL_MS;
  if (row.status === "active" || row.status === "grace") {
    return row.expires_at == null ? null : row.expires_at + ENTITLEMENT_SLACK_MS;
  }
  return null;
}

// Recomputes users.entitled_until for one user from their subscription rows.
// Bind the user id once. MAX ignores NULLs, so a user with no entitling row
// lands on NULL — free.
export const RECOMPUTE_ENTITLED_UNTIL_SQL = `UPDATE users SET entitled_until = (
  SELECT MAX(CASE
    WHEN status = 'legacy' THEN ${LEGACY_ENTITLED_UNTIL_MS}
    WHEN status IN ('active', 'grace') THEN expires_at + ${ENTITLEMENT_SLACK_MS}
    ELSE NULL END)
  FROM subscriptions WHERE user_id = users.id
) WHERE id = ?`;

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
  let winner: SubscriptionRow | null = null;
  let best = -Infinity;
  for (const row of rows) {
    // Entitling rows rank by contribution; the rest by their own expiry, so
    // among lapsed rows the latest wins and any entitling row beats them all.
    const score = entitledUntilContribution(row) ?? (row.expires_at ?? 0) - Number.MAX_SAFE_INTEGER;
    if (score > best) {
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
  const at = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  if (!Number.isFinite(at)) return false;
  return nowMs < at;
}

// `X-TE-Client: android/<versionCode>` — the transitional Android build names
// itself on every request; the legacy claim requires it.
export function parseClientHeader(header: string | undefined): { platform: string; version: number } | null {
  const m = /^([a-z]+)\/(\d{1,9})$/.exec(header?.trim() ?? "");
  return m ? { platform: m[1], version: Number(m[2]) } : null;
}
