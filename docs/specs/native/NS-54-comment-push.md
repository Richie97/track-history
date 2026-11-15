# NS-54 — Push notifications for coach comments

**Phase:** post-rewrite · **Platform:** Shared (server, iOS, Android) · **Depends on:** NS-52 (coach comments, the unread count), NS-38 (grants), the Firebase projects both apps already ship for analytics · **Estimate:** ~2 weeks across three PRs — server, then iOS, then Android · **Issue:** [#466](https://github.com/Richie97/track-history/issues/466)

## Goal

NS-52 shipped comments with *"no push, no email in v1"*: a student only learns
their coach said something when they next open the app and see the dashboard
card. This spec is that follow-up's push half. When a coach comments on a
student's session or lap, the student's phone says so; when the student
replies, the coach's phone says so. Tapping the notification opens the lap (or
session) the comment is on.

```
┌──────────────────────────────────────────────┐
│ TRACK EVOLUTION                        now   │
│ Sam Lee commented on Lap 6 · VIR             │
│ Brake 10 m later here, you have grip left    │
│ on entry.                                    │
└──────────────────────────────────────────────┘
```

## Fixed decisions

| | |
|---|---|
| What sends | **A new comment, to the one other person in its thread** — the coach's comment to the student, the student's reply to the coach. Never an edit, a delete, a `/seen`, or anything not in NS-52. Never to the author. |
| Who receives | Only a recipient who **can still read the thread**: the student always (it is their logbook), the coach only while the grant is live — which an insert already guarantees, since NS-52's insert joins the live grant. |
| Transport | **Firebase Cloud Messaging HTTP v1, for both platforms.** Both apps already link Firebase (analytics, project `track-evolution-app`), and FCM delivers to iOS through APNs once the APNs auth key is uploaded to the Firebase project. The Worker gets one sender, over plain HTTPS: an APNs sender needs HTTP/2 to `api.push.apple.com` and its own token signing, and FCM gives both platforms for one service-account call. |
| Credentials | One secret, **`FCM_SERVICE_ACCOUNT`** — a service-account JSON on the Firebase project with the *Firebase Cloud Messaging API Admin* role, whose `project_id` names the project. Unset, nothing is sent and registration still works: **ships dark**, like Stripe (NS-49). |
| Device registration | **Per app session, not per user.** A device token is stored against the `auth_sessions` row that registered it (`ON DELETE CASCADE`), so signing out — which deletes the session — stops that phone's notifications with no extra call, and an expired session takes its device with it. Bearer transport only: the web registers nothing. |
| One token, one account | Registering a token already held by another session (a shared phone, a sign-out the server never saw) **moves it**: the token's row is replaced, so one phone never receives two accounts' comments. |
| The opt-in | **The OS permission is the opt-in**, asked in context (below), and the app registers only once it is granted. Settings carries *Comment notifications* per device: off deletes the registration, on asks (or re-asks) and registers. No account-level preference — a coach with two phones decides per phone. |
| Payload | `notification` `{ title: feedLine, body: the comment, ≤ 180 characters with an ellipsis }` + `data` `{ kind: "comment", comment_id, event_id, session_id, lap_id?, student_id? }` (all strings; `student_id` present when the recipient is the coach). iOS gets `aps.badge` = the recipient's `comments_unread` and `thread-id` `event-<id>`; Android a `tag` of `event-<id>` and channel `coach_comments`. Nothing else from the logbook: no lap time, no telemetry, no email. |
| The comment text | **Is in the notification.** It is a message from one person to another and the recipient asked to be told; the OS's own *Show previews* setting decides whether a locked screen shows it. |
| Tapping it | Opens the lap (or the event, for a session comment) — the student's own route, or the coach's `student/:id/…` route. On cold start the route is parked like a deep link and opened after sign-in. The page's normal NS-52 read marks it seen. |
| Failures | Best-effort, **after** the 201: the send runs in `waitUntil`, so a push failure never fails or delays a comment, and nothing is retried. An `UNREGISTERED` / 404, or an `INVALID_ARGUMENT` naming the token, deletes that device row. Any other failure is logged and dropped. |
| Rate | Bounded already by NS-52's `COACH_COMMENTS` (20 a minute per author) and thread caps. No digesting in v1: each comment is one notification, grouped on the device by event. |
| Badge | The iOS badge is `comments_unread`, set by each push and **cleared by the app** on foreground to the live count from `/me` — the app is the only thing that knows a comment was read. |
| Tier | Free, both sides, like comments. |
| Never | Email, web push, a notification for anything outside NS-52's comments. Each would be its own spec. |

