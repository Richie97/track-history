-- Subscriptions (NS-32, Track Evolution Pro). The server owns the entitlement:
-- one row per store purchase (or legacy grant), and users.entitled_until as
-- the denormalised answer, recomputed from the user's rows on every write to
-- this table (src/lib/billing/store.ts). NULL is free; a far-future sentinel
-- is a legacy (paid-app) grant; otherwise the latest entitling expiry plus
-- three days of slack for webhook lag.
--
-- external_id is Apple's originalTransactionId or Google's purchaseToken,
-- unique per provider: the same purchase posted from a second device updates
-- the row, and a token already bound to a different user is refused (409),
-- never transferred. `raw` keeps the last verified store payload for support.
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'legacy')),
  product_id TEXT,
  external_id TEXT NOT NULL,
  -- active | grace | billing_retry | expired | revoked | paused | pending | legacy
  status TEXT NOT NULL,
  expires_at INTEGER,
  auto_renew INTEGER,
  environment TEXT,
  -- The signing instant of the store payload this row was last written from.
  -- Apple retries a failed notification for days carrying its *original*
  -- payload, so an older one must never overwrite newer state; every Apple
  -- write is guarded on this (src/lib/billing/store.ts). Google writes come
  -- from a live API read and simply carry the write's own clock.
  signed_date INTEGER,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider, external_id)
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_expires ON subscriptions(provider, expires_at);

ALTER TABLE users ADD COLUMN entitled_until INTEGER;

-- entitled_until is derived, so it is maintained by triggers rather than by
-- route code — the same rule every other derived column in this schema follows
-- (updated_at, migrations 0011/0012). A direct write to `subscriptions` from a
-- support script or a backfill then cannot leave a user's tier stale, which is
-- exactly the drift a recompute-at-each-call-site would allow.
--
-- The rule: legacy is a far-future sentinel; an active or grace row entitles
-- until its expiry plus three days of slack for webhook lag; anything else
-- contributes nothing, and MAX over no contribution is NULL — free. This
-- mirrors entitledUntilContribution in src/lib/entitlement.ts; keep the two in
-- step.
CREATE TRIGGER subscriptions_entitled_ai AFTER INSERT ON subscriptions BEGIN
  UPDATE users SET entitled_until = (
    SELECT MAX(CASE
      WHEN status = 'legacy' THEN 4102444800000
      WHEN status IN ('active', 'grace') THEN expires_at + 259200000
      ELSE NULL END)
    FROM subscriptions WHERE user_id = NEW.user_id
  ) WHERE id = NEW.user_id;
END;

CREATE TRIGGER subscriptions_entitled_au AFTER UPDATE ON subscriptions BEGIN
  UPDATE users SET entitled_until = (
    SELECT MAX(CASE
      WHEN status = 'legacy' THEN 4102444800000
      WHEN status IN ('active', 'grace') THEN expires_at + 259200000
      ELSE NULL END)
    FROM subscriptions WHERE user_id = NEW.user_id
  ) WHERE id = NEW.user_id;
END;

CREATE TRIGGER subscriptions_entitled_ad AFTER DELETE ON subscriptions BEGIN
  UPDATE users SET entitled_until = (
    SELECT MAX(CASE
      WHEN status = 'legacy' THEN 4102444800000
      WHEN status IN ('active', 'grace') THEN expires_at + 259200000
      ELSE NULL END)
    FROM subscriptions WHERE user_id = OLD.user_id
  ) WHERE id = OLD.user_id;
END;
