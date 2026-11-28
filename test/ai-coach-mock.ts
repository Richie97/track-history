// Scripted Anthropic, OpenAI and Gemini for the AI Coach tests (test/api/ai-coach.test.ts),
// registered as fetchMock interceptors by vitest.workers.config.mts.
//
// Two things drive a mock, both chosen by the test:
//   - the API key picks the *status*. undici's mock cannot compute a status
//     from the request body, but it can match on a header, so each failure is
//     its own interceptor keyed on the key below.
//   - with the "ok" key, the first user message is the *script*:
//       "call <tool> <json args>"  one tool call (preceded by a thinking /
//                                  reasoning item), then a reply that echoes
//                                  what the provider was sent back
//       "loop"                     a tool call every round, until the request
//                                  forbids tools
//       "midfail"                  a 200 whose stream then reports an error
//       "blocked" / "unsafe" /     Gemini only: a blocked prompt, a safety
//       "cutoff"                   finish, and a stream with no finish reason
//       anything else              a reply echoing the request's shape
//
// The failures echo the key in their error body, as OpenAI's real 401 does in
// part, so a test can assert that nothing of it reaches the client.

import type { MockAgent } from "undici";

export const ANTHROPIC_KEYS = {
  ok: "sk-ant-test-ok",
  bad: "sk-ant-test-bad",
  limited: "sk-ant-test-limited",
  down: "sk-ant-test-down",
  broke: "sk-ant-test-broke",
};
export const OPENAI_KEYS = {
  ok: "sk-test-openai-ok",
  bad: "sk-test-openai-bad",
  quota: "sk-test-openai-quota",
  // May call Responses but not list models.
  restricted: "sk-test-openai-restricted",
};

export const GEMINI_KEYS = {
  ok: "AIza-test-gemini-ok",
  // Google answers a bad key 400, not 401.
  bad: "AIza-test-gemini-bad",
  limited: "AIza-test-gemini-limited",
  region: "AIza-test-gemini-region",
  down: "AIza-test-gemini-down",
};
export const GEMINI_MODEL = "gemini-3.8-flash";

