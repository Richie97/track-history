# NS-58 — The AI Coach: request, stream and errors

**Phase:** post-rewrite · **Platform:** Server + web (built, #318 / #319) · iOS + Android (built, #320) · **Depends on:** the AI tool layer (#315), NS-32 (subscriptions) · **Epic:** #314

## Goal

The AI Coach is an in-app debrief: the Worker runs a tool-use loop against the
driver's own **Anthropic, OpenAI or Google Gemini** account, with the same read-only tools the
MCP server exposes, and streams the answer back. Three clients parse that
stream, so this file fixes the wire format once: the request, the four events,
and what every refusal looks like.

It is always the **AI Coach** — in the UI, the docs and every identifier
(`/api/ai/coach`, `routes/aiCoach.ts`, `canUseAICoach`). A bare "coach" is a
person in this app (NS-38, NS-52).

## Fixed decisions

| | |
|---|---|
| Tier | **Pro.** `requireEntitlement` on both routes — POSTs that write nothing, so "no write route checks entitlement" holds — and `canUseAICoach` on the client. A free account gets `402 { error: "pro required" }`, drawn as the paywall in place. |
| Providers | `anthropic`, `openai` and `gemini` (added 2026-11), the driver's choice; the stream is the same whichever answers. Gemini is key-only: Google has no connect route (#503). `fake` is a scripted provider for tests and demos, answered only under `DEV_MODE` on a dev host (`isDevHost`); anywhere else it is `400 unknown AI provider`. |
| Your own logbook only | The routes exist at `/api/ai/…` and nowhere else: not under the coach mount (`/api/students/:id/ai/coach` is a 404), not in the tool layer's private router. A client never offers the AI Coach in a read-only view — a coach's view of a student, a shared event, session or lap, a share page. |
| Stateless | The conversation lives on the client and is sent whole each time. The server keeps nothing: not the questions, not the replies. |
| The key | Stored on the driver's device only, sent per request in a header, never persisted, logged or echoed by the server. Provider error bodies are mapped to our own words, never relayed (a provider's 401 can quote the key back). |
| Read-only | The tools only issue GETs. Keeping a reply is the client's ordinary notes write (`PUT /sessions/:id`, `PUT /events/:id`), labelled `AI Coach, 26 Nov:`. |
| Never in the car | Nothing on CarPlay, Android Auto or during a recording. |
| Never queued, never cached | A client's offline layer must not queue or cache anything under `/api/ai/`. Offline, the entry points are disabled and say *needs a connection*. |

## Request

```
POST /api/ai/coach
Cookie: session=…            (or Authorization: Bearer …, the phones)
Content-Type: application/json
X-TE-AI-Provider: anthropic | openai | gemini
X-TE-AI-Key: <the driver's API key>

{
  "context":  { "event_id"?, "session_id"?, "lap_id"?, "compare_lap_id"?, "track_id"? },
  "messages": [ { "role": "user" | "assistant", "content": "…" }, … ],
  "model"?:   "<an id from verify's models>"
}
```

- `context` says where the AI Coach was opened from; every id is a positive
  integer (a row created offline has no server id yet, so its entry point is
  not offered). The three entry points:

  | Entry point | `context` | Opening question (the client's) |
  |---|---|---|
  | A session card — *Debrief this session* | `event_id`, `session_id` | a debrief of that session |
  | The two-lap compare — *Explain the difference* | `lap_id` (lap A, the reference), `compare_lap_id` (lap B), `track_id` | where the time went between the two |
  | An event — *What should I work on next time?* | `event_id`, `track_id` | a plan for the next visit |

  `compare_lap_id` without `lap_id` is a 400. The ids are hints for the system
  prompt; ownership is enforced by the tools, which answer another driver's id
  as "not in this logbook".
- `messages` is the whole conversation, 1–40 entries, starting and ending with
  a `user` message. A user message is at most 8,000 characters, an assistant
  message 40,000. The first message is the entry point's opening question.
- `model` is optional (`default_model` when omitted). It may be **any chat
  model of that provider's** — an id from verify's `models`, or one typed by
  hand — and is refused with a 400 only when it is not shaped like one of the
  provider's model ids (another provider's model, an embedding or realtime
  model, free text). Whether the driver's account can use it is the
  provider's call: a model it does not have is a 424 naming it.

