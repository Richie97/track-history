# NS-48 — Share one event or one session

**Phase:** post-rewrite · **Platform:** Server + web + iOS + Android · **Depends on:** the coach allow-lists (`lib/coaching.ts`, NS-38), `stripProFields`, best-lap clips (NS-45) · **Estimate:** one PR

## Goal

A driver can send a friend or a coach **one track day, or one session**, as a
link that opens without signing in:

```
Event page ⋯            Session card ⋯
  Edit event              Edit session
  Share…        ◀         Share…        ◀
  Delete event            Delete session

Share sheet / dialog
┌──────────────────────────────────────────────┐
│ Anyone with this link can see this session — │
│ its laps, racing line, telemetry and video.  │
│ Notes, costs and setup sheets stay private.  │
│ trackevolution.app/share/s/k3Jx9…            │
│ [ Copy ]  [ Share… ]        [ Stop sharing ] │
└──────────────────────────────────────────────┘
```

The page the link opens is the event page, read-only: the header, the tiles,
the best-lap trace, each shared session's laps and channel panel, and the
best-lap videos.

## Fixed decisions

| | |
|---|---|
| Who can open it | **Anyone with the link**, no account. 128-bit token, so not guessable. |
| One link per item | Share answers the existing link; *Stop sharing* deletes it; a later Share mints a new one. |
| Separate from the logbook share | The logbook slug (`/share/<slug>`) is untouched; sharing one day exposes nothing else. |
| Shown | Laps, best-lap trace, telemetry, recorded conditions, the car's name, best-lap video. |
| Never shown | Event and session notes, the prep checklist, costs, setup sheets, the garage link (`vehicle_id`, `track_hours`), the email. |
| Tier | Sharing is **free**. What the link shows follows the **owner's** tier: the full channel panel and the video while the owner has Pro; the free half (speed / throttle / brake) and no video otherwise — no locked player, no upsell to the viewer. |
| A session link | Carries that session alone; the header's best, lap count, consistency and weather are that session's. |
| Deleting | Deleting the event, the session or the account removes the link (cascade); the link then answers 404. |
| Offline | The owner's share routes are live writes, off every offline queue: *"Sharing needs a connection."* |

## API

Owner (authed, `/api`), each answering `{ kind: "event" | "session", token, url, created_at }`:

| | |
|---|---|
| `POST /events/:id/share` | 201 on a new link, 200 with the existing one |
| `GET /events/:id/share` | the link, or 404 `{ error: "not shared" }` |
| `DELETE /events/:id/share` | `{ ok: true }`, or 404 |
| …and the same three under `/sessions/:id/share` | |

Public (no session, `Cache-Control: no-store`):

| | |
|---|---|
| `GET /api/share/e/:token`, `GET /api/share/s/:token` | `{ kind, name, pro, session_id, event }` — `event` is `GET /events/:id`'s shape, narrowed (hidden fields null / `[]`, so the native `Event` model decodes it) |
| `GET /api/share/(e\|s)/:token/clips/:clipId/url` | `{ url, expires_at }` for a clip on a lap the link shows |
| `GET /share/e/:token`, `GET /share/s/:token` | the SPA shell with per-item Open Graph tags |

Pinned by `contracts/golden/item-share-*.json`, `shared-event.json` and
`shared-session.json`. The prefixes are one letter so they can never be a
logbook slug (three characters minimum).

## Clients

- **Web**: *Share* beside *Edit event* / *Delete event* and beside each
  session's *Edit* / *Delete*; an inline panel with the link, *Copy*, the
  system share sheet where `navigator.share` exists, and *Stop sharing*.
  `/share/(e|s)/<token>` renders `viewEvent` read-only through the share seam.
- **iOS / Android**: *Share…* in the event's and each session's overflow menu,
  opening a sheet / dialog with the same four parts (the system share sheet
  via `ShareLink` / `ACTION_SEND`). The link is a Universal / App Link
  (`/share/*` is already claimed); `DeepLink` gains `sharedItem(kind, token)`
  ahead of the slug rule, and the app opens a read-only shared-item screen
  that reuses the event page's pieces, with the channel panel opened by the
  response's `pro`. Like the logbook share, a link opened in a signed-out app waits
  for sign-in; the browser is the no-account path. Android's event page has
  no overflow menu, so its *Share…* is a button beside *Edit*.
- **Analytics**: the path shape is `/share/e/:token` / `/share/s/:token`; the
  token is never sent.
