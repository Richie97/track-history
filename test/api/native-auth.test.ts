import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/session";
import { createUser, sessionFor, signedInUser } from "./helpers";

// The native-app auth surface: Bearer tokens on /api/*, CORS for the
// Capacitor WebView origins, and the system-browser OAuth flow's one-time
// code exchange (PKCE S256). Tests run with DEV_MODE=1, so
// /auth/login?client=app mints the code without Google.

async function pkcePair() {
  const verifier = crypto.randomUUID().replaceAll("-", "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

// Runs the DEV_MODE app login (bypass only answers on local dev hosts) and
// returns the one-time code from the custom-scheme redirect.
async function appLoginCode(challenge: string) {
  const res = await SELF.fetch(
    `http://localhost:8787/auth/login?client=app&code_challenge=${challenge}`,
    { redirect: "manual" }
  );
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location).toMatch(/^trackevolution:\/\/auth\?code=[0-9a-f]+$/);
  return /code=([0-9a-f]+)/.exec(location)![1];
}

async function exchange(body: unknown) {
  const res = await SELF.fetch("https://example.com/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

function bearerMe(token: string) {
  return SELF.fetch("https://example.com/api/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("Bearer token auth on /api/*", () => {
  it("accepts a live session token in the Authorization header", async () => {
    const { token, email } = await signedInUser();
    const res = await bearerMe(token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).user.email).toBe(email);
  });

  it("rejects an unknown bearer token", async () => {
    expect((await bearerMe("not-a-real-token")).status).toBe(401);
  });

  it("rejects an expired bearer token", async () => {
    const user = await createUser();
    const token = await sessionFor(user.id, Date.now() - 1000);
    expect((await bearerMe(token)).status).toBe(401);
  });
});

describe("CORS for app origins", () => {
  it("answers preflight for a Capacitor origin", async () => {
    const res = await SELF.fetch("https://example.com/api/me", {
      method: "OPTIONS",
      headers: {
        Origin: "capacitor://localhost",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    expect(res.headers.get("access-control-allow-headers") ?? "").toMatch(/Authorization/i);
  });

  it("does not allow other origins", async () => {
    const res = await SELF.fetch("https://example.com/api/me", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("native app login + code exchange", () => {
  it("requires code_challenge on app login", async () => {
    const res = await SELF.fetch("http://localhost:8787/auth/login?client=app", {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  it("exchanges a code + verifier for a working bearer token", async () => {
    const { verifier, challenge } = await pkcePair();
    const code = await appLoginCode(challenge);
    const res = await exchange({ code, code_verifier: verifier });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);

    const me = await bearerMe(res.body.token);
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.email).toBe("dev@example.com");
  });

  it("rejects reuse of a code (single-use)", async () => {
    const { verifier, challenge } = await pkcePair();
    const code = await appLoginCode(challenge);
    expect((await exchange({ code, code_verifier: verifier })).status).toBe(200);
    expect((await exchange({ code, code_verifier: verifier })).status).toBe(401);
  });

  it("rejects a wrong verifier and burns the code", async () => {
    const { verifier, challenge } = await pkcePair();
    const code = await appLoginCode(challenge);
    expect((await exchange({ code, code_verifier: "wrong-verifier" })).status).toBe(401);
    // The failed attempt consumed the code — the real verifier no longer works.
    expect((await exchange({ code, code_verifier: verifier })).status).toBe(401);
  });

  it("rejects an expired code", async () => {
    const { verifier, challenge } = await pkcePair();
    const user = await createUser();
    const code = "e".repeat(64);
    await env.DB.prepare(
      "INSERT INTO auth_codes (code, user_id, code_challenge, expires_at) VALUES (?, ?, ?, ?)"
    )
      .bind(await sha256Hex(code), user.id, challenge, Date.now() - 1000)
      .run();
    expect((await exchange({ code, code_verifier: verifier })).status).toBe(401);
  });

  it("rejects a malformed exchange body", async () => {
    expect((await exchange({ code: "abc" })).status).toBe(400);
    expect((await exchange(null)).status).toBe(400);
  });
});

describe("logout with a bearer token", () => {
  it("deletes the session named by the Authorization header", async () => {
    const { token } = await signedInUser();
    const res = await SELF.fetch("https://example.com/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await bearerMe(token)).status).toBe(401);
  });
});

describe("deep-link association files", () => {
  it("serves apple-app-site-association as JSON with the share path", async () => {
    const res = await SELF.fetch("https://example.com/.well-known/apple-app-site-association");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
    const body = (await res.json()) as any;
    expect(body.applinks.details[0].components).toEqual([{ "/": "/share/*" }]);
  });
});
