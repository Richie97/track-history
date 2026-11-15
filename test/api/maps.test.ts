import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { MAP_TOKEN_TTL_S, mapTokenClaims, mapsAvailable } from "../../src/lib/maps";
import { apiClient, DEV_ORIGIN, signedInProUser, signedInUser } from "./helpers";

// NS-53 ticket 4: the MapKit JS token behind the web's map viewer.

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const part = (jwt: string, i: number) => JSON.parse(new TextDecoder().decode(b64url(jwt.split(".")[i])));

describe("mapTokenClaims", () => {
  it("names the team, a half-hour life and the one origin the token works from", () => {
    expect(mapTokenClaims("TEAM", "https://trackevolution.app", 1_700_000_000_999)).toEqual({
      iss: "TEAM",
      iat: 1_700_000_000,
      exp: 1_700_000_000 + MAP_TOKEN_TTL_S,
      origin: "https://trackevolution.app",
    });
  });
  it("leaves the origin out when there is none to bind to", () => {
    expect(mapTokenClaims("TEAM", null, 0)).toEqual({ iss: "TEAM", iat: 0, exp: MAP_TOKEN_TTL_S });
  });
  it("is available only with all three secrets", () => {
    expect(mapsAvailable({ APPLE_TEAM_ID: "T", MAPKIT_KEY_ID: "K", MAPKIT_PRIVATE_KEY: "P" })).toBe(true);
    expect(mapsAvailable({ APPLE_TEAM_ID: "T", MAPKIT_KEY_ID: "K" })).toBe(false);
    expect(mapsAvailable({ MAPKIT_KEY_ID: "K", MAPKIT_PRIVATE_KEY: "P" })).toBe(false);
    expect(mapsAvailable({})).toBe(false);
  });
});

describe("GET /api/map-token", () => {
  it("mints an ES256 token bound to the asking origin, for a free account", async () => {
    const { api } = await signedInUser();
    const before = Date.now();
    const res = await api("GET", "/map-token");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(part(res.body.token, 0)).toEqual({ alg: "ES256", kid: "TESTMAPKEY", typ: "JWT" });
    const claims = part(res.body.token, 1);
    expect(claims.iss).toBe("TESTTEAM01");
    expect(claims.origin).toBe("https://example.com");
    expect(claims.exp - claims.iat).toBe(MAP_TOKEN_TTL_S);
    expect(res.body.expires_at).toBe(claims.exp * 1000);
    expect(res.body.expires_at).toBeGreaterThan(before);
    // 64 raw bytes: r || s, the JWS form of an ES256 signature.
    expect(b64url(res.body.token.split(".")[2])).toHaveLength(64);
  });

  it("leaves the origin unbound on a local dev host", async () => {
    const { api } = await signedInUser(DEV_ORIGIN);
    const res = await api("GET", "/map-token");
    expect(res.status).toBe(200);
    expect(part(res.body.token, 1)).not.toHaveProperty("origin");
  });

  it("needs a session", async () => {
    expect((await apiClient()("GET", "/map-token")).status).toBe(401);
  });

  it("is not on the coach mount: a coach asks as themselves", async () => {
    const student = await signedInProUser();
    const coach = await signedInUser();
    const inv = await student.api("POST", "/coaching/invites");
    const token = (inv.body.url as string).split("/").pop()!;
    expect((await coach.api("POST", `/coaching/invites/${token}/accept`)).status).toBe(201);
    expect((await coach.api("GET", `/students/${student.id}/map-token`)).status).toBe(404);
    expect((await coach.api("GET", "/map-token")).status).toBe(200);
  });

  it("says so on /me — and reads as absent without the secrets", async () => {
    const user = await signedInUser();
    expect((await user.api("GET", "/me")).body.user.maps).toEqual({ web: true });

    // Ships dark: the same Worker with the MapKit key unset.
    const dark = { ...env, MAPKIT_PRIVATE_KEY: undefined };
    const call = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://example.com/api${path}`, { headers: { Cookie: `session=${user.token}` } }),
        dark as typeof env,
        ctx
      );
      await waitOnExecutionContext(ctx);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call("/map-token")).status).toBe(404);
    expect((await call("/me")).body.user.maps).toEqual({ web: false });
  });
});
