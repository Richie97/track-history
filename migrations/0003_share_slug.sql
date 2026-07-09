-- Public share link path: {domain}/share/<share_slug>. NULL = sharing disabled.
-- Stored lowercase; one link per user, globally unique.
ALTER TABLE users ADD COLUMN share_slug TEXT;
CREATE UNIQUE INDEX idx_users_share_slug ON users(share_slug);
