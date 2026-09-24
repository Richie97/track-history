-- OAuth 2.1 for MCP clients (#316): the Worker is the authorization server
-- that Claude, ChatGPT and other MCP clients sign in through to reach /mcp.
--
-- Deliberately separate from auth_sessions. An MCP token is audience-bound to
-- /mcp and read-only; if it were an auth_sessions row, requireSession would
-- accept it on every /api route, writes included, and a token handed to a
-- third-party AI tool would be a full session. Keeping the tables apart makes
-- that impossible by construction rather than by a column every lookup has to
-- remember to check.
--
-- Every secret here (codes, access and refresh tokens) is stored as its
-- SHA-256 hash, like auth_sessions and auth_codes (migration 0014).

-- A registered client: dynamic client registration (RFC 7591) mints a random
-- id; a client-ID metadata document client uses its document's https URL as
-- its id and is refreshed from that document on every authorization.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT,
  redirect_uris TEXT NOT NULL,          -- JSON array of strings
  metadata_document INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One per (user, client) the user approved — what Settings lists as a
-- connected app, and what Disconnect deletes (its codes and tokens cascade).
CREATE TABLE oauth_grants (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE(user_id, client_id)
);

CREATE TABLE oauth_codes (
  code TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,         -- PKCE S256
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_codes_expiry ON oauth_codes(expires_at);

CREATE TABLE oauth_tokens (
  token TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX idx_oauth_tokens_expiry ON oauth_tokens(expires_at);
