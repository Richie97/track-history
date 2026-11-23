-- Share one lap, or two laps compared (NS-56): two more kinds of item_shares
-- row beside the event and the session (0033).
--
--   event     session_id NULL
--   session   session_id set,  lap_id NULL
--   lap       lap_id set,      lap_b_id NULL   (session_id = the lap's session)
--   compare   lap_id and lap_b_id set          (event_id / session_id are lap A's;
--                                               lap B may be in another event at
--                                               the same track)
--
-- Deleting either lap — or its session, event or account — cascades the row
-- away, so a link to something deleted is a 404.

ALTER TABLE item_shares ADD COLUMN lap_id INTEGER REFERENCES laps(id) ON DELETE CASCADE;
ALTER TABLE item_shares ADD COLUMN lap_b_id INTEGER REFERENCES laps(id) ON DELETE CASCADE;

-- One link per item still, now told apart by kind: a lap's row carries its
-- session's id and must not be taken for that session's own link.
DROP INDEX item_shares_event;
DROP INDEX item_shares_session;
CREATE UNIQUE INDEX item_shares_event ON item_shares(event_id) WHERE session_id IS NULL;
CREATE UNIQUE INDEX item_shares_session ON item_shares(session_id) WHERE session_id IS NOT NULL AND lap_id IS NULL;
CREATE UNIQUE INDEX item_shares_lap ON item_shares(lap_id) WHERE lap_id IS NOT NULL AND lap_b_id IS NULL;
-- Ordered: A against B and B against A are two links, since the sides keep
-- their colours.
CREATE UNIQUE INDEX item_shares_compare ON item_shares(lap_id, lap_b_id) WHERE lap_b_id IS NOT NULL;
CREATE INDEX item_shares_lap_b ON item_shares(lap_b_id) WHERE lap_b_id IS NOT NULL;
