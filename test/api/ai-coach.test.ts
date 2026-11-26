import { SELF, env } from "cloudflare:test";
import { createMiddleware } from "hono/factory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiApp } from "../../src/api";
import { MAX_TOOL_ROUNDS, STOP_MESSAGES } from "../../src/ai/coach";
import { COACH_INSTRUCTIONS } from "../../src/ai/coach-prompt";
import { INSTRUCTIONS } from "../../src/ai/mcp";
import { FAKE_REPLY_CHUNKS, anthropic, openai, sseEvents } from "../../src/ai/providers";
import { TOOLS } from "../../src/ai/tools";
import type { AppContext } from "../../src/types";
import { ANTHROPIC_KEYS, OPENAI_KEYS } from "../ai-coach-mock";
import { DEV_ORIGIN, createEvent, signedInProUser, signedInUser } from "./helpers";
import { telemetrySession } from "./telemetry-fixture";

// POST /api/ai/coach (#318): the Pro gate, the tool-use loop against both
// providers (scripted in test/ai-coach-mock.ts — the key picks the status, the
// first user message the script), the caps, the errors, and the two things the
// route must never do: run over someone else's logbook, or let the key out.

type Sse = { event: string; data: any };

const ALL_KEYS = [...Object.values(ANTHROPIC_KEYS), ...Object.values(OPENAI_KEYS)];
// Every response body this file sees, checked for a key at the end of each test.
const seen: string[] = [];

async function coach(
  token: string,
  body: unknown,
  { provider, key, origin = "https://example.com", path = "/ai/coach" }: { provider?: string; key?: string; origin?: string; path?: string } = {}
) {
  const res = await SELF.fetch(`${origin}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session=${token}`,
      ...(provider ? { "X-TE-AI-Provider": provider } : {}),
      ...(key ? { "X-TE-AI-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  seen.push(text, JSON.stringify([...res.headers]));
  const isStream = (res.headers.get("Content-Type") ?? "").startsWith("text/event-stream");
  const events: Sse[] = [];
  if (isStream)
    for await (const ev of sseEvents(new Response(text).body!)) events.push({ event: ev.event, data: JSON.parse(ev.data) });
  return {
    status: res.status,
    headers: res.headers,
    body: isStream ? null : (JSON.parse(text || "null") as any),
    events,
    text: events
      .filter((e) => e.event === "text")
      .map((e) => e.data.delta)
      .join(""),
    done: events.find((e) => e.event === "done")?.data ?? null,
    tools: events.filter((e) => e.event === "tool").map((e) => e.data.name),
  };
}

const ask = (content: string) => ({ messages: [{ role: "user", content }] });
const viaAnthropic = { provider: "anthropic", key: ANTHROPIC_KEYS.ok };
const viaOpenAI = { provider: "openai", key: OPENAI_KEYS.ok };

async function driverWithSession() {
  const user = await signedInProUser();
  const eventId = await createEvent(user.api, { track_name: `Coach Ring ${user.id}` });
  const created = await user.api("POST", `/events/${eventId}/sessions`, telemetrySession([95_000, 93_400, 94_100]));
  expect(created.status).toBe(201);
  const detail = await user.api("GET", `/events/${eventId}`);
  const session = detail.body.sessions[0];
  return { ...user, eventId, sessionId: session.id as number, lapIds: session.laps.map((l: any) => l.id) as number[] };
}

afterEach(() => {
  for (const body of seen) for (const key of ALL_KEYS) expect(body).not.toContain(key);
  seen.length = 0;
  vi.restoreAllMocks();
});

describe("who may ask", () => {
  it("needs a session", async () => {
    const res = await coach("not-a-session", ask("hi"), viaAnthropic);
    expect(res.status).toBe(401);
  });

  it("answers a free account 402 { error: 'pro required' } on both routes", async () => {
    const free = await signedInUser();
    for (const path of ["/ai/coach", "/ai/coach/verify"]) {
      const res = await coach(free.token, ask("hi"), { ...viaAnthropic, path });
      expect(res.status).toBe(402);
      expect(res.body).toEqual({ error: "pro required" });
    }
  });

  it("refuses a request with no credential, an unknown provider or a malformed key", async () => {
    const { token } = await signedInProUser();
    expect((await coach(token, ask("hi"))).body).toEqual({ error: "no AI provider set up" });
    expect((await coach(token, ask("hi"), { provider: "anthropic" })).body).toEqual({ error: "no AI provider set up" });
    const unknown = await coach(token, ask("hi"), { provider: "skynet", key: "k" });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: "unknown AI provider" });
    expect((await coach(token, ask("hi"), { provider: "openai", key: "two words" })).status).toBe(400);
  });

  it("validates the conversation, the context and the model", async () => {
    const { token } = await signedInProUser();
    const bad: unknown[] = [
      {},
      { messages: [] },
      { messages: [{ role: "system", content: "x" }] },
      { messages: [{ role: "assistant", content: "x" }] },
      { messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] },
      { messages: [{ role: "user", content: "   " }] },
      { ...ask("hi"), context: { session_id: "12" } },
      { ...ask("hi"), context: { session_id: -1 } },
      { ...ask("hi"), context: { compare_lap_id: 3 } },
      { ...ask("hi"), model: "gpt-6.2-astra" }, // another provider's model
    ];
    for (const body of bad) {
      const res = await coach(token, body, viaAnthropic);
      expect(`${JSON.stringify(body)} → ${res.status}`).toBe(`${JSON.stringify(body)} → 400`);
      expect(typeof res.body.error).toBe("string");
    }
  });
});

