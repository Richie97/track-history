// The AI Coach's pure half (#319): the entry points and what each sends, the
// event-stream parser, the safe Markdown subset a reply is drawn with, and the
// label a saved reply carries into the notes. app.js owns the drawer and the
// Settings block; this module touches no DOM, and its two network calls take
// their `fetch`, so all of it is unit-tested (test/unit/ai-coach.test.js).
//
// The wire format — headers, body, the four events, the error mapping — is
// docs/specs/native/NS-58-ai-coach.md. The requests go straight to fetch,
// never through js/api.js: an AI Coach request is neither cached nor queued
// (offline.js refuses /ai/* too, and a test pins it).

import { esc } from "./format.js";

// Always "AI Coach": a bare "coach" is a person in this app (NS-38).
export const COACH_NAME = "AI Coach";

export const COACH_PROVIDERS = Object.freeze([
  { id: "anthropic", name: "Anthropic", keyUrl: "https://platform.claude.com/settings/keys", placeholder: "sk-ant-…" },
  { id: "openai", name: "OpenAI", keyUrl: "https://platform.openai.com/api-keys", placeholder: "sk-…" },
  { id: "gemini", name: "Google Gemini", keyUrl: "https://aistudio.google.com/app/apikey", placeholder: "AIza…" },
]);
// "provider" is the dev-only fake (js/ai-keys.js), which has no name to show.
export const providerName = (id) => COACH_PROVIDERS.find((p) => p.id === id)?.name ?? "provider";

export const COACH_PRO_WHAT =
  "A debrief of a session, an explanation of the gap between two laps, or a plan for your next visit — " +
  "written from your own telemetry and history, on your own Anthropic, OpenAI or Google Gemini account.";
// Shown where the keys are entered. Every driver here may have signed in with
// Google, which grants nothing on the Gemini API.
export const COACH_GEMINI_NOTE =
  "Signing in to Track Evolution with Google does not connect Gemini — it needs its own key. " +
  "A Gemini key can be used free, within low limits Google sets.";
export const COACH_OFFLINE = "needs a connection";
export const COACH_DISCLAIMER = "For the paddock, not the car — and not a substitute for an instructor.";

// The three places the AI Coach opens from: the button's words, the question
// it opens with, and whose notes a kept reply is appended to.
export const COACH_ENTRIES = Object.freeze({
  session: {
    button: "Debrief this session",
    title: "Session debrief",
    question: "Debrief this session: what went well, where the time is, and one or two specific things to try next session.",
    saveTo: "session",
  },
  compare: {
    button: "Explain the difference",
    title: "Two laps compared",
    question: "Explain the difference between these two laps: where the time went, corner by corner, and what I would change.",
    saveTo: "event",
  },
  event: {
    button: "What should I work on next time?",
    title: "Next time",
    question: "What should I work on next time I'm at this track?",
    saveTo: "event",
  },
});
export const coachSaveLabel = (entry) => (COACH_ENTRIES[entry]?.saveTo === "session" ? "Save to session notes" : "Save to event notes");

// A server id as the API wants it: a positive integer. A row created offline
// still has a "tmp-…" id the server has never heard of.
const serverId = (v) => {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};

// The request's `context` for an entry point, or null when a row it needs has
// no server id yet (the button is then not offered).
//   session: { eventId, sessionId }
//   compare: { lapId, compareLapId, trackId? }   — lap A, the reference, then B
//   event:   { eventId, trackId? }               — the track serves "next time"
export function coachContext(entry, ids = {}) {
  const track = serverId(ids.trackId);
  const withTrack = (ctx) => (track ? { ...ctx, track_id: track } : ctx);
  if (entry === "session") {
    const [event, session] = [serverId(ids.eventId), serverId(ids.sessionId)];
    return event && session ? { event_id: event, session_id: session } : null;
  }
  if (entry === "compare") {
    const [a, b] = [serverId(ids.lapId), serverId(ids.compareLapId)];
    return a && b && a !== b ? withTrack({ lap_id: a, compare_lap_id: b }) : null;
  }
  if (entry === "event") {
    const event = serverId(ids.eventId);
    return event ? withTrack({ event_id: event }) : null;
  }
  return null;
}

// ---------- the event stream --------------------------------------------------

