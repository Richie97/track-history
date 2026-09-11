/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as AppEnv } from "../../src/types";
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      // Billing test fixtures (vitest.workers.config.mts): the synthetic Apple
      // chain as JSON, and the RSA key that signs Pub/Sub OIDC push tokens.
      TEST_APPLE_CHAIN: string;
      TEST_GOOGLE_RSA_PRIVATE_KEY_PEM: string;
    }
  }
}
