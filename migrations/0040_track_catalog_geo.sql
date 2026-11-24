-- Import laps anywhere (NS-57): the catalog learns where each track is, so an
-- import can recognise the place a file was driven at. `lat` / `lon` are a
-- point inside the layout's footprint, matched within the venue's radius
-- (VENUE_RADIUS_M in public/js/import/locate.js); the lap's length against
-- `length_m` (0026) is what tells one layout of a venue from another, so a
-- coordinate here only has to be right to about a kilometre.
--
-- Each is the centre of the bounding box OpenStreetMap holds for the circuit
-- or its venue (Nominatim search, 2026-11; data (c) OpenStreetMap contributors,
-- ODbL), rounded to four decimals. The commented rows are the ones OSM has no
-- object of their own for: they sit inside the venue OSM does map, which is all
-- the venue radius needs. A wrong one only means that track is not recognised,
-- and is corrected by a new migration once this one has been applied.
--
-- GET /api/catalog now selects lat, lon and length_m beside id and name.

ALTER TABLE track_catalog ADD COLUMN lat REAL;
ALTER TABLE track_catalog ADD COLUMN lon REAL;

UPDATE track_catalog SET lat = 34.4350, lon = -84.1765 WHERE name = 'Atlanta Motorsports Park';
UPDATE track_catalog SET lat = 41.4539, lon = -88.1265 WHERE name = 'Autobahn Country Club';
UPDATE track_catalog SET lat = 33.5333, lon = -86.6192 WHERE name = 'Barber Motorsports Park';
UPDATE track_catalog SET lat = 42.4878, lon = -89.1104 WHERE name = 'Blackhawk Farms Raceway';
UPDATE track_catalog SET lat = 46.4161, lon = -94.2751 WHERE name = 'Brainerd International Raceway';
UPDATE track_catalog SET lat = 35.4924, lon = -119.5507 WHERE name = 'Buttonwillow Raceway Park';
UPDATE track_catalog SET lat = 34.4883, lon = -80.5953 WHERE name = 'Carolina Motorsports Park';
UPDATE track_catalog SET lat = 35.3519, lon = -80.6837 WHERE name = 'Charlotte Motor Speedway (Roval)';
UPDATE track_catalog SET lat = 33.7512, lon = -115.3245 WHERE name = 'Chuckwalla Valley Raceway';
UPDATE track_catalog SET lat = 30.1356, lon = -97.6334 WHERE name = 'Circuit of the Americas';
UPDATE track_catalog SET lat = 29.1845, lon = -81.0702 WHERE name = 'Daytona International Speedway (Road Course)';
UPDATE track_catalog SET lat = 38.1381, lon = -77.5038 WHERE name = 'Dominion Raceway';
UPDATE track_catalog SET lat = 33.3667, lon = -97.4356 WHERE name = 'Eagles Canyon Raceway';
UPDATE track_catalog SET lat = 42.4086, lon = -86.1381 WHERE name = 'Gingerman Raceway';  -- the circuit's published point; OSM returns only short segments, all within 300 m
UPDATE track_catalog SET lat = 43.0954, lon = -85.3851 WHERE name = 'Grattan Raceway';
UPDATE track_catalog SET lat = 36.2210, lon = -96.5936 WHERE name = 'Hallett Motor Racing Circuit';
UPDATE track_catalog SET lat = 29.9181, lon = -97.8724 WHERE name = 'Harris Hill Raceway';
UPDATE track_catalog SET lat = 39.7442, lon = -103.8981 WHERE name = 'High Plains Raceway';
UPDATE track_catalog SET lat = 25.4519, lon = -80.4096 WHERE name = 'Homestead-Miami Speedway (Road Course)';
UPDATE track_catalog SET lat = 39.7961, lon = -86.2347 WHERE name = 'Indianapolis Motor Speedway (Road Course)';
UPDATE track_catalog SET lat = 32.2286, lon = -110.0069 WHERE name = 'Inde Motorsports Ranch';
UPDATE track_catalog SET lat = 36.5843, lon = -121.7534 WHERE name = 'Laguna Seca (WeatherTech Raceway)';
UPDATE track_catalog SET lat = 41.9279, lon = -73.3827 WHERE name = 'Lime Rock Park';
UPDATE track_catalog SET lat = 42.6230, lon = -83.2842 WHERE name = 'M1 Concourse';
UPDATE track_catalog SET lat = 40.6880, lon = -82.6364 WHERE name = 'Mid-Ohio Sports Car Course';
UPDATE track_catalog SET lat = 32.5245, lon = -97.6165 WHERE name = 'MotorSport Ranch (Cresson)';
UPDATE track_catalog SET lat = 29.2779, lon = -95.4218 WHERE name = 'MSR Houston';
UPDATE track_catalog SET lat = 37.0023, lon = -86.3683 WHERE name = 'NCM Motorsports Park';
UPDATE track_catalog SET lat = 41.3054, lon = -81.0181 WHERE name = 'Nelson Ledges Road Course';
UPDATE track_catalog SET lat = 39.3601, lon = -75.0640 WHERE name = 'New Jersey Motorsports Park (Lightning)';  -- the whole park's centre; OSM maps no circuit of its own
UPDATE track_catalog SET lat = 39.3601, lon = -75.0640 WHERE name = 'New Jersey Motorsports Park (Thunderbolt)';  -- the whole park's centre; OSM maps no circuit of its own
UPDATE track_catalog SET lat = 29.8855, lon = -90.2006 WHERE name = 'NOLA Motorsports Park';
UPDATE track_catalog SET lat = 45.3666, lon = -120.7384 WHERE name = 'Oregon Raceway Park';
UPDATE track_catalog SET lat = 38.2745, lon = -92.8866 WHERE name = 'Ozarks International Raceway';
UPDATE track_catalog SET lat = 47.3224, lon = -122.1446 WHERE name = 'Pacific Raceways';
UPDATE track_catalog SET lat = 42.2361, lon = -72.2440 WHERE name = 'Palmer Motorsports Park';  -- OSM's Whiskey Hill Raceway, the circuit's own name
UPDATE track_catalog SET lat = 40.8472, lon = -80.3475 WHERE name = 'Pittsburgh International Race Complex';
UPDATE track_catalog SET lat = 41.0553, lon = -75.5090 WHERE name = 'Pocono Raceway';
UPDATE track_catalog SET lat = 45.5966, lon = -122.6956 WHERE name = 'Portland International Raceway';
UPDATE track_catalog SET lat = 39.5842, lon = -86.7446 WHERE name = 'Putnam Park Road Course';
UPDATE track_catalog SET lat = 43.7993, lon = -87.9942 WHERE name = 'Road America';
UPDATE track_catalog SET lat = 34.1461, lon = -83.8153 WHERE name = 'Road Atlanta';
UPDATE track_catalog SET lat = 32.1681, lon = -81.3227 WHERE name = 'Roebling Road Raceway';
UPDATE track_catalog SET lat = 27.4534, lon = -81.3548 WHERE name = 'Sebring International Raceway';
UPDATE track_catalog SET lat = 38.1596, lon = -122.4577 WHERE name = 'Sonoma Raceway';
UPDATE track_catalog SET lat = 34.8777, lon = -118.2597 WHERE name = 'Streets of Willow';  -- midway between OSM's two Streets of Willow Springs ways
UPDATE track_catalog SET lat = 39.2328, lon = -77.9737 WHERE name = 'Summit Point (Jefferson Circuit)';
UPDATE track_catalog SET lat = 39.2357, lon = -77.9717 WHERE name = 'Summit Point (Main Circuit)';  -- OSM's Summit Point Circuit
UPDATE track_catalog SET lat = 39.2410, lon = -77.9760 WHERE name = 'Summit Point (Shenandoah Circuit)';  -- approximate: beside OSM's Shenandoah Circuit Road, no circuit object
UPDATE track_catalog SET lat = 47.2555, lon = -123.1917 WHERE name = 'The Ridge Motorsports Park';
UPDATE track_catalog SET lat = 41.9821, lon = -71.8283 WHERE name = 'Thompson Speedway Motorsports Park';
UPDATE track_catalog SET lat = 39.5405, lon = -122.3385 WHERE name = 'Thunderhill Raceway (2-Mile)';  -- approximate: beside OSM's Thunderhill West Clubhouse, no circuit object
UPDATE track_catalog SET lat = 39.5403, lon = -122.3307 WHERE name = 'Thunderhill Raceway (3-Mile)';  -- the circuit's published point, inside OSM's park outline
UPDATE track_catalog SET lat = 40.5810, lon = -112.3785 WHERE name = 'Utah Motorsports Campus';
UPDATE track_catalog SET lat = 36.5625, lon = -79.2053 WHERE name = 'Virginia International Raceway (Full)';
UPDATE track_catalog SET lat = 36.5655, lon = -79.2055 WHERE name = 'Virginia International Raceway (North)';  -- approximate: the northern half, by OSM's north paddock
UPDATE track_catalog SET lat = 36.5565, lon = -79.2050 WHERE name = 'Virginia International Raceway (South)';  -- approximate: the southern half, by OSM's south paddock
UPDATE track_catalog SET lat = 42.3364, lon = -76.9238 WHERE name = 'Watkins Glen International';
UPDATE track_catalog SET lat = 34.8726, lon = -118.2642 WHERE name = 'Willow Springs (Big Willow)';
