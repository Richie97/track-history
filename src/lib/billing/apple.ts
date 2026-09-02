// App Store subscriptions (NS-32 requirement 2): verifying StoreKit 2 payloads
// locally, and the App Store Server API for the cron's re-check.
//
// Every signed thing Apple hands us — a transaction, its renewal info, an
// AppTransaction, a Server Notification — is an ES256 JWS carrying its
// certificate chain, and all of them go through verifyX5cJws against the pinned
// root. Nothing in this file trusts a payload it did not verify.

import type { Env } from "../../types";
import { signES256 } from "../apple";
import { APPLE_ROOTS_DER_B64 } from "./apple-roots";
import { JwsError, base64Decode, pemToDer, verifyX5cJws } from "./jws";
import { isDevHost } from "../dev";
import type { SubscriptionStatus } from "../entitlement";

export const APPLE_SUBSCRIPTION_TYPE = "Auto-Renewable Subscription";

// The bundle id is IOS_APP_ID without its Team ID prefix
// ("L3NS86NMXZ.app.trackevolution" → "app.trackevolution"). A Team ID is
// exactly ten upper-case alphanumerics, so a value that is already a bare
// bundle id ("app.trackevolution", as a fork might set) is left alone rather
// than losing its first segment. Returns "" when IOS_APP_ID is unset, which
// the routes treat as "billing not configured" instead of failing every
// receipt with "wrong bundle id".
export function appleBundleId(env: Pick<Env, "IOS_APP_ID">): string {
  const id = (env.IOS_APP_ID ?? "").trim();
  const dot = id.indexOf(".");
  if (dot < 0) return id;
  return /^[A-Z0-9]{10}$/.test(id.slice(0, dot)) ? id.slice(dot + 1) : id;
}

// The pinned roots, decoded once — the value never changes.
const PINNED_ROOTS: readonly Uint8Array[] = APPLE_ROOTS_DER_B64.map(base64Decode);

// Trust anchors. The extra test root exists so the API tests can verify a
// chain they hold the key to, and its private key is *committed* under
// test/fixtures/ — so it is gated on the request having arrived on a local dev
// host, exactly like the DEV_MODE login bypass (lib/dev.ts). A DEV_MODE=1 that
// leaks into a deployed environment therefore grants nothing. `requestUrl` is
// omitted by the cron, which has no request and so never trusts the test root.
export function appleRootsDer(
  env: Pick<Env, "DEV_MODE" | "APPLE_IAP_TEST_ROOT_PEM">,
  requestUrl: string
): readonly Uint8Array[] {
  if (!env.APPLE_IAP_TEST_ROOT_PEM || !isDevHost(env, requestUrl)) return PINNED_ROOTS;
  return [...PINNED_ROOTS, pemToDer(env.APPLE_IAP_TEST_ROOT_PEM)];
}

// Trust anchors for payloads the *cron* fetched from Apple's own Server API.
// Here DEV_MODE alone is enough, and the hostname gate would be meaningless:
// there is no request and nothing user-supplied in the path — the JWS came
// from api.storekit.itunes.apple.com over TLS. A leaked DEV_MODE therefore
// grants nothing, because no attacker can make Apple's API answer with a
// payload signed by the test key.
export function appleStoreApiRootsDer(
  env: Pick<Env, "DEV_MODE" | "APPLE_IAP_TEST_ROOT_PEM">
): readonly Uint8Array[] {
  if (env.DEV_MODE !== "1" || !env.APPLE_IAP_TEST_ROOT_PEM) return PINNED_ROOTS;
  return [...PINNED_ROOTS, pemToDer(env.APPLE_IAP_TEST_ROOT_PEM)];
}

// JWSTransactionDecodedPayload — the fields we read.
export type AppleTransaction = {
  bundleId: string;
  originalTransactionId: string;
  transactionId?: string;
  productId: string;
  type?: string;
  environment?: string; // "Sandbox" | "Production"
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  signedDate?: number;
};

// JWSRenewalInfoDecodedPayload — the fields we read.
export type AppleRenewalInfo = {
  originalTransactionId: string;
  autoRenewStatus?: number; // 1 on, 0 off
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  expirationIntent?: number;
};

