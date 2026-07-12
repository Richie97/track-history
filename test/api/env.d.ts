/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env as AppEnv } from "../../src/types";
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
