// The daily re-verification (NS-32 requirement 1): webhooks are the fast path,
// this is what makes a missed webhook cost a day rather than a customer. Every
// store-backed row near its expiry is re-read from its store and the row (and,
// through the triggers, the user's entitlement) updated.

import type { Env } from "./types";
import { appleIapConfig, appleServerApiToken, appleStoreApiRootsDer } from "./lib/billing/apple";
import { googleAccessToken, parseServiceAccount } from "./lib/billing/google";
import { reverifyAppleRow, syncGoogleRow } from "./lib/billing/sync";
import { subscriptionsToReverify } from "./lib/billing/store";

export const REVERIFY_AHEAD_MS = 48 * 60 * 60 * 1000;
// Apple's billing retry runs for up to 60 days and Play's hold is comparable,
// so a row that lapsed inside that window can still come back to life — and a
// row wrongly expired by a stale notification has to be reachable for long
// enough that the daily pass can heal it.
export const REVERIFY_BEHIND_MS = 60 * 24 * 60 * 60 * 1000;

export type ReverifyReport = { checked: number; updated: number; skipped: number; failed: number };

export async function reverifyExpiring(env: Env, nowMs: number): Promise<ReverifyReport> {
  const report: ReverifyReport = { checked: 0, updated: 0, skipped: 0, failed: 0 };
  const rows = await subscriptionsToReverify(env.DB, nowMs, REVERIFY_AHEAD_MS, REVERIFY_BEHIND_MS);
  if (rows.length === 0) return report;

  const apple = appleIapConfig(env);
  const google = parseServiceAccount(env.GOOGLE_PLAY_SERVICE_ACCOUNT);
  // Payloads here come from Apple's Server API, not from a request body — see
  // appleStoreApiRootsDer for why that changes which anchors are safe.
  const rootsDer = appleStoreApiRootsDer(env);
  // Both store credentials outlive a whole pass; minting one per row would buy
  // a network round trip (Google) and a signature (Apple) for nothing.
  const appleToken = apple ? await appleServerApiToken(apple, nowMs) : undefined;
  const googleToken = google ? await googleAccessToken(google, nowMs).catch(() => undefined) : undefined;

  for (const row of rows) {
    report.checked++;
    try {
      const outcome =
        row.provider === "apple"
          ? apple
            ? await reverifyAppleRow(env.DB, row, apple, { rootsDer, nowMs, token: appleToken })
            : "unknown"
          : row.provider === "google"
            ? google
              ? await syncGoogleRow(env.DB, row, google, { nowMs, accessToken: googleToken })
              : "unknown"
            : "unknown";
      if (outcome === "updated") report.updated++;
      else report.skipped++;
    } catch (err) {
      report.failed++;
      console.error("reverify failed:", row.provider, row.id, err instanceof Error ? err.message : err);
    }
  }
  console.log("subscription reverify:", JSON.stringify(report));
  return report;
}
