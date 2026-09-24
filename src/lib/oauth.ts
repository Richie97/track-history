// The pure half of the MCP authorization server (#316, routes/oauth.ts):
// redirect-URI rules, client metadata validation, the resource check and the
// discovery documents. No D1, no Hono — unit-tested in test/unit/oauth.test.ts.

export const SCOPE = "read";
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, reset on every rotation
export const OAUTH_CODE_TTL_MS = 60 * 1000;
export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_NAME = 100;
export const DOCS_URL = "https://docs.trackevolution.app/docs/ai.html";

// Loopback redirects (RFC 8252 §7.3): desktop MCP clients listen on an
// ephemeral port, so the port is not part of the match.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

// Schemes a browser would *execute* or read locally rather than hand to an
// app. Everything else — https, loopback http, and private-use schemes like
// cursor:// or com.example.app:/ for native clients (RFC 8252 §7.1) — is a
// legitimate place to send a code.
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:", "ws:", "wss:", "ftp:"]);

export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false; // RFC 6749 §3.1.2: no fragment
  if (u.username || u.password) return false;
  if (FORBIDDEN_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol === "https:") return Boolean(u.hostname);
  // A private-use scheme: at least a scheme and something after it.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && uri.length > u.protocol.length;
}

// Exact string match against a registered URI, except that a loopback
// http URI matches on any port.
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !LOOPBACK_HOSTS.has(req.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        reg.protocol === "http:" &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

// The code (or error) appended to the client's redirect URI.
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

// Control characters and surrounding whitespace out of a self-declared name,
// capped — it is shown on the consent page and in Settings.
export function cleanClientName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_CLIENT_NAME);
  return clean || null;
}

export type ClientRegistration = { name: string | null; redirectUris: string[] };

// A dynamic client registration request (RFC 7591), or an error string. Only
// public clients are supported: the response always says
// token_endpoint_auth_method "none", which a client is bound to honour.
export function parseRegistration(body: unknown): ClientRegistration | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_client_metadata" };
  const o = body as Record<string, unknown>;
  const uris = o.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS) return { error: "invalid_redirect_uri" };
  if (!uris.every(isAllowedRedirectUri)) return { error: "invalid_redirect_uri" };
  if (o.grant_types != null && (!Array.isArray(o.grant_types) || !o.grant_types.includes("authorization_code")))
    return { error: "invalid_client_metadata" };
  if (o.response_types != null && (!Array.isArray(o.response_types) || !o.response_types.includes("code")))
    return { error: "invalid_client_metadata" };
  return { name: cleanClientName(o.client_name), redirectUris: [...new Set(uris as string[])] };
}

// A client-ID metadata document client: its client_id is an https URL with a
// path, which the server fetches to learn the client's name and redirects.
export function isMetadataDocumentClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === "https:" && u.pathname.length > 1 && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

// The fetched document, validated against the URL it came from.
export function parseMetadataDocument(doc: unknown, clientId: string): ClientRegistration | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  if (o.client_id !== clientId) return null;
  const parsed = parseRegistration(o);
  return "error" in parsed ? null : parsed;
}

// RFC 8707: a client may name the resource it wants a token for. Accept the
// MCP endpoint's canonical URI and the bare origin (with or without a slash),
// which several clients send; anything else is another resource server.
export function resourceMatches(resource: string | null | undefined, origin: string): boolean {
  if (!resource) return true;
  return [`${origin}/mcp`, origin, `${origin}/`].includes(resource);
}

export const mcpResourceUri = (origin: string) => `${origin}/mcp`;
export const protectedResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

// RFC 9728.
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResourceUri(origin),
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Track Evolution",
    resource_documentation: DOCS_URL,
  };
}

// RFC 8414.
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: DOCS_URL,
  };
}

// The only post-login destination the sign-in routes accept through `next`:
// back to an authorization request on this origin. Anything else is an open
// redirect.
export function isSafeNext(next: unknown): next is string {
  return typeof next === "string" && next.startsWith("/oauth/authorize?") && !next.includes("\\") && next.length < 4000;
}
