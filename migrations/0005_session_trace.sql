-- Best-lap GPS trace for imported telemetry sessions: JSON array of
-- [x_m, y_m, v] points (local meters, downsampled), rendered as the
-- speed-painted racing line on the event page. NULL for manual sessions.
ALTER TABLE sessions ADD COLUMN trace TEXT;