describe("the loop, on Anthropic", () => {
  it("sends the shared tools and the system prompt, and streams the reply", async () => {
    const { token } = await signedInProUser();
    const res = await coach(token, { ...ask("hello"), context: { session_id: 7, event_id: 3 } }, viaAnthropic);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.tools).toEqual([]);
    const echo = JSON.parse(res.text.replace(/^ECHO /, ""));
    expect(echo.model).toBe(anthropic.defaultModel);
    expect(echo.stream).toBe(true);
    expect(echo.fallbacks).toBe("default");
    // The same tools the MCP server lists — all of them, no second copy.
    expect(echo.tools).toEqual(TOOLS.map((t) => t.name));
    expect(echo.toolHasSchema).toBe(true);
    // The prompt starts from the MCP conventions and appends the coach's own.
    expect(echo.system.startsWith(INSTRUCTIONS)).toBe(true);
    expect(echo.system).toContain(COACH_INSTRUCTIONS);
    expect(echo.system).toContain("get_session_insights for session 7");
    expect(res.done).toEqual({ stop: "end", model: anthropic.defaultModel });
    // More than one delta arrived, in order.
    expect(res.events.filter((e) => e.event === "text").length).toBeGreaterThan(1);
  });

  it("takes a model from the allow-list", async () => {
    const { token } = await signedInProUser();
    const res = await coach(token, { ...ask("hello"), model: "claude-haiku-5-5" }, viaAnthropic);
    const echo = JSON.parse(res.text.replace(/^ECHO /, ""));
    expect(echo.model).toBe("claude-haiku-5-5");
    expect(echo.fallbacks).toBeNull(); // no server-side fallback on Haiku
    expect(res.done.model).toBe("claude-haiku-5-5");
  });

  it("runs a tool call as the driver and hands the result back, thinking blocks intact", async () => {
    const d = await driverWithSession();
    const res = await coach(d.token, ask(`call get_event {"event_id":${d.eventId}}`), viaAnthropic);
    expect(res.status).toBe(200);
    expect(res.events[0]).toEqual({ event: "tool", data: { name: "get_event", label: "Reading the event…" } });
    const { results, thinkingEchoed } = JSON.parse(res.text.replace(/^RESULT /, ""));
    expect(thinkingEchoed).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe("toolu_test_1");
    expect(results[0].is_error).toBeUndefined();
    const event = JSON.parse(results[0].content);
    expect(event.track_name).toBe(`Coach Ring ${d.id}`);
    expect(event.sessions[0].laps).toHaveLength(3);
    // A summary, never the raw channel arrays.
    expect(results[0].content).not.toContain('"throttle":[');
    expect(res.done.stop).toBe("end");
  });

  it("cannot read another driver's session", async () => {
    const owner = await driverWithSession();
    const other = await signedInProUser();
    const res = await coach(other.token, ask(`call get_session_insights {"session_id":${owner.sessionId}}`), viaAnthropic);
    const { results } = JSON.parse(res.text.replace(/^RESULT /, ""));
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toBe(`No session ${owner.sessionId} in this logbook.`);
    expect(results[0].content).not.toContain("Coach Ring");
  });

  it("answers a malformed tool call with a tool error rather than running it", async () => {
    const { token } = await signedInProUser();
    const res = await coach(token, ask("call get_event {not json"), viaAnthropic);
    const { results } = JSON.parse(res.text.replace(/^RESULT /, ""));
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain("not valid JSON");
  });

  it("caps the tool rounds, then asks once more with tools forbidden", async () => {
    const { token } = await signedInProUser();
    const res = await coach(token, ask("loop"), viaAnthropic);
    expect(res.tools).toHaveLength(MAX_TOOL_ROUNDS);
    expect(res.text).toBe("wrapped up");
    expect(res.done).toEqual({ stop: "tool_limit", model: anthropic.defaultModel, message: STOP_MESSAGES.tool_limit });
  });

  it("reports a failure after the stream opened as an error event", async () => {
    const { token } = await signedInProUser();
    const res = await coach(token, ask("midfail"), viaAnthropic);
    expect(res.status).toBe(200);
    expect(res.events).toEqual([{ event: "error", data: { error: "Anthropic is unavailable right now — try again shortly", status: 502 } }]);
  });
});

