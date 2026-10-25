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
  // OpenAI Apps domain-verification token, served verbatim at
  // /.well-known/openai-apps-challenge (src/routes/wellKnown.ts). A secret.
  OPENAI_APPS_CHALLENGE?: string;
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
  // Stripe, the web's purchase surface (NS-49, lib/billing/stripe.ts). A
  // restricted key (write: Checkout Sessions, Customers, Billing Portal
  // sessions; read: Subscriptions, Prices, Invoices, Charges), the webhook
  // endpoint's signing secret, and the two price ids — secrets rather than
  // vars because they differ between test and live mode and belong with the
  // key that picks the mode. Without the key and both prices every Stripe
  // route is a 503 and `/billing/stripe/plans` says `{ enabled: false }`.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_YEARLY?: string;

  // --- MCP rate limits (lib/ratelimit.ts; `ratelimits` in wrangler.jsonc) ---
  // Optional so a fork without them still runs unlimited.
  MCP_CALLS?: RateLimit; // per connection (grant): POST /mcp
  OAUTH_TOKEN?: RateLimit; // per client id: POST /oauth/token
  OAUTH_REGISTER?: RateLimit; // per IP: POST /oauth/register
  EXPORT?: RateLimit; // per user: GET /api/export/* (NS-44)
  CLIP_PARTS?: RateLimit; // per user: PUT /api/clips/:id/parts/:n (NS-45)

  // --- Best-lap video clips (NS-45, routes/clips.ts) -------------------------
  // The R2 bucket the clips live in (r2_buckets in wrangler.jsonc). Optional so
  // a fork without one still runs: every clip route answers 503 instead.
  CLIPS?: R2Bucket;
  // HMAC key for the signed /clips/<id>.mp4 URLs (lib/clips.ts). A secret.
  CLIP_URL_SECRET?: string;

  // --- Publish a best-lap video to YouTube (NS-46, routes/youtube.ts) --------
  // The feature is on only with all three secrets and the queue
  // (youtubeConfigured in lib/youtube.ts). The OAuth client belongs to a
  // separate Google Cloud project from sign-in's.
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  // 32 random bytes, base64: the AES-GCM key the grant's tokens and each
  // upload's resumable session URL are encrypted under.
  YOUTUBE_TOKEN_KEY?: string;
  // Uploads per Pacific day for the whole project (a var). Unset: no budget.
  YOUTUBE_DAILY_BUDGET?: string;
  // Comma-separated emails. While set, only these accounts see the feature —
  // the audit reviewers and our own testing before launch. A secret rather
  // than a var, because a deploy replaces vars (see wrangler.jsonc).
  YOUTUBE_ALLOWLIST?: string;
  // The upload queue (queues.producers in wrangler.jsonc). Optional so the
  // test pool can supply its own and a fork without Queues still runs.
  YOUTUBE_QUEUE?: Queue<{ upload_id: number }>;
};

export type AuthTransport = "cookie" | "bearer";

export type AppContext = {
  Bindings: Env;
  Variables: {
    userId: number;
    // users.entitled_until, read in the same statement as the session (no
    // extra round trip). null is free.
    entitledUntil: number | null;
    // Which credential requireSession accepted: the web's `session` cookie or
    // a native app's bearer token. GET /me masks a Stripe entitlement source
    // on anything but the cookie (lib/entitlement.ts maskEntitlementSource);
    // unset — the coach mount, the MCP tools' private copy — masks too.
    authTransport?: AuthTransport;
  };
};

export type Ctx = Context<AppContext>;
