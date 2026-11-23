# NS-56 — Share one lap, or two laps compared

**Phase:** post-rewrite · **Platform:** Server + web + iOS + Android · **Depends on:** NS-48 (share one event or session), the two-lap compare (#165), the lap page (#267 / #268)

## Goal

NS-48 shares a track day or a session. A driver also wants to send **one lap**
— "look at this one" — or **two laps side by side**, and on the phones the lap
page and the compare pages had no Share at all.

Two more kinds of the same link:

| | |
|---|---|
| `/share/l/<token>` | one lap: its time, its telemetry, its video, and the racing line when it is the lap the line was drawn from |
| `/share/c/<token>` | two laps compared: head to head, the delta, sectors and the channel traces, both videos |

## Fixed decisions

Everything NS-48 fixed holds (anyone with the link, one link per item, free to
share, the **owner's** tier decides what shows, never notes / costs / setups /
the garage link / where the trace lies, live writes off every offline queue).
On top of it:

| | |
|---|---|
| A lap link | Carries that lap alone: its row, its own channel entry, its clip. The header's best, lap count (1) and consistency (none) are the lap's. `trace` stays only for the session's best lap — the stored line is that lap's, and any other would be drawn on a line it never took. |
| A comparison link | Two of the owner's laps **at one track** (a layout is a track), A against B, ordered — B against A is another link. Each side is a lap link's payload, so the laps may be from different days and nothing else of either day comes with them. |
| A free owner's comparison | The compare is a Pro view. The link still resolves, with `pro: false` and the free half of each lap's channels; every client shows both lap times and one sentence — *"{name} is on the free plan, so this link shows the two lap times. The comparison shows while they have Pro."* — never an upsell to the viewer. |
| Deleting | Either lap going (or its session, event, account) removes the link. |

## API

Owner (authed, `/api`), each answering `{ kind: "lap" | "compare", token, url, created_at }` — 201 on a new link, 200 with the existing one, `GET` 404 `{ error: "not shared" }`, `DELETE` `{ ok: true }`:

| | |
|---|---|
| `POST` / `GET` / `DELETE /laps/:id/share` | |
| `POST` / `GET` / `DELETE /laps/:id/compare/:otherId/share` | `:id` is side A, `:otherId` side B. 400 `pick two different laps` / `laps must be at the same track`; 404 when either isn't the caller's. |

Public (no session, `Cache-Control: no-store`):

| | |
|---|---|
| `GET /api/share/l/:token` | `{ kind: "lap", name, pro, session_id, lap_id, event }` — NS-48's shape plus `lap_id`; `event` has the one session with the one lap. (`/share/e` and `/share/s` now carry `lap_id: null`.) |
| `GET /api/share/c/:token` | `{ kind: "compare", name, pro, a, b }`, each side `{ session_id, lap_id, event }` |
| `GET /api/share/(l\|c)/:token/clips/:clipId/url` | as NS-48, for a clip on a lap the link shows |
| `GET /share/l/:token`, `GET /share/c/:token` | the SPA shell with Open Graph tags |

Pinned by `contracts/golden/item-share-lap*.json`, `item-share-compare*.json`,
`shared-lap.json` and `shared-compare.json`. Migration `0039_lap_shares.sql`.

## Words (the same on all three clients)

- Lap: *"Anyone with this link can see this lap — its time, racing line, telemetry and video. The rest of the session, notes, costs and setup sheets stay private."*
- Comparison: *"Anyone with this link can see these two laps compared — their times, telemetry and video. Nothing else in your logbook is shared."*
- Shared page heading line: *"A lap shared by {name}."* / *"Two laps compared, shared by {name}."*
- Offline: *"Sharing needs a connection."* (NS-48's).

## Clients

- **Web**: a session's *Share* panel gains a *Share* select — the session, or
  any one of its laps — and, for a lap in a session with telemetry, a
  *compared with* select; a lap or pair with no link yet shows *Create link*
  rather than minting one per selection. The track's *Compare two laps* page
  has *Share* for the picked pair. `/share/l/<token>` is `viewEvent` through
  the share seam; `/share/c/<token>` is the compare page's own rendering over
  the two sides, without the pickers.
- **iOS / Android**: *Share…* on the lap page (the lap), on the session
  compare (the two lit laps, first lit = A; offered while exactly two or more
  are lit — the first two) and on the track's two-lap compare (the picked
  pair), opening NS-48's sheet / dialog with the new words. Hidden for a
  coach's read-only view, on a shared page, and for a lap whose id is still a
  temp id. `DeepLink.sharedItem` gains the `l` and `c` kinds; a lap link opens
  the shared-item screen, a comparison a read-only compare of the two sides.
  Analytics: `/share/l/:token`, `/share/c/:token`.
