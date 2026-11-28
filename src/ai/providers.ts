// The AI Coach's provider adapters (#318): Anthropic's Messages API, OpenAI's
// Responses API, Google's Gemini API, and a scripted fake for tests and demos. Each is a thin layer
// over `fetch` — no SDK — that turns one provider's streaming tool-use wire
// format into the same three things the loop (ai/coach.ts) needs: text deltas,
// the tool calls a turn ended on, and why it stopped.
//
// Every call takes its `fetch`, as src/youtube/ does, so a test can script a
// provider. Nothing here logs, and nothing here stores: the driver's key lives
// in the request headers of the one outbound call and nowhere else. Provider
// error bodies are never passed through — OpenAI's 401 echoes part of the key
// back — only mapped to our own words.

import type { CoachContext } from "./coach-prompt";
import type { InputSchema } from "./tools";

export type ProviderId = "anthropic" | "openai" | "gemini" | "fake";
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// What a provider failure becomes for the client: bad credentials and account
// trouble are 424 (never our 401, which would sign the client out), their rate
// limit 429, anything else of theirs 502.
export class ProviderError extends Error {
  constructor(
    public status: 424 | 429 | 502,
    message: string,
    public retryAfter: string | null = null
  ) {
    super(message);
  }
}

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ToolSpec = { name: string; description: string; inputSchema: InputSchema };
// `badArgs`: the model's arguments were not valid JSON — answered with a tool
// error rather than run.
export type ToolCall = { id: string; name: string; args: unknown; badArgs?: true };
export type ToolOutput = { call: ToolCall; text: string; isError: boolean };
export type TurnStop = "end" | "tools" | "max_tokens" | "refusal";
export type Turn = { stop: TurnStop; calls: ToolCall[] };
// Reads one streamed turn to its end, handing each text delta on as it arrives.
export type TurnReader = (onText: (delta: string) => Promise<void> | void) => Promise<Turn>;

export type Conversation = {
  // Sends the conversation so far. Resolves once the provider has answered
  // with a status — so a rejected key fails here, before any stream opens —
  // and throws ProviderError otherwise. `final` forbids further tool calls.
  request(opts?: { final?: boolean }): Promise<TurnReader>;
  addResults(outputs: ToolOutput[]): void;
};

export type StartOptions = {
  key: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  context: CoachContext;
  fetch: FetchLike;
};

export type Provider = {
  id: ProviderId;
  name: string;
  defaultModel: string;
  // The models we know the loop's request shape works on: what verify offers
  // when the provider's own list can't be read, and the default first.
  models: ModelChoice[];
  // Whether `model` may be asked for at all: a built-in id, or anything shaped
  // like one of this provider's chat models. The driver's account decides the
  // rest — a model it can't use comes back as a 424 naming it.
  acceptsModel(id: string): boolean;
  start(opts: StartOptions): Conversation;
  // One call that proves the key works *and* reads the models the driver's
  // account can use, for Settings' model field to complete from (the
  // provider's models API, narrowed to the ones the loop can drive). Throws
  // ProviderError for a key the provider refuses.
  listModels(key: string, fetch: FetchLike): Promise<ModelChoice[]>;
};

export type ModelChoice = { id: string; label: string };

// The most models verify answers with: a picker's worth, not a catalogue.
const MAX_MODEL_CHOICES = 60;

// The built-in models first (the default leading), then what the provider
// listed that they don't already cover, in the provider's order.
function mergeModels(provider: Provider, listed: ModelChoice[]): ModelChoice[] {
  const byId = new Map(listed.map((m) => [m.id, m]));
  const builtIn = provider.models.filter((m) => !listed.length || byId.has(m.id)).map((m) => byId.get(m.id) ?? m);
  const lead = builtIn.length ? builtIn : provider.models;
  const seen = new Set(lead.map((m) => m.id));
  return [...lead, ...listed.filter((m) => !seen.has(m.id))].slice(0, MAX_MODEL_CHOICES);
}

// Output tokens per provider request. Every provider counts reasoning against
// it, so it is well above what a debrief's visible text needs.
const ANTHROPIC_MAX_TOKENS = 16_000;
const OPENAI_MAX_OUTPUT_TOKENS = 25_000;
const GEMINI_MAX_OUTPUT_TOKENS = 25_000;