// What the models APIs answer for the "ok" keys: more than the built-in few,
// and — as the real lists do — models the AI Coach cannot drive.
const caps = (adaptive: boolean, effort: boolean) => ({
  thinking: { supported: true, types: { enabled: { supported: !adaptive }, adaptive: { supported: adaptive } } },
  effort: { supported: effort, low: { supported: effort }, medium: { supported: effort }, high: { supported: effort } },
});
export const ANTHROPIC_MODEL_LIST = [
  { type: "model", id: "claude-fable-5-2", display_name: "Claude Fable 5.2", capabilities: caps(true, true) },
  { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", capabilities: caps(true, true) },
  { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", capabilities: caps(true, true) },
  { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", capabilities: caps(true, true) },
  // No adaptive thinking and no effort: never offered.
  { type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", capabilities: caps(false, false) },
];
export const OPENAI_MODEL_LIST = [
  { id: "gpt-6-luna", object: "model", created: 1_780_000_000 },
  { id: "text-embedding-3-large", object: "model", created: 1_700_000_000 },
  { id: "gpt-6.2-astra", object: "model", created: 1_790_000_000 },
  { id: "gpt-realtime-2.1-mini", object: "model", created: 1_785_000_000 },
  { id: "gpt-6.2-sol", object: "model", created: 1_791_000_000 },
  { id: "gpt-image-2", object: "model", created: 1_770_000_000 },
];

export const GEMINI_MODEL_LIST = [
  { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
  { name: "models/gemini-4-argon", displayName: "Gemini 4 Argon", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-3.8-flash-tts", displayName: "Gemini 3.8 Flash TTS", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-embedding-2", displayName: "Gemini Embedding 2", supportedGenerationMethods: ["embedContent"] },
  { name: "models/gemma-4-31b-it", displayName: "Gemma 4", supportedGenerationMethods: ["generateContent"] },
];

async function bodyText(raw: unknown): Promise<string> {
  if (raw && typeof raw === "object" && "getReader" in raw) {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of raw as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
    return text + decoder.decode();
  }
  return String(raw ?? "");
}

const frames = (events: object[]) => events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const halves = (text: string) => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))].filter(Boolean);
const sse = { headers: { "content-type": "text/event-stream" } };

function parseCall(script: string) {
  const m = /^call (\w+) (.*)$/s.exec(script);
  return m ? { name: m[1], args: m[2] } : null;
}

// ---------- Anthropic --------------------------------------------------------

function anthropicText(text: string) {
  return frames([
    { type: "message_start", message: { id: "msg_test", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...halves(text).map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function anthropicToolUse(name: string, argsJson: string, id = "toolu_test_1") {
  return frames([
    { type: "message_start", message: { id: "msg_test", role: "assistant", content: [] } },
    // A thinking block as the API streams it with display omitted: empty text
    // and a signature. The loop must hand it back unchanged.
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-test" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } },
    ...halves(argsJson).map((t) => ({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: t } })),
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function anthropicReply(req: any): string {
  const first = req.messages[0];
  const script = typeof first.content === "string" ? first.content : "";
  const last = req.messages[req.messages.length - 1];
  const results = Array.isArray(last.content) ? last.content.filter((b: any) => b.type === "tool_result") : [];
  if (script === "midfail")
    return frames([
      { type: "message_start", message: { id: "msg_test", role: "assistant", content: [] } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]);
  if (script === "loop")
    return req.tool_choice?.type === "none" ? anthropicText("wrapped up") : anthropicToolUse("get_profile", "{}", `toolu_${req.messages.length}`);
  const call = parseCall(script);
  if (call && !results.length) return anthropicToolUse(call.name, call.args);
  if (call) {
    const assistant = req.messages[req.messages.length - 2];
    return anthropicText(
      "RESULT " +
        JSON.stringify({
          results,
          thinkingEchoed: (assistant?.content ?? []).some((b: any) => b.type === "thinking" && b.signature === "sig-test"),
        })
    );
  }
  return anthropicText(
    "ECHO " +
      JSON.stringify({
        model: req.model,
        stream: req.stream,
        fallbacks: req.fallbacks ?? null,
        tools: (req.tools ?? []).map((t: any) => t.name),
        toolHasSchema: Boolean(req.tools?.[0]?.input_schema),
        system: req.system,
        messages: req.messages.length,
      })
  );
}

// ---------- OpenAI -----------------------------------------------------------

function openaiDone(output: object[], text?: string) {
  return frames([
    { type: "response.created", response: { id: "resp_test" } },
    ...(text ? halves(text).map((t) => ({ type: "response.output_text.delta", delta: t })) : []),
    ...output.map((item) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { id: "resp_test", status: "completed", output } },
  ]);
}
const openaiMessage = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text }] });

function openaiReply(req: any): string {
  const script = typeof req.input[0]?.content === "string" ? req.input[0].content : "";
  const outputs = req.input.filter((it: any) => it.type === "function_call_output");
  const call = parseCall(script);
  if (call && !outputs.length)
    return openaiDone([
      { type: "reasoning", id: "rs_1", encrypted_content: "enc-test", summary: [] },
      { type: "function_call", id: "fc_1", call_id: "call_test_1", name: call.name, arguments: call.args },
    ]);
  const text = call
    ? "RESULT " +
      JSON.stringify({
        outputs,
        reasoningEchoed: req.input.some((it: any) => it.type === "reasoning" && it.encrypted_content === "enc-test"),
        callEchoed: req.input.some((it: any) => it.type === "function_call" && it.call_id === "call_test_1"),
      })
    : "ECHO " +
      JSON.stringify({
        model: req.model,
        store: req.store,
        tools: (req.tools ?? []).map((t: any) => t.name),
        toolType: req.tools?.[0]?.type,
        instructions: req.instructions,
        input: req.input.length,
      });
  return openaiDone([openaiMessage(text)], text);
}

// ---------- Gemini -----------------------------------------------------------
//
// Chunks carry no `event:` line, and a function call arrives whole in one
// part — here with a thoughtSignature and no id, as the thinking models send
// it, so the loop must echo the part unchanged and match results by name.

const geminiFrames = (chunks: object[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
const geminiChunk = (parts: object[], finishReason?: string) => ({
  candidates: [{ content: { role: "model", parts }, index: 0, ...(finishReason ? { finishReason } : {}) }],
});
const geminiText = (text: string) => {
  const [a, b = ""] = halves(text);
  return geminiFrames([geminiChunk([{ text: a }]), geminiChunk([{ text: b }], "STOP")]);
};
const geminiCall = (name: string, args: unknown) =>
  geminiFrames([geminiChunk([{ functionCall: { name, args }, thoughtSignature: "gsig-test" }], "STOP")]);

function geminiReply(req: any): string {
  const script = req.contents?.[0]?.parts?.[0]?.text ?? "";
  const last = req.contents[req.contents.length - 1];
  const results = (last.parts ?? []).filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse);
  if (script === "midfail")
    return geminiFrames([geminiChunk([{ text: "par" }]), { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }]);
  if (script === "blocked") return geminiFrames([{ promptFeedback: { blockReason: "SAFETY" } }]);
  if (script === "unsafe") return geminiFrames([geminiChunk([], "SAFETY")]);
  if (script === "cutoff") return geminiFrames([geminiChunk([{ text: "par" }])]);
  if (script === "loop")
    return req.toolConfig?.functionCallingConfig?.mode === "NONE" ? geminiText("wrapped up") : geminiCall("get_profile", {});
  const call = parseCall(script);
  if (call && !results.length) return geminiCall(call.name, JSON.parse(call.args));
  if (call) {
    const model = req.contents[req.contents.length - 2];
    return geminiText(
      "RESULT " +
        JSON.stringify({
          results,
          role: last.role,
          signatureEchoed: (model?.parts ?? []).some((p: any) => p.functionCall && p.thoughtSignature === "gsig-test"),
        })
    );
  }
  return geminiText(
    "ECHO " +
      JSON.stringify({
        tools: (req.tools?.[0]?.functionDeclarations ?? []).map((t: any) => t.name),
        toolHasSchema: req.tools?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema?.type === "object",
        mode: req.toolConfig?.functionCallingConfig?.mode,
        system: req.systemInstruction?.parts?.[0]?.text,
        contents: req.contents.length,
        roles: req.contents.map((c: any) => c.role),
      })
  );
}

// ---------- registration -----------------------------------------------------

export function mockAiProviders(fetchMock: MockAgent) {
  const a = fetchMock.get("https://api.anthropic.com");
  const messages = (key: string) => a.intercept({ method: "POST", path: "/v1/messages", headers: { "x-api-key": key } });
  messages(ANTHROPIC_KEYS.bad)
    .reply(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${ANTHROPIC_KEYS.bad}` } })
    .persist();
  messages(ANTHROPIC_KEYS.limited)
    .reply(429, { type: "error", error: { type: "rate_limit_error", message: "rate limited" } }, { headers: { "retry-after": "7" } })
    .persist();
  messages(ANTHROPIC_KEYS.down)
    .reply(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
    .persist();
  messages(ANTHROPIC_KEYS.broke)
    .reply(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })
    .persist();
  messages(ANTHROPIC_KEYS.ok)
    .reply(200, async (opts: { body?: unknown }) => anthropicReply(JSON.parse(await bodyText(opts.body))), sse)
    .persist();
  const models = (key: string) => a.intercept({ method: "GET", path: "/v1/models?limit=1000", headers: { "x-api-key": key } });
  models(ANTHROPIC_KEYS.bad)
    .reply(401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${ANTHROPIC_KEYS.bad}` } })
    .persist();
  models(ANTHROPIC_KEYS.ok).reply(200, { data: ANTHROPIC_MODEL_LIST, has_more: false }).persist();

  const o = fetchMock.get("https://api.openai.com");
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  const responses = (key: string) => o.intercept({ method: "POST", path: "/v1/responses", headers: bearer(key) });
  const openaiBad = { error: { message: `Incorrect API key provided: ${OPENAI_KEYS.bad}.`, type: "invalid_request_error", code: "invalid_api_key" } };
  responses(OPENAI_KEYS.bad).reply(401, openaiBad).persist();
  responses(OPENAI_KEYS.quota)
    .reply(429, { error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } })
    .persist();
  responses(OPENAI_KEYS.ok)
    .reply(200, async (opts: { body?: unknown }) => openaiReply(JSON.parse(await bodyText(opts.body))), sse)
    .persist();
  const model = (key: string) => o.intercept({ method: "GET", path: "/v1/models", headers: bearer(key) });
  model(OPENAI_KEYS.bad).reply(401, openaiBad).persist();
  model(OPENAI_KEYS.restricted)
    .reply(403, { error: { message: "You have insufficient permissions for this operation.", type: "invalid_request_error" } })
    .persist();
  model(OPENAI_KEYS.ok).reply(200, { object: "list", data: OPENAI_MODEL_LIST }).persist();

  // Gemini. Every interceptor matches a path with no key in it: a request that
  // put the key in the query string would match none of them and fail.
  const g = fetchMock.get("https://generativelanguage.googleapis.com");
  const generate = (key: string, model = GEMINI_MODEL) =>
    g.intercept({ method: "POST", path: `/v1beta/models/${model}:streamGenerateContent?alt=sse`, headers: { "x-goog-api-key": key } });
  const geminiBad = {
    error: {
      code: 400,
      message: `API key not valid. Please pass a valid API key. (${GEMINI_KEYS.bad})`,
      status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }],
    },
  };
  generate(GEMINI_KEYS.bad).reply(400, geminiBad).persist();
  generate(GEMINI_KEYS.limited)
    .reply(429, {
      error: {
        code: 429,
        message: "You exceeded your current quota.",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" }],
      },
    })
    .persist();
  generate(GEMINI_KEYS.region)
    .reply(400, { error: { code: 400, message: "Gemini API free tier is not available in your country.", status: "FAILED_PRECONDITION" } })
    .persist();
  generate(GEMINI_KEYS.down).reply(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }).persist();
  for (const model of [GEMINI_MODEL, "gemini-4-argon"])
    generate(GEMINI_KEYS.ok, model)
      .reply(200, async (opts: { body?: unknown }) => geminiReply(JSON.parse(await bodyText(opts.body))), sse)
      .persist();
  const geminiModels = (key: string) => g.intercept({ method: "GET", path: "/v1beta/models?pageSize=1000", headers: { "x-goog-api-key": key } });
  geminiModels(GEMINI_KEYS.bad).reply(400, geminiBad).persist();
  geminiModels(GEMINI_KEYS.ok).reply(200, { models: GEMINI_MODEL_LIST }).persist();
}
