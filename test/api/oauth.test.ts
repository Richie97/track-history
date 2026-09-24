import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Base64Url } from "../../src/lib/session";
import { UNUSED_CLIENT_TTL_MS, sweepOAuth } from "../../src/routes/oauth";
import { DEV_ORIGIN, mcpClient, signedInProUser, signedInUser } from "./helpers";

// The MCP authorization server (#316), end to end: discovery, registration,
// the consent page, the code and refresh grants, revocation, and Settings'
// connected apps. Everything an MCP client does, done by hand.

const ORIGIN = "https://example.com";
const REDIRECT = "https://assistant.example/callback";

async function register(body: Record<string, unknown> = {}) {
  const res = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Assistant", redirect_uris: [REDIRECT], ...body }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function pkce() {
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

function authorizeUrl(params: Record<string, string>) {
  return `${ORIGIN}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    redirect_uri: REDIRECT,
    code_challenge_method: "S256",
    state: "xyz",
    ...params,
  })}`;
}

// workerd has Headers#getSetCookie; the workers-types in use don't declare it.
const cookieValue = (res: Response, name: string) =>
  (res.headers as unknown as { getSetCookie(): string[] })
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

// GET the consent page as `sessionToken`, then POST the form back with its
// CSRF token — what a browser does when the user clicks.
async function consent(url: string, sessionToken: string, action: "allow" | "deny" = "allow") {
  const page = await SELF.fetch(url, { headers: { Cookie: `session=${sessionToken}` } });
  const html = await page.text();
  const csrf = cookieValue(page, "oauth_csrf");
  const form = new URLSearchParams();
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)) {
    form.set(name, value.replaceAll("&amp;", "&"));
  }
  form.set("action", action);
  const res = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `session=${sessionToken}; oauth_csrf=${csrf}` },
    body: form,
  });
  return { page, html, res, location: res.headers.get("Location") };
}

async function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

// The whole dance for a Pro user: register, consent, exchange.
async function connected() {
  const user = await signedInProUser();
  const client = (await register()).body;
  const { verifier, challenge } = await pkce();
  const { location } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token);
  const code = new URL(location!).searchParams.get("code")!;
  const tokens = await token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
  });
  return { user, client, tokens: tokens.body };
}

describe("discovery", () => {
  it("serves the protected-resource metadata at both RFC 9728 locations", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await res.json()).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
        scopes_supported: ["read"],
      });
    }
  });

  it("serves the authorization server metadata", async () => {
    const meta = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(meta).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    });
  });
});

describe("registration", () => {
  it("registers a public client", async () => {
    const res = await register({ token_endpoint_auth_method: "client_secret_basic" });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^te_client_/);
    expect(res.body.token_endpoint_auth_method).toBe("none"); // what we support, whatever was asked
    expect(res.body).not.toHaveProperty("client_secret");
    expect(res.body.redirect_uris).toEqual([REDIRECT]);
  });

  it("refuses redirect URIs a code must never be sent to", async () => {
    for (const uri of ["javascript:alert(1)", "http://evil.example/cb", "https://a.example/cb#frag", "data:text/html,x", "not a url"]) {
      expect((await register({ redirect_uris: [uri] })).status, uri).toBe(400);
    }
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: ["http://127.0.0.1:33418/cb", "cursor://anysphere.cursor-mcp/oauth"] })).status).toBe(201);
  });
});

