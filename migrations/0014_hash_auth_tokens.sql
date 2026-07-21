-- Session tokens and native-app one-time auth codes are now stored as
-- SHA-256 hashes (src/lib/session.ts sha256Hex), so a leaked database copy
-- no longer contains usable credentials. Existing rows hold plaintext
-- values that can never match a hashed lookup — drop them instead of
-- letting dead rows linger until expiry. Everyone simply signs in again.

DELETE FROM auth_sessions;
DELETE FROM auth_codes;
