-- Per-track personal goal lap time (ms). NULL = no goal set.
-- Shown as a reference line on the track's best-lap chart: red until beaten, green once a best lap meets it.
ALTER TABLE tracks ADD COLUMN goal_ms INTEGER;
