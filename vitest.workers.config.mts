import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { createFetchMock } from "miniflare";
import { defineConfig } from "vitest/config";

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

// Mock for Apple's token endpoint. This pool version has no per-test
// `fetchMock` export, so the interceptor is defined once here and driven by
// the tests through the authorization code itself: tests send
// base64url(JSON of the id_token payload) as the code, and the mock echoes it
// back inside an unsigned id_token (the Worker trusts the payload without a
// signature check — it normally arrives over TLS from Apple). The literal
// code "apple-error" answers with no id_token, simulating an Apple-side
// failure. The request body arrives as a ReadableStream, hence the async
// data handler (the options-callback reply form must stay synchronous).
function appleFetchMock() {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const b64Url = (s: string) => Buffer.from(s).toString("base64url");
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
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          fetchMock: appleFetchMock(),
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
            APPLE_PRIVATE_KEY: await testAppleKeyPem(),
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
