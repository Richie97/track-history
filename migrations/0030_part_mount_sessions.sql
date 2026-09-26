-- A swap between sessions, not just between days.
--
-- A mount (0029) starts and ends on a date, and an event counts against every
-- part that was on the car the day it started — so pads swapped at lunch
-- credited both sets with the whole day, and tires swapped on the Sunday of a
-- weekend credited the old set with all of it and the new set with none.
-- Either end of a mount can now also name a session of that day's event:
--
--   mounted_session_id — the first session the part ran;
--   removed_session_id — the first session it did not run (the one its
--                        replacement started with).
--
-- A mid-day swap writes the same session on both parts' mounts, and the event's
-- hours divide between them by logged lap time (src/lib/wear.ts eventShares).
-- NULL on either end is the date rule, unchanged. Deleting the session falls
-- back to it too.
ALTER TABLE part_mounts ADD COLUMN mounted_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE part_mounts ADD COLUMN removed_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL;

-- A session boundary belongs to the date it was set on. When 0029's triggers
-- move that date — un-retiring reopens a mount, re-dating a retirement or an
-- install moves one — the session no longer marks that end, so it goes. A
-- route writing a date and a session together changes the session in the same
-- statement and is left alone.
CREATE TRIGGER trg_part_mounts_removed_session AFTER UPDATE OF removed_on ON part_mounts
  WHEN OLD.removed_on IS NOT NEW.removed_on AND NEW.removed_session_id IS NOT NULL
    AND NEW.removed_session_id IS OLD.removed_session_id BEGIN
  UPDATE part_mounts SET removed_session_id = NULL WHERE id = NEW.id;
END;
CREATE TRIGGER trg_part_mounts_mounted_session AFTER UPDATE OF mounted_on ON part_mounts
  WHEN OLD.mounted_on IS NOT NEW.mounted_on AND NEW.mounted_session_id IS NOT NULL
    AND NEW.mounted_session_id IS OLD.mounted_session_id BEGIN
  UPDATE part_mounts SET mounted_session_id = NULL WHERE id = NEW.id;
END;