// An incremental server-sent-events parser: push() text as it arrives, and
// each complete `event:` / `data:` block is handed to onEvent with its data
// parsed as JSON. Comment lines (the server's keepalive) and blocks whose
// data is not JSON are skipped; a block split across chunks waits for its end.
export function createSseParser(onEvent) {
  let buf = "";
  const flush = (block) => {
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length) return;
    let parsed;
    try {
      parsed = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    onEvent(event, parsed);
  };
  const drain = (final) => {
    // A trailing CR may be half of a CRLF whose LF is in the next chunk.
    const held = !final && buf.endsWith("\r") ? "\r" : "";
    buf = buf.slice(0, buf.length - held.length).replace(/\r\n?/g, "\n") + held;
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      flush(block);
    }
    if (final && buf.trim()) flush(buf);
    if (final) buf = "";
  };
  return {
    push(text) {
      buf += text;
      drain(false);
    },
    end() {
      drain(true);
    },
  };
}

const errorOf = async (res) => {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" && body.error ? body.error : `Request failed (${res.status})`;
};

const credentialHeaders = (credential) => ({
  "Content-Type": "application/json",
  "X-TE-AI-Provider": credential.provider,
  ...(credential.key ? { "X-TE-AI-Key": credential.key } : {}),
});

const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?…]$/.test(s) ? "" : ".");

// What the drawer says for a refusal. The server's own `{ error }` is the
// message (clients show it, as everywhere); these only make its terser ones
// into a sentence a driver can act on.
export function coachErrorText(status, error, provider) {
  if (status === 424 && error === "provider rejected the key")
    return sentence(`${providerName(provider)} rejected the key. Check it in Settings → AI assistants`);
  if (status === 400 && error === "no AI provider set up") return "No AI provider is set up yet. Add a key in Settings → AI assistants.";
  if (!error) return `The ${COACH_NAME} couldn't answer. Try again.`;
  return sentence(error);
}

// POST /api/ai/coach and read its stream. Resolves — never rejects — with how
// it ended:
//   { kind: "done", stop, message? }   the reply is complete (`message` when it
//                                      stopped short: the tool cap, the length)
//   { kind: "paywall" }                402: draw the Pro offer in place
//   { kind: "unauthorized" }           401: the session is gone
//   { kind: "error", status, error }   the server's { error }, or the stream's
//   { kind: "offline" }                the request never reached the server
//   { kind: "aborted" }                the caller's signal fired
export async function streamCoach({ credential, body, signal, fetch: fetchImpl = fetch }, { onText = () => {}, onTool = () => {} } = {}) {
  let res;
  try {
    res = await fetchImpl("/api/ai/coach", { method: "POST", headers: credentialHeaders(credential), body: JSON.stringify(body), signal });
  } catch {
    return signal?.aborted ? { kind: "aborted" } : { kind: "offline" };
  }
  if (res.status === 401) return { kind: "unauthorized" };
  if (res.status === 402) return { kind: "paywall" };
  if (!res.ok) return { kind: "error", status: res.status, error: await errorOf(res) };
  if (!res.body) return { kind: "error", status: 502, error: "" };

  let outcome = null;
  const parser = createSseParser((event, data) => {
    if (outcome) return;
    if (event === "text" && typeof data.delta === "string") onText(data.delta);
    else if (event === "tool") onTool(data);
    else if (event === "done") outcome = { kind: "done", stop: data.stop ?? "end", ...(data.message ? { message: data.message } : {}) };
    else if (event === "error") outcome = { kind: "error", status: data.status ?? 502, error: data.error ?? "" };
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) parser.push(decoder.decode(value, { stream: true }));
      if (done) break;
    }
    parser.end();
  } catch {
    return signal?.aborted ? { kind: "aborted" } : { kind: "error", status: 502, error: "the connection dropped before the reply finished" };
  }
  // A stream that just ended, with neither `done` nor `error`, was cut off.
  return outcome ?? { kind: "error", status: 502, error: "the connection dropped before the reply finished" };
}

// POST /api/ai/coach/verify → { ok: true, default_model, models } or
// { ok: false, status, error }.
export async function verifyCoachKey(provider, key, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl("/api/ai/coach/verify", { method: "POST", headers: credentialHeaders({ provider, key }) });
  } catch {
    return { ok: false, status: 0, error: `Checking a key ${COACH_OFFLINE}.` };
  }
  if (!res.ok) {
    const error = await errorOf(res);
    return { ok: false, status: res.status, error: coachErrorText(res.status, error, provider) };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: true, default_model: body.default_model ?? null, models: Array.isArray(body.models) ? body.models : [] };
}

// ---------- the model field ---------------------------------------------------

// Settings' model field is a type-ahead over the models the driver's own
// account lists (verify's `models`, read from the provider's models API). Its
// value is a model id — one from the list or one typed by hand — and empty
// means the provider's default.

