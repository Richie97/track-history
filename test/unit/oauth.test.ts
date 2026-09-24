import { describe, expect, it } from "vitest";
import {
  cleanClientName,
  isAllowedRedirectUri,
  isMetadataDocumentClientId,
  isSafeNext,
  parseMetadataDocument,
  parseRegistration,
  redirectMatches,
  redirectWith,
  resourceMatches,
} from "../../src/lib/oauth";

// The pure rules behind the MCP authorization server (src/lib/oauth.ts).

describe("isAllowedRedirectUri", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "http://127.0.0.1:33418/callback",
    "http://localhost:6274/oauth/callback",
    "http://[::1]/cb",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "com.example.app:/oauth",
  ])("allows %s", (uri) => expect(isAllowedRedirectUri(uri)).toBe(true));

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>",
    "file:///etc/passwd",
    "http://evil.example/cb",
    "https://a.example/cb#fragment",
    "https://user:pass@a.example/cb",
    "not a url",
    "",
    42,
  ])("refuses %s", (uri) => expect(isAllowedRedirectUri(uri)).toBe(false));
});

describe("redirectMatches", () => {
  it("matches exactly", () => {
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb")).toBe(true);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb2")).toBe(false);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb?x=1")).toBe(false);
  });

  it("ignores the port on a loopback redirect only", () => {
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:5000/cb")).toBe(true);
    expect(redirectMatches(["http://127.0.0.1:1/cb"], "http://127.0.0.1:5000/cb")).toBe(true);
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:5000/other")).toBe(false);
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://localhost:5000/cb")).toBe(false);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example:444/cb")).toBe(false);
  });
});

describe("parseRegistration", () => {
  it("keeps the name and de-duplicates redirects", () => {
    expect(parseRegistration({ client_name: " Claude ", redirect_uris: ["https://a.example/cb", "https://a.example/cb"] })).toEqual({
      name: "Claude",
      redirectUris: ["https://a.example/cb"],
    });
  });

  it("refuses clients that can't use the code flow", () => {
    expect(parseRegistration({ redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] })).toEqual({
      error: "invalid_client_metadata",
    });
    expect(parseRegistration({ redirect_uris: ["https://a.example/cb"], response_types: ["token"] })).toEqual({
      error: "invalid_client_metadata",
    });
    expect(parseRegistration({ redirect_uris: Array(11).fill("https://a.example/cb") })).toEqual({ error: "invalid_redirect_uri" });
    expect(parseRegistration(null)).toEqual({ error: "invalid_client_metadata" });
  });
});

describe("cleanClientName", () => {
  it("strips control characters and caps the length", () => {
    expect(cleanClientName("Evil\u0000\nName")).toBe("EvilName");
    expect(cleanClientName("x".repeat(500))).toHaveLength(100);
    expect(cleanClientName("   ")).toBeNull();
    expect(cleanClientName(7)).toBeNull();
  });
});

describe("client-ID metadata documents", () => {
  it("recognises an https URL with a path as a document client id", () => {
    expect(isMetadataDocumentClientId("https://a.example/client.json")).toBe(true);
    expect(isMetadataDocumentClientId("https://a.example/")).toBe(false);
    expect(isMetadataDocumentClientId("http://a.example/client.json")).toBe(false);
    expect(isMetadataDocumentClientId("te_client_abc")).toBe(false);
  });

  it("requires the document to name itself", () => {
    const url = "https://a.example/client.json";
    expect(parseMetadataDocument({ client_id: url, redirect_uris: ["https://a.example/cb"] }, url)).toEqual({
      name: null,
      redirectUris: ["https://a.example/cb"],
    });
    expect(parseMetadataDocument({ client_id: "https://b.example/client.json", redirect_uris: ["https://a.example/cb"] }, url)).toBeNull();
  });
});

describe("resourceMatches", () => {
  it("accepts this server's MCP endpoint and origin, and nothing else", () => {
    const o = "https://trackevolution.app";
    for (const r of [undefined, null, "", `${o}/mcp`, o, `${o}/`]) expect(resourceMatches(r, o)).toBe(true);
    for (const r of ["https://evil.example/mcp", `${o}/api`, `${o}/mcp/x`]) expect(resourceMatches(r, o)).toBe(false);
  });
});

describe("redirectWith", () => {
  it("adds parameters, skipping undefined ones, and keeps the URI's own query", () => {
    expect(redirectWith("https://a.example/cb?x=1", { code: "c", state: undefined })).toBe("https://a.example/cb?x=1&code=c");
  });
});

describe("isSafeNext", () => {
  it("only allows a way back into an authorization request", () => {
    expect(isSafeNext("/oauth/authorize?client_id=a")).toBe(true);
    for (const n of ["/", "/oauth/authorize", "https://evil.example", "//evil.example", "/oauth/authorize?\\evil", undefined])
      expect(isSafeNext(n)).toBe(false);
  });
});
