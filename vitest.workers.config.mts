import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_MODE: "1",
            DEV_USER_EMAIL: "dev@example.com",
            DEV_USER_NAME: "Dev User",
            REVIEW_DEMO_SECRET: "test-demo-secret",
            REVIEW_DEMO_EMAIL: "demo@example.com",
            REVIEW_DEMO_NAME: "Demo Driver",
            GOOGLE_CLIENT_ID: "test-client-id",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
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
