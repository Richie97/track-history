-- Publish a best-lap video to YouTube (NS-46,
-- docs/specs/native/NS-46-youtube-upload.md).
--
-- A connection is its own Google grant, separate from sign-in, limited to
-- youtube.upload (plus openid/email, so Settings can say which account). Its
-- tokens are ENCRYPTED, not hashed (AES-GCM, YOUTUBE_TOKEN_KEY; lib/youtube.ts):
-- unlike a session token we have to send them back to Google, so a hash would
-- be useless. D1 still never holds a usable credential in plaintext.
--
-- An upload is one row per clip, copied from R2 to YouTube by the queue
-- consumer (src/youtube/step.ts) one chunk per message; `lease_until` is what
-- makes a duplicate delivery harmless.

CREATE TABLE youtube_connections (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_sub        TEXT    NOT NULL,
  email             TEXT,
  channel_title     TEXT,               -- learned from the first upload's response
  refresh_token_enc TEXT    NOT NULL,
  access_token_enc  TEXT,
  access_expires_at INTEGER,
  status            TEXT    NOT NULL CHECK (status IN ('ok', 'revoked')),
  connected_at      INTEGER NOT NULL,
  verified_at       INTEGER NOT NULL,   -- the 30-day re-check
  updated_at        INTEGER NOT NULL
);

-- The native connect ticket: single use, 5 minutes, stored hashed like every
-- other one-time code here.
CREATE TABLE youtube_connect_tickets (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE youtube_uploads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  clip_id         INTEGER NOT NULL UNIQUE REFERENCES lap_clips(id) ON DELETE CASCADE,
  status          TEXT    NOT NULL CHECK (status IN ('queued', 'uploading', 'done', 'failed')),
  title           TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  privacy         TEXT    NOT NULL CHECK (privacy IN ('private', 'unlisted', 'public')),
  session_url_enc TEXT,               -- the resumable session URI; a capability, so encrypted
  bytes_sent      INTEGER NOT NULL DEFAULT 0,
  restarts        INTEGER NOT NULL DEFAULT 0,
  lease_until     INTEGER,            -- one queue step at a time
  video_id        TEXT,
  error           TEXT,               -- the words the lap page shows
  created_at      INTEGER NOT NULL,   -- reset when a failed upload is retried
  verified_at     INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX youtube_uploads_user ON youtube_uploads(user_id, created_at);
CREATE INDEX youtube_uploads_status ON youtube_uploads(status, updated_at);

-- The project's daily budget, by Pacific day (YouTube's quota resets at
-- midnight Pacific).
CREATE TABLE youtube_daily (day TEXT PRIMARY KEY, uploads INTEGER NOT NULL);

-- No foreign keys: a revocation outlives the account it came from. Deleting a
-- connection never forgets to revoke it — disconnecting, and the account's own
-- deletion through the users cascade (SQLite fires child triggers on a
-- cascade) — and the daily cron (sweepYouTube) calls Google's revoke endpoint.
CREATE TABLE youtube_revocations (
  refresh_token_enc TEXT PRIMARY KEY,
  queued_at         INTEGER NOT NULL
);

CREATE TRIGGER youtube_connection_revoke AFTER DELETE ON youtube_connections BEGIN
  INSERT OR IGNORE INTO youtube_revocations (refresh_token_enc, queued_at)
  VALUES (OLD.refresh_token_enc, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

-- updated_at, on 0011's arrangement: an upload arriving, changing state or
-- going away bumps its clip's lap → session → event, so the event detail's
-- updated_at moves and every client's prefetch picks up the new
-- `clip.youtube`. Progress (bytes_sent) deliberately does not: the lap page
-- polls GET /clips/:id/youtube for that rather than the whole event.
CREATE TRIGGER youtube_uploads_ins AFTER INSERT ON youtube_uploads BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT l.session_id FROM laps l JOIN lap_clips k ON k.lap_id = l.id WHERE k.id = NEW.clip_id);
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT s.event_id FROM sessions s JOIN laps l ON l.session_id = s.id JOIN lap_clips k ON k.lap_id = l.id
                 WHERE k.id = NEW.clip_id);
END;
CREATE TRIGGER youtube_uploads_upd AFTER UPDATE OF status, video_id, privacy ON youtube_uploads
  WHEN NEW.status IS NOT OLD.status OR NEW.video_id IS NOT OLD.video_id OR NEW.privacy IS NOT OLD.privacy BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT l.session_id FROM laps l JOIN lap_clips k ON k.lap_id = l.id WHERE k.id = NEW.clip_id);
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT s.event_id FROM sessions s JOIN laps l ON l.session_id = s.id JOIN lap_clips k ON k.lap_id = l.id
                 WHERE k.id = NEW.clip_id);
END;
CREATE TRIGGER youtube_uploads_del AFTER DELETE ON youtube_uploads BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT l.session_id FROM laps l JOIN lap_clips k ON k.lap_id = l.id WHERE k.id = OLD.clip_id);
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT s.event_id FROM sessions s JOIN laps l ON l.session_id = s.id JOIN lap_clips k ON k.lap_id = l.id
                 WHERE k.id = OLD.clip_id);
END;
