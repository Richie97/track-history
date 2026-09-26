// The Model Context Protocol server (#317): JSON-RPC over Streamable HTTP,
// stateless — every POST carries everything it needs and the server issues no
// Mcp-Session-Id, because nothing here needs to remember a client between
// calls. That is the whole reason there is no SDK or Durable Object behind it:
// a stateless server that never streams is initialize, ping, tools/list,
// tools/call and the prompt pair, each a plain request/response.
//
// Transport and auth live in routes/mcp.ts; the tools themselves in tools.ts.

import type { Env } from "../types";
import { isEntitled } from "../lib/entitlement";
import { TOOLS, ToolError, type ToolUser, runTool } from "./tools";

// Newest first; the first is what an unknown request version is answered
// with. 2024-11-05 is left out: it is the HTTP+SSE transport, not this one.
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

export const SERVER_INFO = { name: "track-evolution", title: "Track Evolution", version: "1.0.0" };

// Read by the model when the connection opens. The conventions a model would
// otherwise get wrong, stated once.
export const INSTRUCTIONS = `Track Evolution is the driver's track-day (HPDE) logbook: tracks → events (track days) → sessions → laps, plus a garage of cars and consumable parts.

Conventions:
- Lap times are integer milliseconds; each also comes formatted (m:ss.fff). Lower is better.
- An event's best is the lower of its fastest logged lap and a best the driver typed in.
- A track's name includes its layout; different layouts are different tracks and are never compared.
- Values are in stored units, named in each key: speed km/h, temperatures °C (except an event's typed temp_f), pressures kPa (setup sheets: psi), distances metres. Call get_profile first and present numbers in the driver's preferred unit system.
- Telemetry is sampled on a driven-distance grid (usually 20 m) from the start/finish line. Laps with has_telemetry can be analysed with get_session_insights, compare_laps and get_lap_telemetry; typed-in laps cannot.
- Corner numbers (T1, T2…) are the app's own, counted from the start/finish line by sustained lateral load — not the circuit's official turn numbers. Say so if you use them.
- Understeer/oversteer readings are relative to the session's own typical steering response, so a car that understeers everywhere reads neutral everywhere.

When coaching: cite the figure behind each point (lap, sector, corner, value), say plainly when the data can't answer a question, and give advice for the next session in the paddock — never for use while driving. You are not a substitute for an instructor.`;

type Prompt = {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  text: (args: Record<string, string>) => string;
};

export const PROMPTS: Prompt[] = [
  {
    name: "debrief_session",
    title: "Debrief a session",
    description: "A coach's debrief of one session: what went well, where the time is, and one or two things to try next time.",
    arguments: [{ name: "session_id", description: "The session to debrief (from get_event).", required: true }],
    text: (a) =>
      `Debrief my session ${a.session_id}. Call get_profile, then get_session_insights for session ${a.session_id}. Tell me what went well, where the time is (sectors, theoretical best, corners), what the car was doing (interventions, balance, health), and give me one or two specific, measurable things to try next session. Cite the numbers you use.`,
  },
  {
    name: "compare_to_best",
    title: "Compare a lap to my best",
    description: "One lap against the driver's best lap with telemetry at the same track.",
    arguments: [{ name: "lap_id", description: "The lap to look at (from get_event).", required: true }],
    text: (a) =>
      `Compare my lap ${a.lap_id} with my best lap that has telemetry at the same track. Find the track with get_event / list_events, get the fastest laps with get_track_history, then call compare_laps with my best as lap A and lap ${a.lap_id} as lap B. Explain where the time went corner by corner and what I'd change.`,
  },
  {
    name: "plan_next_track_day",
    title: "Plan my next track day",
    description: "A plan for the next visit to a track, from the driver's history there.",
    arguments: [{ name: "track_id", description: "The track (from list_tracks).", required: true }],
    text: (a) =>
      `I'm going back to track ${a.track_id}. Use get_track_history, get_session_insights on my best recent sessions there, get_setup_vs_lap_times and get_garage to give me a plan: goals for the day, what to focus on in each session, setup notes, and anything in the garage that needs attention first.`,
  },
];

export const PRO_REQUIRED_MESSAGE =
  "Track Evolution Pro is required to use this connection. Subscribe (or restore your purchase) in the Track Evolution app on your iPhone or Android phone, then try again.";

// Beyond this the result is refused rather than cut mid-JSON: ~20k tokens.
export const MAX_RESULT_CHARS = 80_000;

type JsonRpcId = string | number;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId | null; method?: string; params?: any; result?: unknown; error?: unknown };
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: JsonRpcId | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

// structuredContent arrived in 2025-06-18; older clients get the text form only.
const supportsStructured = (version: string) => version >= "2025-06-18";

const textResult = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

async function callTool(env: Env, user: ToolUser, params: any, version: string) {
  if (!isEntitled(user.entitledUntil, Date.now())) return textResult(PRO_REQUIRED_MESSAGE, true);
  try {
    const result = await runTool(env, user, params?.name, params?.arguments);
    const text = JSON.stringify(result);
    if (text.length > MAX_RESULT_CHARS)
      return textResult("That result is too large to return. Narrow the request — fewer channels, a wider step, or a filter.", true);
    return {
      content: [{ type: "text", text }],
      ...(supportsStructured(version) ? { structuredContent: result } : {}),
      isError: false,
    };
  } catch (err) {
    if (err instanceof ToolError) return textResult(err.message, true);
    console.error("mcp tool failed", params?.name, err);
    return textResult("The tool failed unexpectedly. Try again, or try a different request.", true);
  }
}

// One JSON-RPC message → its response, or null for a notification (or a
// response the client sent us, which a server that never asks has no use for).
export async function handleMessage(
  env: Env,
  user: ToolUser,
  msg: unknown,
  headerVersion: string | null
): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, INVALID_REQUEST, "invalid request");
  const m = msg as JsonRpcRequest;
  if (m.jsonrpc !== "2.0") return fail(m.id ?? null, INVALID_REQUEST, "jsonrpc must be \"2.0\"");
  const isRequest = typeof m.method === "string" && m.id != null;
  if (!isRequest) return null;
  const id = m.id as JsonRpcId;
  const version = negotiateVersion(headerVersion);

  switch (m.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateVersion(m.params?.protocolVersion),
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          // Output schemas and structuredContent arrived together. Keep the
          // older protocol's text-only result and discovery shape intact.
          ...(supportsStructured(version) ? { outputSchema: t.outputSchema } : {}),
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case "tools/call":
      if (typeof m.params?.name !== "string") return fail(id, INVALID_PARAMS, "params.name is required");
      if (!TOOLS.some((t) => t.name === m.params.name)) return fail(id, INVALID_PARAMS, `unknown tool: ${m.params.name}`);
      return ok(id, await callTool(env, user, m.params, version));
    case "prompts/list":
      return ok(id, {
        prompts: PROMPTS.map(({ text: _text, ...p }) => p),
      });
    case "prompts/get": {
      const prompt = PROMPTS.find((p) => p.name === m.params?.name);
      if (!prompt) return fail(id, INVALID_PARAMS, `unknown prompt: ${m.params?.name}`);
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      const clean: Record<string, string> = {};
      for (const a of prompt.arguments) {
        const v = args[a.name];
        if (a.required && (v == null || v === "")) return fail(id, INVALID_PARAMS, `argument ${a.name} is required`);
        if (v != null) clean[a.name] = String(v).slice(0, 40);
      }
      return ok(id, {
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text: prompt.text(clean) } }],
      });
    }
    default:
      return fail(id, METHOD_NOT_FOUND, `method not found: ${m.method}`);
  }
}
