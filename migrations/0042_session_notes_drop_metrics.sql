-- An imported session's notes used to carry the import's car metrics:
--   "Imported from a.mp4 — top speed 121 mph · max 6,703 rpm · 1.43 G lateral — <caveat>"
-- The stats strip now shows top speed and max G from the stored channels, so
-- the importers stopped writing that segment (public/js/import/ui.js
-- `importSessionBody`, `Telemetry.importNotes` on both phones) and this takes
-- it out of the notes already stored.
--
-- Notes are free text a driver may have edited, so the match is narrow: the
-- line still opens with the importer's own source phrase, the segment after
-- the first " — " opens the way the metrics did and ends on one of their
-- units with no line break inside it. Anything else is left exactly as it is.
-- The source phrase and whatever followed the metrics (the lap-timing caveat,
-- anything the driver added after it) are kept.
WITH parts AS (
  SELECT id,
         substr(notes, 1, instr(notes, ' — ') - 1) AS head,
         substr(notes, instr(notes, ' — ') + 3) AS rest
  FROM sessions
  WHERE (notes LIKE 'Imported from %' OR notes LIKE 'Recorded with the in-app lap timer — %')
    AND instr(notes, ' — ') > 0
),
cut AS (
  SELECT id, head,
         CASE WHEN instr(rest, ' — ') > 0 THEN substr(rest, 1, instr(rest, ' — ') - 1) ELSE rest END AS seg,
         CASE WHEN instr(rest, ' — ') > 0 THEN substr(rest, instr(rest, ' — ')) ELSE '' END AS tail
  FROM parts
)
UPDATE sessions
SET notes = (SELECT head || tail FROM cut WHERE cut.id = sessions.id)
WHERE id IN (
  SELECT id FROM cut
  WHERE (seg GLOB 'top speed [0-9]*' OR seg GLOB 'max [0-9]*rpm*' OR seg GLOB '[0-9]*.[0-9][0-9] G lateral')
    AND instr(seg, char(10)) = 0
    AND (seg GLOB '*[0-9] mph' OR seg GLOB '*[0-9] km/h' OR seg GLOB '*[0-9] rpm' OR seg GLOB '*[0-9] G lateral')
);
