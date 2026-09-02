// Subscription rows and the entitled_until recompute, as D1 statements. Every
// write here batches the recompute with it, so users.entitled_until can never
// be observed out of step with the rows it summarises.

import type { Provider, SubscriptionStatus } from "../entitlement";
import { RECOMPUTE_ENTITLED_UNTIL_SQL } from "../entitlement";

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
};

const recompute = (db: D1Database, userId: number) => db.prepare(RECOMPUTE_ENTITLED_UNTIL_SQL).bind(userId);

// Insert-or-update by (provider, external_id), in one round trip. A row already
// bound to a *different* user is left untouched and reported as a conflict —
// the same purchase must never grant two accounts, and never move between them.
export async function upsertSubscription(db: D1Database, sub: SubscriptionUpsert, nowMs: number): Promise<void> {
  const [, , owner] = await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, raw, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, external_id) DO UPDATE SET
           product_id = COALESCE(excluded.product_id, subscriptions.product_id),
           status = excluded.status,
           expires_at = excluded.expires_at,
           auto_renew = excluded.auto_renew,
           environment = COALESCE(excluded.environment, subscriptions.environment),
           raw = excluded.raw,
           updated_at = excluded.updated_at
         WHERE subscriptions.user_id = excluded.user_id`
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
        sub.raw == null ? null : JSON.stringify(sub.raw),
        nowMs,
        nowMs
      ),
    recompute(db, sub.userId),
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
export async function applyStoreState(
  db: D1Database,
  row: Pick<StoredSubscription, "provider" | "external_id" | "user_id">,
  state: { status: SubscriptionStatus; expiresAt: number | null; autoRenew: boolean | null; productId?: string | null; raw: unknown },
  nowMs: number
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE subscriptions SET status = ?, expires_at = ?, auto_renew = ?, product_id = COALESCE(?, product_id), raw = ?, updated_at = ?
         WHERE provider = ? AND external_id = ?`
      )
      .bind(
        state.status,
        state.expiresAt,
        state.autoRenew == null ? null : state.autoRenew ? 1 : 0,
        state.productId ?? null,
        state.raw == null ? null : JSON.stringify(state.raw),
        nowMs,
        row.provider,
        row.external_id
      ),
    recompute(db, row.user_id),
  ]);
}

// A Play upgrade/downgrade issues a new token and names the one it replaces;
// the old row stops entitling so the user isn't double-counted (and a refund
// of the old token has nothing left to revoke).
export async function retireSubscription(db: D1Database, userId: number, provider: Provider, externalId: string, nowMs: number) {
  await db.batch([
    db
      .prepare("UPDATE subscriptions SET status = 'expired', auto_renew = 0, updated_at = ? WHERE user_id = ? AND provider = ? AND external_id = ? AND status <> 'revoked'")
      .bind(nowMs, userId, provider, externalId),
    recompute(db, userId),
  ]);
}

// The rows worth re-checking against the store: expiring within `aheadMs` or
// expired within the last `behindMs`, store-backed only, not already final.
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
       WHERE provider IN ('apple', 'google') AND status NOT IN ('revoked', 'expired')
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
