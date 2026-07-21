-- Sign in with Apple: users get an apple_sub alongside google_sub. Either (or
-- both) may be set — an account is linked to a second provider by email match
-- on first sign-in (same claim rule google_sub has always used).
ALTER TABLE users ADD COLUMN apple_sub TEXT;
CREATE UNIQUE INDEX idx_users_apple_sub ON users(apple_sub);