// ---------- shared plumbing --------------------------------------------------

// Server-sent events off a response body: `event:` / `data:` blocks separated
// by a blank line, comments (":…") ignored, multi-line data joined.
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader();
  let buf = "";
  const parse = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    // Normalise line endings, holding back a trailing CR whose LF may be in
    // the next chunk.
    const held = !done && buf.endsWith("\r") ? "\r" : "";
    buf = buf.slice(0, buf.length - held.length).replace(/\r\n?/g, "\n") + held;
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const ev = parse(buf.slice(0, cut));
      buf = buf.slice(cut + 2);
      if (ev) yield ev;
    }
    if (done) {
      const ev = parse(buf);
      if (ev) yield ev;
      return;
    }
  }
}

const parseJson = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const unavailable = (name: string) => new ProviderError(502, `${name} is unavailable right now — try again shortly`);

// One outbound provider call. A transport failure is theirs being down, and
// the error object is dropped rather than rethrown: nothing derived from the
// request (its headers carry the key) leaves this function.
async function call(name: string, fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw unavailable(name);
  }
}

// A non-2xx provider answer in our words. `detail` is the provider's own
// error object, read only to tell an empty account from a rate limit.
async function failure(name: string, res: Response, model: string | null, custom = false): Promise<ProviderError> {
  const body = parseJson(await res.text().catch(() => "")) ?? {};
  const detail = body.error ?? {};
  const said = `${detail.code ?? ""} ${detail.type ?? ""} ${detail.message ?? ""}`.toLowerCase();
  const outOfCredit = said.includes("insufficient_quota") || said.includes("credit balance") || said.includes("billing");
  if (res.status === 401 || res.status === 403) return new ProviderError(424, "provider rejected the key");
  if (outOfCredit) return new ProviderError(424, `your ${name} account is out of credit — add credit there and try again`);
  if (res.status === 404 && model) return new ProviderError(424, `your ${name} account can't use the model ${model}`);
  if (res.status === 429)
    return new ProviderError(429, `${name} is rate limiting your account — wait a moment and try again`, res.headers.get("Retry-After"));
  if (res.status >= 500) return unavailable(name);
  // A model the driver typed or picked from their account's list, outside the
  // ones the request shape is known to suit: the likeliest reason for a 400.
  if (custom && model) return new ProviderError(424, `the model ${model} doesn't work with the AI Coach — pick another in Settings`);
  return new ProviderError(502, `${name} refused the request`);
}

function requireStream(name: string, res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw unavailable(name);
  return res.body;
}

// ---------- Anthropic: the Messages API --------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
// A request Anthropic's safety classifiers decline is retried by the API on
// another Claude model inside the same call (server-side fallback). Haiku has
// no server-side fallback, so it goes without.
const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";
// The model families Anthropic documents server-side fallback for. A model
// outside them — Haiku, an older or a future one — goes without rather than
// risk a 400 on a parameter it does not take.
const anthropicHasFallback = (model: string) => /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/.test(model);

const anthropicHeaders = (key: string, extra: Record<string, string> = {}) => ({
  "x-api-key": key,
  "anthropic-version": ANTHROPIC_VERSION,
  "content-type": "application/json",
  ...extra,
});

