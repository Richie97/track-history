// The web's map token (NS-53 ticket 4).
//
// The web draws a session's racing line over Apple's maps with MapKit JS,
// which authorises each page with a short-lived ES256 JWT signed by a MapKit
// JS key from the developer account. The Worker mints it — signES256 is the
// same signer Sign in with Apple and the App Store Server API token use — so
// the key never reaches a browser.
//
// Feature-flagged by its secrets, like Stripe and YouTube: without all three
// the web's viewer draws the line with no imagery and says why.

import { signES256 } from "./apple";
import type { Env } from "../types";

// Long enough for a look at a lap, short enough that a copied token is
// useless by the time anyone finds it. MapKit JS asks again when one expires.
export const MAP_TOKEN_TTL_S = 30 * 60;

export const mapsAvailable = (env: Pick<Env, "APPLE_TEAM_ID" | "MAPKIT_KEY_ID" | "MAPKIT_PRIVATE_KEY">) =>
  Boolean(env.APPLE_TEAM_ID && env.MAPKIT_KEY_ID && env.MAPKIT_PRIVATE_KEY);

// The claims MapKit JS reads: `iss` the team, `iat` / `exp` in seconds, and
// `origin` — the one page origin the token works from, which is what makes a
// token lifted out of a browser worthless anywhere else. `origin` null leaves
// the claim out (a local dev host, which Apple accepts unrestricted).
export function mapTokenClaims(teamId: string, origin: string | null, nowMs: number) {
  const iat = Math.floor(nowMs / 1000);
  return { iss: teamId, iat, exp: iat + MAP_TOKEN_TTL_S, ...(origin ? { origin } : {}) };
}

export async function signMapToken(opts: {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  origin: string | null;
  nowMs: number;
}): Promise<{ token: string; expires_at: number }> {
  const claims = mapTokenClaims(opts.teamId, opts.origin, opts.nowMs);
  const token = await signES256({ kid: opts.keyId, typ: "JWT" }, claims, opts.privateKeyPem);
  return { token, expires_at: claims.exp * 1000 };
}
