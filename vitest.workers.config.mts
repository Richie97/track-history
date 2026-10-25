import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { createFetchMock } from "miniflare";
import { defineConfig } from "vitest/config";
import {
  TEST_PLAY_SERVICE_ACCOUNT_EMAIL,
  TEST_STRIPE_PRICE_MONTHLY,
  TEST_STRIPE_PRICE_YEARLY,
  TEST_STRIPE_SECRET_KEY,
  TEST_STRIPE_WEBHOOK_SECRET,
  appleMockResponse,
  b64urlDecodeJson,
} from "./test/billing-helpers";
import { chain as appleTestChain } from "./test/fixtures/billing/pems.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Throwaway P-256 key for the Apple sign-in tests: the client-secret JWT
// needs a real key to sign with, but nothing ever verifies it (Apple's token
// endpoint is mocked below), so a fresh per-run key is fine.
async function testAppleKeyPem() {
  const { privateKey } = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const der = Buffer.from((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`;
}

// Throwaway RSA key for the Google billing tests: it plays the Play service
// account (signs the token-exchange assertion nobody verifies) AND Google's
// OIDC signing key (the JWKS mock publishes its public half, and the RTDN tests
// sign push tokens with the private half via TEST_GOOGLE_RSA_PRIVATE_KEY_PEM).
async function testRsaKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const der = Buffer.from((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----\n`,
    jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid: "test-kid" },
  };
}

const TEST_BUNDLE_ID = "app.trackevolution";

