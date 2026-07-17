-- Spell out the VIR catalog entries like the rest of the catalog names layouts
-- ("Summit Point (Main Circuit)", "Thunderhill Raceway (2-Mile)"): the 0007
-- seed abbreviated them as "VIR Full" / "VIR North" / "VIR South". Applied
-- migrations are never edited, so rename the rows here instead.

UPDATE track_catalog SET name = 'Virginia International Raceway (Full)'  WHERE name = 'VIR Full';
UPDATE track_catalog SET name = 'Virginia International Raceway (North)' WHERE name = 'VIR North';
UPDATE track_catalog SET name = 'Virginia International Raceway (South)' WHERE name = 'VIR South';

-- Carry the rename through to user tracks linked to those entries so their
-- names stay canonical — unless the user already has a track with the new
-- name (then the old row keeps its name; both stay linked via catalog_id).
UPDATE tracks SET name = (SELECT c.name FROM track_catalog c WHERE c.id = tracks.catalog_id)
WHERE catalog_id IN
    (SELECT id FROM track_catalog WHERE name LIKE 'Virginia International Raceway (%')
  AND NOT EXISTS (
    SELECT 1 FROM tracks t2
    WHERE t2.user_id = tracks.user_id AND t2.id <> tracks.id
      AND t2.name = (SELECT c.name FROM track_catalog c WHERE c.id = tracks.catalog_id) COLLATE NOCASE
  );

-- Tracks users had already spelled out now match the catalog — link them.
UPDATE tracks SET catalog_id =
  (SELECT c.id FROM track_catalog c WHERE c.name = tracks.name COLLATE NOCASE)
WHERE catalog_id IS NULL
  AND name LIKE 'Virginia International Raceway (%' COLLATE NOCASE;
