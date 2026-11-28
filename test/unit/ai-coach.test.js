import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  COACH_ENTRIES,
  appendCoachNote,
  coachBoldRuns,
  coachContext,
  coachErrorText,
  coachMarkdownBlocks,
  coachMarkdownHtml,
  coachNotesLabel,
  coachPlainText,
  coachSaveLabel,
  createSseParser,
  modelOptionsHtml,
  modelPlaceholder,
  resolveModelInput,
  streamCoach,
  verifyCoachKey,
} from "../../public/js/ai-coach.js";
import {
  aiCredential,
  aiKeyState,
  clearAiKeys,
  forgetAiKey,
  loadAiKeys,
  maskKey,
  refreshAiModels,
  saveAiKey,
  setAiActive,
  setAiKeyBackend,
  setAiModel,
} from "../../public/js/ai-keys.js";
import { cachePut, cachedGet, isAiPath, isQueueable, resetOfflineForTests } from "../../public/js/offline.js";
import { FREE_ENTITLEMENT, canUseAICoach } from "../../public/js/entitlement.js";

// The AI Coach on the web (#319): the pure half in public/js/ai-coach.js, the
// key store in ai-keys.js, and the two rules other modules keep for it.

const collect = () => {
  const events = [];
  return { events, parser: createSseParser((event, data) => events.push([event, data])) };
};

// A streamed Response, cut into the given chunks.
const streamed = (chunks, init = {}) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init });
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const cred = { provider: "anthropic", key: "sk-ant-unit-test-key", model: null };

describe("the gate", () => {
  it("follows the tier", () => {
    expect(canUseAICoach({ tier: "pro", source: "apple", expires_at: 1, auto_renew: true })).toBe(true);
    expect(canUseAICoach(FREE_ENTITLEMENT)).toBe(false);
    expect(canUseAICoach(null)).toBe(false);
  });
});

describe("offline.js never queues or caches /api/ai/*", () => {
  beforeEach(() => resetOfflineForTests());

  it("refuses to queue any method on any /ai path", () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"])
      for (const path of ["/ai/coach", "/ai/coach/verify", "/ai/connections", "/ai"]) expect(isQueueable(method, path)).toBe(false);
    // …without catching a path that only starts with the same letters.
    expect(isAiPath("/aircraft")).toBe(false);
    expect(isQueueable("PUT", "/events/3")).toBe(true);
  });

  it("drops a response it is asked to cache", async () => {
    await cachePut("/ai/coach/verify", { ok: true });
    expect(await cachedGet("/ai/coach/verify")).toBeUndefined();
    await cachePut("/tracks", [{ id: 1 }]);
    expect(await cachedGet("/tracks")).toEqual([{ id: 1 }]);
  });
});

describe("coachContext", () => {
  it("builds each entry point's context from server ids", () => {
    expect(coachContext("session", { eventId: 4, sessionId: "12" })).toEqual({ event_id: 4, session_id: 12 });
    expect(coachContext("compare", { lapId: 31, compareLapId: 40, trackId: "2" })).toEqual({ lap_id: 31, compare_lap_id: 40, track_id: 2 });
    expect(coachContext("compare", { lapId: 31, compareLapId: 40 })).toEqual({ lap_id: 31, compare_lap_id: 40 });
    expect(coachContext("event", { eventId: 4, trackId: 2 })).toEqual({ event_id: 4, track_id: 2 });
  });

  it("is null when a row has no server id yet, or the two laps are one", () => {
    expect(coachContext("session", { eventId: 4, sessionId: "tmp-3" })).toBeNull();
    expect(coachContext("session", { eventId: "tmp-1", sessionId: 3 })).toBeNull();
    expect(coachContext("compare", { lapId: 31, compareLapId: "tmp-9" })).toBeNull();
    expect(coachContext("compare", { lapId: 31, compareLapId: 31 })).toBeNull();
    expect(coachContext("event", { eventId: undefined })).toBeNull();
    expect(coachContext("garage", { eventId: 4 })).toBeNull();
    // A temp track just drops out; the event question still stands.
    expect(coachContext("event", { eventId: 4, trackId: "tmp-2" })).toEqual({ event_id: 4 });
  });

  it("gives every entry point a question, a button and a notes target", () => {
    for (const [key, entry] of Object.entries(COACH_ENTRIES)) {
      expect(entry.button && entry.question && entry.title).toBeTruthy();
      expect(["session", "event"]).toContain(entry.saveTo);
      expect(coachSaveLabel(key)).toBe(entry.saveTo === "session" ? "Save to session notes" : "Save to event notes");
    }
    expect(COACH_ENTRIES.session.saveTo).toBe("session");
    expect(COACH_ENTRIES.compare.saveTo).toBe("event");
    expect(COACH_ENTRIES.event.saveTo).toBe("event");
  });
});

