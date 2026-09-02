import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { createFetchMock } from "miniflare";
import { defineConfig } from "vitest/config";
import { TEST_PLAY_SERVICE_ACCOUNT_EMAIL, appleMockResponse } from "./test/billing-helpers";
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
  fetchMock
    .get("https://oauth2.googleapis.com")
    .intercept({ method: "POST", path: "/token" })
    .reply(200, { access_token: "test-access-token", expires_in: 3600, token_type: "Bearer" })
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
