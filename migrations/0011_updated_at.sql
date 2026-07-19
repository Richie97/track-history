-- updated_at on every user-editable domain table, maintained by triggers so
-- all writes (including nested ones: laps → session → event) bump it without
-- any route-code cooperation. The frontend's offline cache uses events/tracks
-- updated_at to decide which cached responses are stale; the columns also lay
-- the groundwork for delta sync.
--
-- Timestamps are integer ms (matching created_at elsewhere), derived from
-- julianday() for sub-second resolution. ALTER TABLE can't add a non-constant
-- default, so new rows get their timestamp from the AFTER INSERT triggers.
-- Every AFTER UPDATE trigger is guarded with WHEN NEW.updated_at =
-- OLD.updated_at so the touch-update itself (and cascade bumps) can't loop,
-- regardless of the recursive_triggers pragma.

ALTER TABLE tracks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

UPDATE tracks SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);

-- tracks
CREATE TRIGGER trg_tracks_ins AFTER INSERT ON tracks BEGIN
  UPDATE tracks SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
END;
CREATE TRIGGER trg_tracks_upd AFTER UPDATE ON tracks WHEN NEW.updated_at = OLD.updated_at BEGIN
  UPDATE tracks SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
END;

-- vehicles
CREATE TRIGGER trg_vehicles_ins AFTER INSERT ON vehicles BEGIN
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
END;
CREATE TRIGGER trg_vehicles_upd AFTER UPDATE ON vehicles WHEN NEW.updated_at = OLD.updated_at BEGIN
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
END;

-- events
CREATE TRIGGER trg_events_ins AFTER INSERT ON events BEGIN
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
END;
CREATE TRIGGER trg_events_upd AFTER UPDATE ON events WHEN NEW.updated_at = OLD.updated_at BEGIN
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
END;

-- sessions: bump the session and its parent event
CREATE TRIGGER trg_sessions_ins AFTER INSERT ON sessions BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.event_id;
END;
CREATE TRIGGER trg_sessions_upd AFTER UPDATE ON sessions WHEN NEW.updated_at = OLD.updated_at BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.event_id;
END;
CREATE TRIGGER trg_sessions_del AFTER DELETE ON sessions BEGIN
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = OLD.event_id;
END;

-- laps: bump the parent session and event
CREATE TRIGGER trg_laps_ins AFTER INSERT ON laps BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.session_id;
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT event_id FROM sessions WHERE id = NEW.session_id);
END;
CREATE TRIGGER trg_laps_upd AFTER UPDATE ON laps BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.session_id;
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT event_id FROM sessions WHERE id = NEW.session_id);
END;
CREATE TRIGGER trg_laps_del AFTER DELETE ON laps BEGIN
  UPDATE sessions SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = OLD.session_id;
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT event_id FROM sessions WHERE id = OLD.session_id);
END;
