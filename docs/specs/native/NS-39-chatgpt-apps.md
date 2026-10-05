# NS-39 — A native ChatGPT experience

**Phase:** post-rewrite · **Platform:** Server (the MCP server and its widgets; no iOS, Android or web-app change) · **Depends on:** #314 (#315 tool layer, #316 OAuth, #317 MCP server), NS-32 (tier), NS-36 (Season Wrapped), the promo's demo logbook · **Estimate:** 3–4 weeks across six PRs, ticket 0 first · **Issue:** [#361](https://github.com/Richie97/track-history/issues/361)

## Goal

Track Evolution should feel native in ChatGPT, not merely reachable from it.
Today a Pro user can add `https://trackevolution.app/mcp` as a custom
connector and get good text answers. This spec adds three things:

1. **A public listing** in ChatGPT's **Plugin Directory**, so a driver finds
   Track Evolution by name and connects in one tap.
2. **Interactive cards in the conversation.** Ask "where did I lose time
   against my best at VIR?" and the answer arrives with the delta chart, the
   two speed traces and the sector table, drawn by the same code the web app
   uses. Tapping a sector tells the model which one you're looking at.
3. **A plugin bundle**: the server's three prompts as ChatGPT skills, so
   "debrief my last session" runs the same tool sequence every time.

```
ChatGPT conversation
┌────────────────────────────────────────────────────────────┐
│ You: Where did I lose time vs my best at VIR?              │
│                                                            │
│ ┌ Track Evolution ─────────────────────────────── ⤢ ─────┐ │
│ │ Lap 7 (Apr 12) vs Lap 4 (Mar 2)         +0.84 s        │ │
│ │ Δ ───────╮____________╭──────────╮___________          │ │
│ │ speed ═══╪════════════╪══════════╪═══════════          │ │
│ │ S1 +0.12   S2 +0.61 ◀ tapped   S3 +0.11                │ │
│ │ [ Ask about S2 ]                                       │ │
│ └────────────────────────────────────────────────────────┘ │
│ Claude/GPT: Most of it is S2 — you braked 18 m earlier …   │
└────────────────────────────────────────────────────────────┘
```

## Why now

- **The server is already most of a ChatGPT app.** Apps in ChatGPT *are* MCP
  servers. Ours has OAuth 2.1 with dynamic registration, client-ID metadata
  documents and PKCE; annotated read-only tools; output schemas;
  `/.well-known/openai-apps-challenge`; and a drafted
  `chatgpt-app-submission.json`. What's missing is policy work for the
  listing, plus UI.
- **The UI layer is now a standard, not a ChatGPT-only API.** *MCP Apps*
  (SEP-1865, official 2026-01-26) is the first official MCP extension, written
  by Anthropic and OpenAI together. ChatGPT, Claude, VS Code and Goose render
  it. OpenAI's own guidance is to build against the standard and treat
  `window.openai` as optional extras. **One widget therefore serves both our
  ChatGPT listing and the existing Claude directory listing.**
- **OpenAI is pushing discovery.** On 2026-07-09 the App Directory became the
  Plugin Directory: a plugin bundles apps (MCP servers), skills and workflow
  templates. At DevDay (2026-09-29) OpenAI announced that ChatGPT will
  recommend plugins during conversations. A track-day question in ChatGPT is
  where that recommendation would fire.

## Fixed decisions