`POST /api/ai/coach/verify` takes the same two headers and no body, makes one
call to the provider — **its models API**, which both proves the key and lists
the models the driver's account can use — and answers

```json
{ "ok": true, "provider": "anthropic", "default_model": "claude-sonnet-5-5",
  "models": [ { "id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5" }, … ] }
```

— pinned by `contracts/golden/ai-coach-verify.json`. `provider` and the ids
are strings, never enums, on every client.

`models` is what Settings' model field **completes from**: the provider's own
list for that key, narrowed to the models the loop can drive (on Anthropic,
those whose capabilities include adaptive thinking and `effort`; on OpenAI,
the GPT and o-series chat models, since its list has no capability field and
also carries embedding, speech, image and realtime models; on Gemini, the
`gemini-*` chat models that support `generateContent`), the server's
built-in models first with the default leading, at most 60. `label` is the
provider's display name where it gives one, else the id. A key that works but
may not list models (a restricted OpenAI key) gets the built-in models.

The model field on every client is a **type-ahead, not a closed picker**: it
offers `models` by id with the label beside it, accepts an id that is not
listed, and empty means the default. A client keeps the list with the key and
calls verify again when the field is focused, so a model released since is
there to pick; a failed refresh leaves the stored list standing.

## The stream

A request that passes every check answers `200` with
`Content-Type: text/event-stream`. Events are standard server-sent events —
an `event:` line, one `data:` line of JSON, a blank line:

| `event` | `data` | Meaning |
|---|---|---|
| `text` | `{ "delta": "…" }` | The next piece of the reply. Append in order. |
| `tool` | `{ "name": "get_session_insights", "label": "Analysing the session…" }` | A tool is running. Show `label` as progress; `name` is the tool's id (new names may appear — never switch on it exhaustively). |
| `done` | `{ "stop": "end" \| "tool_limit" \| "max_tokens" \| "refusal", "model": "…", "message"?: "…" }` | The reply is complete; nothing follows. `message` is present whenever `stop` is not `end` — the sentence to show under the reply. |
| `error` | `{ "error": "…", "status": 502 }` | The run failed after the stream opened; nothing follows. `status` is what the HTTP status would have been. Whatever `text` arrived before it is an unfinished reply. |

Rules for a parser:

- A line starting with `:` is a comment (the server sends `: keepalive` every
  15 s while the model is quiet). Ignore it.
- Unknown event names and unknown keys in `data` are ignored.
- A stream that ends with neither `done` nor `error` was cut off: treat it as
  an error.
- Line endings may be LF or CRLF, and an event may be split across network
  chunks anywhere, including inside a multi-byte character.

`contracts/streams/ai-coach.sse` is a recorded stream — the fake provider's
reply to a session debrief, byte for byte as the Worker sent it (regenerated by
`npm run contracts:generate`, checked by `contracts:check`). Each client's SSE
parser is tested against it: one `tool` event, six `text` events whose deltas
join into the reply, then `done` with `stop: "end"`.

The reply is Markdown-flavoured plain text. A client draws **paragraphs, lists
and bold** and shows everything else as the text it is; nothing a model writes
is ever interpreted as HTML or as a link.

### The caps

- **8 rounds of tool calls** per reply (and 24 tool calls in all). After the
  eighth round the model is asked once more with tools forbidden, so the driver
  gets what it found; that reply ends `done` with `stop: "tool_limit"`.
- Output is capped per provider request; a reply cut off there ends
  `stop: "max_tokens"`.
- The CPU cost of a worst-case session (eight rounds, each reducing a channel
  blob) has **not** been measured against the Workers CPU limit yet — do that
  on the deployed Worker before raising either cap.

## Errors

