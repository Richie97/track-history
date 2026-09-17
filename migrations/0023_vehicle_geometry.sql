-- Two spec-sheet constants of a car (#208), both optional and both plain
-- numbers a driver can read off a manual — the inputs the bicycle model needs
-- to turn the balance read-out (#189) from relative into absolute:
--   expected yaw rate = v · (steering-wheel angle ÷ steering_ratio) ÷ wheelbase
--
--   wheelbase_mm    INTEGER  millimetres, how every manufacturer quotes it
--                            (2710 for a C7). Validated to 1500–4500 so a
--                            metres-vs-millimetres slip is a 400, not a nonsense
--                            diagnosis.
--   steering_ratio  REAL     16.25 for "16.25:1". Validated to 5–30.
--
-- NULL means "not entered", and a car with neither behaves exactly as before:
-- the balance view keeps its relative reading. The car catalog (0024) can
-- pre-fill both at pick time; after that the values are the user's.
ALTER TABLE vehicles ADD COLUMN wheelbase_mm INTEGER;
ALTER TABLE vehicles ADD COLUMN steering_ratio REAL;