// The <option>s of the field's <datalist>: the id is what is entered, the
// name is shown beside it when the provider gave one.
export function modelOptionsHtml(models) {
  return (models ?? [])
    .filter((m) => m && typeof m.id === "string" && m.id)
    .map((m) => `<option value="${esc(m.id)}"${m.label && m.label !== m.id ? ` label="${esc(m.label)}"` : ""}></option>`)
    .join("");
}

// What the driver typed, as the id to send: a listed model's *name* picks its
// id (some browsers fill the field with an option's label), anything else is
// taken as an id, and nothing is the default (null).
export function resolveModelInput(text, models) {
  const typed = String(text ?? "").trim();
  if (!typed) return null;
  const list = models ?? [];
  const lower = typed.toLowerCase();
  const hit = list.find((m) => m.id.toLowerCase() === lower) ?? list.find((m) => String(m.label ?? "").toLowerCase() === lower);
  return hit ? hit.id : typed;
}

// The field's placeholder: which model an empty field means.
export const modelPlaceholder = (defaultModel) => (defaultModel ? `Default (${defaultModel})` : "Default");

// ---------- drawing a reply ---------------------------------------------------

// A model's reply as blocks: paragraphs (their lines), bulleted and numbered
// lists (their items) and headings, which are drawn as a bold line. Everything
// else Markdown can say stays the plain text it is — there is no HTML, no link,
// no image and no code block. The native apps port this (and coachBoldRuns)
// under the same names, pinned by contracts/logic/ai-coach.json.
//   { type: "p", lines: [string] } | { type: "ul" | "ol", items: [string] } | { type: "h", text }
export function coachMarkdownBlocks(text) {
  const out = [];
  let para = [];
  let list = null;
  const endPara = () => {
    if (para.length) out.push({ type: "p", lines: para });
    para = [];
  };
  const endList = () => {
    if (list) out.push({ type: list.tag, items: list.items });
    list = null;
  };
  for (const raw of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      endPara();
      endList();
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      endPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) endList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)[1]);
    } else if (heading) {
      endPara();
      endList();
      out.push({ type: "h", text: heading[1].replace(/\*\*/g, "") });
    } else if (list && /^\s+\S/.test(raw)) {
      // An indented line under a list item continues it.
      list.items[list.items.length - 1] += ` ${line}`;
    } else {
      endList();
      para.push(line);
    }
  }
  endPara();
  endList();
  return out;
}

// A line split at its bold marks — the one inline mark — into runs:
// [{ text, bold }]. An unclosed ** stays as the text it is.
export function coachBoldRuns(s) {
  const runs = [];
  const re = /\*\*(.+?)\*\*/g;
  let at = 0;
  let m;
  const str = String(s ?? "");
  while ((m = re.exec(str))) {
    if (m.index > at) runs.push({ text: str.slice(at, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    at = m.index + m[0].length;
  }
  if (at < str.length) runs.push({ text: str.slice(at), bold: false });
  return runs;
}

// Escaped FIRST, run by run, so the only tags that exist afterwards are the
// ones written here: nothing a model (or a lap note it quoted) says can become
// markup.
const inline = (s) => coachBoldRuns(s).map((r) => (r.bold ? `<strong>${esc(r.text)}</strong>` : esc(r.text))).join("");

// A model's reply as HTML, from coachMarkdownBlocks.
export function coachMarkdownHtml(text) {
  return coachMarkdownBlocks(text)
    .map((b) => {
      if (b.type === "p") return `<p>${b.lines.map(inline).join("<br>")}</p>`;
      if (b.type === "h") return `<p><strong>${esc(b.text)}</strong></p>`;
      return `<${b.type}>${b.items.map((it) => `<li>${inline(it)}</li>`).join("")}</${b.type}>`;
    })
    .join("");
}

// ---------- keeping a reply ---------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "AI Coach, 26 Nov" — notes travel to a human coach the driver has shared
// with (NS-38), who should be able to tell this from the driver's own words.
export const coachNotesLabel = (date) => `${COACH_NAME}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;

// Notes are plain text, so the reply loses its marks: bold and heading markers
// go, list items keep a dash.
export function coachPlainText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^(\s*)#{1,6}\s+/, "$1").replace(/^(\s*)[*•]\s+/, "$1- ").replace(/\*\*(.+?)\*\*/g, "$1").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The notes after keeping a reply: what was there, a blank line, the label on
// its own line, then the reply.
export function appendCoachNote(existing, reply, date) {
  const kept = `${coachNotesLabel(date)}:\n${coachPlainText(reply)}`;
  const before = String(existing ?? "").trim();
  return before ? `${before}\n\n${kept}` : kept;
}
