-- Share with a coach (NS-38, #338): a driver gives an instructor or coach
-- read-only access to their logbook, and fills out a driver profile their
-- coaches see beside it.
--
-- A grant is account to account. The coach reads the student's logbook
-- through /api/students/:id/* (routes/coaching.ts), which runs the ordinary
-- /api routes as the student, GET only, behind a path and a field allowlist —
-- so this table is the whole of the permission, and deleting a row is the
-- whole of revoking it. Either account's deletion cascades it away.

CREATE TABLE coach_grants (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coach_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  -- Touched at most once an hour by the coach's reads; Settings shows it to
  -- the student as "viewed 2h ago".
  last_viewed_at INTEGER,
  UNIQUE(student_id, coach_id),
  CHECK (student_id <> coach_id)
);
CREATE INDEX coach_grants_coach ON coach_grants(coach_id);

-- An invite link, single use. The token is stored as its SHA-256 hash like
-- every other secret here (auth_sessions, auth_codes, oauth_*), so the link
-- can only be shown once, at creation. Expired rows are swept by the daily
-- cron.
CREATE TABLE coach_invites (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX coach_invites_student ON coach_invites(student_id);

-- The driver profile (JSON validated by sanitizeProfile in lib/profile.ts),
-- NULL until filled in. A plain, route-set column: seen by its owner and the
-- owner's coaches, and by nothing public — not the share page, the
-- leaderboards, OG meta or the MCP tools.
ALTER TABLE users ADD COLUMN profile TEXT;
