// POST /api/ai/coach — the AI Coach (#318, epic #314; wire format in
// docs/specs/native/NS-58-ai-coach.md). The loop is ai/coach.ts and the
// providers ai/providers.ts; this file is the HTTP around them: who is asking,
// which credential they brought, the rate limit, and the event stream.
//
// Mounted by index.ts at /api/ai, NOT through api.ts's router list. Two
// reasons, and both are requirements:
//   - the AI Coach is for your own logbook only. api.ts's list is also mounted
//     at /api/students/:id (a coach reading a student) and inside the tool
//     layer's private copy; a route in it would exist in both. A student did
//     not agree to their data going to their coach's AI provider.
//   - ai/tools.ts imports api.ts, so this file cannot be in api.ts's import
//     graph (the itemSharePublic.ts rule).
//
// Pro: requireEntitlement on both routes. They are POSTs that write nothing —
// an analysis request, not a logbook write — so "no write route checks
// entitlement" holds, and test/api/entitlement-gates.test.ts enumerates them.
//
// The key. It arrives in X-TE-AI-Key, goes to the provider in the one outbound
// request and is never stored, logged or echoed: nothing here logs a header or
// a caught error object, and provider error bodies are mapped, not relayed.

import { Hono } from "hono";
import type { AppContext, Ctx } from "../types";
import { requireEntitlement, requireSession } from "../middleware";
import { isDevHost } from "../lib/dev";
import { RATE_LIMIT_RETRY_AFTER_S, withinLimit } from "../lib/ratelimit";
import { type Emit, parseCoachRequest, sseFrame, startCoach } from "../ai/coach";
import { type FetchLike, PROVIDERS, type Provider, ProviderError } from "../ai/providers";

export const aiCoach = new Hono<AppContext>();

const MAX_BODY_BYTES = 512 * 1024;
const MAX_KEY_CHARS = 512;
// A comment line every few seconds keeps proxies from closing a stream that is
// quiet while the model thinks.
const KEEPALIVE_MS = 15_000;

// How the request pays for the model. Today that is always a key the driver
// pasted; #503 adds `{ kind: "linked" }` (Anthropic linked billing) and
// `{ kind: "oauth" }` (Sign in with ChatGPT) here, and nothing downstream of
// this function reads a header.
export type Credential = { kind: "key"; provider: Provider; key: string };

export function resolveCredential(c: Ctx): Credential | { error: string } {
  const id = (c.req.header("X-TE-AI-Provider") ?? "").trim().toLowerCase();
  const key = (c.req.header("X-TE-AI-Key") ?? "").trim();
  // The scripted provider for tests and demos: DEV_MODE and a local dev host,
  // like every dev shortcut. Anywhere else it reads as a provider that does
  // not exist.
  if (id === "fake") return isDevHost(c.env, c.req.url) ? { kind: "key", provider: PROVIDERS.fake, key: "" } : { error: "unknown AI provider" };
  if (!id && !key) return { error: "no AI provider set up" };
  if (id !== "anthropic" && id !== "openai") return { error: "unknown AI provider" };
  if (!key) return { error: "no AI provider set up" };
  if (key.length > MAX_KEY_CHARS || /\s/.test(key)) return { error: "that doesn't look like an API key" };
  return { kind: "key", provider: PROVIDERS[id], key };
}

const providerFailure = (c: Ctx, err: ProviderError) => {
  if (err.retryAfter) c.header("Retry-After", err.retryAfter);
  return c.json({ error: err.message }, err.status);
};

aiCoach.use("*", requireSession);
// Keys must never sit in a cache, and neither should an analysis of a logbook.
aiCoach.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// Per user, both routes. Required before #503, where requests run on our own
// provider quota; until then it bounds the tool handlers' CPU.
const limited = async (c: Ctx) => {
  if (await withinLimit(c.env.AI_COACH, `user:${c.get("userId")}`)) return null;
  c.header("Retry-After", String(RATE_LIMIT_RETRY_AFTER_S));
  return c.json({ error: "rate limited — too many AI Coach requests; wait a minute" }, 429);
};

// Settings' Verify: one provider call — its models API — which proves the key
// and answers the models this account can use, for the model field to
// complete from. Called again when the field is focused, to refresh the list.
aiCoach.post("/coach/verify", requireEntitlement, async (c) => {
  const cred = resolveCredential(c);
  if ("error" in cred) return c.json({ error: cred.error }, 400);
  const refused = await limited(c);
  if (refused) return refused;
  let models;
  try {
    models = await cred.provider.listModels(cred.key, fetch as FetchLike);
  } catch (err) {
    if (err instanceof ProviderError) return providerFailure(c, err);
    return c.json({ error: "the AI Coach failed unexpectedly — try again" }, 500);
  }
  return c.json({ ok: true, provider: cred.provider.id, default_model: cred.provider.defaultModel, models });
});

aiCoach.post("/coach", requireEntitlement, async (c) => {
  const cred = resolveCredential(c);
  if ("error" in cred) return c.json({ error: cred.error }, 400);

  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: "request too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }
  const request = parseCoachRequest(body, cred.provider);
  if ("error" in request) return c.json({ error: request.error }, 400);

  const refused = await limited(c);
  if (refused) return refused;

  let pump: (emit: Emit) => Promise<void>;
  try {
    pump = await startCoach({
      env: c.env,
      user: { userId: c.get("userId"), entitledUntil: c.get("entitledUntil") },
      provider: cred.provider,
      key: cred.key,
      request,
      fetch: fetch as FetchLike,
    });
  } catch (err) {
    if (err instanceof ProviderError) return providerFailure(c, err);
    return c.json({ error: "the AI Coach failed unexpectedly — try again" }, 500);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // A write fails once the client has gone; that ends the run, so an
  // abandoned debrief stops spending the driver's tokens.
  const emit: Emit = (event, data) => writer.write(encoder.encode(sseFrame(event, data)));
  const keepalive = setInterval(() => void writer.write(encoder.encode(": keepalive\n\n")).catch(() => {}), KEEPALIVE_MS);
  const work = (async () => {
    try {
      await pump(emit);
    } catch (err) {
      const failure =
        err instanceof ProviderError
          ? { error: err.message, status: err.status }
          : { error: "the AI Coach failed unexpectedly — try again", status: 500 };
      // Deliberately not `console.error(err)`: only that it failed, and how.
      if (!(err instanceof ProviderError)) console.error("ai coach failed", cred.provider.id, err instanceof Error ? err.name : typeof err);
      await emit("error", failure).catch(() => {});
    } finally {
      clearInterval(keepalive);
      await writer.close().catch(() => {});
    }
  })();
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // no execution context (tests calling app.fetch directly)
  }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