Before the stream opens, every refusal is `{ "error": string }` with a status,
like the rest of the API. After it opens, the same pair arrives as the `error`
event.

| Status | `error` | When | A client shows |
|---|---|---|---|
| 400 | `no AI provider set up` | no key (and no connection) | the way to Settings' AI Coach block |
| 400 | `unknown AI provider`, or a sentence naming the rule | a bad header or body | the message |
| 401 | `unauthorized` | no session | the sign-in screen, as everywhere |
| 402 | `pro required` | a free account | **the paywall, in place** — never an error |
| 424 | `provider rejected the key` | the provider's 401 / 403 (Gemini: its 400 `API_KEY_INVALID`) | the message, and the way to Settings |
| 424 | `your <Provider> account is out of credit — …`, `your <Provider> account can't use the model <id>`, `the model <id> doesn't work with the AI Coach — pick another in Settings` | the driver's account with the provider, or a hand-picked model the provider refused the request for | the message |
| 429 | `<Provider> is rate limiting your account — …` | the provider's 429; its `Retry-After` is passed on | the message |
| 429 | `rate limited — too many AI Coach requests; wait a minute` | our own limit (`AI_COACH`, 10 a minute per user), `Retry-After: 60` | the message |
| 502 | `<Provider> is unavailable right now — try again shortly` | the provider's 5xx, a dropped connection, a malformed stream | the message, and *Try again* |

A provider's bad key is **424, never 401**: a 401 from our API means the app
session is gone and signs the client out.

Every one of these is shown where the AI Coach is — its drawer or sheet —
never as the sync banner, and a failed question is not kept in the
conversation, so *Try again* asks it afresh.

## Credentials

`resolveCredential(c)` in `routes/aiCoach.ts` is the one place a request's
credential is read; today it answers `{ kind: "key", provider, key }` from the
two headers. Ticket 7 (#503) adds `{ kind: "linked" }` (Anthropic linked
billing) and `{ kind: "oauth" }` (Sign in with ChatGPT) there, without touching
the loop or the adapters. A connected provider needs no `X-TE-AI-Key`.

Where a client keeps a pasted key:

| Client | Storage |
|---|---|
| Web | the tab's memory; IndexedDB in that browser only with *Remember on this device*; cleared on sign-out |
| iOS / Android (ticket 6) | the Keychain (`AfterFirstUnlockThisDeviceOnly`, never synced) / the Keystore-backed encrypted prefs (excluded from backup and device transfer); cleared on sign-out |

## The system prompt

`src/ai/coach-prompt.ts`, reviewed like code. It is the MCP server's
`INSTRUCTIONS` (the conventions already tuned against real assistants),
then the coach's own rules, then one paragraph naming the entry point and its
ids. A client sends no prompt of its own beyond the opening question.

## Tests

- `test/api/ai-coach.test.ts` — the gate, the loop on both providers
  (scripted in `test/ai-coach-mock.ts`), the caps, the error mapping, the key
  absent from every response and log line, ownership, the coach mount, the
  rate limit, the fake provider's dev-host gate.
- `test/unit/ai-coach.test.js` — the web's parser against the recorded
  stream and every chunking, the context builder, the Markdown subset and its
  escaping, the notes label, the key store, and that `offline.js` never queues
  or caches `/api/ai/*`.
- `contracts/logic/ai-coach.json` — the pure half of `public/js/ai-coach.js`
  run by `npm run contracts:logic`: the entry points and their words,
  `coachContext`, `coachErrorText`, the model field, the reply as
  `coachMarkdownBlocks` / `coachBoldRuns` (the web draws those as HTML, the
  phones as styled text), the notes a kept reply makes, and
  `createSseParser` over CRLF, comments, unknown events, non-JSON data and
  split chunks. The Kit and `:core` ports assert against it and parse the
  recorded stream themselves, byte by byte, so a split inside a multi-byte
  character is covered.

## Outstanding

- Connecting a provider account instead of pasting a key (ticket 7, #503).
- The CPU measurement above.