describe("the loop, on OpenAI's Responses API", () => {
  it("sends function tools and the instructions, statelessly", async () => {
    const { token } = await signedInProUser();
    const res = await coach(token, ask("hello"), viaOpenAI);
    const echo = JSON.parse(res.text.replace(/^ECHO /, ""));
    expect(echo.model).toBe(openai.defaultModel);
    expect(echo.store).toBe(false);
    expect(echo.toolType).toBe("function");
    expect(echo.tools).toEqual(TOOLS.map((t) => t.name));
    expect(echo.instructions.startsWith(INSTRUCTIONS)).toBe(true);
    expect(res.done).toEqual({ stop: "end", model: openai.defaultModel });
  });

  it("runs a function call and returns its output with the reasoning item", async () => {
    const d = await driverWithSession();
    const res = await coach(d.token, ask(`call get_session_insights {"session_id":${d.sessionId}}`), viaOpenAI);
    expect(res.tools).toEqual(["get_session_insights"]);
    const { outputs, reasoningEchoed, callEchoed } = JSON.parse(res.text.replace(/^RESULT /, ""));
    expect(reasoningEchoed).toBe(true);
    expect(callEchoed).toBe(true);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe("call_test_1");
    expect(JSON.parse(outputs[0].output).event.track_name).toBe(`Coach Ring ${d.id}`);
  });
});