| | |
|---|---|
| Standard | **MCP Apps first.** `_meta.ui.resourceUri`, `ui://` resources, `text/html;profile=mcp-app`, and the `ui/*` postMessage bridge. `window.openai` is used only behind feature detection, and only for something the standard can't do. As of this spec, nothing qualifies. |
| Read-only | **Unchanged from #314.** No write tool, no tool a widget can call that writes, and every tool keeps `readOnlyHint: true`. A widget reaches data only through `tools/call` on our own read-only tools, via the host. |
| Tier | **Pro, as today** (NS-32 row for the MCP server). Widgets are presentation of tool results already gated per `tools/call`, so they need no gate of their own. The wording a free user sees changes; see *Policy*. |
| What the model sees | **Summaries, as today.** `structuredContent` and its `outputSchema` are unchanged by this work, so text-only hosts and the phone apps lose nothing. Chart arrays go **to the widget only** (see *Widget data*). |
| Graceful degradation | **The text answer must stand on its own.** A host without the extension, a ChatGPT phone app that fails to render the widget (see *Risks*), or a screen reader all get the same complete answer. A card adds detail; it never carries the only copy of a fact. |
| Code reuse | **The cards draw with the web app's own modules**, bundled at build time: the pure ones (`compare-laps.js`, `sectors.js`, `gears.js`, `limits.js`, `conditions.js`, `garage.js`, `wrapped.js`, `units.js`, `format.js`) and the markup half of three that also touch the page (`channel-graphs.js`, `chart.js`, `wrapped-story.js`), plus `trackmap.js`, which draws on a canvas (see *Modules under a sandbox*). No second implementation of any chart. |
| Self-contained resources | **A widget's HTML has no external script, style or font dependency.** Its CSP declares empty `connectDomains`, `resourceDomains` and `frameDomains`. This makes it reviewable by the host before first use, cacheable, and immune to a deploy landing between the HTML and its scripts. |
| Clients | **None.** No iOS, Android or web-app change. `public/js/` modules are imported, and the only edit this work makes to one is a **seam**, the way `channelDefs(units)` got one: an explicit parameter whose default is today's behaviour, so the web app renders exactly as before and its unit tests stay green. At least one is known now (`gearRibbonSvg`; see *Modules under a sandbox*). |

## Policy (ticket 0, and blocking)

### The Pro gate and the rule against selling digital goods

OpenAI's submission guidelines allow commerce only for physical goods:
"selling digital products or services — including subscriptions, digital
content, tokens, or credits — is not allowed, whether offered directly or
indirectly (for example, through freemium upsells)". Two of our surfaces
currently read as a purchase prompt inside ChatGPT:

- `PRO_REQUIRED_MESSAGE` in `src/ai/mcp.ts`: "*Subscribe (or restore your
  purchase) in the Track Evolution app on your iPhone or Android phone, then
  try again.*"
- The consent page's refusal in `src/routes/oauth.ts`: "*Subscribe in the
  Track Evolution app on your iPhone or Android phone, then connect again.*"

**Default (owner to confirm):** both become factual and carry no call to
action and no link:

> This connection is available to Track Evolution Pro accounts. This account
> doesn't have Pro.

Nothing changes in the native apps' purchase flows, and nothing in ChatGPT
sells, prices, links to or describes a purchase. The submission states that
subscriptions are sold only through the App Store and Google Play. **Ask
OpenAI before submitting** whether an app that requires an existing paid
account is acceptable. I found no ruling either way.

**Fallback if review rejects a Pro-only app:** free accounts get the tools
whose data is free in the apps (`get_profile`, `list_tracks`, `list_events`,
`get_event`, `get_track_history`, `get_leaderboard`, `get_season_summary`).
Two of those need a change for it. `get_event` returns no channel data
(only which channels a session carries), but it does return `setups`, which
the apps gate behind `canUseSetups`, so a free account's result drops them.
`get_season_summary` already answers `pro: null` for a free account, since
`GET /wrapped/:year` decides that field from the tier. The analysis tools
stay Pro and answer the neutral sentence. That fallback costs an NS-32
tier-table change and a consent-page change, and is **not** built
speculatively.

The docs site's `ai.html` may keep saying "with Pro". It's our site, not a
surface inside ChatGPT.

### Reviewer access

Review requires "a test account with sample data" that needs "no MFA,
one-time codes or extra setup". Google and Apple sign-in can't promise that:
both challenge an unfamiliar device. **Proposal:**

- **One review account**, configured by two Worker secrets:
  `REVIEW_LOGIN_EMAIL` and `REVIEW_LOGIN_PASSWORD_HASH` (PBKDF2-SHA-256,
  `lib/review.ts`). Unset means every review route is a **404**, like
  `OPENAI_APPS_CHALLENGE`.
- **Reachable only from the OAuth consent flow.** When signed out, the
  consent page already shows a *Sign in to connect* chooser: Google, plus
  Apple when it's configured, each linking to its login route with `next`
  set back to the authorization request. It gains a third option, shown only
  when the secrets are set: a *Review account* form. Posting it creates an ordinary
  `auth_sessions` row for that one user and continues to `next`
  (`isSafeNext` unchanged). It never appears in the web app or the native
  apps.
