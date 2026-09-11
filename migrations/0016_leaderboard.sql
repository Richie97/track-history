-- Per-track community leaderboards, strictly opt-in. 0 (the default) means
-- nothing about the user ever appears on a leaderboard. Opting in publishes
-- exactly two things to other signed-in users, per catalog track: the user's
-- display name and their best lap (with the event date it was set). Tracks
-- are matched across users via tracks.catalog_id — user-entered track rows
-- stay private, the canonical catalog identity is what's shared.
ALTER TABLE users ADD COLUMN leaderboard_opt_in INTEGER NOT NULL DEFAULT 0;
