import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/session";
import { apiClient, createEvent, createUser, sessionFor, signedInUser } from "./helpers";

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

  it("counts only past events (including today) in the totals", async () => {
    const { api } = await signedInUser();
    const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    await createEvent(api, { start_date: iso(0), days: 1 }); // today has started — counts
    await createEvent(api, { start_date: iso(30), days: 2 }); // upcoming — doesn't
    expect((await api("GET", "/me")).body.totals).toEqual({ events: 1, track_days: 1 });
  });
});

describe("DEV_MODE login", () => {
  // The bypass only answers on local dev hosts (see DEV_HOSTS in routes/auth.ts).
  it("signs in the fixed dev user and sets a working session cookie", async () => {
    const res = await SELF.fetch("http://localhost:8787/auth/login", { redirect: "manual" });
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
      const res = await SELF.fetch("http://localhost:8787/auth/login", { redirect: "manual" });
      const token = /session=([0-9a-f]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
      const me = await apiClient(token)("GET", "/me");
      return me.body.user.id as number;
    };
    expect(await login()).toBe(await login());
  });

  it("stores only a hash of the session token", async () => {
    const res = await SELF.fetch("http://localhost:8787/auth/login", { redirect: "manual" });
    const token = /session=([0-9a-f]+)/.exec(res.headers.get("set-cookie") ?? "")![1];
    const count = async (value: string) =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE token = ?")
          .bind(value)
          .first<{ n: number }>()
      )!.n;
    expect(await count(token)).toBe(0);
    expect(await count(await sha256Hex(token))).toBe(1);
  });

  it("falls through to real OAuth on a non-local host", async () => {
    const res = await SELF.fetch("https://example.com/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("session=");
  });
});

describe("DEV_MODE entitlement", () => {
  // The tier control the UI suites use to declare what they exercise. Same gate
  // as the login bypass: DEV_MODE *and* a local dev host.
  const login = async () => {
    const res = await SELF.fetch("http://localhost:8787/auth/login", { redirect: "manual" });
    return /session=([0-9a-f]+)/.exec(res.headers.get("set-cookie") ?? "")![1];
  };
  const setTier = (token: string | undefined, body: unknown, origin = "http://localhost:8787") =>
    SELF.fetch(`${origin}/auth/dev/entitlement`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Cookie: `session=${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("grants and revokes Pro for the signed-in account", async () => {
    const token = await login();
    expect((await apiClient(token)("GET", "/me")).body.entitlement.tier).toBe("free");

    const on = await setTier(token, { pro: true });
    expect(on.status).toBe(200);
    const granted = await apiClient(token)("GET", "/me");
    expect(granted.body.entitlement.tier).toBe("pro");
    expect(granted.body.entitlement.source).toBe("legacy");

    const off = await setTier(token, { pro: false });
    expect(off.status).toBe(200);
    expect((await off.json<{ entitled_until: number | null }>()).entitled_until).toBeNull();
    expect((await apiClient(token)("GET", "/me")).body.entitlement.tier).toBe("free");
  });

  it("is idempotent, so a suite can set the tier it wants on every test", async () => {
    const token = await login();
    for (const pro of [true, true, false, false]) {
      expect((await setTier(token, { pro })).status).toBe(200);
    }
    expect((await apiClient(token)("GET", "/me")).body.entitlement.tier).toBe("free");
  });

  // A separate account, so the store row it plants can't follow the dev user
  // into the tests below — D1 is reset per *file*, not per test.
  it("leaves a real purchase alone when asked for Free", async () => {
    const { id, token, api } = await signedInUser();
    // A row this route does not own: turning the dev grant off must not
    // silently strip an account of a subscription it is actually paying for.
    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id, provider, product_id, external_id, status, expires_at, created_at, updated_at)
       VALUES (?, 'apple', 'pro.monthly', 'apple-real', 'active', ?, 0, 0)`
    )
      .bind(id, Date.now() + 30 * 86_400_000)
      .run();
    await setTier(token, { pro: true });
    await setTier(token, { pro: false });
    const me = await api("GET", "/me");
    expect(me.body.entitlement.tier).toBe("pro");
    expect(me.body.entitlement.source).toBe("apple");
  });

  it("rejects a request without a session, and a body that isn't a boolean", async () => {
    expect((await setTier(undefined, { pro: true })).status).toBe(401);
    const token = await login();
    expect((await setTier(token, { pro: "yes" })).status).toBe(400);
    expect((await setTier(token, {})).status).toBe(400);
  });

  it("reads as absent on a non-local host, so a leaked DEV_MODE grants nothing", async () => {
    const token = await login();
    await setTier(token, { pro: false });
    const res = await setTier(token, { pro: true }, "https://example.com");
    expect(res.status).toBe(404);
    expect((await apiClient(token)("GET", "/me")).body.entitlement.tier).toBe("free");
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
      .bind(await sha256Hex(token))
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
    expect((await api("GET", "/me")).status).toBe(401);
  });
});
