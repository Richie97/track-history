import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiClient, createUser, sessionFor, signedInUser } from "./helpers";

describe("API auth middleware", () => {
  it("rejects requests without a session cookie", async () => {
    const res = await apiClient()("GET", "/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("rejects an unknown session token", async () => {
    const res = await apiClient("bogus-token")("GET", "/me");
    expect(res.status).toBe(401);
  });

  it("rejects an expired session", async () => {
    const user = await createUser();
    const token = await sessionFor(user.id, Date.now() - 1000);
    const res = await apiClient(token)("GET", "/me");
    expect(res.status).toBe(401);
  });

  it("accepts a live session and returns the current user with totals", async () => {
    const { api, email } = await signedInUser();
    const res = await api("GET", "/me");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.totals).toEqual({ events: 0, track_days: 0 });
  });
});

describe("DEV_MODE login", () => {
  it("signs in the fixed dev user and sets a working session cookie", async () => {
    const res = await SELF.fetch("https://example.com/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    const token = /session=([0-9a-f]+)/.exec(cookie)?.[1];
    expect(token).toBeTruthy();

    const me = await apiClient(token)("GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("dev@example.com");
  });

  it("reuses the same user across logins", async () => {
    const login = async () => {
      const res = await SELF.fetch("https://example.com/auth/login", { redirect: "manual" });
      const token = /session=([0-9a-f]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
      const me = await apiClient(token)("GET", "/me");
      return me.body.user.id as number;
    };
    expect(await login()).toBe(await login());
  });
});

describe("logout", () => {
  it("deletes the session so the token stops working", async () => {
    const { token, api } = await signedInUser();
    const out = await SELF.fetch("https://example.com/auth/logout", {
      method: "POST",
      headers: { Cookie: `session=${token}` },
    });
    expect(out.status).toBe(200);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE token = ?")
      .bind(token)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
    expect((await api("GET", "/me")).status).toBe(401);
  });
});