// AppTransaction (the app's own purchase record) — the fields we read.
export type AppleAppTransaction = {
  bundleId: string;
  appTransactionId?: string;
  originalApplicationVersion: string;
  originalPurchaseDate?: number;
  receiptType?: string; // "Sandbox" | "Production" | "Xcode"
  signedDate?: number;
};

type VerifyOpts = { bundleId: string; rootsDer: readonly Uint8Array[]; nowMs?: number };

// A signed payload's own signing instant, used to order Apple's writes: a
// notification Apple retries for days carries the payload it was issued with,
// so an older one must never overwrite newer state (see store.ts).
export const appleSignedDate = (p: { signedDate?: number }): number | null =>
  typeof p.signedDate === "number" ? p.signedDate : null;

async function verifyFor(jws: unknown, opts: VerifyOpts): Promise<Record<string, unknown>> {
  if (typeof jws !== "string" || !jws) throw new JwsError("missing JWS");
  const payload = await verifyX5cJws(jws, { rootsDer: opts.rootsDer, nowMs: opts.nowMs });
  if (payload.bundleId !== opts.bundleId) throw new JwsError("wrong bundle id");
  return payload;
}

export async function verifyAppleTransaction(jws: unknown, opts: VerifyOpts): Promise<AppleTransaction> {
  const p = await verifyFor(jws, opts);
  if (typeof p.originalTransactionId !== "string" || typeof p.productId !== "string")
    throw new JwsError("not a transaction");
  return p as unknown as AppleTransaction;
}

// Renewal info carries no bundleId, so it is verified against the chain alone
// and tied to its transaction by originalTransactionId instead.
export async function verifyAppleRenewalInfo(
  jws: unknown,
  opts: { rootsDer: readonly Uint8Array[]; nowMs?: number; originalTransactionId: string }
): Promise<AppleRenewalInfo> {
  if (typeof jws !== "string" || !jws) throw new JwsError("missing JWS");
  const p = await verifyX5cJws(jws, { rootsDer: opts.rootsDer, nowMs: opts.nowMs });
  if (p.originalTransactionId !== opts.originalTransactionId) throw new JwsError("renewal info for another transaction");
  return p as unknown as AppleRenewalInfo;
}

export async function verifyAppleAppTransaction(jws: unknown, opts: VerifyOpts): Promise<AppleAppTransaction> {
  const p = await verifyFor(jws, opts);
  if (typeof p.originalApplicationVersion !== "string") throw new JwsError("not an app transaction");
  return p as unknown as AppleAppTransaction;
}

export type StoreState = {
  status: SubscriptionStatus;
  expiresAt: number | null;
  autoRenew: boolean | null;
};

// Derives the row state from a verified transaction (+ renewal info when we
// have it). The notification *type* is deliberately not an input: the payloads
// say what is true now, and reading them the same way from a purchase POST, a
// notification and the cron is what keeps the three paths from disagreeing.
export function appleSubscriptionState(
  tx: AppleTransaction,
  renewal: AppleRenewalInfo | null,
  nowMs: number
): StoreState {
  const autoRenew = renewal?.autoRenewStatus == null ? null : renewal.autoRenewStatus === 1;
  const expires = tx.expiresDate ?? null;
  if (tx.revocationDate != null) return { status: "revoked", expiresAt: expires, autoRenew };
  if (expires != null && expires > nowMs) return { status: "active", expiresAt: expires, autoRenew };
  const grace = renewal?.gracePeriodExpiresDate;
  if (grace != null && grace > nowMs) return { status: "grace", expiresAt: grace, autoRenew };
  if (renewal?.isInBillingRetryPeriod) return { status: "billing_retry", expiresAt: expires, autoRenew };
  return { status: "expired", expiresAt: expires, autoRenew };
}

export type VerifiedAppleTransaction = {
  tx: AppleTransaction;
  renewal: AppleRenewalInfo | null;
  state: StoreState;
  signedDate: number | null;
};

