import { Hono } from "hono";
import type { AppContext } from "../types";
import { userTotals } from "../db";

export const me = new Hono<AppContext>();

me.get("/me", async (c) => {
  const userId = c.get("userId");
  const user = await c.env.DB.prepare(
    "SELECT id, email, name, picture, share_slug FROM users WHERE id = ?"
  )
    .bind(userId)
    .first();
  const totals = await userTotals(c.env.DB, userId);
  return c.json({ user, totals });
});
