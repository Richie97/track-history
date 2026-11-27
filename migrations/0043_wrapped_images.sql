-- Season Wrapped's link-preview image (NS-36, #155): the 1200×630 poster the
-- owner's browser draws, kept so /share/<slug>/wrapped/<year> can name it as
-- its og:image. The Worker has no rasteriser, so the picture (a JPEG) is uploaded
-- rather than rendered — one row per account and year, replaced on each
-- upload. It is drawn from the free card set only, the same numbers the public
-- share already serves.
--
-- In D1 rather than R2 so an account's deletion takes its images with it
-- (ON DELETE CASCADE), with no tombstone or sweep to keep.

CREATE TABLE wrapped_images (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  image      BLOB    NOT NULL,  -- a 1200×630 JPEG
  updated_at INTEGER NOT NULL,  -- ms since the epoch; the og:image URL's ?v=
  PRIMARY KEY (user_id, year)
);
