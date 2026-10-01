// The Worker the promo is filmed against: the real app, on a scratch D1 of its
// own (promo/.state), so a render never touches anyone's local dev database.
// Modelled on the contract harness (contracts/generate.mjs) — same
// unstable_startWorker call, same DEV_MODE sign-in.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

export const PROMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = path.resolve(PROMO, "..");
export const PERSIST = path.join(PROMO, ".state");

const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, stdio: "pipe" }).toString();
}

// Wipe the scratch database and apply every migration to it.
export function freshDatabase() {
  rmSync(PERSIST, { recursive: true, force: true });
  mkdirSync(PERSIST, { recursive: true });
  wrangler(["d1", "migrations", "apply", "track-history", "--local", "--persist-to", PERSIST]);
}

// Run SQL against the scratch database (only while no Worker holds it).
export function execSql(sql) {
  const file = path.join(PERSIST, "promo-exec.sql");
  writeFileSync(file, sql);
  wrangler(["d1", "execute", "track-history", "--local", "--persist-to", PERSIST, "--file", file]);
}

// A session token for a user created in SQL, stored hashed exactly as
// src/lib/session.ts stores it.
export function newToken() {
  const token = randomBytes(32).toString("hex");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

// DEV_MODE answers only on local hosts (src/lib/dev.ts), which is where this
// runs; the Google values are inert placeholders.
export async function startWorker({ email, name, port = 0 }) {
  const env = {
    DEV_MODE: "1",
    DEV_USER_EMAIL: email,
    DEV_USER_NAME: name,
    GOOGLE_CLIENT_ID: "promo",
    GOOGLE_CLIENT_SECRET: "promo",
  };
  const worker = await unstable_startWorker({
    config: path.join(ROOT, "wrangler.jsonc"),
    dev: {
      remote: false,
      persist: PERSIST,
      server: { port },
      inspector: false,
      logLevel: "error",
    },
    bindings: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, { type: "plain_text", value: v }])),
  });
  const url = await worker.url;
  // unstable_startWorker listens on 127.0.0.1 or localhost; DEV_MODE accepts
  // both, and the browser needs one hostname for the session cookie.
  const base = new URL(url);
  base.hostname = "localhost";
  return { worker, base: base.origin };
}

// Sign in through the DEV_MODE bypass; returns the session cookie's token.
export async function signIn(base) {
  const res = await fetch(new URL("/auth/login", base), { redirect: "manual" });
  const token = res.headers.get("set-cookie")?.match(/session=([^;]+)/)?.[1];
  if (!token) throw new Error(`DEV_MODE sign-in failed (status ${res.status})`);
  return token;
}

// JSON client for /api as one account. Throws on anything but 2xx, because a
// demo logbook with a silently missing event films as a broken app.
export function apiClient(base, token) {
  return async (method, apiPath, body) => {
    const res = await fetch(new URL(apiPath.startsWith("/auth") ? apiPath : `/api${apiPath}`, base), {
      method,
      headers: { "Content-Type": "application/json", Cookie: `session=${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${apiPath} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
}