## Server (ticket 1)

### Migration `0038_push_devices.sql`

```sql
CREATE TABLE push_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_token TEXT NOT NULL REFERENCES auth_sessions(token) ON DELETE CASCADE, -- the hashed session
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  token TEXT NOT NULL UNIQUE,              -- the FCM registration token
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX push_devices_session ON push_devices(auth_token);
CREATE INDEX push_devices_user ON push_devices(user_id);
```

One row per session (a session is one install) and one per token. `auth_token`
is the SHA-256 the `auth_sessions` row already keys on; `requireSession` puts
it on the context as `authSession` for bearer requests.

### `src/lib/push.ts` (pure, unit-tested)

- `PUSH_BODY_MAX = 180`, `PUSH_PLATFORMS`.
- `sanitizePushDevice(v)` → `{ device: { platform, token } }` or `{ error }`:
  platform one of the two; token a printable ASCII string, 1–4,096 characters.
- `pushExcerpt(body)` — the first `PUSH_BODY_MAX` code points, newlines
  collapsed to spaces, `…` when cut.
- `commentPushMessage(row, recipient, unread)` → the FCM `message` object
  (title from the same words as the web's `feedLine` / `feedTarget`, which
  the test pins against `public/js/comments.js`).
- `isDeadToken(status, errorBody)` — the delete-the-row decision.
- `parseFcmServiceAccount(json)` — `parseServiceAccount` plus `project_id`.

### Routes (`routes/push.ts`, an ordinary `/api` router, in `API_ROUTERS` with no gate)

| Route | |
|---|---|
| `PUT /push/device` | `{ platform, token }` → `{ ok }`. Bearer only (a cookie request is a 400 `push needs the app`). Upserts this session's row; takes the token from any other row first. |
| `DELETE /push/device` | `{ ok }`. Deletes this session's row; idempotent. |

Both are live writes, off every offline queue, and absent from `COACH_ROUTES`.

### Sending (`src/push/fcm.ts`)

`notifyComment(env, commentId, nowMs, fetch)`, called through
`c.executionCtx.waitUntil` from NS-52's `insertComment` after the row is
written. One `DB.batch`: the comment with its feed fields (the
`GET /coaching/comments` join), the recipient's devices, and the recipient's
unread count. It mints an access token with the
`https://www.googleapis.com/auth/firebase.messaging` scope
(`googleAccessToken`, now taking a scope), then POSTs
`/v1/projects/<id>/messages:send` per device and deletes the dead ones.
`fetch` is injected, the YouTube step's pattern, so the tests script FCM.

### Tests

- `test/unit/push.test.ts`: the sanitizer, the excerpt (code points, an emoji
  at the cut), the message for both directions, the dead-token rule, and the
  title pinned to `feedLine`.
- `test/api/push.test.ts`: register / re-register / move a token between
  accounts / unregister; a cookie request refused; signing out deletes the
  row; `notifyComment` over a scripted fetch — the student's devices for a
  coach's comment and the coach's for a reply, never the author's, nothing
  when the secret is unset, a 404 device deleted and the others still sent;
  a comment's POST is still 201 when FCM is down.

## iOS (ticket 2)

- Link `FirebaseMessaging` (same `firebase-ios-sdk` package as Analytics);
  `aps-environment` in the entitlements (development in Debug, production in
  Release, from `project.yml`); *Push Notifications* capability; the APNs
  auth key uploaded to Firebase (Console, not code). `Package.resolved` gains
  the product's pins — the Kit's file is the app's, per AGENTS.md.
- `PushController` on `AppServices`: `Messaging.messaging().token` →
  `APIClient.registerPushDevice`, re-registered on token refresh and after
  every sign-in, unregistered on the Settings toggle. Messaging is configured
  only where `AppAnalytics` configures Firebase today, so the simulator and UI
  suites stay silent — and the `FIREBASE_ANALYTICS_COLLECTION_ENABLED=NO`
  default is untouched: messaging does not need analytics collection.
- **Asking**: never on launch. The first time a student opens a thread with a
  comment from their coach, or a coach sends their first comment, a card
  under the thread offers *Get notified when <name> replies* → the system
  prompt. Declined is remembered per install and not asked again; Settings
  carries the toggle from then on, opening iOS Settings when the OS has
  denied it.