describe("the event-stream parser", () => {
  it("reads the server's recorded stream", () => {
    // contracts/streams/ai-coach.sse is the fake provider's reply as the
    // Worker sent it — the fixture all three clients' parsers read.
    const recorded = readFileSync(new URL("../../contracts/streams/ai-coach.sse", import.meta.url), "utf8");
    const { events, parser } = collect();
    parser.push(recorded);
    parser.end();
    expect(events[0]).toEqual(["tool", { name: "get_session_insights", label: "Analysing the session…" }]);
    expect(events.at(-1)).toEqual(["done", { stop: "end", model: "fake-1" }]);
    const text = events.filter(([e]) => e === "text").map(([, d]) => d.delta).join("");
    expect(text).toContain("**Where the time is.**");
    expect(events.every(([e]) => ["text", "tool", "done"].includes(e))).toBe(true);
  });

  it("gives the same events however the bytes are cut", () => {
    const wire = 'event: tool\ndata: {"name":"get_event","label":"Reading the event…"}\n\nevent: text\ndata: {"delta":"Hello "}\n\n: keepalive\n\nevent: text\ndata: {"delta":"there"}\n\nevent: done\ndata: {"stop":"end","model":"m"}\n\n';
    const whole = collect();
    whole.parser.push(wire);
    whole.parser.end();
    expect(whole.events).toHaveLength(4);
    for (const size of [1, 2, 7, 33]) {
      const cut = collect();
      for (let i = 0; i < wire.length; i += size) cut.parser.push(wire.slice(i, i + size));
      cut.parser.end();
      expect(cut.events).toEqual(whole.events);
    }
    // CRLF line endings, split between the CR and the LF.
    const crlf = collect();
    const dos = wire.replace(/\n/g, "\r\n");
    for (let i = 0; i < dos.length; i += 3) crlf.parser.push(dos.slice(i, i + 3));
    crlf.parser.end();
    expect(crlf.events).toEqual(whole.events);
  });

  it("skips comments and data that is not JSON, and reads a last block with no blank line", () => {
    const { events, parser } = collect();
    parser.push(": keepalive\n\nevent: text\ndata: not json\n\nevent: text\ndata: {\"delta\":\"x\"}");
    expect(events).toEqual([]);
    parser.end();
    expect(events).toEqual([["text", { delta: "x" }]]);
  });
});

