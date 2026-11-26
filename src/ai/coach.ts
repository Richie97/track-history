// The AI Coach's tool-use loop (#318, wire format in
// docs/specs/native/NS-58-ai-coach.md): the Worker drives the driver's chosen
// provider with the same TOOLS the MCP server exposes, running each tool call
// as the signed-in driver and streaming the answer back as server-sent events.
//
// Stateless: the conversation lives on the client and arrives whole on every
// request. Read-only by construction, since the tools only ever issue GETs.

import type { Env } from "../types";
import { type CoachContext, coachSystemPrompt } from "./coach-prompt";
import { type ChatMessage, type FetchLike, type Provider, ProviderError, type ToolOutput, type TurnReader } from "./providers";
import { TOOLS, type ToolUser, answerTool, toolByName } from "./tools";

// Rounds of tool calls per reply. A debrief takes two or three (profile, the
// session's insights, perhaps the track's history); eight is a model going in
// circles. After the last round the model is asked once more with tools
// forbidden, so the driver gets what it found rather than nothing.
export const MAX_TOOL_ROUNDS = 8;
// …and tool calls in total, since one round may carry several in parallel and
// each reduces a channel blob on the Worker's CPU.
export const MAX_TOOL_CALLS = 24;

export const MAX_MESSAGES = 40;
export const MAX_USER_CHARS = 8_000;
export const MAX_ASSISTANT_CHARS = 40_000;

export type CoachStop = "end" | "max_tokens" | "refusal" | "tool_limit";

// What the client shows under a reply that did not end normally.
export const STOP_MESSAGES: Record<Exclude<CoachStop, "end">, string> = {
  tool_limit: `The AI Coach reached its limit of ${MAX_TOOL_ROUNDS} rounds of data lookups for one reply, so this answer may be incomplete. Ask a narrower follow-up.`,
  max_tokens: "The reply was cut off at the length limit. Ask a narrower question to get the rest.",
  refusal: "The model declined to answer this.",
};

// The `tool` event's label: what the coach is reading, in the driver's words.
const TOOL_LABELS: Record<string, string> = {
  get_profile: "Reading your profile…",
  list_tracks: "Reading your tracks…",
  list_events: "Reading your events…",
  get_event: "Reading the event…",
  get_session_insights: "Analysing the session…",
  compare_laps: "Comparing the two laps…",
  get_lap_telemetry: "Reading the lap's telemetry…",
  get_racing_line: "Reading the racing line…",
  get_track_history: "Reading your history at this track…",
  get_setup_vs_lap_times: "Reading your setup sheets…",
  get_garage: "Reading your garage…",
  get_leaderboard: "Reading the leaderboard…",
  get_season_summary: "Reading your season…",
};
export const toolLabel = (name: string) => TOOL_LABELS[name] ?? `${toolByName(name)?.title ?? "Reading your logbook"}…`;

export type Emit = (event: "text" | "tool" | "done" | "error", data: Record<string, unknown>) => Promise<void>;

export type CoachRequest = { context: CoachContext; messages: ChatMessage[]; model: string };

const CONTEXT_KEYS = ["event_id", "session_id", "lap_id", "compare_lap_id", "track_id"] as const;

// The request body, validated. Answers `{ error }` naming the rule broken.
export function parseCoachRequest(body: unknown, provider: Provider): CoachRequest | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid body" };
  const b = body as Record<string, unknown>;

  const context: CoachContext = {};
  if (b.context != null) {
    if (typeof b.context !== "object" || Array.isArray(b.context)) return { error: "context must be an object" };
    for (const key of CONTEXT_KEYS) {
      const v = (b.context as Record<string, unknown>)[key];
      if (v == null) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return { error: `context.${key} must be a positive integer` };
      context[key] = v;
    }
    if (context.compare_lap_id != null && context.lap_id == null) return { error: "context.compare_lap_id needs context.lap_id" };
  }

  if (!Array.isArray(b.messages) || !b.messages.length) return { error: "messages must be a non-empty array" };
  if (b.messages.length > MAX_MESSAGES) return { error: `at most ${MAX_MESSAGES} messages — start a new conversation` };
  const messages: ChatMessage[] = [];
  for (const m of b.messages as unknown[]) {
    const role = (m as any)?.role;
    const content = (m as any)?.content;
    if (role !== "user" && role !== "assistant") return { error: "a message's role must be user or assistant" };
    if (typeof content !== "string" || !content.trim()) return { error: "a message's content must be a non-empty string" };
    if (content.length > (role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS)) return { error: "a message is too long" };
    messages.push({ role, content });
  }
  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user")
    return { error: "the conversation must start and end with a user message" };

  let model = provider.defaultModel;
  if (b.model != null) {
    // Any model of this provider's, not only the built-in few: Settings
  // completes the field from the driver's own account (verify's `models`).
    if (typeof b.model !== "string" || !provider.acceptsModel(b.model)) return { error: `that isn't a model ${provider.name} offers for the AI Coach` };
    model = b.model;
  }
  return { context, messages, model };
}

export type CoachRun = {
  env: Env;
  user: ToolUser;
  provider: Provider;
  key: string;
  request: CoachRequest;
  fetch: FetchLike;
};

// Opens the conversation with the provider and returns the rest of the run.
// The first provider call happens here, so a rejected key, an empty account or
// a provider outage throws ProviderError *before* the caller has committed to
// a 200 and an event stream; everything after is reported in-stream.
export async function startCoach(run: CoachRun): Promise<(emit: Emit) => Promise<void>> {
  const { env, user, provider, request } = run;
  const convo = provider.start({
    key: run.key,
    model: request.model,
    system: coachSystemPrompt(request.context),
    messages: request.messages,
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    context: request.context,
    fetch: run.fetch,
  });
  let read: TurnReader = await convo.request();

  return async (emit) => {
    const done = (stop: CoachStop) =>
      emit("done", { stop, model: request.model, ...(stop === "end" ? {} : { message: STOP_MESSAGES[stop] }) });
    let calls = 0;
    let limited = false;
    for (let round = 1; ; round++) {
      const turn = await read((delta) => emit("text", { delta }));
      if (turn.stop !== "tools" || limited) return done(limited && turn.stop !== "refusal" && turn.stop !== "max_tokens" ? "tool_limit" : (turn.stop as CoachStop));

      const outputs: ToolOutput[] = [];
      for (const call of turn.calls) {
        await emit("tool", { name: call.name, label: toolLabel(call.name) });
        if (call.badArgs) outputs.push({ call, text: "The arguments were not valid JSON. Call the tool again with a JSON object.", isError: true });
        else if (++calls > MAX_TOOL_CALLS)
          outputs.push({ call, text: "No more tool calls are available for this reply. Answer with what you have.", isError: true });
        else outputs.push({ call, ...(await answerTool(env, user, call.name, call.args)) });
      }
      convo.addResults(outputs);
      limited = round >= MAX_TOOL_ROUNDS;
      read = await convo.request({ final: limited });
    }
  };
}

// One server-sent event, as NS-58 fixes it.
export const sseFrame = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export { ProviderError };