export const anthropic: Provider = {
  id: "anthropic",
  name: "Anthropic",
  defaultModel: "claude-sonnet-5-5",
  models: [
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  ],
  acceptsModel: (id) => anthropic.models.some((m) => m.id === id) || /^claude-[a-z0-9][a-z0-9.-]{0,80}$/.test(id),

  start({ key, model, system, messages, tools, fetch }) {
    // The conversation in Anthropic's shape. Assistant turns are appended as
    // the full content-block arrays they arrived as — thinking blocks and
    // their signatures included, unchanged — which the API requires of a
    // tool-use loop.
    const history: { role: "user" | "assistant"; content: unknown }[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const fallback = anthropicHasFallback(model);
    const custom = !anthropic.models.some((m) => m.id === model);

    return {
      async request({ final = false } = {}) {
        const res = await call("Anthropic", fetch, `${ANTHROPIC_URL}/messages`, {
          method: "POST",
          headers: anthropicHeaders(key, fallback ? { "anthropic-beta": ANTHROPIC_FALLBACK_BETA } : {}),
          body: JSON.stringify({
            model,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            stream: true,
            // Thinking is adaptive by default on every model in the list;
            // effort is the one depth control, and medium suits a tool loop.
            output_config: { effort: "medium" },
            // The tools and system prompt repeat on every round of the loop:
            // cache the prefix so rounds two to eight read it back.
            cache_control: { type: "ephemeral" },
            system,
            tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
            ...(final ? { tool_choice: { type: "none" } } : {}),
            ...(fallback ? { fallbacks: "default" } : {}),
            messages: history,
          }),
        });
        if (!res.ok) throw await failure("Anthropic", res, model, custom);
        const body = requireStream("Anthropic", res);

        return async (onText) => {
          const blocks: any[] = [];
          const inputJson: Record<number, string> = {};
          const bad = new Set<number>();
          let stopReason: string | null = null;
          for await (const { data } of sseEvents(body)) {
            const ev = parseJson(data);
            if (!ev) continue;
            switch (ev.type) {
              case "content_block_start":
                blocks[ev.index] = { ...ev.content_block };
                if (ev.content_block?.type === "tool_use") inputJson[ev.index] = "";
                break;
              case "content_block_delta": {
                const block = blocks[ev.index];
                const d = ev.delta ?? {};
                if (!block) break;
                if (d.type === "text_delta") {
                  block.text = (block.text ?? "") + d.text;
                  if (d.text) await onText(d.text);
                } else if (d.type === "input_json_delta") inputJson[ev.index] = (inputJson[ev.index] ?? "") + d.partial_json;
                else if (d.type === "thinking_delta") block.thinking = (block.thinking ?? "") + d.thinking;
                else if (d.type === "signature_delta") block.signature = d.signature;
                break;
              }
              case "content_block_stop": {
                const block = blocks[ev.index];
                if (block?.type !== "tool_use") break;
                const raw = inputJson[ev.index] ?? "";
                const input = raw.trim() ? parseJson(raw) : {};
                if (input === undefined || input === null || typeof input !== "object") {
                  bad.add(ev.index);
                  block.input = {};
                } else block.input = input;
                break;
              }
              case "message_delta":
                if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
                break;
              case "error":
                throw unavailable("Anthropic");
            }
          }
          // A stream that ended without a stop reason was cut off mid-answer.
          if (!stopReason) throw unavailable("Anthropic");
          const content = blocks.filter(Boolean);
          if (content.length) history.push({ role: "assistant", content });
          const calls: ToolCall[] = [];
          blocks.forEach((b, i) => {
            if (b?.type === "tool_use") calls.push({ id: b.id, name: b.name, args: b.input, ...(bad.has(i) ? { badArgs: true as const } : {}) });
          });
          if (stopReason === "refusal") return { stop: "refusal", calls: [] };
          // A tool call cut off by the length limit may be truncated: never run it.
          if (stopReason === "max_tokens") return { stop: "max_tokens", calls: [] };
          if (stopReason === "tool_use" && calls.length) return { stop: "tools", calls };
          return { stop: "end", calls: [] };
        };
      },

      addResults(outputs) {
        // Every result of a turn goes back in one user message.
        history.push({
          role: "user",
          content: outputs.map((o) => ({
            type: "tool_result",
            tool_use_id: o.call.id,
            content: o.text,
            ...(o.isError ? { is_error: true } : {}),
          })),
        });
      },
    };
  },

  // GET /v1/models: every model the key's organization can call, each with a
  // capability tree. The loop sends adaptive thinking and `effort: "medium"`,
  // so only models that say they take both are offered.
  async listModels(key, fetch) {
    const res = await call("Anthropic", fetch, `${ANTHROPIC_URL}/models?limit=1000`, { method: "GET", headers: anthropicHeaders(key) });
    if (!res.ok) throw await failure("Anthropic", res, null);
    const body = parseJson(await res.text().catch(() => "")) ?? {};
    const listed: ModelChoice[] = (Array.isArray(body.data) ? body.data : [])
      .filter(
        (m: any) =>
          typeof m?.id === "string" &&
          anthropic.acceptsModel(m.id) &&
          m.capabilities?.thinking?.types?.adaptive?.supported === true &&
          m.capabilities?.effort?.medium?.supported === true
      )
      .map((m: any) => ({ id: m.id, label: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id }));
    return mergeModels(anthropic, listed);
  },
};

// ---------- OpenAI: the Responses API ----------------------------------------
//
// Responses, not chat completions: it is what a Sign in with ChatGPT token
// calls (#503), so a pasted key and a connected account share this adapter.
// Stateless (`store: false`): the whole input is resent each round, with every
// output item of the previous round — reasoning items included — appended in
// order, as the API asks of a function-calling loop.

const OPENAI_URL = "https://api.openai.com/v1";
const openaiHeaders = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
// GET /v1/models lists everything an account has — embeddings, speech, image
// and realtime models among them — with no capability field to filter on. So
// the chat models are told apart by name: the GPT and o-series families, less
// the ones built for another job.
const OPENAI_CHAT_MODEL = /^(gpt-|o\d|chatgpt-)[a-z0-9][a-z0-9._:-]{0,80}$/;
const OPENAI_NOT_CHAT = /(realtime|audio|tts|transcribe|whisper|image|embedding|moderation|search|instruct|codex)/;
const isOpenAIChatModel = (id: string) => OPENAI_CHAT_MODEL.test(id) && !OPENAI_NOT_CHAT.test(id);

export const openai: Provider = {
  id: "openai",
  name: "OpenAI",
  defaultModel: "gpt-6.2-astra",
  models: [
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
  ],
  acceptsModel: (id) => openai.models.some((m) => m.id === id) || isOpenAIChatModel(id),

  start({ key, model, system, messages, tools, fetch }) {
    const input: unknown[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const custom = !openai.models.some((m) => m.id === model);

    return {
      async request({ final = false } = {}) {
        const res = await call("OpenAI", fetch, `${OPENAI_URL}/responses`, {
          method: "POST",
          headers: openaiHeaders(key),
          body: JSON.stringify({
            model,
            stream: true,
            store: false,
            max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
            instructions: system,
            tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema, strict: false })),
            ...(final ? { tool_choice: "none" } : {}),
            input,
          }),
        });
        if (!res.ok) throw await failure("OpenAI", res, model, custom);
        const body = requireStream("OpenAI", res);

        return async (onText) => {
          const items: any[] = [];
          let finished: any = null;
          for await (const { data } of sseEvents(body)) {
            const ev = parseJson(data);
            if (!ev) continue;
            switch (ev.type) {
              case "response.output_text.delta":
                if (ev.delta) await onText(ev.delta);
                break;
              case "response.output_item.done":
                if (ev.item) items.push(ev.item);
                break;
              case "response.completed":
              case "response.incomplete":
                finished = ev.response ?? {};
                break;
              case "response.failed":
              case "error":
                throw unavailable("OpenAI");
            }
          }
          if (!finished) throw unavailable("OpenAI");
          const output: any[] = Array.isArray(finished.output) && finished.output.length ? finished.output : items;
          input.push(...output);
          const refused = output.some((it) => it?.type === "message" && (it.content ?? []).some((c: any) => c?.type === "refusal"));
          if (refused) return { stop: "refusal", calls: [] };
          if (finished.status === "incomplete") return { stop: "max_tokens", calls: [] };
          const calls: ToolCall[] = output
            .filter((it) => it?.type === "function_call")
            .map((it) => {
              const args = String(it.arguments ?? "").trim() ? parseJson(it.arguments) : {};
              const ok = args !== undefined && args !== null && typeof args === "object";
              return { id: it.call_id, name: it.name, args: ok ? args : {}, ...(ok ? {} : { badArgs: true as const }) };
            });
          return calls.length ? { stop: "tools", calls } : { stop: "end", calls: [] };
        };
      },

      addResults(outputs) {
        for (const o of outputs) input.push({ type: "function_call_output", call_id: o.call.id, output: o.text });
      },
    };
  },

  // GET /v1/models. A restricted key may be allowed to call Responses but not
  // to list models: that 403 is a working key with no list to offer, so it
  // gets the built-in models rather than "rejected" (a 401 is still that).
  async listModels(key, fetch) {
    const res = await call("OpenAI", fetch, `${OPENAI_URL}/models`, { method: "GET", headers: openaiHeaders(key) });
    if (res.status === 403) return openai.models;
    if (!res.ok) throw await failure("OpenAI", res, null);
    const body = parseJson(await res.text().catch(() => "")) ?? {};
    const listed: ModelChoice[] = (Array.isArray(body.data) ? body.data : [])
      .filter((m: any) => typeof m?.id === "string" && isOpenAIChatModel(m.id))
      // Newest first: the list arrives in no useful order.
      .sort((a: any, b: any) => (Number(b.created) || 0) - (Number(a.created) || 0))
      .map((m: any) => ({ id: m.id, label: openai.models.find((x) => x.id === m.id)?.label ?? m.id }));
    return mergeModels(openai, listed);
  },
};