// Mock for Apple's token endpoint. This pool version has no per-test
// `fetchMock` export, so the interceptor is defined once here and driven by
// the tests through the authorization code itself: tests send
// base64url(JSON of the id_token payload) as the code, and the mock echoes it
// back inside an unsigned id_token (the Worker trusts the payload without a
// signature check — it normally arrives over TLS from Apple). The literal
// code "apple-error" answers with no id_token, simulating an Apple-side
// failure. The request body arrives as a ReadableStream, hence the async
// data handler (the options-callback reply form must stay synchronous).
// A mocked request's body arrives as a ReadableStream (or already a string).
async function bodyText(raw: unknown): Promise<string> {
  if (raw && typeof raw === "object" && "getReader" in raw) {
    const chunks: Buffer[] = [];
    for await (const chunk of raw as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString();
  }
  return String(raw ?? "");
}

function appleFetchMock(googleJwk: object) {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const b64Url = (s: string) => Buffer.from(s).toString("base64url");

  // --- store mocks for the billing tests (contracts in test/billing-helpers.ts) ---
  // App Store Server API, both environments: the id in the path carries the
  // spec the mock signs a transaction from; "apple-404" is an unknown id.
  // The reply(status, callback) form is the one that allows an async data
  // callback, so the "known"/"unknown" cases are two interceptors by path.
  for (const host of ["https://api.storekit.itunes.apple.com", "https://api.storekit-sandbox.itunes.apple.com"]) {
    fetchMock
      .get(host)
      .intercept({ method: "GET", path: /^\/inApps\/v1\/subscriptions\/[^/~]+$/ })
      .reply(404, { errorCode: 4040010, errorMessage: "Original transaction id not found." })
      .persist();
    fetchMock
      .get(host)
      .intercept({ method: "GET", path: /^\/inApps\/v1\/subscriptions\/[^/]*~[^/]*$/ })
      .reply(200, async (opts) => {
        const id = decodeURIComponent(String(opts.path).split("/").pop() ?? "");
        return appleMockResponse(id, appleTestChain, TEST_BUNDLE_ID);
      })
      .persist();
  }
  // Google: the service-account token exchange, the Play Developer API (a
  // purchase token that is base64url JSON is echoed back as the body;
  // "google-404" is a token Play never issued) and the OIDC JWKS the RTDN route
  // verifies push tokens against.
  // The token endpoint answers two callers. The Play service account's JWT
  // exchange gets a fixed token. The YouTube connect tests (NS-46,
  // test/api/youtube.test.ts) drive it through the authorization code, which
  // is base64url JSON of the id_token payload plus an optional `scope` (the
  // scopes granted) and `noRefresh`, echoed back as a token response the way
  // the Apple mock echoes its code; "yt-bad" answers without a token. The
  // status is always 200: undici's mock can only compute the *body* from the
  // async request body, so the error statuses (invalid_grant, outages) are the
  // queue and cron tests', which inject their own fetch.
  fetchMock
    .get("https://oauth2.googleapis.com")
    .intercept({ method: "POST", path: "/token" })
    .reply(200, async (opts) => {
      const form = new URLSearchParams(await bodyText(opts.body));
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code") ?? "";
        if (code === "yt-bad") return { error: "invalid_grant" };
        const payload = JSON.parse(Buffer.from(code, "base64url").toString());
        const { scope = "openid email https://www.googleapis.com/auth/youtube.upload", noRefresh, ...claims } = payload;
        return {
          access_token: `yt-access-${claims.sub}`,
          ...(noRefresh ? {} : { refresh_token: `yt-refresh-${claims.sub}` }),
          expires_in: 3600,
          scope,
          token_type: "Bearer",
          id_token: `${b64Url('{"alg":"RS256"}')}.${b64Url(JSON.stringify(claims))}.fake-signature`,
        };
      }
      return { access_token: "test-access-token", expires_in: 3600, token_type: "Bearer" };
    })
    .persist();
  // Google's revoke endpoint (disconnecting YouTube).
  fetchMock
    .get("https://oauth2.googleapis.com")
    .intercept({ method: "POST", path: "/revoke" })
    .reply(200, {})
    .persist();
  fetchMock
    .get("https://androidpublisher.googleapis.com")
    .intercept({ method: "GET", path: /\/purchases\/subscriptionsv2\/tokens\/google-404$/ })
    .reply(404, { error: { code: 404, message: "The purchase token was not found." } })
    .persist();
  fetchMock
    .get("https://androidpublisher.googleapis.com")
    .intercept({ method: "GET", path: /\/purchases\/subscriptionsv2\/tokens\/(?!google-404$).+$/ })
    .reply(200, (opts) => {
      const token = decodeURIComponent(String(opts.path).split("/").pop() ?? "");
      return JSON.parse(Buffer.from(token, "base64url").toString());
    })
    .persist();
  fetchMock
    .get("https://www.googleapis.com")
    .intercept({ method: "GET", path: "/oauth2/v3/certs" })
    .reply(200, { keys: [googleJwk] })
    .persist();

  // Stripe (NS-49; the contract is in test/billing-helpers.ts). Requests that
  // don't carry the test key and a pinned API version are refused, so a route
  // that forgot either fails its test.
  const header = (opts: { headers?: unknown }, name: string): string | undefined => {
    const h = opts.headers as Record<string, string> | string[] | undefined;
    if (Array.isArray(h)) {
      for (let i = 0; i < h.length; i += 2) if (String(h[i]).toLowerCase() === name) return String(h[i + 1]);
      return undefined;
    }
    for (const [k, v] of Object.entries(h ?? {})) if (k.toLowerCase() === name) return String(v);
    return undefined;
  };
  const stripeAuthorized = (opts: { headers?: unknown }) =>
    header(opts, "authorization") === `Bearer ${TEST_STRIPE_SECRET_KEY}` && /^\d{4}-\d{2}-\d{2}\./.test(header(opts, "stripe-version") ?? "");
  const unauthorized = { error: { type: "invalid_request_error", message: "mock: missing test key or Stripe-Version" } };
  const readBody = async (raw: unknown) => {
    if (raw && typeof raw === "object" && "getReader" in raw) {
      const chunks: Buffer[] = [];
      for await (const chunk of raw as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString();
    }
    return String(raw ?? "");
  };
  fetchMock
    .get("https://api.stripe.com")
    .intercept({ method: "GET", path: /^\/v1\/(subscriptions|checkout\/sessions|prices|invoices|charges)\/[^/?]*missing(\?.*)?$/ })
    .reply(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such object" } })
    .persist();
  fetchMock
    .get("https://api.stripe.com")
    .intercept({ method: "GET", path: /^\/v1\/(subscriptions|checkout\/sessions|prices|invoices|charges)\/(?![^/?]*missing(\?|$))[^/?]+(\?.*)?$/ })
    .reply((opts) => {
      if (!stripeAuthorized(opts)) return { statusCode: 401, data: unauthorized };
      const id = decodeURIComponent(String(opts.path).split("?")[0].split("/").pop() ?? "");
      const prefix = /^(sub|cs|price|in|ch)_/.exec(id)?.[0] ?? "";
      return { statusCode: 200, data: { ...b64urlDecodeJson(id.slice(prefix.length)), id } };
    })
    .persist();
  fetchMock
    .get("https://api.stripe.com")
    .intercept({ method: "POST", path: "/v1/customers" })
    .reply(200, async (opts) => {
      const form = new URLSearchParams(await readBody(opts.body));
      if (!stripeAuthorized(opts)) return { ...unauthorized, id: null };
      return { id: `cus_test_${form.get("metadata[user_id]")}`, email: form.get("email") };
    })
    .persist();
  for (const [path, base] of [
    ["/v1/checkout/sessions", "https://checkout.stripe.com/c/pay/cs_test"],
    ["/v1/billing_portal/sessions", "https://billing.stripe.com/p/session/test"],
  ]) {
    fetchMock
      .get("https://api.stripe.com")
      .intercept({ method: "POST", path })
      .reply(200, async (opts) => {
        const body = await readBody(opts.body);
        if (!stripeAuthorized(opts)) return { ...unauthorized, url: null };
        return { id: "cs_test_created", url: `${base}#${Buffer.from(body).toString("base64url")}` };
      })
      .persist();
  }

  fetchMock
    .get("https://appleid.apple.com")
    .intercept({ method: "POST", path: "/auth/token" })
    .reply(200, async (opts) => {
      let raw = opts.body as unknown;
      if (raw && typeof raw === "object" && "getReader" in raw) {
        const chunks: Buffer[] = [];
        for await (const chunk of raw as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        raw = Buffer.concat(chunks).toString();
      }
      const code = new URLSearchParams(String(raw ?? "")).get("code") ?? "";
      if (code === "apple-error") return {};
      const payload = Buffer.from(code, "base64url").toString();
      return { id_token: `${b64Url('{"alg":"RS256"}')}.${b64Url(payload)}.fake-signature` };
    })
    .persist();

  // Client-ID metadata documents for the MCP OAuth tests
  // (test/api/oauth.test.ts): one well-formed, one naming a different
  // client_id than the URL it was fetched from.
  fetchMock
    .get("https://assistant.example")
    .intercept({ method: "GET", path: "/oauth/client.json" })
    .reply(200, {
      client_id: "https://assistant.example/oauth/client.json",
      client_name: "Metadata Assistant",
      redirect_uris: ["https://assistant.example/callback"],
    })
    .persist();
  fetchMock
    .get("https://assistant.example")
    .intercept({ method: "GET", path: "/oauth/mismatch.json" })
    .reply(200, {
      client_id: "https://evil.example/oauth/client.json",
      client_name: "Mismatched",
      redirect_uris: ["https://assistant.example/callback"],
    })
    .persist();
  return fetchMock;
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(dirname, "migrations"));
  const rsa = await testRsaKey();
  const appleKeyPem = await testAppleKeyPem();
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          fetchMock: appleFetchMock(rsa.jwk),
          // The upload queue goes to a queue nothing consumes, so a test's
          // POST never races a real consumer reaching for Google: the tests
          // step uploads themselves (test/api/youtube.test.ts).
          queueProducers: { YOUTUBE_QUEUE: { queueName: "test-youtube-unconsumed" } },
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_MODE: "1",
            DEV_USER_EMAIL: "dev@example.com",
            DEV_USER_NAME: "Dev User",
            GOOGLE_CLIENT_ID: "test-client-id",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            APPLE_CLIENT_ID: "app.trackevolution.web",
            APPLE_TEAM_ID: "TESTTEAM01",
            APPLE_KEY_ID: "TESTKEY001",
            APPLE_PRIVATE_KEY: appleKeyPem,
            OPENAI_APPS_CHALLENGE: "test-openai-challenge",
            // Best-lap video URLs (NS-45). CLIPS itself comes from
            // wrangler.jsonc's r2_buckets, which miniflare serves locally.
            CLIP_URL_SECRET: "test-clip-url-secret",
            // YouTube (NS-46). The token key is a fixed 32 bytes so a test can
            // decrypt what the Worker stored; the allowlist stays unset (every
            // account), and the tests that need it narrow it per request.
            YOUTUBE_CLIENT_ID: "test-youtube-client-id",
            YOUTUBE_CLIENT_SECRET: "test-youtube-client-secret",
            YOUTUBE_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
            // Billing (NS-32). The App Store Server API key is only ever used
            // to sign requests the mock doesn't verify, so the sign-in key
            // stands in. APPLE_IAP_TEST_ROOT_PEM is honoured under DEV_MODE so
            // JWSs signed with the fixture chain verify.
            APPLE_IAP_KEY_ID: "IAPKEY0001",
            APPLE_IAP_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
            APPLE_IAP_PRIVATE_KEY: appleKeyPem,
            APPLE_IAP_TEST_ROOT_PEM: appleTestChain.root,
            TEST_APPLE_CHAIN: JSON.stringify(appleTestChain),
            GOOGLE_PLAY_SERVICE_ACCOUNT: JSON.stringify({
              type: "service_account",
              client_email: TEST_PLAY_SERVICE_ACCOUNT_EMAIL,
              private_key: rsa.pem,
              token_uri: "https://oauth2.googleapis.com/token",
            }),
            TEST_GOOGLE_RSA_PRIVATE_KEY_PEM: rsa.pem,
            // Stripe (NS-49): api.stripe.com is the mock above.
            STRIPE_SECRET_KEY: TEST_STRIPE_SECRET_KEY,
            STRIPE_WEBHOOK_SECRET: TEST_STRIPE_WEBHOOK_SECRET,
            STRIPE_PRICE_MONTHLY: TEST_STRIPE_PRICE_MONTHLY,
            STRIPE_PRICE_YEARLY: TEST_STRIPE_PRICE_YEARLY,
          },
        },
      }),
    ],
    test: {
      name: "api",
      include: ["test/api/**/*.test.ts"],
      setupFiles: ["./test/api/setup.ts"],
    },
  };
});
