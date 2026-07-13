-- Track configurations, course notes, event conditions and prep checklists.
--
-- Tracks are rebuilt because the layout/config becomes part of the track's
-- identity: "VIR" Full vs Patriot are different timing contexts, so bests and
-- goals must never mix across configs. config is NOT NULL DEFAULT '' (not
-- NULL) so the UNIQUE constraint actually dedupes the no-config case.
--
-- D1 can't disable foreign_keys, and rebuilding a *referenced* table under
-- defer_foreign_keys still fails at commit when events rows exist (SQLite's
-- deferred-violation counter isn't reset by recreating the parent under a new
-- name). So children are held aside, events emptied (cascades through
-- sessions/laps), tracks rebuilt while childless, then everything restored —
-- all inside the migration's single transaction.
PRAGMA defer_foreign_keys = true;

CREATE TABLE laps_hold AS SELECT * FROM laps;
CREATE TABLE sessions_hold AS SELECT * FROM sessions;
CREATE TABLE events_hold AS SELECT * FROM events;
DELETE FROM events;

CREATE TABLE tracks_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '',   -- layout/variant, e.g. "Full", "Patriot", "CCW"
  goal_ms INTEGER,
  notes TEXT,                        -- course notes: braking references, gears, line
  UNIQUE(user_id, name, config)
);
INSERT INTO tracks_new (id, user_id, name, config, goal_ms)
  SELECT id, user_id, name, '', goal_ms FROM tracks;
DROP TABLE tracks;
ALTER TABLE tracks_new RENAME TO tracks;

INSERT INTO events SELECT * FROM events_hold;
INSERT INTO sessions SELECT * FROM sessions_hold;
INSERT INTO laps SELECT * FROM laps_hold;
DROP TABLE events_hold;
DROP TABLE sessions_hold;
DROP TABLE laps_hold;

ALTER TABLE events ADD COLUMN conditions TEXT;   -- dry | damp | wet | mixed
ALTER TABLE events ADD COLUMN temp_f INTEGER;    -- ambient temperature, °F
ALTER TABLE events ADD COLUMN checklist TEXT;    -- JSON [{"text","done"}] prep list for upcoming events
