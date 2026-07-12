import { applyD1Migrations, env } from "cloudflare:test";

// Apply migrations/ to the test D1 before each test file runs.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
