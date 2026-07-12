import { defineConfig } from "vitest/config";

// Two projects:
//  - unit: pure functions (src/lib, public/js) in plain Node
//  - api:  the full Worker + a real D1 database via @cloudflare/vitest-pool-workers
export default defineConfig({
  test: {
    projects: ["./vitest.unit.config.mts", "./vitest.workers.config.mts"],
  },
});
