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
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider, external_id)
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_expires ON subscriptions(provider, expires_at);

ALTER TABLE users ADD COLUMN entitled_until INTEGER;