// Verify a transaction and (when present) its renewal info, then derive the
// row state — the sequence every Apple write path needs, in one place so the
// purchase POST, the notification webhook and the cron cannot drift apart on
// what a payload means.
export async function verifyAppleTransactionPair(
  jws: unknown,
  renewalJws: unknown,
  opts: VerifyOpts & { nowMs: number }
): Promise<VerifiedAppleTransaction> {
  const tx = await verifyAppleTransaction(jws, opts);
  const renewal =
    typeof renewalJws === "string" && renewalJws
      ? await verifyAppleRenewalInfo(renewalJws, {
          rootsDer: opts.rootsDer,
          nowMs: opts.nowMs,
          originalTransactionId: tx.originalTransactionId,
        })
      : null;
  return { tx, renewal, state: appleSubscriptionState(tx, renewal, opts.nowMs), signedDate: appleSignedDate(tx) };
}

export const appleEnvironment = (value: string | undefined): string =>
  (value ?? "production").toLowerCase();

// App Store Server Notifications V2 types that change subscription state.
// Anything else is acknowledged and logged.
export const APPLE_HANDLED_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "SUBSCRIBED",
  "DID_RENEW",
  "DID_CHANGE_RENEWAL_STATUS",
  "DID_CHANGE_RENEWAL_PREF",
  "EXPIRED",
  "GRACE_PERIOD_EXPIRED",
  "REFUND",
  "REVOKE",
  "DID_FAIL_TO_RENEW",
  "OFFER_REDEEMED",
  "RENEWAL_EXTENDED",
]);

// ---------------------------------------------------------------------------
// App Store Server API (cron only)
// ---------------------------------------------------------------------------

export type AppleIapConfig = { keyId: string; issuerId: string; privateKeyPem: string; bundleId: string };

export function appleIapConfig(env: Env): AppleIapConfig | null {
  const { APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_IAP_PRIVATE_KEY } = env;
  if (!APPLE_IAP_KEY_ID || !APPLE_IAP_ISSUER_ID || !APPLE_IAP_PRIVATE_KEY) return null;
  return { keyId: APPLE_IAP_KEY_ID, issuerId: APPLE_IAP_ISSUER_ID, privateKeyPem: APPLE_IAP_PRIVATE_KEY, bundleId: appleBundleId(env) };
}

// The Server API bearer: ES256, kid/iss/aud/bid — the same JWT shape Sign in
// with Apple's client secret uses, hence the shared signES256.
export async function appleServerApiToken(cfg: AppleIapConfig, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  return signES256(
    { kid: cfg.keyId, typ: "JWT" },
    { iss: cfg.issuerId, iat, exp: iat + 5 * 60, aud: "appstoreconnect-v1", bid: cfg.bundleId },
    cfg.privateKeyPem
  );
}

export const APPLE_SERVER_API = {
  production: "https://api.storekit.itunes.apple.com",
  sandbox: "https://api.storekit-sandbox.itunes.apple.com",
} as const;

export type AppleLastTransaction = {
  originalTransactionId: string;
  status: number; // 1 active, 2 expired, 3 billing retry, 4 grace, 5 revoked
  signedTransactionInfo: string;
  signedRenewalInfo: string;
};

// GET /inApps/v1/subscriptions/{originalTransactionId}: the latest signed
// transaction + renewal info for the subscription. Returns null when Apple
// doesn't know the transaction (or on a non-2xx), leaving the row as it was.
export async function fetchAppleSubscription(
  cfg: AppleIapConfig,
  originalTransactionId: string,
  environment: string,
  nowMs: number,
  // A token minted once for a whole cron pass. It is valid for five minutes,
  // so re-signing one per row is pure work.
  token?: string
): Promise<AppleLastTransaction | null> {
  const base = environment === "sandbox" ? APPLE_SERVER_API.sandbox : APPLE_SERVER_API.production;
  const res = await fetch(`${base}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`, {
    headers: { Authorization: `Bearer ${token ?? (await appleServerApiToken(cfg, nowMs))}` },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    data?: { lastTransactions?: AppleLastTransaction[] }[];
  } | null;
  for (const group of body?.data ?? []) {
    for (const t of group.lastTransactions ?? []) {
      if (t.originalTransactionId === originalTransactionId) return t;
    }
  }
  return null;
}
