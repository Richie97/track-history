-- Canonical track catalog: a seeded, app-owned list of known tracks.
-- Per-user tracks stay free-text and freely renameable; catalog_id links a
-- user track to its canonical entry (matched by name, case-insensitive) so
-- the same physical track is identifiable across users without sharing any
-- user-entered data. NULL catalog_id = a track the catalog does not know.
--
-- Seed list mirrors US_TRACKS in public/js/us-tracks.js — keep the two in
-- sync: adding a catalog entry means a new migration (never edit this one)
-- plus the same name appended to US_TRACKS.

CREATE TABLE track_catalog (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
);

INSERT INTO track_catalog (name) VALUES
  ('Atlanta Motorsports Park'),
  ('Autobahn Country Club'),
  ('Barber Motorsports Park'),
  ('Blackhawk Farms Raceway'),
  ('Brainerd International Raceway'),
  ('Buttonwillow Raceway Park'),
  ('Carolina Motorsports Park'),
  ('Charlotte Motor Speedway (Roval)'),
  ('Chuckwalla Valley Raceway'),
  ('Circuit of the Americas'),
  ('Daytona International Speedway (Road Course)'),
  ('Dominion Raceway'),
  ('Eagles Canyon Raceway'),
  ('Gingerman Raceway'),
  ('Grattan Raceway'),
  ('Hallett Motor Racing Circuit'),
  ('Harris Hill Raceway'),
  ('High Plains Raceway'),
  ('Homestead-Miami Speedway (Road Course)'),
  ('Indianapolis Motor Speedway (Road Course)'),
  ('Inde Motorsports Ranch'),
  ('Laguna Seca (WeatherTech Raceway)'),
  ('Lime Rock Park'),
  ('M1 Concourse'),
  ('Mid-Ohio Sports Car Course'),
  ('MotorSport Ranch (Cresson)'),
  ('MSR Houston'),
  ('NCM Motorsports Park'),
  ('Nelson Ledges Road Course'),
  ('New Jersey Motorsports Park (Lightning)'),
  ('New Jersey Motorsports Park (Thunderbolt)'),
  ('NOLA Motorsports Park'),
  ('Oregon Raceway Park'),
  ('Ozarks International Raceway'),
  ('Pacific Raceways'),
  ('Palmer Motorsports Park'),
  ('Pittsburgh International Race Complex'),
  ('Pocono Raceway'),
  ('Portland International Raceway'),
  ('Putnam Park Road Course'),
  ('Road America'),
  ('Road Atlanta'),
  ('Roebling Road Raceway'),
  ('Sebring International Raceway'),
  ('Sonoma Raceway'),
  ('Streets of Willow'),
  ('Summit Point (Jefferson Circuit)'),
  ('Summit Point (Main Circuit)'),
  ('Summit Point (Shenandoah Circuit)'),
  ('The Ridge Motorsports Park'),
  ('Thompson Speedway Motorsports Park'),
  ('Thunderhill Raceway (2-Mile)'),
  ('Thunderhill Raceway (3-Mile)'),
  ('Utah Motorsports Campus'),
  ('VIR Full'),
  ('VIR North'),
  ('VIR South'),
  ('Watkins Glen International'),
  ('Willow Springs (Big Willow)');

ALTER TABLE tracks ADD COLUMN catalog_id INTEGER REFERENCES track_catalog(id);

-- Backfill existing user tracks whose name matches a catalog entry.
UPDATE tracks SET catalog_id =
  (SELECT c.id FROM track_catalog c WHERE c.name = tracks.name COLLATE NOCASE);
