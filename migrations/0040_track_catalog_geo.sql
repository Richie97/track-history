-- Import laps anywhere (NS-57): the catalog learns where each track is, so an
-- import can recognise the place a file was driven at. `lat` / `lon` are a
-- point inside the layout's footprint, matched within the venue's radius
-- (VENUE_RADIUS_M in public/js/import/locate.js); the lap's length against
-- `length_m` (0026) is what tells one layout of a venue from another, so a
-- coordinate here only has to be right to about a kilometre.
--
-- Unmarked rows are the circuit's published coordinate (its Wikipedia infobox
-- point, read from search summaries — the sandbox this was written in could
-- not open a map). Rows marked ESTIMATE had no source found and must be
-- checked against a map before this migration is applied remotely; a wrong
-- one only means that track is not recognised, and is corrected by a new
-- migration once this one has been applied.
--
-- GET /api/catalog now selects lat, lon and length_m beside id and name.

ALTER TABLE track_catalog ADD COLUMN lat REAL;
ALTER TABLE track_catalog ADD COLUMN lon REAL;

UPDATE track_catalog SET lat = 34.4347, lon = -84.1769 WHERE name = 'Atlanta Motorsports Park';
UPDATE track_catalog SET lat = 41.4547, lon = -88.1272 WHERE name = 'Autobahn Country Club';
UPDATE track_catalog SET lat = 33.5325, lon = -86.6189 WHERE name = 'Barber Motorsports Park';
UPDATE track_catalog SET lat = 42.4881, lon = -89.1154 WHERE name = 'Blackhawk Farms Raceway';  -- secondary source; confirm against a map
UPDATE track_catalog SET lat = 46.4171, lon = -94.2731 WHERE name = 'Brainerd International Raceway';
UPDATE track_catalog SET lat = 35.4913, lon = -119.5449 WHERE name = 'Buttonwillow Raceway Park';
UPDATE track_catalog SET lat = 34.4877, lon = -80.5970 WHERE name = 'Carolina Motorsports Park';
UPDATE track_catalog SET lat = 35.3525, lon = -80.6825 WHERE name = 'Charlotte Motor Speedway (Roval)';
UPDATE track_catalog SET lat = 33.7536, lon = -115.3197 WHERE name = 'Chuckwalla Valley Raceway';
UPDATE track_catalog SET lat = 30.1328, lon = -97.6411 WHERE name = 'Circuit of the Americas';
UPDATE track_catalog SET lat = 29.1856, lon = -81.0694 WHERE name = 'Daytona International Speedway (Road Course)';
UPDATE track_catalog SET lat = 38.1388, lon = -77.5046 WHERE name = 'Dominion Raceway';
UPDATE track_catalog SET lat = 33.3669, lon = -97.4272 WHERE name = 'Eagles Canyon Raceway';
UPDATE track_catalog SET lat = 42.4086, lon = -86.1381 WHERE name = 'Gingerman Raceway';
UPDATE track_catalog SET lat = 43.0957, lon = -85.3831 WHERE name = 'Grattan Raceway';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 36.2211, lon = -96.5931 WHERE name = 'Hallett Motor Racing Circuit';
UPDATE track_catalog SET lat = 29.9189, lon = -97.8733 WHERE name = 'Harris Hill Raceway';
UPDATE track_catalog SET lat = 39.7355, lon = -103.8945 WHERE name = 'High Plains Raceway';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 25.4519, lon = -80.4086 WHERE name = 'Homestead-Miami Speedway (Road Course)';
UPDATE track_catalog SET lat = 39.7948, lon = -86.2350 WHERE name = 'Indianapolis Motor Speedway (Road Course)';  -- secondary source; confirm against a map
UPDATE track_catalog SET lat = 32.2247, lon = -110.0078 WHERE name = 'Inde Motorsports Ranch';  -- secondary source; confirm against a map
UPDATE track_catalog SET lat = 36.5842, lon = -121.7536 WHERE name = 'Laguna Seca (WeatherTech Raceway)';
UPDATE track_catalog SET lat = 41.9277, lon = -73.3836 WHERE name = 'Lime Rock Park';
UPDATE track_catalog SET lat = 42.6230, lon = -83.2945 WHERE name = 'M1 Concourse';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 40.6893, lon = -82.6364 WHERE name = 'Mid-Ohio Sports Car Course';
UPDATE track_catalog SET lat = 32.5238, lon = -97.6166 WHERE name = 'MotorSport Ranch (Cresson)';
UPDATE track_catalog SET lat = 29.2781, lon = -95.4224 WHERE name = 'MSR Houston';
UPDATE track_catalog SET lat = 37.0020, lon = -86.3650 WHERE name = 'NCM Motorsports Park';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 41.3074, lon = -81.0152 WHERE name = 'Nelson Ledges Road Course';
UPDATE track_catalog SET lat = 39.3555, lon = -75.0700 WHERE name = 'New Jersey Motorsports Park (Lightning)';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 39.3610, lon = -75.0610 WHERE name = 'New Jersey Motorsports Park (Thunderbolt)';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 29.8836, lon = -90.1978 WHERE name = 'NOLA Motorsports Park';
UPDATE track_catalog SET lat = 45.3624, lon = -120.7469 WHERE name = 'Oregon Raceway Park';  -- secondary source; confirm against a map
UPDATE track_catalog SET lat = 38.2712, lon = -92.8901 WHERE name = 'Ozarks International Raceway';
UPDATE track_catalog SET lat = 47.3201, lon = -122.1452 WHERE name = 'Pacific Raceways';
UPDATE track_catalog SET lat = 42.2361, lon = -72.2444 WHERE name = 'Palmer Motorsports Park';
UPDATE track_catalog SET lat = 40.8490, lon = -80.3422 WHERE name = 'Pittsburgh International Race Complex';
UPDATE track_catalog SET lat = 41.0554, lon = -75.5115 WHERE name = 'Pocono Raceway';  -- secondary source; confirm against a map
UPDATE track_catalog SET lat = 45.5969, lon = -122.6958 WHERE name = 'Portland International Raceway';
UPDATE track_catalog SET lat = 39.5828, lon = -86.7425 WHERE name = 'Putnam Park Road Course';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 43.7975, lon = -87.9939 WHERE name = 'Road America';
UPDATE track_catalog SET lat = 34.1467, lon = -83.8178 WHERE name = 'Road Atlanta';
UPDATE track_catalog SET lat = 32.1697, lon = -81.3233 WHERE name = 'Roebling Road Raceway';
UPDATE track_catalog SET lat = 27.4547, lon = -81.3483 WHERE name = 'Sebring International Raceway';
UPDATE track_catalog SET lat = 38.1608, lon = -122.4550 WHERE name = 'Sonoma Raceway';
UPDATE track_catalog SET lat = 34.8777, lon = -118.2585 WHERE name = 'Streets of Willow';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 39.2365, lon = -77.9655 WHERE name = 'Summit Point (Jefferson Circuit)';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 39.2344, lon = -77.9753 WHERE name = 'Summit Point (Main Circuit)';  -- secondary source; confirm against a map
UPDATE track_catalog SET lat = 39.2410, lon = -77.9760 WHERE name = 'Summit Point (Shenandoah Circuit)';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 47.2557, lon = -123.1903 WHERE name = 'The Ridge Motorsports Park';
UPDATE track_catalog SET lat = 41.9818, lon = -71.8255 WHERE name = 'Thompson Speedway Motorsports Park';
UPDATE track_catalog SET lat = 39.5405, lon = -122.3385 WHERE name = 'Thunderhill Raceway (2-Mile)';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 39.5403, lon = -122.3307 WHERE name = 'Thunderhill Raceway (3-Mile)';  -- secondary source; confirm against a map
UPDATE track_catalog SET lat = 40.5750, lon = -112.3747 WHERE name = 'Utah Motorsports Campus';
UPDATE track_catalog SET lat = 36.5617, lon = -79.2047 WHERE name = 'Virginia International Raceway (Full)';
UPDATE track_catalog SET lat = 36.5655, lon = -79.2055 WHERE name = 'Virginia International Raceway (North)';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 36.5565, lon = -79.2050 WHERE name = 'Virginia International Raceway (South)';  -- ESTIMATE, unsourced; confirm against a map
UPDATE track_catalog SET lat = 42.3369, lon = -76.9272 WHERE name = 'Watkins Glen International';
UPDATE track_catalog SET lat = 34.8750, lon = -118.2644 WHERE name = 'Willow Springs (Big Willow)';  -- secondary source; confirm against a map