describe("streamCoach", () => {
  const body = { context: { session_id: 3 }, messages: [{ role: "user", content: "Debrief" }] };

  it("sends the credential in headers, never in the body, and reports the reply", async () => {
    let sent;
    const fetch = async (url, init) => {
      sent = { url, init };
      return streamed(['event: tool\ndata: {"name":"get_profile","label":"Reading your profile…"}\n\n', 'event: text\ndata: {"delta":"Brake "}\n\nevent: te', 'xt\ndata: {"delta":"later."}\n\nevent: done\ndata: {"stop":"end","model":"m"}\n\n']);
    };
    const seen = { text: "", tools: [] };
    const result = await streamCoach({ credential: cred, body, fetch }, { onText: (d) => (seen.text += d), onTool: (t) => seen.tools.push(t.label) });
    expect(result).toEqual({ kind: "done", stop: "end" });
    expect(seen).toEqual({ text: "Brake later.", tools: ["Reading your profile…"] });
    expect(sent.url).toBe("/api/ai/coach");
    expect(sent.init.method).toBe("POST");
    expect(sent.init.headers["X-TE-AI-Provider"]).toBe("anthropic");
    expect(sent.init.headers["X-TE-AI-Key"]).toBe(cred.key);
    expect(sent.init.body).not.toContain(cred.key);
    expect(JSON.parse(sent.init.body)).toEqual(body);
  });

  it("carries a stop message when the reply was cut short", async () => {
    const fetch = async () => streamed(['event: text\ndata: {"delta":"…"}\n\nevent: done\ndata: {"stop":"tool_limit","model":"m","message":"Reached its limit."}\n\n']);
    expect(await streamCoach({ credential: cred, body, fetch })).toEqual({ kind: "done", stop: "tool_limit", message: "Reached its limit." });
  });

  it("maps 402 to the paywall and 401 to signed out", async () => {
    expect(await streamCoach({ credential: cred, body, fetch: async () => json(402, { error: "pro required" }) })).toEqual({ kind: "paywall" });
    expect(await streamCoach({ credential: cred, body, fetch: async () => json(401, { error: "unauthorized" }) })).toEqual({ kind: "unauthorized" });
  });

  it("reports the server's { error } for a provider failure", async () => {
    for (const [status, error] of [[424, "provider rejected the key"], [429, "rate limited"], [502, "Anthropic is unavailable right now"]])
      expect(await streamCoach({ credential: cred, body, fetch: async () => json(status, { error }) })).toEqual({ kind: "error", status, error });
  });

  it("reports an error event, and a stream that ends without `done`", async () => {
    const failed = async () => streamed(['event: text\ndata: {"delta":"par"}\n\nevent: error\ndata: {"error":"OpenAI is unavailable right now","status":502}\n\n']);
    expect(await streamCoach({ credential: cred, body, fetch: failed })).toEqual({ kind: "error", status: 502, error: "OpenAI is unavailable right now" });
    const cut = async () => streamed(['event: text\ndata: {"delta":"par"}\n\n']);
    expect((await streamCoach({ credential: cred, body, fetch: cut })).kind).toBe("error");
  });

  it("tells a dropped network from an abort", async () => {
    const down = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await streamCoach({ credential: cred, body, fetch: down })).toEqual({ kind: "offline" });
    const controller = new AbortController();
    controller.abort();
    expect(await streamCoach({ credential: cred, body, signal: controller.signal, fetch: down })).toEqual({ kind: "aborted" });
  });
});

