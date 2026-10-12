-- Best-lap video clips (NS-45, docs/specs/native/NS-45-best-lap-clips.md):
-- one clip per imported video session, its best lap, cut on the phone and
-- uploaded to R2 (bucket track-evolution-clips, binding CLIPS) in parts
-- through the Worker (routes/clips.ts).
--
-- A row is `uploading` from create until every part is in and `complete` has
-- stitched them, then `ready`; only a ready clip is on the event detail. The
-- object itself is never deleted by a route: deleting a row writes a
-- tombstone (the trigger below) and the daily cron (sweepClips) deletes the
-- object, or aborts the multipart upload, behind it. That covers every way a
-- row disappears — the clip, its lap, session, event or track, and the
-- account, since users cascades all of them.
--
-- AUTOINCREMENT on purpose: the R2 key is derived from the id, and a reused id
-- would put a new clip under a key whose tombstone the cron has not drained
-- yet — which would then delete the new object.

CREATE TABLE lap_clips (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lap_id        INTEGER NOT NULL UNIQUE REFERENCES laps(id) ON DELETE CASCADE,
  -- clips/<userId>/<clipId>.mp4 once the multipart upload exists; a
  -- pending/<uuid> placeholder for the moment between the insert that issues
  -- the id and the call that creates the upload.
  r2_key        TEXT    NOT NULL UNIQUE,
  upload_id     TEXT,                 -- R2 multipart id; NULL once ready
  status        TEXT    NOT NULL CHECK (status IN ('uploading', 'ready')),
  size_bytes    INTEGER NOT NULL,     -- declared at create, checked at complete
  duration_ms   INTEGER NOT NULL,
  lap_offset_ms INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX lap_clips_user ON lap_clips(user_id);

CREATE TABLE lap_clip_parts (
  clip_id     INTEGER NOT NULL REFERENCES lap_clips(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag        TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  PRIMARY KEY (clip_id, part_number)
);

-- No foreign keys: a tombstone outlives the user, event, session and lap it
-- came from.
CREATE TABLE lap_clip_tombstones (
  r2_key     TEXT PRIMARY KEY,
  upload_id  TEXT,
  deleted_at INTEGER NOT NULL
);

CREATE TRIGGER lap_clips_tombstone AFTER DELETE ON lap_clips BEGIN
  INSERT OR REPLACE INTO lap_clip_tombstones (r2_key, upload_id, deleted_at)
  VALUES (OLD.r2_key, OLD.upload_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;

-- updated_at, on 0011's arrangement: a clip arriving, changing state or going
-- away bumps its lap's session and event, so the event detail's updated_at
-- moves and every client's prefetch picks up the new `clip`.
CREATE TRIGGER lap_clips_ins AFTER INSERT ON lap_clips BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT session_id FROM laps WHERE id = NEW.lap_id);
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT s.event_id FROM sessions s JOIN laps l ON l.session_id = s.id WHERE l.id = NEW.lap_id);
END;
CREATE TRIGGER lap_clips_upd AFTER UPDATE OF status ON lap_clips WHEN NEW.status <> OLD.status BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT session_id FROM laps WHERE id = NEW.lap_id);
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT s.event_id FROM sessions s JOIN laps l ON l.session_id = s.id WHERE l.id = NEW.lap_id);
END;
CREATE TRIGGER lap_clips_del AFTER DELETE ON lap_clips BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT session_id FROM laps WHERE id = OLD.lap_id);
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT s.event_id FROM sessions s JOIN laps l ON l.session_id = s.id WHERE l.id = OLD.lap_id);
END;
