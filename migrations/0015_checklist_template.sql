-- Per-user prep checklist template: the list "Use default list" starts a new
-- event's checklist from.
--
-- JSON array of strings (the items' text only — a template has no done flags),
-- or NULL when the user hasn't customised it and the app's built-in default
-- applies. Deliberately not a table: it is one ordered list per user, edited as
-- a whole, and rows would buy nothing but joins.
ALTER TABLE users ADD COLUMN checklist_template TEXT;
