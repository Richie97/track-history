-- Per-lap channel data for imported telemetry sessions: JSON
-- { v: 1, dStepM, laps: [{ n, timeMs, speed: [...], rpm?: [...], latG?: [...] }] }
-- where each array holds one value per dStepM meters of driven distance from
-- the lap's start (speed km/h, latG G). Rendered as the per-lap channel
-- graphs on the event page. NULL for manual sessions and imports whose
-- telemetry had no per-lap windows.
ALTER TABLE sessions ADD COLUMN channels TEXT;
