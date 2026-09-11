// Subscription rows as D1 statements.
//
// users.entitled_until is *not* maintained here: migration 0017 installs
// triggers that recompute it on every insert, update and delete, the same way
// updated_at works everywhere else in this schema. That is what makes the
// invariant self-enforcing — a support script or a backfill that writes a row
// directly cannot leave a user's tier stale.
//
// Apple's writes are additionally guarded on signed_date. Apple retries a
// failed notification for days carrying its *original* payload, so without the
// guard a stale EXPIRED redelivered after the user resubscribed would put a
// paying account back on free — and, since the client can replay any JWS it
// still holds, a refunded subscriber could restore their own entitlement by
// re-posting a pre-refund transaction.

import type { Provider, SubscriptionStatus } from "../entitlement";

export class SubscriptionConflict extends Error {
  constructor() {
    super("purchase belongs to another account");
  }
}

export type SubscriptionUpsert = {
  userId: number;
  provider: Provider;
  productId: string | null;
  externalId: string;
  status: SubscriptionStatus;
  expiresAt: number | null;
  autoRenew: boolean | null;
  environment: string | null;
  raw: unknown;
  // The store payload's own signing instant, for Apple's ordering guard. Null
  // for Google and legacy, whose writes are never replayed from an old payload.
  signedDate?: number | null;
};

// Insert-or-update by (provider, external_id), in one round trip. A row already
// bound to a *different* user is left untouched and reported as a conflict —
// the same purchase must never grant two accounts, and never move between them.
export async function upsertSubscription(db: D1Database, sub: SubscriptionUpsert, nowMs: number): Promise<void> {
  const [, owner] = await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, signed_date, raw, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, external_id) DO UPDATE SET
           product_id = COALESCE(excluded.product_id, subscriptions.product_id),
           status = excluded.status,
           expires_at = excluded.expires_at,
           auto_renew = excluded.auto_renew,
           environment = COALESCE(excluded.environment, subscriptions.environment),
           signed_date = COALESCE(excluded.signed_date, subscriptions.signed_date),
           raw = excluded.raw,
           updated_at = excluded.updated_at
         WHERE subscriptions.user_id = excluded.user_id
           AND (excluded.signed_date IS NULL OR subscriptions.signed_date IS NULL
                OR excluded.signed_date >= subscriptions.signed_date)`
      )
      .bind(
        sub.userId,
        sub.provider,
        sub.productId,
        sub.externalId,
        sub.status,
        sub.expiresAt,
        sub.autoRenew == null ? null : sub.autoRenew ? 1 : 0,
        sub.environment,
        sub.signedDate ?? null,
        sub.raw == null ? null : JSON.stringify(sub.raw),
        nowMs,
        nowMs
      ),
    db.prepare("SELECT user_id FROM subscriptions WHERE provider = ? AND external_id = ?").bind(sub.provider, sub.externalId),
  ]);
  const row = owner.results[0] as { user_id: number } | undefined;
  if (row && row.user_id !== sub.userId) throw new SubscriptionConflict();
}

export type StoredSubscription = {
  id: number;
  user_id: number;
  provider: Provider;
  product_id: string | null;
  external_id: string;
  status: SubscriptionStatus;
  expires_at: number | null;
  auto_renew: number | null;
  environment: string | null;
};

export async function findSubscription(
  db: D1Database,
  provider: Provider,
  externalId: string
): Promise<StoredSubscription | null> {
  return db
    .prepare(
      "SELECT id, user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment FROM subscriptions WHERE provider = ? AND external_id = ?"
    )
    .bind(provider, externalId)
    .first<StoredSubscription>();
}

// Applies a fresh store state to an existing row (webhook / cron path, where
// the user is whoever already owns the row) and recomputes their entitlement.
// Returns false when the write was skipped as stale — an Apple payload signed
// before the one the row already holds. The caller acks it and logs; there is
// nothing to correct, because the row already reflects something newer.
export async function applyStoreState(
  db: D1Database,
  row: Pick<StoredSubscription, "provider" | "external_id" | "user_id">,
  state: {
    status: SubscriptionStatus;
    expiresAt: number | null;
    autoRenew: boolean | null;
    productId?: string | null;
    raw: unknown;
    signedDate?: number | null;
  },
  nowMs: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE subscriptions SET status = ?, expires_at = ?, auto_renew = ?, product_id = COALESCE(?, product_id),
         signed_date = COALESCE(?, signed_date), raw = ?, updated_at = ?
       WHERE provider = ? AND external_id = ?
         AND (? IS NULL OR signed_date IS NULL OR ? >= signed_date)`
    )
    .bind(
      state.status,
      state.expiresAt,
      state.autoRenew == null ? null : state.autoRenew ? 1 : 0,
      state.productId ?? null,
      state.signedDate ?? null,
      state.raw == null ? null : JSON.stringify(state.raw),
      nowMs,
      row.provider,
      row.external_id,
      state.signedDate ?? null,
      state.signedDate ?? null
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// A Play upgrade/downgrade issues a new token and names the one it replaces;
// the old row stops entitling so the user isn't double-counted (and a refund
// of the old token has nothing left to revoke).
//
// Deliberately *not* scoped to the upgrading user: the same Google account can
// be signed in to two Track Evolution accounts, and the superseded token may
// belong to the other one. Play has already ended it either way, so leaving it
// active would keep an account Pro on a subscription that no longer exists.
// The trigger recomputes whichever user owns it.
export async function retireSubscription(db: D1Database, provider: Provider, externalId: string, nowMs: number) {
  await db
    .prepare("UPDATE subscriptions SET status = 'expired', auto_renew = 0, updated_at = ? WHERE provider = ? AND external_id = ? AND status NOT IN ('revoked', 'expired')")
    .bind(nowMs, provider, externalId)
    .run();
}

// The rows worth re-checking against the store: expiring within `aheadMs` or
// expired within the last `behindMs`, store-backed only.
//
// `expired` rows are deliberately included. Only a refund/revocation is
// terminal; an expiry is not, because the row may have been expired by a stale
// notification or a renewal we never heard about, and excluding it would mean
// the daily re-check could never heal the one failure it exists to catch.
export async function subscriptionsToReverify(
  db: D1Database,
  nowMs: number,
  aheadMs: number,
  behindMs: number
): Promise<StoredSubscription[]> {
  const res = await db
    .prepare(
      `SELECT id, user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment
       FROM subscriptions
       WHERE provider IN ('apple', 'google') AND status <> 'revoked' 
         AND expires_at IS NOT NULL AND expires_at BETWEEN ? AND ?
       ORDER BY expires_at`
    )
    .bind(nowMs - behindMs, nowMs + aheadMs)
    .all<StoredSubscription>();
  return res.results;
}

// The user's rows, for the /me entitlement object. Batched by the caller.
export function subscriptionsForUserStmt(db: D1Database, userId: number) {
  return db
    .prepare("SELECT provider, status, expires_at, auto_renew FROM subscriptions WHERE user_id = ? ORDER BY expires_at DESC, id DESC")
    .bind(userId);
}