describe("provider errors", () => {
  it("maps a rejected key to 424, never 401, and keeps the key out of the answer", async () => {
    const { token } = await signedInProUser();
    for (const via of [
      { provider: "anthropic", key: ANTHROPIC_KEYS.bad },
      { provider: "openai", key: OPENAI_KEYS.bad },
    ]) {
      for (const path of ["/ai/coach", "/ai/coach/verify"]) {
        const res = await coach(token, ask("hello"), { ...via, path });
        expect(res.status).toBe(424);
        expect(res.body).toEqual({ error: "provider rejected the key" });
      }
    }
  });

  it("maps a provider rate limit to 429 with its Retry-After, and an outage to 502", async () => {
    const { token } = await signedInProUser();
    const limited = await coach(token, ask("hello"), { provider: "anthropic", key: ANTHROPIC_KEYS.limited });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("7");
    expect(limited.body.error).toContain("Anthropic is rate limiting");
    const down = await coach(token, ask("hello"), { provider: "anthropic", key: ANTHROPIC_KEYS.down });
    expect(down.status).toBe(502);
    expect(down.body).toEqual({ error: "Anthropic is unavailable right now — try again shortly" });
  });

  it("says when the account is out of credit", async () => {
    const { token } = await signedInProUser();
    const broke = await coach(token, ask("hello"), { provider: "anthropic", key: ANTHROPIC_KEYS.broke });
    expect(broke.status).toBe(424);
    expect(broke.body.error).toContain("out of credit");
    const quota = await coach(token, ask("hello"), { provider: "openai", key: OPENAI_KEYS.quota });
    expect(quota.status).toBe(424);
    expect(quota.body.error).toContain("out of credit");
  });

  it("never logs the key", async () => {
    const logged: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
    const { token } = await signedInProUser();
    await coach(token, ask("hello"), { provider: "anthropic", key: ANTHROPIC_KEYS.bad });
    await coach(token, ask("hello"), { provider: "openai", key: OPENAI_KEYS.bad });
    await coach(token, ask("midfail"), viaAnthropic);
    await coach(token, ask("hello"), viaAnthropic);
    const all = logged.map((args) => args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : JSON.stringify(a))).join(" ")).join("\n");
    for (const key of ALL_KEYS) expect(all).not.toContain(key);
  });
});

describe("verify", () => {
  it("answers the models the key's own account lists, narrowed to ones the AI Coach can drive", async () => {
    const { token } = await signedInProUser();
    const a = await coach(token, undefined, { ...viaAnthropic, path: "/ai/coach/verify" });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      ok: true,
      provider: "anthropic",
      default_model: "claude-sonnet-5-5",
      // The built-in models first (the default leading), then the rest of
      // the account's list — and not the model without adaptive thinking.
      models: [...anthropic.models, { id: "claude-fable-5-2", label: "Claude Fable 5.2" }],
    });
    const o = await coach(token, undefined, { ...viaOpenAI, path: "/ai/coach/verify" });
    expect(o.body.default_model).toBe(openai.defaultModel);
    // Chat models only: no embedding, realtime or image model.
    expect(o.body.models).toEqual([...openai.models, { id: "gpt-6.2-sol", label: "gpt-6.2-sol" }]);
  });

  it("offers the built-in models to a key that may not list models", async () => {
    const { token } = await signedInProUser();
    const res = await coach(token, undefined, { provider: "openai", key: OPENAI_KEYS.restricted, path: "/ai/coach/verify" });
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(openai.models);
  });

  it("lets a conversation use any model of the provider's, and nothing else", async () => {
    const { token } = await signedInProUser();
    // A model from the account's list that is not one of the built-in three.
    const listed = await coach(token, { ...ask("hello"), model: "claude-fable-5-2" }, viaAnthropic);
    expect(listed.status).toBe(200);
    const echo = JSON.parse(listed.text.replace(/^ECHO /, ""));
    expect(echo.model).toBe("claude-fable-5-2");
    expect(echo.fallbacks).toBe("default");
    // An older family gets no fallback parameter it would not accept.
    const old = await coach(token, { ...ask("hello"), model: "claude-sonnet-4-6" }, viaAnthropic);
    expect(JSON.parse(old.text.replace(/^ECHO /, "")).fallbacks).toBeNull();
    for (const model of ["gpt-6.2-astra", "not a model!", "claude-", "", 7, "text-embedding-3-large"]) {
      const res = await coach(token, { ...ask("hello"), model }, viaAnthropic);
      expect(`${JSON.stringify(model)} → ${res.status}`).toBe(`${JSON.stringify(model)} → 400`);
    }
    for (const model of ["text-embedding-3-large", "gpt-realtime-2.1-mini", "claude-sonnet-5-5"]) {
      const res = await coach(token, { ...ask("hello"), model }, viaOpenAI);
      expect(`${model} → ${res.status}`).toBe(`${model} → 400`);
    }
    expect((await coach(token, { ...ask("hello"), model: "gpt-6.2-sol" }, viaOpenAI)).status).toBe(200);
  });
});

