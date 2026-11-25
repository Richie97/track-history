-- The hosted database's "Virginia International Raceway (Full)" catalog row was
-- stored with two spaces before the parenthesis, so 0026's length and 0040's
-- coordinate — both matched by name — never reached it: the venue's main
-- layout had no length and no place there. Put the name right and fill the row
-- in. One statement, so a database whose row was always spelled correctly
-- (every fresh one) matches nothing and is left alone.
--
-- Drivers' own tracks picked from the misspelled row keep the name they have;
-- they are linked by catalog_id, which does not change.

UPDATE OR IGNORE track_catalog
SET name = 'Virginia International Raceway (Full)', length_m = 5262, lat = 36.5625, lon = -79.2053
WHERE name = 'Virginia International Raceway  (Full)';
