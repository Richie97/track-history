-- The car's own odometer (#192), lifted out of the channels blob into a column.
--
-- `sessions.channels.meta.odometerKm` is the car's *lifetime* odometer as the
-- PDR recorder saw it — the highest reading in the recording, so the car's
-- mileage at the end of the session. It arrived as context for a graph, but it
-- is a fact about the car, and the garage (`GET /garage`) reads it across every
-- session a vehicle has ever run to reconcile its estimated hours with the
-- distance the car actually covered. That is a query over a logbook, the same
-- shape as 0020's conditions columns, and it gets the same arrangement:
-- trigger-maintained, never route-set, backfilled.
--
-- A session imported without video, recorded on a phone, or typed by hand has
-- no reading: json_extract(NULL, …) is NULL and the column simply stays empty.
--
-- It is deliberately *not* added to any session response. The events and
-- tracks routes select their session columns by name, so the column reaches a
-- client only through the garage, which is Pro; the blob it comes from is
-- unchanged.
ALTER TABLE sessions ADD COLUMN odometer_km REAL;

CREATE TRIGGER trg_sessions_odometer_ins AFTER INSERT ON sessions BEGIN
  UPDATE sessions
     SET odometer_km = json_extract(NEW.channels, '$.meta.odometerKm')
   WHERE id = NEW.id;
END;

-- A derived column owes its source a trigger (see 0020). `UPDATE OF channels`
-- does not fire on the SET above, which touches only the derived column.
CREATE TRIGGER trg_sessions_odometer_upd AFTER UPDATE OF channels ON sessions BEGIN
  UPDATE sessions
     SET odometer_km = json_extract(NEW.channels, '$.meta.odometerKm')
   WHERE id = NEW.id;
END;

UPDATE sessions
   SET odometer_km = json_extract(channels, '$.meta.odometerKm')
 WHERE channels IS NOT NULL;
