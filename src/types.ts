import type { Context } from "hono";

export type Env = {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  IOS_APP_ID?: string;
  DEV_MODE?: string;
  DEV_USER_EMAIL?: string;
  DEV_USER_NAME?: string;
  REVIEW_DEMO_SECRET?: string;
  REVIEW_DEMO_EMAIL?: string;
  REVIEW_DEMO_NAME?: string;
};

export type AppContext = { Bindings: Env; Variables: { userId: number } };

export type Ctx = Context<AppContext>;
