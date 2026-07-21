import type { Context } from "hono";

export type Env = {
  DB: D1Database;
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
};

export type AppContext = { Bindings: Env; Variables: { userId: number } };

export type Ctx = Context<AppContext>;
