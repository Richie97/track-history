-- Per-user garage. Vehicles feed the event form's free-text car field
-- (events.car stays a plain string); at most one per user is the default
-- that pre-fills new events.
CREATE TABLE vehicles (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  notes TEXT,                      -- modifications, setup, tire notes
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(user_id, name)
);
CREATE INDEX idx_vehicles_user ON vehicles(user_id);
