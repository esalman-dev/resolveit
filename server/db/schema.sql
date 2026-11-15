-- ResolveIT database schema (Phase 1: users and tickets)
-- Run with: psql -U postgres -d resolveit -f server/db/schema.sql
-- Safe to run more than once: IF NOT EXISTS skips tables that already exist.

-- Everyone who can log in: regular users, technicians, and admins
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- auto-numbered: 1, 2, 3...
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,                               -- no two accounts with the same email
    password_hash TEXT NOT NULL,                                      -- scrambled password, never the real one
    role          TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'technician', 'admin')),    -- only these three values allowed
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Help desk requests
CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'in_progress', 'resolved')),
    priority    TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    category    TEXT,                                                 -- e.g. 'Network', 'Printer' (optional)

    -- Foreign keys: point to a row in users instead of copying the person's info
    created_by  INTEGER NOT NULL REFERENCES users(id),                -- who submitted it (required)
    assigned_to INTEGER REFERENCES users(id),                         -- which technician (empty = unassigned)

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes make common searches fast (like an index in the back of a book)
CREATE INDEX IF NOT EXISTS idx_tickets_status      ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by  ON tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);

-- ---------------------------------------------------------------------------
-- 2026-11-15: "Sign in with Google"
-- ALTER (not CREATE) because the users table already exists. Safe to re-run.
-- ---------------------------------------------------------------------------

-- Google's permanent ID for the account (their "sub" field). UNIQUE: one Google account = one user.
-- We match on this, not on email, because a person can change their Gmail address but never this ID.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;

-- Google users have no ResolveIT password, so the hash is now optional
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ...but every account still needs at least ONE way to log in
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_has_login_method;
ALTER TABLE users ADD CONSTRAINT users_has_login_method
    CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2026-11-15: Refresh tokens ("stay logged in" for 30 days)
-- One row per logged-in browser. The browser holds the raw token in an httpOnly cookie;
-- we store only its SHA-256 hash, so a database leak can't be used to log in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- delete user = delete their sessions
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,              -- set when used (rotated) or logged out; kept to detect reuse
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