// ---------- Google: the Gemini API -------------------------------------------
//
// `streamGenerateContent?alt=sse` on the Generative Language API, with the key
// in the `x-goog-api-key` header — never the `?key=` query string Google's
// examples also show, because a URL is what ends up in a log.
//
// Three things differ from the other two:
//   - a function call arrives whole in one part, not as argument deltas, and
//     may carry no id (results are then matched by name and order);
//   - parts carry an opaque `thoughtSignature` the API wants back exactly
//     where it was. So a model turn is appended to the history as the parts
//     it streamed, unmerged and unedited — a missing signature is a 400 or a
//     MISSING_THOUGHT_SIGNATURE finish on the thinking models;
//   - a rejected key is a 400 (`API_KEY_INVALID`), not a 401, so the failure
//     mapping is its own.
// Tool schemas go as `parametersJsonSchema` (plain JSON Schema): `parameters`
// is an OpenAPI subset that refuses `additionalProperties`. Thinking is left
// at each model's default, since the control differs by model generation.

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta";
const geminiHeaders = (key: string) => ({ "x-goog-api-key": key, "content-type": "application/json" });
// models.list carries everything a key can reach — image, speech, embedding
// and live models among them. Chat models are told apart by name, and by
// supporting generateContent.
const GEMINI_CHAT_MODEL = /^gemini-[a-z0-9][a-z0-9.-]{0,80}$/;
const GEMINI_NOT_CHAT = /(image|tts|audio|live|embedding|transcribe|robotics|computer-use|banana|veo|lyria)/;
const isGeminiChatModel = (id: string) => GEMINI_CHAT_MODEL.test(id) && !GEMINI_NOT_CHAT.test(id);