- **Rate-limited** per `CF-Connecting-IP` through a new `REVIEW_LOGIN`
  binding (`withinLimit`, five a minute), with a constant-time compare.
- **The account holds a fictional logbook only**, seeded by a script that
  reuses the promo's demo data (`promo/demo/`, COTA telemetry from
  `sim.mjs`, cut by the importer's own `buildLapChannels`), plus the
  "April 10 Test Ring" session the draft's `test_cases` already describe.
  Pro comes from a `legacy` subscriptions row.
- **If the Claude directory review already solved this**, reuse that
  mechanism instead and drop the above.

### Other listing requirements

Some of these come from secondary checklists and are verified in ticket 0
against `platform.openai.com/apps-manage`:

- A verified OpenAI organisation, and an Owner to submit.
- Privacy policy and terms URLs (`docs.trackevolution.app/docs/privacy.html`,
  `terms.html`).
- Correct annotations on every tool (already done), and tool descriptions
  that say when to use them.
- **Test prompts**: direct, indirect and negative. The draft's `test_cases` /
  `negative_test_cases` already cover this; re-extract them after any tool
  change. **The draft is already stale**: it lists 13 tools, but its
  `x_submission_review` still says "All 12 annotation objects" and records a
  commit from before `get_racing_line` landed. Ticket 0 re-extracts it from
  the current `tools/list`.
- No request for the full conversation history, location, or sensitive
  inputs. None of our tools asks.
- **13+ audience.** Track-day drivers are adults; the privacy policy already
  covers age.
- **EU data residency is reportedly unsupported** for apps. The project must
  be a global-residency one.
- One version in review at a time. A widget release is a new review, so
  batch widget tickets into as few submissions as is sensible.
- **`GET /mcp` answers 405 today.** That's correct for a server with no event
  stream under the Streamable HTTP transport. One checklist claims ChatGPT
  requires a `GET` stream; verify in developer mode before changing anything.

## Architecture (ticket 1)

### Protocol

`src/ai/mcp.ts` stays hand-rolled, stateless and JSON-only. Every new method
is a plain request and response.

- **`initialize`** adds `resources: { listChanged: false }` to `capabilities`
  and reads the client's `capabilities.extensions["io.modelcontextprotocol/ui"]`
  (its `mimeTypes`). The server answers whether or not the client advertises
  it.
- **`resources/list`** returns one entry per widget template: `uri`
  (`ui://track-evolution/<name>.html`), `name`, `title`, `description` and
  `mimeType: "text/html;profile=mcp-app"`. **`resources/read`** returns
  `{ contents: [{ uri, mimeType, text, _meta: { ui: { csp, prefersBorder } } }] }`.
  Unknown URI → `INVALID_PARAMS`. **`resources/templates/list`** answers
  `{ resourceTemplates: [] }`.
- **Linking a tool to a widget** goes in `tools/list` as
  `_meta: { ui: { resourceUri } }` (plus `openai/outputTemplate` with the same
  URI, if ticket 1 confirms ChatGPT still needs it for compatibility). The
  link is **always published**: a host without the extension ignores `_meta`,
  and the server is stateless, so it can't remember what a client advertised
  in `initialize`. Each link is a field on the tool's definition in
  `src/ai/tools.ts` (`widget?: WidgetName`), so a renamed widget fails to
  type-check.
- **Widget-only tools** carry `_meta.ui.visibility: ["app"]`. ChatGPT and
  Claude keep them out of the model's tool list. They're still read-only,
  still Pro-checked in `callTool`, still built only from `GET`s, and still
  listed in `chatgpt-app-submission.json` with their visibility stated.
- **Protocol version.** MCP 2026-07-28 formalised the extensions framework.
  Ticket 1 reads its changelog and adds it to `PROTOCOL_VERSIONS` only if
  nothing in it needs sessions or streaming. Otherwise the extension is
  negotiated under 2025-11-25, as SEP-1865 allows.

### Widget data