describe("the consent page", () => {
  it("won't redirect anywhere for an unknown client or an unregistered redirect", async () => {
    const { challenge } = await pkce();
    const unknown = await SELF.fetch(authorizeUrl({ client_id: "nope", code_challenge: challenge }), { redirect: "manual" });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toMatch(/isn&#39;t registered/);
    const client = (await register()).body;
    const elsewhere = await SELF.fetch(
      authorizeUrl({ client_id: client.client_id, code_challenge: challenge, redirect_uri: "https://evil.example/cb" }),
      { redirect: "manual" }
    );
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get("Location")).toBeNull();
  });

  it("sends a missing PKCE challenge back to the client as an error", async () => {
    const client = (await register()).body;
    const res = await SELF.fetch(authorizeUrl({ client_id: client.client_id }), { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("xyz");
    expect(loc.searchParams.get("iss")).toBe(ORIGIN);
  });

  it("asks a signed-out user to sign in and come back", async () => {
    const client = (await register()).body;
    const { challenge } = await pkce();
    const res = await SELF.fetch(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }));
    const html = await res.text();
    expect(html).toContain("Sign in to connect");
    expect(html).toContain("Test Assistant");
    const next = decodeURIComponent(html.match(/href="\/auth\/login\?next=([^"]+)"/)![1]);
    expect(next.startsWith("/oauth/authorize?")).toBe(true);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("tells a free account the connection needs Pro, with no Allow button", async () => {
    const user = await signedInUser();
    const client = (await register()).body;
    const { challenge } = await pkce();
    const { html, location } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token);
    expect(html).toContain("Track Evolution Pro required");
    expect(html).not.toContain('value="allow"');
    // Even a forged "allow" is refused for a free account.
    expect(new URL(location!).searchParams.get("error")).toBe("access_denied");
  });

  it("shows a Pro user what the app will read, and where they'll be sent", async () => {
    const user = await signedInProUser();
    const client = (await register()).body;
    const { challenge } = await pkce();
    const { html } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token, "deny");
    expect(html).toContain("Connect Test Assistant?");
    expect(html).toContain("can't change or delete anything");
    expect(html).toContain("assistant.example");
  });

  it("escapes a hostile client name", async () => {
    const user = await signedInProUser();
    const client = (await register({ client_name: '<script>alert("x")</script>' })).body;
    const { challenge } = await pkce();
    const { html } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token, "deny");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns access_denied on Cancel", async () => {
    const user = await signedInProUser();
    const client = (await register()).body;
    const { challenge } = await pkce();
    const { location } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token, "deny");
    const loc = new URL(location!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("xyz");
  });

  it("refuses a form post without the page's CSRF token", async () => {
    const user = await signedInProUser();
    const client = (await register()).body;
    const { challenge } = await pkce();
    const res = await SELF.fetch(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `session=${user.token}; oauth_csrf=abc` },
      body: new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        action: "allow",
        csrf: "different",
      }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("accepts a loopback redirect on any port", async () => {
    const user = await signedInProUser();
    const client = (await register({ redirect_uris: ["http://127.0.0.1/callback"] })).body;
    const { challenge } = await pkce();
    const { location } = await consent(
      authorizeUrl({ client_id: client.client_id, code_challenge: challenge, redirect_uri: "http://127.0.0.1:53682/callback" }),
      user.token
    );
    expect(location!.startsWith("http://127.0.0.1:53682/callback?code=")).toBe(true);
  });
});

describe("client-ID metadata documents", () => {
  it("reads the client's name and redirects from its document", async () => {
    const user = await signedInProUser();
    const { challenge } = await pkce();
    const { html, location } = await consent(
      authorizeUrl({ client_id: "https://assistant.example/oauth/client.json", code_challenge: challenge }),
      user.token
    );
    expect(html).toContain("Connect Metadata Assistant?");
    expect(new URL(location!).searchParams.get("code")).toBeTruthy();
  });

  it("refuses a document that names a different client", async () => {
    const { challenge } = await pkce();
    const res = await SELF.fetch(
      authorizeUrl({ client_id: "https://assistant.example/oauth/mismatch.json", code_challenge: challenge })
    );
    expect(res.status).toBe(400);
  });
});

describe("tokens", () => {
  it("trades a code for tokens that open /mcp", async () => {
    const { tokens } = await connected();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read" });
    expect(tokens.access_token).toMatch(/^te_at_/);
    expect(tokens.refresh_token).toMatch(/^te_rt_/);
    const res = await mcpClient(tokens.access_token)("tools/call", { name: "get_profile", arguments: {} });
    expect(res.body.result.isError).toBe(false);
  });

  it("stores only hashes", async () => {
    const { tokens } = await connected();
    const raw = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE token IN (?, ?)")
      .bind(tokens.access_token, tokens.refresh_token)
      .first<{ n: number }>();
    expect(raw!.n).toBe(0);
  });

  it("burns a code on first use, right or wrong", async () => {
    const user = await signedInProUser();
    const client = (await register()).body;
    const { verifier, challenge } = await pkce();
    const { location } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token);
    const code = new URL(location!).searchParams.get("code")!;
    const wrong = await token({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: client.client_id });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    const retry = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id });
    expect(retry.body.error).toBe("invalid_grant");
  });

  it("binds a code to its client and redirect URI", async () => {
    const user = await signedInProUser();
    const client = (await register()).body;
    const other = (await register()).body;
    for (const [params, expected] of [
      [{ client_id: other.client_id }, "code was issued to another client"],
      [{ client_id: client.client_id, redirect_uri: "https://assistant.example/other" }, "redirect_uri mismatch"],
    ] as const) {
      const { verifier, challenge } = await pkce();
      const { location } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token);
      const code = new URL(location!).searchParams.get("code")!;
      const res = await token({ grant_type: "authorization_code", code, code_verifier: verifier, ...params });
      expect(res.body.error_description).toBe(expected);
    }
  });

  it("takes the client id from a Basic header, as client_secret_basic clients send it", async () => {
    const user = await signedInProUser();
    const client = (await register()).body;
    const { verifier, challenge } = await pkce();
    const { location } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token);
    const code = new URL(location!).searchParams.get("code")!;
    const res = await token(
      { grant_type: "authorization_code", code, code_verifier: verifier },
      { Authorization: `Basic ${btoa(`${client.client_id}:`)}` }
    );
    expect(res.status).toBe(200);
  });

  it("rotates refresh tokens", async () => {
    const { client, tokens } = await connected();
    const next = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(tokens.refresh_token);
    const reused = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(reused.body.error).toBe("invalid_grant");
    expect((await mcpClient(next.body.access_token)("ping")).status).toBe(200);
  });

  it("rejects a resource that isn't this server's MCP endpoint", async () => {
    const res = await token({ grant_type: "refresh_token", refresh_token: "x", resource: "https://other.example/mcp" });
    expect(res.body.error).toBe("invalid_target");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("revokes: a refresh token takes its access tokens with it", async () => {
    const { tokens } = await connected();
    const res = await SELF.fetch(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh_token }),
    });
    expect(res.status).toBe(200);
    expect((await mcpClient(tokens.access_token)("ping")).status).toBe(401);
    const unknown = await SELF.fetch(`${ORIGIN}/oauth/revoke`, { method: "POST", body: new URLSearchParams({ token: "nope" }) });
    expect(unknown.status).toBe(200);
  });
});

