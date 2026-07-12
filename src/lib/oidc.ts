export type IdTokenPayload = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
};

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
