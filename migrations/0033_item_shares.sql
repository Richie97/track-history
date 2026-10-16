-- Share one event or one session (NS-48): a link anyone can open, without
-- signing in, that shows that day or that session alone — its laps, racing
-- line, telemetry and best-lap video — and nothing else of the logbook.
--
-- One row per shared item. `session_id` NULL is the whole event; otherwise
-- the row shares that session (with its event's header). The token is the
-- whole of the permission and deleting the row the whole of revoking it.
--
-- Unlike a coach invite the token is stored in the clear, as `share_slug` is:
-- it is a link the owner copies again whenever they open Share, not a
-- credential to anything they can change, and a hashed one could be shown
-- only once. 128 random bits, so it is not guessable.
--
-- Deleting the event, the session or the account cascades the row away, so a
-- link to something deleted is a 404 rather than a dangling share.

CREATE TABLE item_shares (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
-- One link per item: Share answers the existing link rather than minting a
-- second, so "Stop sharing" really stops it. (A plain UNIQUE would not do
-- this for events, since SQLite treats every NULL session_id as distinct.)
CREATE UNIQUE INDEX item_shares_event ON item_shares(event_id) WHERE session_id IS NULL;
CREATE UNIQUE INDEX item_shares_session ON item_shares(session_id) WHERE session_id IS NOT NULL;
