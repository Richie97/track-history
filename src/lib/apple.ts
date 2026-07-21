// Sign in with Apple plumbing. Unlike Google, Apple has no static client
// secret: each token-endpoint call authenticates with a short-lived ES256 JWT
// you sign yourself using the .p8 key from the developer portal.

export const APPLE_ISSUER = "https://appleid.apple.com";

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

// PKCS#8 PEM (the .p8 file's contents) → DER bytes for WebCrypto import.
function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
}

// The client-secret JWT per Apple's spec: iss = Team ID, sub = the client id
// (Services ID for web, bundle id for native), aud = Apple's issuer, signed
// ES256 with the portal key named by kid. Apple allows a lifetime up to six
// months; we mint a fresh five-minute one per token call instead of caching.
export async function appleClientSecret(opts: {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKeyPem: string;
  nowMs: number;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(opts.privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const iat = Math.floor(opts.nowMs / 1000);
  const signingInput =
    base64UrlJson({ alg: "ES256", kid: opts.keyId }) +
    "." +
    base64UrlJson({
      iss: opts.teamId,
      iat,
      exp: iat + 5 * 60,
      aud: APPLE_ISSUER,
      sub: opts.clientId,
    });
  // WebCrypto ECDSA emits the raw 64-byte r||s form — exactly what JWS ES256
  // wants, no DER conversion needed.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return signingInput + "." + base64UrlEncode(new Uint8Array(signature));
}

// Apple sends the user's name only once — as a `user` form field on the very
// first authorization, JSON like {"name":{"firstName":"…","lastName":"…"}}.
// Returns the joined display name, or null when absent/malformed.
export function appleUserName(userField: unknown): string | null {
  if (typeof userField !== "string" || !userField) return null;
  try {
    const parsed = JSON.parse(userField) as {
      name?: { firstName?: string; lastName?: string };
    };
    const name = [parsed.name?.firstName, parsed.name?.lastName]
      .filter((part) => typeof part === "string" && part.trim())
      .join(" ")
      .trim();
    return name || null;
  } catch {
    return null;
  }
}
