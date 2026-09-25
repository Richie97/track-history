-- Equip / unequip, and a size on every part.
--
-- Until now a part was on the car for exactly one unbroken stretch, from
-- installed_on to retired_on. That cannot say "the track set came off for the
-- drive home and goes back on next month": the only way off the car was
-- retiring, which is forever. A part now carries its *mounts* — the stretches
-- it was actually on the car — and wear accrues across those alone
-- (src/lib/wear.ts `eventsInWindow`). installed_on / retired_on stay the part's
-- lifetime: bought-and-first-fitted, and thrown away. Between them a part is
-- either equipped (an open mount) or on the shelf (none).
--
-- The mounts are kept consistent with installed_on / retired_on by the
-- triggers below rather than by route code, the same arrangement as every
-- derived column here, so a part inserted by the seed, a support script or a
-- client that has never heard of mounts is on the car from installed_on, and
-- retiring or un-retiring one through a plain PUT closes or reopens its mount.
-- Only equipping and unequipping (POST /parts/:id/equip | /unequip) write
-- mounts directly.

-- A free-text size or spec ("255/40R17", "275/35ZR18") — what makes a front
-- and a rear pair of tyres two different things to buy.
ALTER TABLE parts ADD COLUMN size TEXT;

CREATE TABLE part_mounts (
  id INTEGER PRIMARY KEY,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  mounted_on TEXT NOT NULL,        -- ISO yyyy-mm-dd, inclusive
  removed_on TEXT                  -- inclusive; NULL while on the car
);
CREATE INDEX idx_part_mounts_part ON part_mounts(part_id);

-- Every existing part was on the car for its whole life.
INSERT INTO part_mounts (part_id, mounted_on, removed_on)
  SELECT id, installed_on, retired_on FROM parts;

-- A new part goes on the car the day it was installed (and comes off the day
-- it was retired, if it arrives already retired). A route creating a spare
-- that goes straight to the shelf deletes this mount afterwards.
CREATE TRIGGER trg_parts_mount_ins AFTER INSERT ON parts BEGIN
  INSERT INTO part_mounts (part_id, mounted_on, removed_on) VALUES (NEW.id, NEW.installed_on, NEW.retired_on);
END;

-- Retiring closes the open mount (never before it began).
CREATE TRIGGER trg_parts_mount_retire AFTER UPDATE OF retired_on ON parts
  WHEN OLD.retired_on IS NULL AND NEW.retired_on IS NOT NULL BEGIN
  UPDATE part_mounts SET removed_on = MAX(mounted_on, NEW.retired_on)
    WHERE part_id = NEW.id AND removed_on IS NULL;
END;

-- Un-retiring reverses exactly that: the mount that closed on the retirement
-- date reopens. A part that was already on the shelf when it was retired has
-- no such mount and goes back to the shelf.
CREATE TRIGGER trg_parts_mount_unretire AFTER UPDATE OF retired_on ON parts
  WHEN OLD.retired_on IS NOT NULL AND NEW.retired_on IS NULL BEGIN
  UPDATE part_mounts SET removed_on = NULL
    WHERE id = (SELECT id FROM part_mounts WHERE part_id = NEW.id AND removed_on = OLD.retired_on
                ORDER BY mounted_on DESC, id DESC LIMIT 1);
END;

-- Moving the retirement date moves the mount that closed on it.
CREATE TRIGGER trg_parts_mount_reretire AFTER UPDATE OF retired_on ON parts
  WHEN OLD.retired_on IS NOT NULL AND NEW.retired_on IS NOT NULL AND OLD.retired_on <> NEW.retired_on BEGIN
  UPDATE part_mounts SET removed_on = MAX(mounted_on, NEW.retired_on)
    WHERE part_id = NEW.id AND removed_on = OLD.retired_on;
END;

-- Moving the install date moves the first mount's start with it.
CREATE TRIGGER trg_parts_mount_install AFTER UPDATE OF installed_on ON parts
  WHEN OLD.installed_on <> NEW.installed_on BEGIN
  UPDATE part_mounts SET mounted_on = NEW.installed_on
    WHERE part_id = NEW.id AND mounted_on = OLD.installed_on;
END;

-- updated_at upkeep (see 0012): a mount change is a change to its part and
-- vehicle, so the offline cache's staleness checks see it.
CREATE TRIGGER trg_part_mounts_ins AFTER INSERT ON part_mounts BEGIN
  UPDATE parts SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.part_id;
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT vehicle_id FROM parts WHERE id = NEW.part_id);
END;
CREATE TRIGGER trg_part_mounts_upd AFTER UPDATE ON part_mounts BEGIN
  UPDATE parts SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.part_id;
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT vehicle_id FROM parts WHERE id = NEW.part_id);
END;
CREATE TRIGGER trg_part_mounts_del AFTER DELETE ON part_mounts BEGIN
  UPDATE parts SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = OLD.part_id;
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT vehicle_id FROM parts WHERE id = OLD.part_id);
END;
