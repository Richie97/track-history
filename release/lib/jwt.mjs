// The two store APIs authenticate with JWTs we sign ourselves: App Store
// Connect takes one directly as the bearer (ES256, the .p8 key), Google takes
// one as an assertion it trades for an access token (RS256, the service
// account's key). Node's crypto signs both, so the scripts need no packages.

import { sign } from "node:crypto";

export const ASC_AUDIENCE = "appstoreconnect-v1";
// Apple refuses a token whose lifetime exceeds 20 minutes. The scripts mint
// one per request, so a short lifetime costs nothing even across a long wait
// for build processing.
export const ASC_TOKEN_LIFETIME_S = 10 * 60;
export const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

// `alg` is ES256 or RS256. For ES256 the signature must be the raw 64-byte
// r||s pair JWS specifies, not the DER that Node emits by default.
export function signJwt({ alg, header = {}, payload, privateKeyPem }) {
  const input = `${b64url({ alg, typ: "JWT", ...header })}.${b64url(payload)}`;
  const key =
    alg === "ES256" ? { key: privateKeyPem, dsaEncoding: "ieee-p1363" } : privateKeyPem;
  return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
}

export function ascToken({ issuerId, keyId, privateKeyPem, nowMs }) {
  const iat = Math.floor(nowMs / 1000);
  return signJwt({
    alg: "ES256",
    header: { kid: keyId },
    payload: { iss: issuerId, iat, exp: iat + ASC_TOKEN_LIFETIME_S, aud: ASC_AUDIENCE },
    privateKeyPem,
  });
}

// The service-account JSON's own fields: client_email, private_key, token_uri.
export function googleAssertion({ serviceAccount, nowMs }) {
  const iat = Math.floor(nowMs / 1000);
  return signJwt({
    alg: "RS256",
    payload: {
      iss: serviceAccount.client_email,
      scope: PLAY_SCOPE,
      aud: serviceAccount.token_uri,
      iat,
      exp: iat + 60 * 60,
    },
    privateKeyPem: serviceAccount.private_key,
  });
}
