// Bringing one stored subscription row up to date with its store.
//
// The notification webhooks and the daily cron both do the same thing — take a
// row we already own, learn the store's current answer, write it — and the two
// used to say it twice. They say it here once, so a change to what a payload
// means (or to the retire-the-superseded-token follow-up, which is easy to
// forget) lands on both.

import type { AppleIapConfig } from "./apple";
import {
  fetchAppleSubscription,
  verifyAppleTransactionPair,
} from "./apple";
import type { ServiceAccount } from "./google";
import { fetchGoogleSubscription, googleSubscriptionState } from "./google";
import { applyStoreState, retireSubscription, type StoredSubscription } from "./store";

export type SyncOutcome = "updated" | "stale" | "unknown";

type RowRef = Pick<StoredSubscription, "provider" | "external_id" | "user_id" | "environment">;

// Apple: verify the signed payloads, then apply — unless the row already holds
// something signed later, which is what a retried notification looks like.
export async function syncAppleRow(
  db: D1Database,
  row: RowRef,
  payload: { transactionJws: unknown; renewalJws?: unknown; tag: Record<string, unknown> },
  opts: { bundleId: string; rootsDer: readonly Uint8Array[]; nowMs: number }
): Promise<SyncOutcome> {
  const { tx, renewal, state, signedDate } = await verifyAppleTransactionPair(
    payload.transactionJws,
    payload.renewalJws,
    opts
  );
  const applied = await applyStoreState(
    db,
    row,
    { ...state, productId: tx.productId, signedDate, raw: { transaction: tx, renewal, ...payload.tag } },
    opts.nowMs
  );
  return applied ? "updated" : "stale";
}

// Apple, via the App Store Server API: what the cron uses, since it has no
// payload of its own.
export async function reverifyAppleRow(
  db: D1Database,
  row: RowRef,
  cfg: AppleIapConfig,
  opts: { rootsDer: readonly Uint8Array[]; nowMs: number; token?: string }
): Promise<SyncOutcome> {
  const last = await fetchAppleSubscription(cfg, row.external_id, row.environment ?? "production", opts.nowMs, opts.token);
  if (!last) return "unknown";
  return syncAppleRow(
    db,
    row,
    { transactionJws: last.signedTransactionInfo, renewalJws: last.signedRenewalInfo, tag: { cron: true } },
    { bundleId: cfg.bundleId, rootsDer: opts.rootsDer, nowMs: opts.nowMs }
  );
}

// Google: always a live read, so there is no stale-payload case — RTDN says
// something changed, the API says what.
export async function syncGoogleRow(
  db: D1Database,
  row: RowRef,
  sa: ServiceAccount,
  opts: { nowMs: number; accessToken?: string; tag?: Record<string, unknown> }
): Promise<SyncOutcome> {
  const sub = await fetchGoogleSubscription(sa, row.external_id, opts.nowMs, opts.accessToken);
  if (!sub) return "unknown";
  const state = googleSubscriptionState(sub, opts.nowMs);
  await applyStoreState(db, row, { ...state, raw: { purchase: sub, ...(opts.tag ?? {}) } }, opts.nowMs);
  // An upgrade/downgrade names the token it replaces; that row must stop
  // entitling, whichever account holds it.
  if (state.linkedPurchaseToken) await retireSubscription(db, "google", state.linkedPurchaseToken, opts.nowMs);
  return "updated";
}
