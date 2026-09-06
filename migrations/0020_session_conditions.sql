-- Session conditions (#191): the ambient temperature a session was driven in,
-- and the elevation range the recording saw, lifted out of the channels blob
-- into columns.
--
-- `sessions.channels.meta` already carries `ambientC` (the recording's median
-- outside-air temperature) and `elevationM` (its max−min altitude, i.e. the
-- track's elevation change, not its height above sea level) on every video
-- telemetry import. Reading them out of the JSON was fine while they were
-- context for one session's graphs, but #191 puts ambient *behind the progress
-- chart* — a band across every event at a track — and that is a query over
-- every session in the logbook. json_extract over a megabyte of per-lap arrays,
-- once per session, to read one number is the wrong shape for it.
--
-- So: two derived columns, trigger-maintained like every other derived column
-- here (0011's updated_at, 0018's laps.device_timed), never route-set, and
-- backfilled so existing imports carry their conditions the moment this
-- applies. json_extract(NULL, …) is NULL, so a recorded or hand-entered
-- session needs no special case — it simply has no conditions.
--
-- The columns are deliberately *not* Pro-gated: the channels blob is the one
-- Pro field on a session (NS-32 rule 4), and "it was 92 °F" is context for a
-- lap time rather than analysis of it. A free account sees the temperature and
-- not the traces it came from.
ALTER TABLE sessions ADD COLUMN ambient_c REAL;
ALTER TABLE sessions ADD COLUMN elevation_m REAL;

-- The blob is written by the insert itself (POST /events/:id/sessions carries
-- `channels`), so the insert trigger sees it. The nested UPDATE re-fires 0011's
-- ancestor bumps in the same transaction; harmless, and the same thing 0018's
-- trigger does.
CREATE TRIGGER trg_sessions_conditions_ins AFTER INSERT ON sessions BEGIN
  UPDATE sessions
     SET ambient_c   = json_extract(NEW.channels, '$.meta.ambientC'),
         elevation_m = json_extract(NEW.channels, '$.meta.elevationM')
   WHERE id = NEW.id;
END;

-- A column derived from another column owes that column a trigger, or the
-- first edit silently strands it. No route rewrites `channels` today (PUT
-- /sessions/:id touches label and notes only) — this is the guarantee that one
-- doing so later cannot leave the conditions stale. `UPDATE OF channels` does
-- not fire on the SET above, which only touches the derived columns.
CREATE TRIGGER trg_sessions_conditions_upd AFTER UPDATE OF channels ON sessions BEGIN
  UPDATE sessions
     SET ambient_c   = json_extract(NEW.channels, '$.meta.ambientC'),
         elevation_m = json_extract(NEW.channels, '$.meta.elevationM')
   WHERE id = NEW.id;
END;

UPDATE sessions
   SET ambient_c   = json_extract(channels, '$.meta.ambientC'),
       elevation_m = json_extract(channels, '$.meta.elevationM')
 WHERE channels IS NOT NULL;
