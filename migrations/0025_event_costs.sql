-- What a track day cost (#147). Four optional line items on an event, each
-- stored as integer cents (the same idiom as parts.cost_cents) and formatted
-- client-side, single currency per user:
--   cost_entry_cents   the entry fee / registration
--   cost_fuel_cents    fuel, on track and getting there
--   cost_travel_cents  travel and lodging
--   cost_misc_cents    everything else — insurance, tow, a broken mirror
-- NULL means "not entered", never zero: an event with all four NULL carries no
-- cost at all (`cost_cents` in the API is null for it) and drops out of every
-- roll-up rather than dragging a per-event average down. Validated to
-- 0–$100,000 each (`isValidCostCents` in src/lib/costs.ts).
--
-- Costs are private: GET /api/share/:slug strips them like notes.
ALTER TABLE events ADD COLUMN cost_entry_cents INTEGER;
ALTER TABLE events ADD COLUMN cost_fuel_cents INTEGER;
ALTER TABLE events ADD COLUMN cost_travel_cents INTEGER;
ALTER TABLE events ADD COLUMN cost_misc_cents INTEGER;
