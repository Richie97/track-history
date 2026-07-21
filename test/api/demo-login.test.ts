import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiClient } from "./helpers";

// The App Store / Play review bypass: /auth/login?demo_code=<secret> signs
// into the shared demo account (REVIEW_DEMO_EMAIL) without Google. Bindings
// live in vitest.workers.config.mts. The demo branch runs before the
// DEV_MODE bypass, so it's testable even though tests set DEV_MODE=1.

function demoLogin(code: string, extra = "") {
  return SELF.fetch(
    `https://example.com/auth/login?demo_code=${encodeURIComponent(code)}${extra}`,
    { redirect: "manual" }
  );
}

async function webLoginToken(code: string) {
  const res = await demoLogin(code);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  const token = /session=([0-9a-f]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  expect(token).toBeTruthy();
  return token!;
}

describe("review demo login (web)", () => {
  it("signs into the demo account with the correct code", async () => {
    const me = await apiClient(await webLoginToken("test-demo-secret"))("GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("demo@example.com");
    expect(me.body.user.name).toBe("Demo Driver");
  });

  it("reuses the same demo user across logins", async () => {
    const userId = async () =>
      (await apiClient(await webLoginToken("test-demo-secret"))("GET", "/me")).body.user
        .id as number;
    expect(await userId()).toBe(await userId());
  });

  it("rejects a wrong code without setting a session", async () => {
    const res = await demoLogin("wrong-code");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("is disabled entirely when REVIEW_DEMO_SECRET is unset", async () => {
    const saved = env.REVIEW_DEMO_SECRET;
    try {
      env.REVIEW_DEMO_SECRET = undefined;
      expect((await demoLogin("test-demo-secret")).status).toBe(401);
    } finally {
      env.REVIEW_DEMO_SECRET = saved;
    }
  });

  it("falls through to the normal flow without a demo_code", async () => {
    // DEV_MODE=1 in tests, so the fallthrough lands on the dev user.
    const res = await SELF.fetch("https://example.com/auth/login", { redirect: "manual" });
    const token = /session=([0-9a-f]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    const me = await apiClient(token)("GET", "/me");
    expect(me.body.user.email).toBe("dev@example.com");
  });
});

describe("review demo login (native app)", () => {
  it("mints a one-time code the app can exchange for a bearer token", async () => {
    const verifier = "review-demo-verifier";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

    const res = await demoLogin("test-demo-secret", `&client=app&code_challenge=${challenge}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^trackevolution:\/\/auth\?code=[0-9a-f]+$/);

    const code = /code=([0-9a-f]+)/.exec(location)![1];
    const exchanged = await SELF.fetch("https://example.com/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
    });
    expect(exchanged.status).toBe(200);
    const { token } = (await exchanged.json()) as { token: string };

    const me = await SELF.fetch("https://example.com/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.email).toBe("demo@example.com");
  });

  it("rejects a wrong code on the app flow too", async () => {
    const res = await demoLogin("wrong-code", "&client=app&code_challenge=abc");
    expect(res.status).toBe(401);
  });
});
