-- Push notifications for coach comments (NS-54,
-- docs/specs/native/NS-54-comment-push.md).
--
-- One row per signed-in app install: a device is registered against the
-- auth_sessions row that registered it, so signing out — which deletes the
-- session — unregisters the phone with no extra call, and an expired session
-- takes its device with it. `auth_token` is the session's key, the token's
-- SHA-256, never a usable credential.
--
-- `token` is the FCM registration token, unique: a token one account
-- registers is moved off any other (a shared phone, a sign-out the server
-- never saw), so one phone never receives two accounts' comments.

CREATE TABLE push_devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_token TEXT    NOT NULL REFERENCES auth_sessions(token) ON DELETE CASCADE,
  platform   TEXT    NOT NULL CHECK (platform IN ('ios', 'android')),
  token      TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX push_devices_session ON push_devices(auth_token);
CREATE INDEX push_devices_user ON push_devices(user_id);
