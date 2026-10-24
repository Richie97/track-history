-- Stripe: Track Evolution Pro bought on the web (NS-49). Stripe is a fourth
-- `provider` on the subscriptions table 0017 created, and the table was shaped
-- for it — except for one thing: `provider` carries a CHECK, and SQLite cannot
-- alter a constraint. So the table is rebuilt: a new table with 'stripe' in
-- the set, every row copied across with its id, the old table dropped and the
-- new one renamed into its place.
--
-- Triggers die with the table they are on, so both indexes and all three
-- subscriptions_entitled_* triggers are re-created below, verbatim from 0017.
-- That is the part of this migration that fails silently if forgotten — a
-- table with no triggers still accepts every write and simply stops updating
-- users.entitled_until — which is why test/api/billing-stripe.test.ts asserts
-- the triggers exist and still recompute.
--
-- The CHECK is kept rather than dropped because it is what turns a typo in a
-- support script into an error instead of a row that entitles nobody.
--
-- DROP TABLE's implicit delete fires no triggers, so dropping the old table
-- leaves every user's entitled_until exactly as it was; the copy into the new
-- table runs before it has triggers, for the same reason.
CREATE TABLE subscriptions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'legacy', 'stripe')),
  product_id TEXT,
  -- Apple's originalTransactionId, Google's purchaseToken, or Stripe's
  -- subscription id (sub_…).
  external_id TEXT NOT NULL,
  -- active | grace | billing_retry | expired | revoked | paused | pending | legacy
  status TEXT NOT NULL,
  expires_at INTEGER,
  auto_renew INTEGER,
  environment TEXT,
  -- See 0017. Null for Google and Stripe, whose every write comes from a live
  -- API read and so has no stale-payload case.
  signed_date INTEGER,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider, external_id)
);

INSERT INTO subscriptions_new (id, user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, signed_date, raw, created_at, updated_at)
  SELECT id, user_id, provider, product_id, external_id, status, expires_at, auto_renew, environment, signed_date, raw, created_at, updated_at
  FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_new RENAME TO subscriptions;

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_expires ON subscriptions(provider, expires_at);

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

-- One Stripe Customer per account, created lazily by the first checkout with
-- metadata.user_id set to our id (src/routes/billing.ts). Unique, so two
-- accounts can never share a customer; NULL until then.
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
CREATE UNIQUE INDEX idx_users_stripe_customer ON users(stripe_customer_id);