A card needs arrays (an aligned pair's speed and delta, a track trace) that
must not reach the model: they would cost context and invite arithmetic, and
#314 fixed "summaries, never raw channel blobs". Two mechanisms are possible.
**Ticket 1 decides between them with a spike in ChatGPT developer mode and
Claude, and records the answer here.**

1. **`_meta` on the tool result.** OpenAI documents a result's `_meta` as
   delivered to the widget and hidden from the model, and MCP Apps forwards
   the whole `CallToolResult` in `ui/notifications/tool-result`. If both hosts
   keep `_meta` out of the model's context, this costs no round trip.
2. **A widget-only tool**, `get_widget_data({ kind, ...ids })` with
   `visibility: ["app"]`, called by the card through the bridge's
   `tools/call` once it has the model-visible result. This is unambiguous
   under the spec, at the cost of one more request per card.

**Default if the spike is inconclusive: (2).** It's the one the standard
guarantees. Either way, the payload is built in `src/ai/widgets/data.ts` from
the same `insights.ts` reductions, carries `units` (the user's unit system,
read through the private API's `GET /me`), and is bounded by
`TELEMETRY_MAX_VALUES`.

### The bundle

`public/` has no build step, and that rule stands. The widgets get one, in
`src/`:

- `src/ai/widgets/<name>/view.js` is a **pure** `render<Name>(payload, ctx)`
  returning an HTML string, mirroring the codebase's pure/DOM split. Where a
  card has a canvas (the session debrief's track map), the string carries an
  empty `<canvas>` and the payload carries the trace and markers;
  `bridge.js` hands both to `renderTrackMap` after mounting.
  `bridge.js` is the thin DOM half: the `ui/*` handshake, size
  notifications, host-context theming, mounting canvases, the per-module
  binders (`bindWrappedStory`, the charts' hover read-outs), and event
  delegation.
- `npm run widgets:build` (`scripts/build-widgets.mjs`) runs **esbuild**
  (already in the lockfile through wrangler; added as an explicit
  devDependency) to bundle each widget, inline its CSS, and write
  `src/ai/widgets/generated/<name>.html`. The output is **committed**, in the
  same idiom as the token generators and `contracts/`.
- `npm run widgets:check` rebuilds and fails on a dirty tree; CI runs it.
  `src/ai/widgets/index.ts` imports the generated files as text (a wrangler
  `rules` entry for `**/*.html` under that directory) and `resources/read`
  serves them.

**Rejected:**
- **Loading `/js/*.js` from trackevolution.app** via CSP `resourceDomains`.
  It needs CORS on static assets (module scripts are CORS-fetched), lets a
  deploy split the HTML from its scripts, and makes the template unreviewable
  by the host.
- **Inlining modules through an import map of `data:` URLs.** Relative
  `import "./x.js"` can't resolve against a `data:` base, and hosts' CSP may
  refuse `data:` scripts.

### Theming

Hosts send CSS variables in `HostContext.styles.variables`: `--color-*`,
`--font-sans`, `--font-mono` and `--border-radius-*`. The bundle step writes
a `:root` block from `public/style.css`'s light and dark token blocks (the
`generate-tokens.mjs` idiom). `bridge.js` maps the host's variables onto
ours where a mapping exists, keeps ours otherwise, and follows the host's
`theme` for light or dark. **The chart colours stay ours**: the accent is the
charts' "faster" signal, the same reason Material You is off on Android.

### Modules under a sandbox

The widget iframe is sandboxed, and it isn't the web app's page. The
modules assume three things about that page, and each needs an answer:

- **Units.** `localStorage` may be unavailable, and `currentUnits()` swallows
  that and falls back to imperial. A metric driver's card would then read in
  miles without failing, so **units are always passed explicitly** and never
  read through `currentUnits()`. Most renderers already take them
  (`channelChartSvg` and `deltaChartSvg` via `{ units }`, `wrappedStoryHtml`
  via `ctx.units`). **`gearRibbonSvg` doesn't**: [gears.js](../../../public/js/gears.js)
  reads `currentUnits()` for its distance axis and labels. Ticket 1 gives it
  a `{ units = currentUnits() }` option, which is the one `public/js` seam
  known today.
- **The tooltip.** `chart.js` (`lineChart`, `multiLineChart`) and
  `channel-graphs.js`'s hover read-out look up `#tooltip` and use it
  without a null check, so a page without one throws on the first hover. The
  bundle's shell **provides a `#tooltip` element** and the modules stay as
  they are.
- **Colours.** `trackmap.js` reads its colours from the computed style of
  `document.documentElement`, so the bundle's `:root` token block (see
  *Theming*) has to be in place before `renderTrackMap` first draws.

Any other module that needs a code change to run there gets a seam with the
old default, made in the ticket that needs it, and the web app's unit tests
must stay green.

## Widgets

Each card renders inline by default. Where noted, it offers
`ui/request-display-mode` → `fullscreen`. Each one degrades to nothing when
its data isn't there, never to an empty frame.

| Ticket | Card | Linked tool | Shows | Interactions |
|---|---|---|---|---|
| 1 | **Two-lap compare** | `compare_laps` | Head-to-head line, delta chart, speed overlay, sector table (`sectorTableHtml`), the gear ribbon when both laps stored `gear` | Hover read-out. Tap a sector → `ui/update-model-context` ("the driver is looking at S2: +0.61 s"). *Ask about S2* → `ui/message`. Fullscreen adds throttle and brake. |
| 2 | **Session debrief** | `get_session_insights` | Best-lap track map with limit markers (`limitMarkers`), sector table with theoretical best, the health and balance summary sentences, the stats line | Tap a limit marker or corner row → model context. *Debrief this session* → `ui/message`. |
| 3 | **Track progress** | `get_track_history` | Best-per-event chart (`lineChart`, lower is better) with the conditions band; waits for two timed events, like every client | Tap a point → model context naming the event. |
| 3 | **Season Wrapped** | `get_season_summary` | `wrappedStoryHtml` in **fullscreen**, as on the web, with the Pro cards when `pro` holds data. A `pro: null` payload (only possible under the free fallback in *Policy*) is passed **without the `pro` key**, as the public share page does, so `wrappedCards` draws no locked Pro cards: a locked card is an upsell. `ctx` supplies no year picker, store links or poster actions | Story navigation only. No poster download: the sandbox can't hand over a file, and the share page is the shareable thing. |
| 4 | **Garage wear** | `get_garage` | Per-car consumables with wear bars, the `partStatus` wording, the no-basis rule (no bar, words instead) | None. |

No card offers a link into the web app in v1. `ui/open-link` to
`trackevolution.app` is harmless, but it's a judgement call against the
"no indirect upsell" reading, and nothing needs it yet.

## Plugin bundle (ticket 5)

A ChatGPT plugin bundles skills with apps. The three MCP prompts become
skills that name the same tool sequence, cite figures, keep advice for the
paddock, and say "you are not a substitute for an instructor", as
`INSTRUCTIONS` does:

- `debrief_session`
- `compare_to_best`
- `plan_next_track_day`

**The prompts stay in `src/ai/mcp.ts` as the source of truth.** The bundle is
generated from them (`scripts/build-plugin.mjs`), so the two can't drift.
Ticket 5 confirms the bundle format against the plugin docs before building
and records it here.

## Tests

- **`test/api/mcp.test.ts`:**
  - `initialize` advertises `resources`.
  - `resources/list` names every template.
  - `resources/read` returns the MIME type, an empty-domain CSP, and HTML with
    no `<script src` or `<link href` to another origin.
  - Every `_meta.ui.resourceUri` in `tools/list` resolves through
    `resources/read`.
  - App-only tools carry `visibility: ["app"]`.
  - The text-only protocol (2025-03-26) is unchanged.
- **`test/api/ai-tools.test.ts`:** each widget payload, built from the
  telemetry fixture, stays within its bound and carries `units`. A free
  account's app-only tool call gets the Pro tool error like any other.
- **`test/unit/widgets.test.js`:** each `render<Name>` over a fixture
  payload, in both unit systems, plus the empty case. These are pure-function
  tests, the same shape as the existing chart tests. The metric case
  includes the gear ribbon's axis, which is what proves the `gearRibbonSvg`
  seam is wired. The track map's canvas drawing isn't reachable from Node,
  so the debrief test asserts the payload's trace and markers and the empty
  `<canvas>`, not pixels; the manual pass covers the drawing.
- **`widgets:check` in CI**, beside `contracts:check`.
- **Manual, per widget ticket**, recorded in the PR: ChatGPT developer mode
  (web, then the phone apps), Claude (web and desktop), and the MCP Apps
  reference host from `modelcontextprotocol/ext-apps`, each in light and
  dark.

## Docs

Each ticket updates what it makes true:

- **README**, *AI assistants (MCP)*: resources, widgets, the bundle step,
  and the review account's secrets.
- **AGENTS.md**: the AI bullet gains the widgets, the `widgets:*` commands,
  and the rule that `public/js/` modules imported by a widget must render
  under a sandbox.
- **`site/docs/ai.html`**: what the cards show, with screenshots; ChatGPT
  connects from the Plugin Directory once listed.
- **`site/docs/privacy.html`**: only if what an assistant receives changes.
  It shouldn't, since cards draw data the tools already return. Say so in the
  PR.
- **NS-32's tier table**: one line saying widgets inherit the MCP row.
- **This spec**: the ticket 1 spike's answer and the ticket 5 bundle format.

The site keeps its rules: it names ChatGPT and Claude, never Cloudflare or
hosting.

## Risks

- **The ChatGPT phone apps.** OpenAI's FAQ has said MCP Apps aren't
  available on mobile. Community reports since 2026-07-10 also say widgets
  fail to render in the iOS and Android ChatGPT apps, specifically when the
  widget's tool runs after another tool in the same turn. That chaining is
  our normal flow (`get_profile` → `get_event` → insights). This is why the
  text answer must stand alone. Ticket 1 re-tests and notes the state in the
  PR; nothing is designed around a bug.
- **Policy drift.** The Pro gate is the likeliest reason for rejection. It's
  settled with OpenAI first, not discovered in review.
- **Unverified OpenAI details.** developers.openai.com was unreachable when
  this was researched. Anything sourced to it (the `_meta` visibility,
  `openai/*` compatibility keys, submission fields) is verified in the ticket
  that relies on it.
- **Host review of templates.** Hosts may cache a `ui://` resource. A widget
  change ships under a **new URI** (`compare-v2.html`) rather than
  overwriting, so a cached template never meets a payload shape it doesn't
  know.

## Tickets

0. **Listing.** Neutral Pro wording (consent page and `PRO_REQUIRED_MESSAGE`,
   with tests), the review account (or reuse of the Claude review's), the
   review logbook seed, the submission JSON re-extracted and reviewed, and
   OpenAI's answer on the Pro question recorded here. Ships with no UI.
1. **Plumbing and the two-lap compare card**: everything under
   *Architecture*, plus the first widget.
2. **Session debrief card.**
3. **Track progress card and Season Wrapped (fullscreen).**
4. **Garage wear card.** Optional.
5. **Plugin bundle.**

## Out of scope

- Write tools (logging a lap, editing notes), so the connection stays
  read-only.
- Anything sold, priced or linked for purchase inside ChatGPT.
- A hosted model on our key (#314's follow-on).
- Native Settings rows for connected assistants (#314's follow-up).
- Any change to `apps/` or the web app's routes, and any change to `public/`
  beyond the default-preserving seams described under *Clients* and
  *Modules under a sandbox*.

## Sources

- MCP Apps: [announcement](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/), [SEP-1865 spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- OpenAI: [Apps SDK reference](https://developers.openai.com/apps-sdk/reference), [submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines), [authentication](https://learn.chatgpt.com/apps-sdk/build/auth), [opening submissions](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/)
- Plugin Directory and DevDay 2026: [TechCrunch](https://techcrunch.com/2026/09/29/openai-expands-chatgpts-plugins-with-app-like-interfaces-and-automations), [Taskade explainer](https://www.taskade.com/blog/chatgpt-plugins)
- Mobile rendering: [community report](https://community.openai.com/t/widgets-are-not-loading-in-the-chatgpt-mobile-apps-for-launched-apps-plugins/1388831), [chained-tool regression](https://community.openai.com/t/bug-chatgpt-mobile-app-fails-to-render-mcp-app-widget-when-the-widget-linked-tool-is-called-after-another-tool-in-the-same-assistant-turn-regression-july-10/1387449)
- Review checklist (secondary): [BayramAnnakov/chatgpt-app-skill](https://github.com/BayramAnnakov/chatgpt-app-skill/blob/main/chatgpt-app-builder/references/submission_requirements.md), [Alpic on rejections](https://alpic.ai/blog/why-your-chatgpt-app-is-getting-rejected-and-what-you-can-do-about-it)
