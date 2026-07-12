import { describe, expect, it } from "vitest";
import { decodeIdTokenPayload } from "../../src/lib/oidc";

// base64url without Buffer so this compiles against workers-types only.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64url(s: string) {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[n >> 18] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "";
    out += i + 2 < bytes.length ? B64[n & 63] : "";
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

function makeIdToken(payload: object) {
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(payload))}.signature`;
}

describe("decodeIdTokenPayload", () => {
  it("decodes the payload segment", () => {
    const payload = { sub: "g-123", email: "a@b.com", name: "Alice", picture: "https://p" };
    expect(decodeIdTokenPayload(makeIdToken(payload))).toEqual(payload);
  });

  it("handles base64url characters and non-ASCII names", () => {
    const payload = { sub: "??>>~~", email: "x@y.com", name: "Jörg Müller 🏁" };
    expect(decodeIdTokenPayload(makeIdToken(payload))).toEqual(payload);
  });

  it("throws on malformed tokens", () => {
    expect(() => decodeIdTokenPayload("not-a-jwt")).toThrow();
  });
});
