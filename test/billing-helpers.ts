// Signing helpers shared by the billing unit tests, the API tests and the
// vitest workers config's store mocks. Pure WebCrypto, so they run in Node and
// in workerd alike.

export type Chain = { leaf: string; leafKey: string; intermediate: string; root: string };

// The Play service account the workers config wires in as GOOGLE_PLAY_SERVICE_ACCOUNT.
export const TEST_PLAY_SERVICE_ACCOUNT_EMAIL = "play@track-evolution-tests.iam.gserviceaccount.com";

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
}
export const pemToB64 = (pem: string) => pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
export function b64urlDecodeJson(s: string): any {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
}

// An ES256 JWS carrying the chain in x5c — the shape StoreKit 2 hands the app.
export async function signFixtureJws(
  payload: Record<string, unknown>,
  chain: Chain,
  opts: { leaf?: string; leafKey?: string; alg?: string } = {}
): Promise<string> {
  const x5c = [opts.leaf ?? chain.leaf, chain.intermediate, chain.root].map(pemToB64);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(opts.leafKey ?? chain.leafKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signingInput = `${b64urlJson({ alg: opts.alg ?? "ES256", x5c })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// An RS256 JWT — what Pub/Sub's OIDC push token looks like.
export async function signRS256Jwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKeyPem: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const input = `${b64urlJson({ alg: "RS256", typ: "JWT", ...header })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

// The App Store Server API mock's contract (vitest.workers.config.mts): an
// originalTransactionId of the form "<anything>~<base64url JSON spec>" makes
// the mock answer GET /inApps/v1/subscriptions/<id> with a lastTransactions
// entry it signs itself from the spec. The literal "apple-404" answers 404.
export type AppleMockSpec = {
  status?: number;
  expiresDate?: number;
  revocationDate?: number;
  productId?: string;
  autoRenewStatus?: number;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  environment?: string;
};
export const appleMockId = (prefix: string, spec: AppleMockSpec) => `${prefix}~${b64urlJson(spec)}`;

export async function appleMockResponse(id: string, chain: Chain, bundleId: string) {
  const spec: AppleMockSpec = b64urlDecodeJson(id.slice(id.indexOf("~") + 1));
  const signedDate = 1_800_000_000_000;
  const signedTransactionInfo = await signFixtureJws(
    {
      bundleId,
      originalTransactionId: id,
      transactionId: `${id}-latest`,
      productId: spec.productId ?? "app.trackevolution.pro.monthly",
      type: "Auto-Renewable Subscription",
      environment: spec.environment ?? "Sandbox",
      expiresDate: spec.expiresDate,
      revocationDate: spec.revocationDate,
      signedDate,
    },
    chain
  );
  const signedRenewalInfo = await signFixtureJws(
    {
      originalTransactionId: id,
      autoRenewStatus: spec.autoRenewStatus ?? 1,
      gracePeriodExpiresDate: spec.gracePeriodExpiresDate,
      isInBillingRetryPeriod: spec.isInBillingRetryPeriod,
      signedDate,
    },
    chain
  );
  return {
    environment: spec.environment ?? "Sandbox",
    bundleId,
    data: [
      {
        subscriptionGroupIdentifier: "21000000",
        lastTransactions: [{ originalTransactionId: id, status: spec.status ?? 1, signedTransactionInfo, signedRenewalInfo }],
      },
    ],
  };
}

// The Play Developer API mock's contract: a purchase token that is the
// base64url of a subscriptionsv2 response body is answered with that body;
// the literal "google-404" answers 404.
export const googleMockToken = (body: Record<string, unknown>) => b64urlJson(body);
