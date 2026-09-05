-- Whether a lap was timed by a device (the phone's GPS recorder or an imported
-- telemetry file) rather than typed in. The per-track leaderboards rank only
-- these (NS-33): a typed number costs nothing and is indistinguishable from a
-- driven one, while every measuring source writes sessions.channels — the
-- per-lap telemetry blob — and no hand entry can. A lap is device-timed when
-- its session's channels carry a lap entry with the same time, the rule the
-- channel graphs already match laps to their data by.
--
-- Trigger-maintained like every other derived column here, so a support
-- script that inserts laps directly cannot leave it stale, and backfilled so
-- existing recordings rank the moment this applies. Laps added to a session
-- afterwards (POST /sessions/:id/laps) have no channel entry and stay 0 —
-- which is the point: a lap typed into a recorded session is still typed.
-- json_each(NULL) yields no rows, so a manual session's laps need no special
-- case. sanitizeChannels rounds timeMs and sanitizeLaps rounds time_ms, so
-- integer equality is exact.
ALTER TABLE laps ADD COLUMN device_timed INTEGER NOT NULL DEFAULT 0;

-- The session (and its channels) is inserted before its laps, so the insert
-- trigger sees the blob. The nested UPDATE re-fires the 0011 ancestor bumps
-- in the same transaction; harmless.
CREATE TRIGGER trg_laps_device_timed_ins AFTER INSERT ON laps BEGIN
  UPDATE laps SET device_timed = EXISTS (
    SELECT 1 FROM sessions s, json_each(s.channels, '$.laps') j
     WHERE s.id = NEW.session_id
       AND json_extract(j.value, '$.timeMs') = NEW.time_ms)
  WHERE id = NEW.id;
END;

-- No route rewrites channels today (PUT /sessions/:id touches label and notes
-- only), but a column derived from another column owes that column a trigger,
-- or the first edit silently strands it. laps.time_ms is never updated by any
-- route; a route that starts to owes this column an AFTER UPDATE OF time_ms.
CREATE TRIGGER trg_sessions_device_timed_upd AFTER UPDATE OF channels ON sessions BEGIN
  UPDATE laps SET device_timed = EXISTS (
    SELECT 1 FROM json_each(NEW.channels, '$.laps') j
     WHERE json_extract(j.value, '$.timeMs') = laps.time_ms)
  WHERE session_id = NEW.id;
END;

UPDATE laps SET device_timed = EXISTS (
  SELECT 1 FROM sessions s, json_each(s.channels, '$.laps') j
   WHERE s.id = laps.session_id
     AND json_extract(j.value, '$.timeMs') = laps.time_ms);
