-- A swap between sessions, not just between days.
--
-- A mount (0029) starts and ends on a date, and an event counts against every
-- part that was on the car the day it started — so pads swapped at lunch
-- credited both sets with the whole day, and tires swapped on the Sunday of a
-- weekend credited the old set with all of it and the new set with none.
-- Either end of a mount can now also sit at a point inside that day's event:
--
--   *_event_id          — the event the swap happened during;
--   *_after_session_id  — the last of its sessions before the swap, or NULL
--                         for the event's start, before any session.
--
-- "After a session" rather than "before one" because a swap is recorded as it
-- happens, at the track: the sessions already logged ran on the old part, and
-- every session logged after it — including ones imported that evening — runs
-- on the new one. A mid-day swap writes the same point on both parts' mounts,
-- and the event's hours divide between them by logged lap time
-- (src/lib/wear.ts eventShares). A NULL event is the date rule, unchanged.
ALTER TABLE part_mounts ADD COLUMN mounted_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE part_mounts ADD COLUMN mounted_after_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE part_mounts ADD COLUMN removed_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE part_mounts ADD COLUMN removed_after_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;

-- Deleting the session a swap came after moves the swap back to after the
-- session before it (or the event's start), which is still where it happened
-- relative to every session that remains. Deleting the event deletes its
-- sessions first, and then the event reference goes by its foreign key.
CREATE TRIGGER trg_sessions_del_swap_point BEFORE DELETE ON sessions BEGIN
  UPDATE part_mounts SET mounted_after_session_id = (
      SELECT s.id FROM sessions s WHERE s.event_id = OLD.event_id AND s.id <> OLD.id
        AND (s.sort < OLD.sort OR (s.sort = OLD.sort AND s.id < OLD.id))
      ORDER BY s.sort DESC, s.id DESC LIMIT 1)
    WHERE mounted_after_session_id = OLD.id;
  UPDATE part_mounts SET removed_after_session_id = (
      SELECT s.id FROM sessions s WHERE s.event_id = OLD.event_id AND s.id <> OLD.id
        AND (s.sort < OLD.sort OR (s.sort = OLD.sort AND s.id < OLD.id))
      ORDER BY s.sort DESC, s.id DESC LIMIT 1)
    WHERE removed_after_session_id = OLD.id;
END;

-- A swap point belongs to the date it was set on. When 0029's triggers move
-- that date — un-retiring reopens a mount, re-dating a retirement or an install
-- moves one — the point no longer marks that end, so it goes. A route writing a
-- date and a point together changes the event in the same statement and is
-- left alone.
CREATE TRIGGER trg_part_mounts_removed_point AFTER UPDATE OF removed_on ON part_mounts
  WHEN OLD.removed_on IS NOT NEW.removed_on AND NEW.removed_event_id IS NOT NULL
    AND NEW.removed_event_id IS OLD.removed_event_id BEGIN
  UPDATE part_mounts SET removed_event_id = NULL, removed_after_session_id = NULL WHERE id = NEW.id;
END;
CREATE TRIGGER trg_part_mounts_mounted_point AFTER UPDATE OF mounted_on ON part_mounts
  WHEN OLD.mounted_on IS NOT NEW.mounted_on AND NEW.mounted_event_id IS NOT NULL
    AND NEW.mounted_event_id IS OLD.mounted_event_id BEGIN
  UPDATE part_mounts SET mounted_event_id = NULL, mounted_after_session_id = NULL WHERE id = NEW.id;
END;
