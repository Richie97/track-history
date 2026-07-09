-- Track History schema. Multi-user: every domain row is scoped to a user.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  google_sub TEXT UNIQUE,          -- NULL until the user first signs in (allows pre-seeding by email)
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE auth_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  start_date TEXT NOT NULL,        -- ISO yyyy-mm-dd
  days REAL NOT NULL DEFAULT 1,
  club TEXT,
  run_group TEXT,
  car TEXT,
  notes TEXT,
  -- Manual best time (ms) for events without recorded laps (e.g. imported history).
  -- When laps exist, the effective best is MIN(manual, best lap).
  best_time_ms INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_events_user_date ON events(user_id, start_date DESC);
CREATE INDEX idx_events_track ON events(track_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT,                      -- e.g. "Day 1 - Session 2" or a lap-timer file id
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_event ON sessions(event_id);

CREATE TABLE laps (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  lap_num INTEGER NOT NULL,
  time_ms INTEGER NOT NULL
);
CREATE INDEX idx_laps_session ON laps(session_id);
