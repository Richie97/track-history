-- Season Wrapped (NS-36): the catalog learns each track's lap length, so a
-- season's laps can be turned into track miles (lib/wrapped.ts).
--
-- Metres, from the venue's own published figure for the layout the catalog row
-- names, verified against the venue before merge — a wrong length is a wrong
-- number on somebody's poster. Rows whose name doesn't pin one layout
-- (MotorSport Ranch, Pocono, Utah Motorsports Campus) stay NULL rather than
-- guessing: a driver with telemetry there gets a length derived from their own
-- laps instead, and one without is counted out ("across N of M tracks").
--
-- GET /api/catalog keeps selecting only { id, name }, so its response is
-- byte-identical before and after. A wrong length is corrected in a new
-- migration, never by editing this one.

ALTER TABLE track_catalog ADD COLUMN length_m INTEGER;

UPDATE track_catalog SET length_m = 3219 WHERE name = 'Atlanta Motorsports Park';
UPDATE track_catalog SET length_m = 5729 WHERE name = 'Autobahn Country Club';
UPDATE track_catalog SET length_m = 3830 WHERE name = 'Barber Motorsports Park';
UPDATE track_catalog SET length_m = 3138 WHERE name = 'Blackhawk Farms Raceway';
UPDATE track_catalog SET length_m = 4023 WHERE name = 'Brainerd International Raceway';  -- Competition Road Course, 2.5 mi
UPDATE track_catalog SET length_m = 4313 WHERE name = 'Buttonwillow Raceway Park';  -- configuration #13, 2.68 mi (Cal Club SCCA) — not the 3.1 mi full course
UPDATE track_catalog SET length_m = 3668 WHERE name = 'Carolina Motorsports Park';
UPDATE track_catalog SET length_m = 3734 WHERE name = 'Charlotte Motor Speedway (Roval)';  -- 2.32 mi, the 2024 re-layout (the speedway's old facts page says 2.28)
UPDATE track_catalog SET length_m = 4313 WHERE name = 'Chuckwalla Valley Raceway';
UPDATE track_catalog SET length_m = 5514 WHERE name = 'Circuit of the Americas';  -- 3.426 mi
UPDATE track_catalog SET length_m = 5729 WHERE name = 'Daytona International Speedway (Road Course)';
UPDATE track_catalog SET length_m = 3219 WHERE name = 'Dominion Raceway';
UPDATE track_catalog SET length_m = 4426 WHERE name = 'Eagles Canyon Raceway';  -- 2.75 mi, the course since 2018
UPDATE track_catalog SET length_m = 3444 WHERE name = 'Gingerman Raceway';
UPDATE track_catalog SET length_m = 3219 WHERE name = 'Grattan Raceway';
UPDATE track_catalog SET length_m = 2897 WHERE name = 'Hallett Motor Racing Circuit';
UPDATE track_catalog SET length_m = 2929 WHERE name = 'Harris Hill Raceway';
UPDATE track_catalog SET length_m = 4104 WHERE name = 'High Plains Raceway';
UPDATE track_catalog SET length_m = 3557 WHERE name = 'Homestead-Miami Speedway (Road Course)';  -- the original 2.21 mi course
UPDATE track_catalog SET length_m = 3925 WHERE name = 'Indianapolis Motor Speedway (Road Course)';
UPDATE track_catalog SET length_m = 4426 WHERE name = 'Inde Motorsports Ranch';
UPDATE track_catalog SET length_m = 3602 WHERE name = 'Laguna Seca (WeatherTech Raceway)';
UPDATE track_catalog SET length_m = 2414 WHERE name = 'Lime Rock Park';  -- 1.5 mi, the track's own figure (older sources say 1.53)
UPDATE track_catalog SET length_m = 2414 WHERE name = 'M1 Concourse';
UPDATE track_catalog SET length_m = 3862 WHERE name = 'Mid-Ohio Sports Car Course';  -- the 2.4 mi / 15-turn course, not the 2.258 mi pro course
UPDATE track_catalog SET length_m = 3830 WHERE name = 'MSR Houston';
UPDATE track_catalog SET length_m = 5069 WHERE name = 'NCM Motorsports Park';
UPDATE track_catalog SET length_m = 3219 WHERE name = 'Nelson Ledges Road Course';
UPDATE track_catalog SET length_m = 3058 WHERE name = 'New Jersey Motorsports Park (Lightning)';
UPDATE track_catalog SET length_m = 3621 WHERE name = 'New Jersey Motorsports Park (Thunderbolt)';
UPDATE track_catalog SET length_m = 4426 WHERE name = 'NOLA Motorsports Park';
UPDATE track_catalog SET length_m = 3701 WHERE name = 'Oregon Raceway Park';
UPDATE track_catalog SET length_m = 6389 WHERE name = 'Ozarks International Raceway';  -- 3.97 mi
UPDATE track_catalog SET length_m = 3621 WHERE name = 'Pacific Raceways';
UPDATE track_catalog SET length_m = 3701 WHERE name = 'Palmer Motorsports Park';
UPDATE track_catalog SET length_m = 4474 WHERE name = 'Pittsburgh International Race Complex';
UPDATE track_catalog SET length_m = 3166 WHERE name = 'Portland International Raceway';  -- 1.967 mi, with the chicane
UPDATE track_catalog SET length_m = 2865 WHERE name = 'Putnam Park Road Course';
UPDATE track_catalog SET length_m = 6515 WHERE name = 'Road America';
UPDATE track_catalog SET length_m = 4088 WHERE name = 'Road Atlanta';
UPDATE track_catalog SET length_m = 3251 WHERE name = 'Roebling Road Raceway';
UPDATE track_catalog SET length_m = 6019 WHERE name = 'Sebring International Raceway';
UPDATE track_catalog SET length_m = 4056 WHERE name = 'Sonoma Raceway';
UPDATE track_catalog SET length_m = 2897 WHERE name = 'Streets of Willow';  -- 1.8 mi, the extended course
UPDATE track_catalog SET length_m = 2736 WHERE name = 'Summit Point (Jefferson Circuit)';  -- 1.7 mi, enlarged in 2014 (the old layout was 1.1)
UPDATE track_catalog SET length_m = 3219 WHERE name = 'Summit Point (Main Circuit)';
UPDATE track_catalog SET length_m = 3541 WHERE name = 'Summit Point (Shenandoah Circuit)';
UPDATE track_catalog SET length_m = 3975 WHERE name = 'The Ridge Motorsports Park';
UPDATE track_catalog SET length_m = 2736 WHERE name = 'Thompson Speedway Motorsports Park';
UPDATE track_catalog SET length_m = 3219 WHERE name = 'Thunderhill Raceway (2-Mile)';  -- the West course, 2.0 mi
UPDATE track_catalog SET length_m = 4612 WHERE name = 'Thunderhill Raceway (3-Mile)';  -- the East course, 2.866 mi
UPDATE track_catalog SET length_m = 5262 WHERE name = 'Virginia International Raceway (Full)';
UPDATE track_catalog SET length_m = 3621 WHERE name = 'Virginia International Raceway (North)';
UPDATE track_catalog SET length_m = 2655 WHERE name = 'Virginia International Raceway (South)';
UPDATE track_catalog SET length_m = 5472 WHERE name = 'Watkins Glen International';  -- the 3.4 mi long course
UPDATE track_catalog SET length_m = 4023 WHERE name = 'Willow Springs (Big Willow)';
