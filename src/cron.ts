// The daily re-verification (NS-32 requirement 1): webhooks are the fast path,
// this is what makes a missed webhook cost a day rather than a customer. Every
// store-backed row expiring in the next 48 h or expired in the last 7 days is
// re-read from its store and the row (and the user's entitled_until) updated.

import type { Env } from "./types";
import {
  appleIapConfig,
  appleSubscriptionState,
  fetchAppleSubscription,
  verifyAppleRenewalInfo,
  verifyAppleTransaction,
  appleRootsDer,
} from "./lib/billing/apple";
import { fetchGoogleSubscription, googleSubscriptionState, parseServiceAccount } from "./lib/billing/google";
import { applyStoreState, retireSubscription, subscriptionsToReverify } from "./lib/billing/store";

export const REVERIFY_AHEAD_MS = 48 * 60 * 60 * 1000;
export const REVERIFY_BEHIND_MS = 7 * 24 * 60 * 60 * 1000;

export type ReverifyReport = { checked: number; updated: number; skipped: number; failed: number };

export async function reverifyExpiring(env: Env, nowMs: number): Promise<ReverifyReport> {
  const report: ReverifyReport = { checked: 0, updated: 0, skipped: 0, failed: 0 };
  const rows = await subscriptionsToReverify(env.DB, nowMs, REVERIFY_AHEAD_MS, REVERIFY_BEHIND_MS);
  if (rows.length === 0) return report;

  const apple = appleIapConfig(env);
  const google = parseServiceAccount(env.GOOGLE_PLAY_SERVICE_ACCOUNT);
  const rootsDer = appleRootsDer(env);

  for (const row of rows) {
    report.checked++;
    try {
      if (row.provider === "apple") {
        if (!apple) {
          report.skipped++;
          continue;
        }
        const last = await fetchAppleSubscription(apple, row.external_id, row.environment ?? "production", nowMs);
        if (!last) {
          report.skipped++;
          continue;
        }
        const tx = await verifyAppleTransaction(last.signedTransactionInfo, { bundleId: apple.bundleId, rootsDer });
        const renewal = last.signedRenewalInfo
          ? await verifyAppleRenewalInfo(last.signedRenewalInfo, { rootsDer, originalTransactionId: tx.originalTransactionId })
          : null;
        const state = appleSubscriptionState(tx, renewal, nowMs);
        await applyStoreState(env.DB, row, { ...state, productId: tx.productId, raw: { transaction: tx, renewal, cron: true } }, nowMs);
        report.updated++;
      } else if (row.provider === "google") {
        if (!google) {
          report.skipped++;
          continue;
        }
        const sub = await fetchGoogleSubscription(google, row.external_id, nowMs);
        if (!sub) {
          report.skipped++;
          continue;
        }
        const state = googleSubscriptionState(sub, nowMs);
        await applyStoreState(env.DB, row, { ...state, raw: { purchase: sub, cron: true } }, nowMs);
        if (state.linkedPurchaseToken) await retireSubscription(env.DB, row.user_id, "google", state.linkedPurchaseToken, nowMs);
        report.updated++;
      } else {
        report.skipped++;
      }
    } catch (err) {
      report.failed++;
      console.error("reverify failed:", row.provider, row.id, err instanceof Error ? err.message : err);
    }
  }
  console.log("subscription reverify:", JSON.stringify(report));
  return report;
}
