export type IdTokenPayload = {
  sub: string;
  email: string;
  email_verified?: boolean | string; // Apple sends "true"/"false" strings
  name?: string;
  picture?: string;
};

// Sign-in requires a verified email because accounts are claimed/linked by
// email (see upsertOidcUser in routes/auth.ts): an attacker with an
// unverified provider email could otherwise take over — or pre-poison — the
// account of whoever really owns that address. Only an explicit true counts;
// a missing claim is treated as unverified.
export const isEmailVerified = (payload: IdTokenPayload): boolean =>
  payload.email_verified === true || payload.email_verified === "true";

// Decode a JWT payload without signature verification. Only safe for tokens
// received directly from Google's token endpoint over TLS (OIDC spec 3.1.3.7).
export function decodeIdTokenPayload(idToken: string): IdTokenPayload {
  const payloadB64 = idToken.split(".")[1];
  if (!payloadB64) throw new Error("malformed id_token");
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
        ch.charCodeAt(0)
      )
    )
  ) as IdTokenPayload;
}
