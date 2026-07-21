import { describe, expect, it } from "vitest";
import { APPLE_ISSUER, appleClientSecret, appleUserName } from "../../src/lib/apple";

function b64UrlToBytes(b64url: string): Uint8Array {
  return Uint8Array.from(atob(b64url.replaceAll("-", "+").replaceAll("_", "/")), (ch) =>
    ch.charCodeAt(0)
  );
}

function decodeSegment(segment: string) {
  return JSON.parse(new TextDecoder().decode(b64UrlToBytes(segment)));
}

async function keyPairPem() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let b64 = "";
  for (const byte of der) b64 += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64)}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

describe("appleClientSecret", () => {
  it("mints an ES256 JWT with Apple's required claims, verifiable with the key", async () => {
    const { pem, publicKey } = await keyPairPem();
    const nowMs = 1_750_000_000_000;
    const jwt = await appleClientSecret({
      teamId: "TEAM123456",
      keyId: "KEY9876543",
      clientId: "app.example.web",
      privateKeyPem: pem,
      nowMs,
    });

    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(decodeSegment(headerB64)).toEqual({ alg: "ES256", kid: "KEY9876543" });
    expect(decodeSegment(payloadB64)).toEqual({
      iss: "TEAM123456",
      iat: nowMs / 1000,
      exp: nowMs / 1000 + 300,
      aud: APPLE_ISSUER,
      sub: "app.example.web",
    });

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      b64UrlToBytes(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    expect(valid).toBe(true);
  });
});

describe("appleUserName", () => {
  it("joins first and last name from the first-auth user field", () => {
    expect(appleUserName('{"name":{"firstName":"Ayrton","lastName":"Senna"}}')).toBe(
      "Ayrton Senna"
    );
  });

  it("handles a single name part", () => {
    expect(appleUserName('{"name":{"firstName":"Ayrton"}}')).toBe("Ayrton");
    expect(appleUserName('{"name":{"lastName":"Senna"}}')).toBe("Senna");
  });

  it("returns null for absent, empty, or malformed input", () => {
    expect(appleUserName(undefined)).toBeNull();
    expect(appleUserName("")).toBeNull();
    expect(appleUserName("not json")).toBeNull();
    expect(appleUserName("{}")).toBeNull();
    expect(appleUserName('{"name":{"firstName":"  "}}')).toBeNull();
  });
});