describe("verifyCoachKey", () => {
  it("answers the models on success and a sentence on refusal", async () => {
    const models = [{ id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }];
    const ok = await verifyCoachKey("anthropic", "k", async (url, init) => {
      expect(url).toBe("/api/ai/coach/verify");
      expect(init.headers["X-TE-AI-Key"]).toBe("k");
      return json(200, { ok: true, provider: "anthropic", default_model: "claude-sonnet-5-5", models });
    });
    expect(ok).toEqual({ ok: true, default_model: "claude-sonnet-5-5", models });
    const bad = await verifyCoachKey("openai", "k", async () => json(424, { error: "provider rejected the key" }));
    expect(bad).toEqual({ ok: false, status: 424, error: "OpenAI rejected the key. Check it in Settings → AI assistants." });
    const offline = await verifyCoachKey("openai", "k", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(offline.ok).toBe(false);
    expect(offline.error).toContain("needs a connection");
  });
});

describe("the model field", () => {
  const models = [
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
    { id: "gpt-6.2-sol", label: "gpt-6.2-sol" },
  ];

  it("offers each listed model by id, with its name beside it", () => {
    expect(modelOptionsHtml(models)).toBe(
      '<option value="claude-sonnet-5-5" label="Claude Sonnet 5.5"></option>' +
        '<option value="claude-fable-5-2" label="Claude Fable 5.2"></option>' +
        '<option value="gpt-6.2-sol"></option>'
    );
    expect(modelOptionsHtml([])).toBe("");
    expect(modelOptionsHtml(null)).toBe("");
    // A provider's strings are data, not markup.
    expect(modelOptionsHtml([{ id: 'x"><script>', label: "<b>" }])).toBe('<option value="x&quot;&gt;&lt;script&gt;" label="&lt;b&gt;"></option>');
    expect(modelOptionsHtml([{ id: "" }, null, { label: "no id" }])).toBe("");
  });

  it("reads what was typed as a model id", () => {
    expect(resolveModelInput("claude-fable-5-2", models)).toBe("claude-fable-5-2");
    expect(resolveModelInput("  Claude-Fable-5-2 ", models)).toBe("claude-fable-5-2");
    // A browser that fills the field with the option's name still picks its id.
    expect(resolveModelInput("Claude Fable 5.2", models)).toBe("claude-fable-5-2");
    // Not in the list: taken as typed — the provider is the judge of it.
    expect(resolveModelInput("claude-opus-6", models)).toBe("claude-opus-6");
    // Nothing is the default.
    expect(resolveModelInput("", models)).toBeNull();
    expect(resolveModelInput("   ", models)).toBeNull();
    expect(resolveModelInput(null, null)).toBeNull();
  });

  it("says which model an empty field means", () => {
    expect(modelPlaceholder("claude-sonnet-5-5")).toBe("Default (claude-sonnet-5-5)");
    expect(modelPlaceholder(null)).toBe("Default");
  });
});

describe("coachErrorText", () => {
  it("shows the server's message as a sentence", () => {
    expect(coachErrorText(502, "Anthropic is unavailable right now — try again shortly", "anthropic")).toBe("Anthropic is unavailable right now — try again shortly.");
    expect(coachErrorText(429, "rate limited — too many AI Coach requests; wait a minute", "openai")).toBe("Rate limited — too many AI Coach requests; wait a minute.");
    expect(coachErrorText(500, "", "openai")).toBe("The AI Coach couldn't answer. Try again.");
  });
});

describe("coachMarkdownHtml", () => {
  it("draws paragraphs, lists and bold", () => {
    expect(coachMarkdownHtml("**Where the time is.** In T3.\nStill T3.\n\n- brake later\n- **more** throttle\n\n1. first\n2) second")).toBe(
      "<p><strong>Where the time is.</strong> In T3.<br>Still T3.</p><ul><li>brake later</li><li><strong>more</strong> throttle</li></ul><ol><li>first</li><li>second</li></ol>"
    );
  });

  it("renders a reply carrying markup inert", () => {
    const html = coachMarkdownHtml('Try this: <img src=x onerror="alert(1)">\n\n- <script>steal()</script>\n- **<b onclick=x>bold</b>**\n\n# <svg onload=x>\n\n[link](javascript:alert(1))');
    // Every angle bracket and quote the model wrote is text…
    expect(html).not.toMatch(/<(img|script|svg|b |a )/i);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    // …and the only tags are the ones the renderer writes.
    expect([...html.matchAll(/<\/?([a-z]+)[^>]*>/g)].every((m) => ["p", "ul", "ol", "li", "strong", "br"].includes(m[1]))).toBe(true);
    expect(html).not.toMatch(/<[a-z]+ [^>]*>/); // no tag carries an attribute
    // A link stays the text it is: nothing becomes an href.
    expect(html).toContain("[link](javascript:alert(1))");
  });

  it("handles nothing, and a heading", () => {
    expect(coachMarkdownHtml("")).toBe("");
    expect(coachMarkdownHtml(null)).toBe("");
    expect(coachMarkdownHtml("## Next **session**")).toBe("<p><strong>Next session</strong></p>");
  });
});

// The phones port these two and draw the blocks as styled text (#320).
describe("coachMarkdownBlocks and coachBoldRuns", () => {
  it("splits a reply into paragraphs, lists and headings", () => {
    expect(coachMarkdownBlocks("A\nB\n\n- one\n  more\n1. two\n# Head **x**")).toEqual([
      { type: "p", lines: ["A", "B"] },
      { type: "ul", items: ["one more"] },
      { type: "ol", items: ["two"] },
      { type: "h", text: "Head x" },
    ]);
  });

  it("splits a line at its bold marks and leaves an unclosed one alone", () => {
    expect(coachBoldRuns("a **b** c")).toEqual([
      { text: "a ", bold: false },
      { text: "b", bold: true },
      { text: " c", bold: false },
    ]);
    expect(coachBoldRuns("**open")).toEqual([{ text: "**open", bold: false }]);
    expect(coachBoldRuns("")).toEqual([]);
  });
});

describe("keeping a reply in the notes", () => {
  const date = new Date(2026, 10, 26, 15, 0);

  it("labels it so a human coach can tell it from the driver's words", () => {
    expect(coachNotesLabel(date)).toBe("AI Coach, 26 Nov");
    expect(coachNotesLabel(new Date(2027, 0, 3))).toBe("AI Coach, 3 Jan");
  });

  it("appends under what was there, as plain text", () => {
    expect(appendCoachNote("Fronts at 34 hot.", "**Brake** later.\n\n* T3\n* T5", date)).toBe("Fronts at 34 hot.\n\nAI Coach, 26 Nov:\nBrake later.\n\n- T3\n- T5");
    expect(appendCoachNote(null, "Short.", date)).toBe("AI Coach, 26 Nov:\nShort.");
    expect(appendCoachNote("   ", "Short.", date)).toBe("AI Coach, 26 Nov:\nShort.");
  });

  it("strips the marks notes cannot show", () => {
    expect(coachPlainText("## Plan\n\n\n\n**One** thing\n- kept dash")).toBe("Plan\n\nOne thing\n- kept dash");
  });
});

describe("the key store", () => {
  const fakeBackend = () => {
    let value;
    return {
      stored: () => value,
      get: async () => value,
      set: async (v) => void (value = structuredClone(v)),
      clear: async () => void (value = undefined),
    };
  };
  const models = [{ id: "m1", label: "Model 1" }];

  it("holds a key for the tab by default and stores nothing", async () => {
    const backend = fakeBackend();
    setAiKeyBackend(backend);
    await loadAiKeys();
    expect(aiCredential()).toBeNull();
    expect(await saveAiKey("anthropic", { key: "sk-ant-aaaaaaaaaaaaaaaa1234", models })).toBe(true);
    expect(aiCredential()).toEqual({ provider: "anthropic", key: "sk-ant-aaaaaaaaaaaaaaaa1234", model: null });
    expect(backend.stored()).toBeUndefined();
  });

  it("remembers only the keys it was asked to, and reads them back", async () => {
    const backend = fakeBackend();
    setAiKeyBackend(backend);
    await saveAiKey("anthropic", { key: "sk-ant-tab-only-000000000", models });
    await saveAiKey("openai", { key: "sk-remembered-00000000000", models, remember: true });
    expect(Object.keys(backend.stored().keys)).toEqual(["openai"]);
    // A new tab: only the remembered key comes back.
    const kept = backend.stored();
    setAiKeyBackend({ ...fakeBackend(), get: async () => kept });
    await loadAiKeys();
    expect(aiKeyState().map((s) => [s.id, s.hasKey, s.remembered])).toEqual([["anthropic", false, false], ["openai", true, true], ["gemini", false, false]]);
    expect(aiCredential().provider).toBe("openai");
  });

  it("uses the provider the driver picked, with its model", async () => {
    setAiKeyBackend(fakeBackend());
    await saveAiKey("anthropic", { key: "sk-ant-aaaaaaaaaaaaaaaa1234", models });
    await saveAiKey("openai", { key: "sk-bbbbbbbbbbbbbbbbbbbb5678", models });
    expect(aiCredential().provider).toBe("anthropic"); // the first one set up
    await setAiActive("openai");
    await setAiModel("openai", "m1");
    expect(aiCredential()).toEqual({ provider: "openai", key: "sk-bbbbbbbbbbbbbbbbbbbb5678", model: "m1" });
    await forgetAiKey("openai");
    expect(aiCredential().provider).toBe("anthropic");
    await forgetAiKey("anthropic");
    expect(aiCredential()).toBeNull();
  });

  it("refreshes a provider's models with its key, and keeps the old list when that fails", async () => {
    const backend = fakeBackend();
    setAiKeyBackend(backend);
    const key = "sk-ant-aaaaaaaaaaaaaaaa1234";
    await saveAiKey("anthropic", { key, models, defaultModel: "m1", remember: true });
    expect(aiKeyState()[0].defaultModel).toBe("m1");
    const fresh = [...models, { id: "m2", label: "Model 2" }];
    const calls = [];
    const got = await refreshAiModels("anthropic", async (provider, k) => {
      calls.push([provider, k]);
      return { ok: true, default_model: "m2", models: fresh };
    });
    expect(calls).toEqual([["anthropic", key]]);
    expect(got).toEqual(fresh);
    expect(aiKeyState()[0].models).toEqual(fresh);
    expect(aiKeyState()[0].defaultModel).toBe("m2");
    expect(backend.stored().keys.anthropic.models).toEqual(fresh);
    // The provider is down: the list that was there stands.
    expect(await refreshAiModels("anthropic", async () => ({ ok: false, status: 502, error: "down" }))).toBeNull();
    expect(aiKeyState()[0].models).toEqual(fresh);
    // No key, nothing to ask with.
    expect(await refreshAiModels("openai", async () => ({ ok: true, models: [] }))).toBeNull();
    // A key forgotten while the request was out is not brought back.
    const late = refreshAiModels("anthropic", async () => {
      await forgetAiKey("anthropic");
      return { ok: true, models: fresh };
    });
    expect(await late).toBeNull();
    expect(aiCredential()).toBeNull();
  });

  it("takes a typed model id, trimmed, and empty as the default", async () => {
    setAiKeyBackend(fakeBackend());
    await saveAiKey("openai", { key: "sk-bbbbbbbbbbbbbbbbbbbb5678", models });
    await setAiModel("openai", "  gpt-6.2-sol ");
    expect(aiCredential().model).toBe("gpt-6.2-sol");
    await setAiModel("openai", "   ");
    expect(aiCredential().model).toBeNull();
  });

  it("never shows a key in Settings' state", async () => {
    setAiKeyBackend(fakeBackend());
    const key = "sk-ant-secretsecretsecret9Qf";
    await saveAiKey("anthropic", { key, models });
    expect(JSON.stringify(aiKeyState())).not.toContain(key);
    expect(aiKeyState()[0].masked).toBe("sk-ant-…t9Qf");
    expect(maskKey("short")).toBe("…");
  });

  it("works for the tab when the browser refuses storage, and says the key was not remembered", async () => {
    const refuse = async () => {
      throw new Error("storage blocked");
    };
    setAiKeyBackend({ get: refuse, set: refuse, clear: refuse });
    await loadAiKeys();
    expect(await saveAiKey("anthropic", { key: "sk-ant-aaaaaaaaaaaaaaaa1234", models, remember: true })).toBe(false);
    expect(aiKeyState()[0].remembered).toBe(false);
    expect(aiCredential().provider).toBe("anthropic");
  });

  it("clears everything on sign-out", async () => {
    const backend = fakeBackend();
    setAiKeyBackend(backend);
    await saveAiKey("openai", { key: "sk-remembered-00000000000", models, remember: true });
    await clearAiKeys();
    expect(aiCredential()).toBeNull();
    expect(backend.stored()).toBeUndefined();
  });
});
