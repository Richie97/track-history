// Google Play subscriptions (NS-32 requirement 3): the Play Developer API for
// verifying a purchase token, and the OIDC check on Pub/Sub's push delivery of
// Real-Time Developer Notifications. All WebCrypto — the Worker has no
// google-auth-library and doesn't need one for two RS256 operations.

import type { Env } from "../../types";
import type { SubscriptionStatus } from "../entitlement";
import { JwsError, base64UrlDecode, base64UrlEncode, pemToDer } from "./jws";

export const ANDROID_PACKAGE_NAME = "app.trackevolution";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

export function parseServiceAccount(json: string | undefined): ServiceAccount | null {
  if (!json) return null;
  try {
    const sa = JSON.parse(json) as Partial<ServiceAccount>;
    if (typeof sa.client_email !== "string" || typeof sa.private_key !== "string") return null;
    return { client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri };
  } catch {
    return null;
  }
}

const encodeJson = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));

async function signRS256(payload: Record<string, unknown>, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const input = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

// Service-account OAuth: a signed JWT assertion traded for a short-lived
// access token. Minted per call — the cron and a purchase POST are rare
// enough that caching would only add a place for a stale token to hide.
export async function googleAccessToken(sa: ServiceAccount, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = await signRS256(
    { iss: sa.client_email, scope: ANDROID_PUBLISHER_SCOPE, aud: tokenUri, iat, exp: iat + 5 * 60 },
    sa.private_key
  );
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("google token exchange returned no access_token");
  return body.access_token;
}

// purchases.subscriptionsv2.get — the fields we read.
export type GoogleSubscriptionPurchase = {
  subscriptionState?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  testPurchase?: unknown;
  lineItems?: {
    productId?: string;
    expiryTime?: string; // RFC 3339
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: { basePlanId?: string };
  }[];
};

// Returns null when Play has never seen the token (404). Any other non-2xx
// throws — a transient failure must not read as "not a subscription".
export async function fetchGoogleSubscription(
  sa: ServiceAccount,
  purchaseToken: string,
  nowMs: number,
  // An access token minted once for a whole cron pass; it outlives the run, so
  // exchanging one per row is a round trip bought for nothing.
  accessToken?: string,
  packageName = ANDROID_PACKAGE_NAME
): Promise<GoogleSubscriptionPurchase | null> {
  const token = accessToken ?? (await googleAccessToken(sa, nowMs));
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}` +
    `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`play developer api failed: ${res.status}`);
  return (await res.json()) as GoogleSubscriptionPurchase;
}

export type GoogleState = {
  status: SubscriptionStatus;
  expiresAt: number | null;
  autoRenew: boolean | null;
  productId: string | null;
  environment: string;
  linkedPurchaseToken: string | null;
};

// subscriptionState → our row. CANCELED is still paid up until expiry, so it
// is `active` with auto_renew false; the not-entitled states each keep their
// own name so support can see why.
export function googleSubscriptionState(sub: GoogleSubscriptionPurchase, nowMs: number): GoogleState {
  const items = sub.lineItems ?? [];
  let expiresAt: number | null = null;
  let autoRenew: boolean | null = null;
  let productId: string | null = null;
  for (const item of items) {
    const t = item.expiryTime ? Date.parse(item.expiryTime) : NaN;
    if (Number.isFinite(t) && (expiresAt == null || t > expiresAt)) {
      expiresAt = t;
      autoRenew = item.autoRenewingPlan ? item.autoRenewingPlan.autoRenewEnabled === true : false;
      productId = item.productId ?? null;
    }
  }
  const state = sub.subscriptionState ?? "";
  let status: SubscriptionStatus;
  switch (state) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      status = "active";
      break;
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      status = "grace";
      break;
    case "SUBSCRIPTION_STATE_CANCELED":
      status = expiresAt != null && expiresAt > nowMs ? "active" : "expired";
      autoRenew = false;
      break;
    case "SUBSCRIPTION_STATE_ON_HOLD":
      status = "billing_retry";
      break;
    case "SUBSCRIPTION_STATE_PAUSED":
      status = "paused";
      break;
    case "SUBSCRIPTION_STATE_EXPIRED":
      status = "expired";
      break;
    default:
      status = "pending";
  }
  return {
    status,
    expiresAt,
    autoRenew,
    productId,
    environment: sub.testPurchase !== undefined ? "sandbox" : "production",
    linkedPurchaseToken: sub.linkedPurchaseToken ?? null,
  };
}

// ---------------------------------------------------------------------------
// RTDN push authentication
// ---------------------------------------------------------------------------

type Jwk = { kid?: string; kty: string; n: string; e: string; alg?: string };

// Google's signing keys rotate slowly and every RTDN push needs them, so they
// are cached for the isolate's life with a short TTL rather than re-fetched per
// delivery. A key id the cache doesn't know forces one refetch (below), so a
// rotation is picked up immediately rather than after the TTL.
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

async function googleJwks(url: string, nowMs: number, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.url === url && nowMs - jwksCache.fetchedAt < JWKS_TTL_MS)
    return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) {
    if (jwksCache?.url === url) return jwksCache.keys; // stale beats nothing
    throw new JwsError("could not fetch Google keys");
  }
  const body = (await res.json().catch(() => null)) as { keys?: Jwk[] } | null;
  if (!body?.keys) throw new JwsError("could not fetch Google keys");
  jwksCache = { url, keys: body.keys, fetchedAt: nowMs };
  return body.keys;
}

// Verifies the OIDC token Pub/Sub attaches to a push delivery: RS256 under
// Google's published keys, issued by Google, for this URL, from the expected
// service account. Throws JwsError on any failure.
export async function verifyGoogleOidcToken(
  token: string | null | undefined,
  opts: { audience: string; email: string; nowMs: number; jwksUrl?: string }
): Promise<Record<string, unknown>> {
  if (!token) throw new JwsError("missing bearer token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwsError("malformed token");
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    throw new JwsError("malformed token");
  }
  if (header.alg !== "RS256") throw new JwsError("unsupported token algorithm");

  const keys = await googleJwks(opts.jwksUrl ?? GOOGLE_JWKS_URL, opts.nowMs);
  let jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
  if (!jwk) {
    // Unknown kid: the cache may predate a rotation. One forced refetch.
    const fresh = await googleJwks(opts.jwksUrl ?? GOOGLE_JWKS_URL, opts.nowMs, true);
    jwk = fresh.find((k) => k.kid === header.kid) ?? (fresh.length === 1 ? fresh[0] : undefined);
  }
  if (!jwk) throw new JwsError("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new JwsError("token signature does not verify");

  if (!GOOGLE_ISSUERS.has(String(payload.iss))) throw new JwsError("wrong issuer");
  if (payload.aud !== opts.audience) throw new JwsError("wrong audience");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= opts.nowMs) throw new JwsError("token expired");
  if (payload.email !== opts.email || payload.email_verified !== true) throw new JwsError("wrong service account");
  return payload;
}

// The Pub/Sub envelope: { message: { data: base64(JSON) } }. Returns the
// decoded developer notification, or null when the body isn't one.
export type GoogleDeveloperNotification = {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: { version?: string; notificationType?: number; purchaseToken?: string; subscriptionId?: string };
  testNotification?: { version?: string };
};

export function decodePubSubMessage(body: unknown): GoogleDeveloperNotification | null {
  const data = (body as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== "string") return null;
  try {
    const bytes = Uint8Array.from(atob(data.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" ? (parsed as GoogleDeveloperNotification) : null;
  } catch {
    return null;
  }
}
