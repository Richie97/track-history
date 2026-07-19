-- Garage logbook: consumable part instances per vehicle (with wear
-- measurements) and per-event-day setup sheets — plus the event → vehicle
-- link they hang off.

-- Events gain a real vehicle link. events.car stays free text for display and
-- imported history; the link is auto-matched from the garage by name on
-- create/update (see routes/events.ts). track_hours optionally overrides the
-- on-track time estimate for the event (default: days × 2h — src/lib/wear.ts).
ALTER TABLE events ADD COLUMN vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN track_hours REAL;

-- Link existing events to the garage where the car text matches a vehicle
-- name — same rule the routes apply going forward.
UPDATE events SET vehicle_id =
  (SELECT v.id FROM vehicles v
   WHERE v.user_id = events.user_id AND v.name = events.car COLLATE NOCASE);

-- A part *instance* ("Hawk DTC-60 fronts, set #2"), not a catalog entry.
-- Usage is computed, never logged: a part accrues the track hours of every
-- event on its vehicle between installed_on and retired_on.
CREATE TABLE parts (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- pads_front | pads_rear | tires | rotors_front | rotors_rear | brake_fluid | oil | other
  name TEXT NOT NULL,              -- compound / model: "Hawk DTC-60", "RE-71RS 255/40R17"
  installed_on TEXT NOT NULL,      -- ISO yyyy-mm-dd; usage accrues from here…
  retired_on TEXT,                 -- …through here (NULL while in service)
  cost_cents INTEGER,              -- feeds the spend summary on the vehicle page
  expected_hours REAL,             -- planning prior; measurements refine the estimate
  wear_limit REAL,                 -- replace-at measurement value (e.g. 3 mm pad)
  notes TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_parts_vehicle ON parts(vehicle_id);

-- Optional wear observations taken between events (pad mm, tread 32nds…).
-- Two or more let src/lib/wear.ts fit wear-per-hour and project replacement.
CREATE TABLE part_measurements (
  id INTEGER PRIMARY KEY,
  part_id INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  measured_on TEXT NOT NULL,       -- ISO yyyy-mm-dd
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'mm'
);
CREATE INDEX idx_part_measurements_part ON part_measurements(part_id);

-- One setup sheet per event day (pressures, alignment, dampers, part refs).
-- data is JSON validated by sanitizeSetup in src/lib/validate.ts; each sheet
-- stores the full resolved snapshot (copy-forward happens at write time in
-- the UI), so diffing two sheets never chases an inheritance chain.
CREATE TABLE setups (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(event_id, day)
);
CREATE INDEX idx_setups_event ON setups(event_id);

-- updated_at upkeep, same scheme as 0011: inserts/updates stamp the row, and
-- child writes bump ancestors (measurements → part → vehicle, setups → event)
-- so the offline cache's staleness checks see nested changes. Every AFTER
-- UPDATE trigger is guarded WHEN NEW.updated_at = OLD.updated_at so the
-- touch-update itself can't loop.

-- parts: bump the part and its vehicle
CREATE TRIGGER trg_parts_ins AFTER INSERT ON parts BEGIN
  UPDATE parts SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.vehicle_id;
END;
CREATE TRIGGER trg_parts_upd AFTER UPDATE ON parts WHEN NEW.updated_at = OLD.updated_at BEGIN
  UPDATE parts SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.vehicle_id;
END;
CREATE TRIGGER trg_parts_del AFTER DELETE ON parts BEGIN
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = OLD.vehicle_id;
END;

-- part_measurements: bump the parent part and its vehicle
CREATE TRIGGER trg_part_measurements_ins AFTER INSERT ON part_measurements BEGIN
  UPDATE parts SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.part_id;
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT vehicle_id FROM parts WHERE id = NEW.part_id);
END;
CREATE TRIGGER trg_part_measurements_del AFTER DELETE ON part_measurements BEGIN
  UPDATE parts SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = OLD.part_id;
  UPDATE vehicles SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE id = (SELECT vehicle_id FROM parts WHERE id = OLD.part_id);
END;

-- setups: bump the setup and its parent event
CREATE TRIGGER trg_setups_ins AFTER INSERT ON setups BEGIN
  UPDATE setups SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.event_id;
END;
CREATE TRIGGER trg_setups_upd AFTER UPDATE ON setups WHEN NEW.updated_at = OLD.updated_at BEGIN
  UPDATE setups SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.id;
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = NEW.event_id;
END;
CREATE TRIGGER trg_setups_del AFTER DELETE ON setups BEGIN
  UPDATE events SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = OLD.event_id;
END;
