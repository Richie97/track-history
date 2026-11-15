-- Coach comments on sessions and laps (NS-52,
-- docs/specs/native/NS-52-coach-comments.md): a coach with a grant (NS-38)
-- says something about a student's session, a lap in it, or a place on that
-- lap, and the student replies. The first table two users write to.
--
-- One private thread per coach: every row carries the `coach_id` whose
-- conversation it is and the `author_id` who wrote it — that coach, or the
-- student in reply. The student reads every thread on their logbook; a coach
-- reads only rows whose coach_id is theirs.
--
-- `coach_id` references users, not coach_grants, on purpose. The grant decides
-- who may read and write *as a coach* (the routes join it on every statement);
-- the row outlives it, which is what lets the comments stay with the student
-- after a coach is removed. Deleting either account cascades away everything
-- it wrote or received.
--
-- `event_id` is denormalised from the session so the per-event read and the
-- unread feed need no join through sessions. It is set by the insert's own
-- SELECT from the ownership-scoped session, never from a request body. No
-- route moves a session between events; one that starts to owes this column
-- an update.
--
-- `dist_m` is whole metres from the start/finish line along the lap's own
-- driven distance, so it needs no grid and survives a re-import that changes
-- the channel blob's dStepM.
--
-- Each row has exactly one reader who is not its author, so one `seen_at` is
-- the whole read state.
--
-- No trigger bumps updated_at: a comment is not an edit of the logbook (the
-- item_shares rule), and the offline prefetch must not re-fetch an event
-- detail that has not changed.
--
-- AUTOINCREMENT so an id is never reused: a reported comment's id stays
-- unambiguous after it is deleted.

CREATE TABLE coach_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   INTEGER NOT NULL REFERENCES events(id)   ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lap_id     INTEGER REFERENCES laps(id) ON DELETE CASCADE,
  dist_m     INTEGER,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  seen_at    INTEGER,
  CHECK (student_id <> coach_id),
  CHECK (author_id IN (student_id, coach_id)),
  CHECK (dist_m IS NULL OR lap_id IS NOT NULL)
);
CREATE INDEX coach_comments_event ON coach_comments(event_id, coach_id);
CREATE INDEX coach_comments_unread ON coach_comments(student_id, coach_id, seen_at);
CREATE INDEX coach_comments_coach ON coach_comments(coach_id);
CREATE INDEX coach_comments_session ON coach_comments(session_id);
CREATE INDEX coach_comments_lap ON coach_comments(lap_id);