describe("the fake provider", () => {
  it("calls one tool and streams a fixed reply on a dev host", async () => {
    const d = await driverWithSession();
    const res = await coach(d.token, { ...ask("Debrief this session."), context: { session_id: d.sessionId } }, { provider: "fake", origin: DEV_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.tools).toEqual(["get_session_insights"]);
    expect(res.text).toBe(FAKE_REPLY_CHUNKS.join(""));
    expect(res.done).toEqual({ stop: "end", model: "fake-1" });
    const verify = await coach(d.token, undefined, { provider: "fake", origin: DEV_ORIGIN, path: "/ai/coach/verify" });
    expect(verify.body.ok).toBe(true);
  });

  it("does not exist anywhere else, even with DEV_MODE set", async () => {
    expect(env.DEV_MODE).toBe("1");
    const { token } = await signedInProUser();
    for (const path of ["/ai/coach", "/ai/coach/verify"]) {
      const res = await coach(token, ask("hi"), { provider: "fake", path });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "unknown AI provider" });
    }
  });
});

describe("your own logbook only", () => {
  it("is a 404 under the coach mount, for a coach with a live grant", async () => {
    const student = await driverWithSession();
    const coachUser = await signedInProUser();
    const invite = await student.api("POST", "/coaching/invites");
    const inviteToken = (invite.body.url as string).split("/coach/")[1];
    expect((await coachUser.api("POST", `/coaching/invites/${inviteToken}/accept`)).status).toBe(201);
    // The grant is real: the coach reads the student's events…
    expect((await coachUser.api("GET", `/students/${student.id}/events`)).status).toBe(200);
    // …and the AI Coach is not there to run over them.
    for (const path of ["/ai/coach", "/ai/coach/verify"]) {
      const res = await coach(coachUser.token, { ...ask("hi"), context: { session_id: student.sessionId } }, { ...viaAnthropic, path: `/students/${student.id}${path}` });
      expect(res.status).toBe(404);
    }
  });

  it("is not in the router the tool layer reads through", async () => {
    const { id } = await signedInProUser();
    const copy = apiApp(
      createMiddleware<AppContext>(async (c, next) => {
        c.set("userId", id);
        c.set("entitledUntil", Number.MAX_SAFE_INTEGER);
        return next();
      })
    );
    for (const path of ["/ai/coach", "/ai/coach/verify"]) {
      const res = await copy.fetch(new Request(`https://internal${path}`, { method: "POST", body: "{}" }), env);
      expect(res.status).toBe(404);
    }
    // The copy itself works — the 404 is the route's absence, not a broken app.
    expect((await copy.fetch(new Request("https://internal/tracks"), env)).status).toBe(200);
  });
});

describe("the rate limit", () => {
  it("is per user, with Retry-After", async () => {
    const busy = await signedInProUser();
    const other = await signedInProUser();
    const verify = (token: string) => coach(token, undefined, { provider: "fake", origin: DEV_ORIGIN, path: "/ai/coach/verify" });
    let limited = null;
    // The binding counts in fixed windows, so call until the first refusal
    // (see ratelimit.test.ts): at least `limit` successes come first.
    for (let allowed = 0; allowed <= 20; allowed++) {
      const res = await verify(busy.token);
      if (res.status === 429) {
        expect(allowed).toBeGreaterThanOrEqual(10);
        limited = res;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers.get("Retry-After")).toBe("60");
    expect(limited!.body.error).toContain("rate limited");
    expect((await verify(other.token)).status).toBe(200);
  });
});
