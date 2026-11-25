-- Virginia International Raceway's Grand Course joins the catalog: the fourth
-- of the venue's layouts, 4.20 miles (6.76 km), beside Full (3.27 mi), North
-- (2.25 mi) and South (1.65 mi), whose lengths 0026 already carries. Named
-- like its siblings, so its public page is /tracks/virginia-international-raceway-grand.
--
-- The coordinate is the venue's (0040's Full row): the Grand Course runs both
-- halves, and length is what tells the layouts apart — its window is well
-- clear of Full's (test/unit/locate.test.js).

INSERT INTO track_catalog (name) VALUES
  ('Virginia International Raceway (Grand)');

UPDATE track_catalog SET length_m = 6759 WHERE name = 'Virginia International Raceway (Grand)';
UPDATE track_catalog SET lat = 36.5625, lon = -79.2053 WHERE name = 'Virginia International Raceway (Grand)';

-- Tracks drivers had already named this way now match the catalog — link them.
UPDATE tracks SET catalog_id =
  (SELECT c.id FROM track_catalog c WHERE c.name = tracks.name COLLATE NOCASE)
WHERE catalog_id IS NULL
  AND name = 'Virginia International Raceway (Grand)' COLLATE NOCASE;