// Finish reasons that are the model or its filters declining, not a fault.
const GEMINI_DECLINED = new Set(["SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);

const geminiRateLimited = (retryAfter: string | null) =>
  new ProviderError(
    429,
    "Gemini is rate limiting your Google account, not Track Evolution — the free tier's limits are low; wait a minute and try again, or enable billing in Google AI Studio",
    retryAfter
  );

// Google's error envelope: `{ error: { code, message, status, details } }`.
// Read for its status and reasons only; none of it is passed on.
async function geminiFailure(res: Response, model: string | null, custom = false): Promise<ProviderError> {
  const body = parseJson(await res.text().catch(() => "")) ?? {};
  // A non-streaming error may arrive wrapped in an array.
  const detail = (Array.isArray(body) ? body[0]?.error : body.error) ?? {};
  const details: any[] = Array.isArray(detail.details) ? detail.details : [];
  const said = `${detail.status ?? ""} ${detail.message ?? ""} ${details.map((d) => d?.reason ?? "").join(" ")}`.toLowerCase();
  if (res.status === 401 || res.status === 403 || said.includes("api_key_invalid") || said.includes("api key not valid") || said.includes("api key expired"))
    return new ProviderError(424, "provider rejected the key");
  if (res.status === 429) {
    // RetryInfo's `retryDelay` is seconds with an "s" suffix ("34s").
    const delay = details.map((d) => /^(\d+)(?:\.\d+)?s$/.exec(String(d?.retryDelay ?? ""))?.[1]).find(Boolean);
    return geminiRateLimited(res.headers.get("Retry-After") ?? delay ?? null);
  }
  // The free tier is not offered everywhere; Google answers this until the
  // account has billing.
  if (said.includes("failed_precondition"))
    return new ProviderError(424, "Gemini's free tier isn't available for your Google account or region — enable billing in Google AI Studio and try again");
  if (res.status === 404 && model) return new ProviderError(424, `your Gemini account can't use the model ${model}`);
  if (res.status >= 500) return unavailable("Gemini");
  if (custom && model) return new ProviderError(424, `the model ${model} doesn't work with the AI Coach — pick another in Settings`);
  return new ProviderError(502, "Gemini refused the request");
}

export const gemini: Provider = {
  id: "gemini",
  name: "Gemini",
  defaultModel: "gemini-3.8-flash",
  models: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-pro-latest", label: "Gemini Pro" },
    { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite" },
  ],
  acceptsModel: (id) => gemini.models.some((m) => m.id === id) || isGeminiChatModel(id),

  start({ key, model, system, messages, tools, fetch }) {
    const contents: { role: "user" | "model"; parts: any[] }[] = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const custom = !gemini.models.some((m) => m.id === model);
    let minted = 0;

    return {
      async request({ final = false } = {}) {
        // `model` passed acceptsModel, so it is a bare id; encoded all the same.
        const res = await call("Gemini", fetch, `${GEMINI_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: geminiHeaders(key),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }],
            toolConfig: { functionCallingConfig: { mode: final ? "NONE" : "AUTO" } },
            generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
          }),
        });
        if (!res.ok) throw await geminiFailure(res, model, custom);
        const body = requireStream("Gemini", res);

        return async (onText) => {
          const parts: any[] = [];
          const calls: ToolCall[] = [];
          let finish: string | null = null;
          let blocked = false;
          let wrote = false;
          for await (const { data } of sseEvents(body)) {
            const chunk = parseJson(data);
            if (!chunk) continue;
            // A failure after the 200: the same envelope, mid-stream.
            if (chunk.error) throw Number(chunk.error.code) === 429 ? geminiRateLimited(null) : unavailable("Gemini");
            if (chunk.promptFeedback?.blockReason) blocked = true;
            const candidate = chunk.candidates?.[0];
            if (!candidate) continue;
            for (const part of candidate.content?.parts ?? []) {
              if (!part || typeof part !== "object") continue;
              parts.push(part);
              if (part.functionCall) {
                const fc = part.functionCall;
                const args = fc.args ?? {};
                const ok = typeof args === "object" && !Array.isArray(args);
                calls.push({
                  // Gemini may send no id; ours is never sent back (see addResults).
                  id: typeof fc.id === "string" && fc.id ? fc.id : `gemini_call_${++minted}`,
                  name: String(fc.name ?? ""),
                  args: ok ? args : {},
                  ...(ok ? {} : { badArgs: true as const }),
                });
              } else if (typeof part.text === "string" && part.text && !part.thought) {
                wrote = true;
                await onText(part.text);
              }
            }
            if (candidate.finishReason) finish = candidate.finishReason;
          }
          if (blocked && !parts.length) return { stop: "refusal", calls: [] };
          // A stream that ended without a finish reason was cut off mid-answer.
          if (!finish) throw unavailable("Gemini");
          if (parts.length) contents.push({ role: "model", parts });
          if (GEMINI_DECLINED.has(finish)) return { stop: "refusal", calls: [] };
          // A tool call cut off by the length limit may be truncated: never run it.
          if (finish === "MAX_TOKENS") return { stop: "max_tokens", calls: [] };
          if (finish === "STOP") return calls.length ? { stop: "tools", calls } : { stop: "end", calls: [] };
          // The model tried a call it could not form, or one after tools were
          // forbidden. Whatever it had written stands as the answer.
          if ((finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") && wrote) return { stop: "end", calls: [] };
          throw unavailable("Gemini");
        };
      },

      addResults(outputs) {
        // Every result of a turn goes back in one user turn, in call order.
        // `response` must be an object: `output` for a result, `error` for a
        // failure. The id is echoed only when Gemini sent one.
        contents.push({
          role: "user",
          parts: outputs.map((o) => ({
            functionResponse: {
              ...(o.call.id.startsWith("gemini_call_") ? {} : { id: o.call.id }),
              name: o.call.name,
              response: o.isError ? { error: o.text } : { output: o.text },
            },
          })),
        });
      },
    };
  },

  // GET /v1beta/models: what the key can call. Each names the methods it
  // supports; only generateContent models that are chat models by name are
  // offered.
  async listModels(key, fetch) {
    const res = await call("Gemini", fetch, `${GEMINI_URL}/models?pageSize=1000`, { method: "GET", headers: geminiHeaders(key) });
    if (!res.ok) throw await geminiFailure(res, null);
    const body = parseJson(await res.text().catch(() => "")) ?? {};
    const listed: ModelChoice[] = (Array.isArray(body.models) ? body.models : [])
      .map((m: any) => ({ ...m, id: typeof m?.name === "string" ? m.name.replace(/^models\//, "") : "" }))
      .filter((m: any) => isGeminiChatModel(m.id) && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map((m: any) => ({ id: m.id, label: gemini.models.find((x) => x.id === m.id)?.label ?? (typeof m.displayName === "string" && m.displayName ? m.displayName : m.id) }));
    return mergeModels(gemini, listed);
  },
};

// ---------- the fake provider ------------------------------------------------
//
// `X-TE-AI-Provider: fake` (routes/aiCoach.ts gates it on DEV_MODE and
// isDevHost, like every dev shortcut): calls one tool — the one the entry
// point would start with — then streams a fixed reply. The web tests, both
// native UI suites, the stream fixture in contracts/streams/ and the guide
// captures all run on it, so its output is deterministic and names no row.

export const FAKE_REPLY_CHUNKS = [
  "**Where the time is.** Your best lap sits close to your theoretical best, ",
  "so the pace is there — the gap is in stringing your best sectors together.\n\n",
  "- **Brake release into the slow corners**: the minimum speed at the apex is where the laps differ most.\n",
  "- **Throttle pickup**: full throttle comes later on your slower laps onto the longest straight.\n\n",
  "For the next session, pick one corner and work on releasing the brake a little earlier. ",
  "Your instructor can tell you whether the car is ready for it.",
];
export const FAKE_FOLLOW_UP_CHUNKS = ["Start with the slowest corner: ", "it is where a small change in minimum speed is worth the most time."];

export const fake: Provider = {
  id: "fake",
  name: "Fake provider",
  defaultModel: "fake-1",
  models: [{ id: "fake-1", label: "Fake 1" }],
  acceptsModel: (id) => id === "fake-1",

  start({ messages, context }) {
    const followUp = messages.length > 1;
    let step = 0;
    const first = (): ToolCall => {
      if (context.lap_id != null && context.compare_lap_id != null)
        return { id: "fake_1", name: "compare_laps", args: { lap_a_id: context.lap_id, lap_b_id: context.compare_lap_id } };
      if (context.session_id != null) return { id: "fake_1", name: "get_session_insights", args: { session_id: context.session_id } };
      if (context.event_id != null) return { id: "fake_1", name: "get_event", args: { event_id: context.event_id } };
      return { id: "fake_1", name: "get_profile", args: {} };
    };
    return {
      async request() {
        return async (onText) => {
          if (!followUp && step++ === 0) return { stop: "tools", calls: [first()] };
          for (const chunk of followUp ? FAKE_FOLLOW_UP_CHUNKS : FAKE_REPLY_CHUNKS) await onText(chunk);
          return { stop: "end", calls: [] };
        };
      },
      addResults() {},
    };
  },

  async listModels() {
    return fake.models;
  },
};

export const PROVIDERS: Record<ProviderId, Provider> = { anthropic, openai, gemini, fake };
