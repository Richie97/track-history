-- One-time login codes for the native-app OAuth flow: after the Google
-- callback the server mints a short-lived code and redirects to the app's
-- custom scheme; the app exchanges it (with its PKCE verifier) for a bearer
-- session token at POST /auth/exchange. Codes are single-use.

CREATE TABLE auth_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,    -- base64url(SHA-256(verifier)), PKCE S256
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_codes_expiry ON auth_codes(expires_at);
