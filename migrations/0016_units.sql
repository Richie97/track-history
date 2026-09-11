-- Per-user unit system for display: 'metric' or 'imperial'.
--
-- NULL means the user never chose, and the API answers "imperial" — what the
-- app always showed (mph, °F, psi, gallons), so nobody's logbook changes
-- units under them. Storage is unaffected either way: lap times stay
-- milliseconds, temperatures stay °F (events.temp_f), channel speeds km/h,
-- setup pressures psi and fuel gallons. The preference only changes how the
-- clients render and read those values.
ALTER TABLE users ADD COLUMN units TEXT;
