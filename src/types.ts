import type { Context } from "hono";

export type Env = {
  DB: D1Database;
  // The static-assets binding (wrangler.jsonc "assets"). Used by the share
  // page route to read index.html and inject per-slug OG meta.
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // Sign in with Apple — all four required for the feature to be enabled
  // (src/routes/auth.ts appleConfig); absent on forks without an Apple
  // developer account. APPLE_PRIVATE_KEY is the .p8 file's PEM contents.
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  IOS_APP_ID?: string;
  DEV_MODE?: string;
  DEV_USER_EMAIL?: string;
  DEV_USER_NAME?: string;

  // --- Subscriptions (NS-32) -------------------------------------------------
  // App Store Server API key (In-App Purchase role — a different key from the
  // Sign in with Apple one). Only the daily cron re-check needs it; purchase
  // verification is local against the pinned root.
  APPLE_IAP_KEY_ID?: string;
  APPLE_IAP_ISSUER_ID?: string;
  APPLE_IAP_PRIVATE_KEY?: string;
  // DEV_MODE only: an extra trust anchor (PEM) so the API tests can verify a
  // chain they hold the key to. Ignored without DEV_MODE.
  APPLE_IAP_TEST_ROOT_PEM?: string;
  // Optional: the first iOS build that sold the subscription. When set, an
  // AppTransaction legacy claim must have an originalApplicationVersion below
  // it; unset, the client's own version check is trusted.
  APPLE_FIRST_SUBSCRIPTION_BUILD?: string;
  // Google Play Developer API service-account key (the JSON file's contents),
  // with "View financial data" and "Manage orders and subscriptions".
  GOOGLE_PLAY_SERVICE_ACCOUNT?: string;
  // The service account the RTDN Pub/Sub push subscription authenticates as.
  // Defaults to the key's own client_email.
  GOOGLE_RTDN_EMAIL?: string;
  // Android legacy claims (POST /api/billing/google/legacy) succeed only before
  // this instant (ISO date or epoch ms). Unset ⇒ every claim succeeds; set it
  // to the flip date at phase D.
  LEGACY_CUTOFF?: string;
};

export type AppContext = {
  Bindings: Env;
  Variables: {
    userId: number;
    // users.entitled_until, read in the same statement as the session (no
    // extra round trip). null is free.
    entitledUntil: number | null;
  };
};

export type Ctx = Context<AppContext>;
