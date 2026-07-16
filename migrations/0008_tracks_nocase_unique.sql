-- Make track uniqueness case-insensitive at the schema level.
--
-- resolveTrack has always find-or-created NOCASE, but direct creates/renames
-- (POST/PUT /api/tracks) only hit the case-*sensitive* UNIQUE(user_id, name,
-- config), so "VIR" and "vir" could coexist as separate tracks with separate
-- bests and goals. Rebuild tracks with NOCASE name/config columns so the
-- unique constraint (and every comparison) is case-insensitive.
--
-- First merge any case-duplicates that already slipped in: the lowest id in
-- each (user_id, name, config) NOCASE group is canonical — it absorbs the
-- dupes' goal/notes where it has none, their events are repointed at it, and
-- the dupes are deleted.

-- Canonical rows inherit goal/notes from a dupe when they lack their own.
UPDATE tracks SET
  goal_ms = COALESCE(goal_ms, (
    SELECT t2.goal_ms FROM tracks t2
    WHERE t2.user_id = tracks.user_id
      AND t2.name = tracks.name COLLATE NOCASE
      AND t2.config = tracks.config COLLATE NOCASE
      AND t2.goal_ms IS NOT NULL
    ORDER BY t2.id LIMIT 1)),
  notes = COALESCE(notes, (
    SELECT t2.notes FROM tracks t2
    WHERE t2.user_id = tracks.user_id
      AND t2.name = tracks.name COLLATE NOCASE
      AND t2.config = tracks.config COLLATE NOCASE
      AND t2.notes IS NOT NULL
    ORDER BY t2.id LIMIT 1))
WHERE id = (
  SELECT MIN(t2.id) FROM tracks t2
  WHERE t2.user_id = tracks.user_id
    AND t2.name = tracks.name COLLATE NOCASE
    AND t2.config = tracks.config COLLATE NOCASE);

-- Repoint events at the canonical track in each group, then drop the dupes.
UPDATE events SET track_id = (
  SELECT MIN(t2.id)
  FROM tracks t1 JOIN tracks t2
    ON t2.user_id = t1.user_id
   AND t2.name = t1.name COLLATE NOCASE
   AND t2.config = t1.config COLLATE NOCASE
  WHERE t1.id = events.track_id);

DELETE FROM tracks WHERE id NOT IN (
  SELECT MIN(id) FROM tracks
  GROUP BY user_id, name COLLATE NOCASE, config COLLATE NOCASE);

-- Rebuild with NOCASE columns — same hold-aside dance as 0004 (D1 can't
-- disable foreign_keys, and rebuilding a referenced table under
-- defer_foreign_keys fails at commit while events rows exist).
PRAGMA defer_foreign_keys = true;

CREATE TABLE laps_hold AS SELECT * FROM laps;
CREATE TABLE sessions_hold AS SELECT * FROM sessions;
CREATE TABLE events_hold AS SELECT * FROM events;
DELETE FROM events;

CREATE TABLE tracks_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  config TEXT NOT NULL DEFAULT '' COLLATE NOCASE,  -- layout/variant, e.g. "Full", "Patriot", "CCW"
  goal_ms INTEGER,
  notes TEXT,                                      -- course notes: braking references, gears, line
  catalog_id INTEGER REFERENCES track_catalog(id),
  UNIQUE(user_id, name, config)
);
INSERT INTO tracks_new (id, user_id, name, config, goal_ms, notes, catalog_id)
  SELECT id, user_id, name, config, goal_ms, notes, catalog_id FROM tracks;
DROP TABLE tracks;
ALTER TABLE tracks_new RENAME TO tracks;

INSERT INTO events SELECT * FROM events_hold;
INSERT INTO sessions SELECT * FROM sessions_hold;
INSERT INTO laps SELECT * FROM laps_hold;
DROP TABLE events_hold;
DROP TABLE sessions_hold;
DROP TABLE laps_hold;
