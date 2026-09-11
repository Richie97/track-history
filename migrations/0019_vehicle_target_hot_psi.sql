-- The target hot tyre pressure for a garage vehicle, in psi (one number for
-- all four corners — the pressure the driver wants the tyres to reach on
-- track). It closes the loop the session health strip opens (#190): a setup
-- sheet records the cold pressures set in the morning, a PDR import records
-- the hot pressures the tyres reached, and this is what the suggested cold
-- pressure for next time is aimed at. NULL means no target set.
ALTER TABLE vehicles ADD COLUMN target_hot_psi REAL;