describe("connected apps", () => {
  it("lists a connection in Settings and disconnects it", async () => {
    const { user, tokens } = await connected();
    await mcpClient(tokens.access_token)("ping");
    const list = await user.api("GET", "/me/connections");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: "Test Assistant" });
    expect(list.body[0].last_used_at).toBeGreaterThan(0);

    const stranger = await signedInProUser();
    expect((await stranger.api("DELETE", `/me/connections/${list.body[0].id}`)).status).toBe(404);
    expect((await stranger.api("GET", "/me/connections")).body).toEqual([]);

    expect((await user.api("DELETE", `/me/connections/${list.body[0].id}`)).status).toBe(200);
    expect((await mcpClient(tokens.access_token)("ping")).status).toBe(401);
    expect((await user.api("GET", "/me/connections")).body).toEqual([]);
  });

  it("keeps one row per app when a user connects it twice", async () => {
    const user = await signedInProUser();
    const client = (await register()).body;
    for (let i = 0; i < 2; i++) {
      const { verifier, challenge } = await pkce();
      const { location } = await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token);
      const code = new URL(location!).searchParams.get("code")!;
      await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id });
    }
    expect((await user.api("GET", "/me/connections")).body).toHaveLength(1);
  });

  it("lists only connections that still hold a live token", async () => {
    const user = await signedInProUser();
    const client = (await register()).body;
    const { challenge } = await pkce();
    await consent(authorizeUrl({ client_id: client.client_id, code_challenge: challenge }), user.token);
    // Approved, but the code was never exchanged: not a connection.
    expect((await user.api("GET", "/me/connections")).body).toEqual([]);
  });
});

describe("sign-in's way back", () => {
  it("returns a dev-bypass sign-in to the authorization request", async () => {
    const next = "/oauth/authorize?client_id=abc&state=1";
    const res = await SELF.fetch(`${DEV_ORIGIN}/auth/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
    expect(res.headers.get("Location")).toBe(next);
  });

  it("ignores a next that isn't an authorization request", async () => {
    for (const next of ["https://evil.example/", "//evil.example", "/api/me", "/oauth/authorize\\@evil"]) {
      const res = await SELF.fetch(`${DEV_ORIGIN}/auth/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
      expect(res.headers.get("Location"), next).toBe("/");
    }
  });

  it("remembers next across the Google round trip", async () => {
    const next = "/oauth/authorize?client_id=abc";
    const res = await SELF.fetch(`${ORIGIN}/auth/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
    expect(res.headers.get("Location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(decodeURIComponent(cookieValue(res, "auth_next")!)).toBe(next);
  });
});

describe("the daily sweep", () => {
  it("drops expired tokens and never-connected clients, and keeps live connections", async () => {
    const { user, client, tokens } = await connected();
    const orphan = (await register()).body;
    const later = Date.now() + UNUSED_CLIENT_TTL_MS + 1000;
    await sweepOAuth(env.DB, later);
    const ids = (await env.DB.prepare("SELECT id FROM oauth_clients WHERE id IN (?, ?)").bind(client.client_id, orphan.client_id).all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toEqual([client.client_id]);
    // The access token (1 h) is gone by then; the refresh token (90 days) isn't.
    expect((await mcpClient(tokens.access_token)("ping")).status).toBe(401);
    expect((await user.api("GET", "/me/connections")).body).toHaveLength(1);
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refreshed.status).toBe(200);
  });
});
