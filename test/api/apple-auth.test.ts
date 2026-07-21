import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiClient, createUser } from "./helpers";

// Sign in with Apple: the authorize redirect, the cross-site form_post
// callback (web cookie session + native PKCE code), and account linking by
// email. Apple's token endpoint is mocked in vitest.workers.config.mts — the
// authorization code a test sends *is* the base64url id_token payload the
// mock echoes back, so each test picks its own identity via codeFor().

function codeFor(payload: Record<string, unknown>) {
  return btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

// Runs GET /auth/apple/login and returns the state + the cookies to send back.
async function appleLogin(query = "") {
  const res = await SELF.fetch(`https://example.com/auth/apple/login${query}`, {
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  return {
    location,
    state: location.searchParams.get("state")!,
    cookieHeader: setCookies(res)
      .map((c) => c.split(";")[0])
      .join("; "),
    setCookies: setCookies(res),
  };
}

async function postCallback(form: Record<string, string>, cookieHeader: string) {
  return SELF.fetch("https://example.com/auth/apple/callback", {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
    },
    body: new URLSearchParams(form),
  });
}

function sessionCookieToken(res: Response) {
  const cookie = setCookies(res).find((c) => c.startsWith("session=")) ?? "";
  return /session=([0-9a-f]+)/.exec(cookie)?.[1];
}

describe("GET /auth/providers", () => {
  it("advertises both providers when Apple is configured", async () => {
    const res = await SELF.fetch("https://example.com/auth/providers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ google: true, apple: true });
  });
});

describe("GET /auth/apple/login", () => {
  it("redirects to Apple's authorize endpoint with form_post and a state cookie", async () => {
    const { location, state, setCookies } = await appleLogin();
    expect(location.origin).toBe("https://appleid.apple.com");
    expect(location.pathname).toBe("/auth/authorize");
    expect(location.searchParams.get("client_id")).toBe("app.trackevolution.web");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("response_mode")).toBe("form_post");
    expect(location.searchParams.get("scope")).toBe("name email");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://example.com/auth/apple/callback"
    );
    // The callback is a cross-site POST — the state cookie must ride along.
    const stateCookie = setCookies.find((c) => c.startsWith("apple_oauth_state="))!;
    expect(stateCookie).toContain(state);
    expect(stateCookie).toMatch(/SameSite=None/i);
    expect(stateCookie).toMatch(/Secure/i);
  });

  it("requires code_challenge for the app client", async () => {
    const res = await SELF.fetch("https://example.com/auth/apple/login?client=app", {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/apple/callback (web)", () => {
  it("creates a user with the first-auth name and signs them in", async () => {
    const { state, cookieHeader } = await appleLogin();
    const res = await postCallback(
      {
        code: codeFor({ sub: "apple-sub-1", email: "senna@example.com", email_verified: true }),
        state,
        user: JSON.stringify({ name: { firstName: "Ayrton", lastName: "Senna" } }),
      },
      cookieHeader
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const token = sessionCookieToken(res);
    expect(token).toBeTruthy();
    const me = await apiClient(token)("GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("senna@example.com");
    expect(me.body.user.name).toBe("Ayrton Senna");
  });

  it("reuses the account on a later sign-in and keeps the stored name", async () => {
    // Apple sends email_verified as the string "true" — that form must pass.
    const code = codeFor({ sub: "apple-sub-2", email: "prost@example.com", email_verified: "true" });
    const first = await appleLogin();
    const firstRes = await postCallback(
      {
        code,
        state: first.state,
        user: JSON.stringify({ name: { firstName: "Alain", lastName: "Prost" } }),
      },
      first.cookieHeader
    );
    const firstId = (await apiClient(sessionCookieToken(firstRes))("GET", "/me")).body.user.id;

    // Apple never re-sends the name after the first authorization.
    const second = await appleLogin();
    const secondRes = await postCallback({ code, state: second.state }, second.cookieHeader);
    const me = (await apiClient(sessionCookieToken(secondRes))("GET", "/me")).body;
    expect(me.user.id).toBe(firstId);
    expect(me.user.name).toBe("Alain Prost");
  });

  it("links to an existing account with the same email", async () => {
    const existing = await createUser("Existing User");
    const { state, cookieHeader } = await appleLogin();
    const res = await postCallback(
      { code: codeFor({ sub: "apple-sub-3", email: existing.email, email_verified: true }), state },
      cookieHeader
    );
    const me = (await apiClient(sessionCookieToken(res))("GET", "/me")).body;
    expect(me.user.id).toBe(existing.id);

    const row = await env.DB.prepare("SELECT apple_sub FROM users WHERE id = ?")
      .bind(existing.id)
      .first<{ apple_sub: string }>();
    expect(row!.apple_sub).toBe("apple-sub-3");
  });

  it("rejects a state mismatch", async () => {
    const { cookieHeader } = await appleLogin();
    const res = await postCallback(
      { code: codeFor({ sub: "x", email: "x@example.com" }), state: "forged-state" },
      cookieHeader
    );
    expect(res.status).toBe(400);
  });

  it("rejects an id_token without an email", async () => {
    const { state, cookieHeader } = await appleLogin();
    const res = await postCallback({ code: codeFor({ sub: "apple-sub-4" }), state }, cookieHeader);
    expect(res.status).toBe(502);
  });

  it("rejects an unverified email (accounts are claimed/linked by email)", async () => {
    const unverified = [
      { sub: "apple-sub-6", email: "unverified@example.com", email_verified: false },
      { sub: "apple-sub-7", email: "unverified2@example.com", email_verified: "false" },
      { sub: "apple-sub-8", email: "no-claim@example.com" }, // missing claim = unverified
    ];
    for (const payload of unverified) {
      const { state, cookieHeader } = await appleLogin();
      const res = await postCallback({ code: codeFor(payload), state }, cookieHeader);
      expect(res.status).toBe(403);
    }
  });

  it("surfaces an Apple response with no id_token", async () => {
    const { state, cookieHeader } = await appleLogin();
    const res = await postCallback({ code: "apple-error", state }, cookieHeader);
    expect(res.status).toBe(502);
  });

  it("sends the user back to the login screen when they cancel at Apple", async () => {
    const { cookieHeader } = await appleLogin();
    const res = await postCallback({ error: "user_cancelled_authorize" }, cookieHeader);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("POST /auth/apple/callback (native app)", () => {
  it("bounces to the custom scheme with a code the app can exchange", async () => {
    const verifier = crypto.randomUUID().replaceAll("-", "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

    const { state, cookieHeader } = await appleLogin(`?client=app&code_challenge=${challenge}`);
    expect(state.endsWith(".app")).toBe(true);
    const res = await postCallback(
      {
        code: codeFor({ sub: "apple-sub-5", email: "app-user@example.com", email_verified: true }),
        state,
      },
      cookieHeader
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^trackevolution:\/\/auth\?code=[0-9a-f]+$/);

    const appCode = /code=([0-9a-f]+)/.exec(location)![1];
    const exchange = await SELF.fetch("https://example.com/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: appCode, code_verifier: verifier }),
    });
    expect(exchange.status).toBe(200);
    const { token } = (await exchange.json()) as { token: string };
    const me = await SELF.fetch("https://example.com/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.email).toBe("app-user@example.com");
  });
});
