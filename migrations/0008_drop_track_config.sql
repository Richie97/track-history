-- Remove per-track configurations: the layout now lives in the track name
-- ("VIR Full", "VIR Patriot"), the same way the track catalog names layouts.
-- Existing rows with a config get it folded into the name ("VIR" + "Patriot" →
-- "VIR — Patriot") so no timing context is lost; tracks that collapse to the
-- same name are merged — the lowest id survives (keeping its goal/notes) and
-- events are re-pointed at it.
--
-- Same rebuild dance as 0004: D1 can't disable foreign_keys, and rebuilding a
-- *referenced* table under defer_foreign_keys still fails at commit when
-- events rows exist, so children are held aside, events emptied (cascades
-- through sessions/laps), tracks rebuilt while childless, then everything
-- restored — all inside the migration's single transaction.
PRAGMA defer_foreign_keys = true;

CREATE TABLE laps_hold AS SELECT * FROM laps;
CREATE TABLE sessions_hold AS SELECT * FROM sessions;
CREATE TABLE events_hold AS SELECT * FROM events;
DELETE FROM events;

-- old track id → surviving track id once configs are folded into names
-- (lowest id per (user, folded name); new_id = old_id when nothing collides).
CREATE TABLE track_redirect AS
  WITH folded AS (
    SELECT id, user_id,
           CASE WHEN config = '' THEN name ELSE name || ' — ' || config END AS name
    FROM tracks
  )
  SELECT f.id AS old_id,
         (SELECT MIN(x.id) FROM folded x WHERE x.user_id = f.user_id AND x.name = f.name) AS new_id
  FROM folded f;

CREATE TABLE tracks_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal_ms INTEGER,
  notes TEXT,
  catalog_id INTEGER REFERENCES track_catalog(id),
  UNIQUE(user_id, name)
);
INSERT INTO tracks_new (id, user_id, name, goal_ms, notes, catalog_id)
  SELECT t.id, t.user_id,
         CASE WHEN t.config = '' THEN t.name ELSE t.name || ' — ' || t.config END,
         t.goal_ms, t.notes, t.catalog_id
  FROM tracks t
  JOIN track_redirect r ON r.old_id = t.id AND r.new_id = t.id;
DROP TABLE tracks;
ALTER TABLE tracks_new RENAME TO tracks;

-- Folding changed names, so re-match the catalog (same rule as a rename).
UPDATE tracks SET catalog_id =
  (SELECT c.id FROM track_catalog c WHERE c.name = tracks.name COLLATE NOCASE);

INSERT INTO events SELECT * FROM events_hold;
UPDATE events SET track_id =
  (SELECT r.new_id FROM track_redirect r WHERE r.old_id = events.track_id);
INSERT INTO sessions SELECT * FROM sessions_hold;
INSERT INTO laps SELECT * FROM laps_hold;
DROP TABLE events_hold;
DROP TABLE sessions_hold;
DROP TABLE laps_hold;
DROP TABLE track_redirect;
