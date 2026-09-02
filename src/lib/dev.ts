// The one definition of "this request reached us on a local dev host".
//
// DEV_MODE turns on two shortcuts that must never work in a deployed
// environment: the login bypass (routes/auth.ts) and the extra billing trust
// anchor (lib/billing/apple.ts, whose matching private key is committed under
// test/fixtures/). Both are gated on the *hostname* as well as the flag, so a
// DEV_MODE=1 that leaks into production fails closed rather than handing out
// sessions and lifetime entitlements.
import type { Env } from "../types";

// localhost/loopback, plus 10.0.2.2 — the Android emulator's alias for the
// host machine.
export const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "10.0.2.2"]);

export function isDevHost(env: Pick<Env, "DEV_MODE">, url: string): boolean {
  if (env.DEV_MODE !== "1") return false;
  try {
    return DEV_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