- Tapping a notification: `UNUserNotificationCenterDelegate` →
  `DeepLink.commentPush(data)` in the Kit (pure, unit-tested) → `Route.lap` /
  `Route.event`, or the `Route.student(id:page:)` form for a coach; parked
  across sign-in like any link. Foreground: shown as a banner unless the
  thread is already on screen.
- The badge set to `/me`'s `comments_unread` on every foreground and after
  every `/seen`.

### As built — ticket 2

- `App/Push/PushController.swift` + `PushAskCard.swift`; the Kit's
  `Models/Push.swift` (`PushDeviceDraft`, `CommentPushTarget`,
  `DeepLink.commentPush`) and `APIClient.registerPushDevice` /
  `unregisterPushDevice`. The tap is a new `DeepLink.comment(_)` case that
  `parse(_:)` never produces, so it reuses the router's parking.
- **Swizzling off** (`FirebaseAppDelegateProxyEnabled` false) and
  `FirebaseMessagingAutoInitEnabled` false: no FCM token exists until the
  user says yes.
- **Foreground: always a banner.** The spec's "unless the thread is already
  on screen" is not built — knowing which thread is on screen would need
  every comment surface to report itself; a banner over the thread you are
  reading is harmless. The inbox is refreshed when one arrives.
- The badge follows `AuthController.commentsUnread`, which `/me` (re-read on
  every foreground) and `/seen` already keep, rather than a separate read.
- The toggle lives in Settings' *Coaching* card.

## Android (ticket 3)

- `firebase-messaging` (BoM-versioned beside analytics); a
  `FirebaseMessagingService` (`CommentMessagingService`) whose `onNewToken`
  re-registers and whose `onMessageReceived` posts the notification itself
  when the app is in the foreground (FCM shows `notification` messages only
  in the background).
- Channel **`coach_comments`** (*Coach comments*, default importance), created
  at start; `POST_NOTIFICATIONS` is already declared and asked in the same
  in-context places as iOS — the clip uploader's `ClipNotificationAsk` is the
  precedent for *ask where it means something*.
- `PushRegistrar` on `AppServices`, driven off `AuthState` like the billing
  sync; the Settings toggle beside *Upload lap videos over cellular*.
- Tapping: a `PendingIntent` to `MainActivity` carrying the data; `:core`'s
  `DeepLink.commentPush(data)` (pure, pinned by the same table as iOS) →
  `Route.Lap` / `Route.Event` with the optional `student`; parked through
  `PendingInvite`'s pattern across sign-in.
- Robolectric: the registrar's register/unregister/re-register on sign-in,
  the service building a notification on the right channel with the right
  `PendingIntent` extras.

## Docs and disclosures (owed by the tickets that ship them)

- **Privacy policy**: the push token, what a notification contains, that
  Google (FCM) and Apple (APNs) carry it; bump the effective date.
- **App Store App Privacy**: no new data type is collected for tracking;
  user content (comments) is already declared by NS-52. **Play Data
  safety**: FCM's device identifier, *App functionality*, not shared.
- `site/docs/` coaching page: *Getting notified*, and the Settings toggle.
- README: the `FCM_SERVICE_ACCOUNT` secret and the APNs key step.
- NS-52: strike *Push notifications* from its follow-ups.

## Tickets

1. **Server**: migration, `lib/push.ts`, `routes/push.ts`, `push/fcm.ts`, the
   `insertComment` hook, tests, README/AGENTS. **3–4 days.**
2. **iOS**: Messaging, registration, the in-context ask, the Settings toggle,
   tap routing, the badge. **3–4 days.**
3. **Android**: the messaging service, channel, registration, the ask, the
   toggle, tap routing. **3–4 days.**

## Acceptance

- [ ] A coach comments; the student's phone shows *"<coach> commented on Lap 6 · <track>"* with the comment, and tapping it opens that lap.
- [ ] The student replies; the coach's phone shows *"<student> replied on …"*, and tapping it opens the lap in the student's logbook.
- [ ] The author's own devices never notify; a second coach of the same student never does.
- [ ] Signing out of a phone stops its notifications with no other step.
- [ ] Turning *Comment notifications* off in Settings stops that phone's notifications and no other.
- [ ] A dead token is removed on its first failure; a FCM outage never fails a comment.
- [ ] With `FCM_SERVICE_ACCOUNT` unset nothing is sent and nothing errors.
- [ ] The privacy policy, store disclosures and docs ship with the first build that registers.
