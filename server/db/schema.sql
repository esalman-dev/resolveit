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
                  CHECK (role IN ('user', 'technician', 'admin')),    -- REPLACED: 'owner' added below
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
    category    TEXT,                                                 -- REPLACED by category_id (see 'Categories' below)

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

-- When the user originally logged in. Copied from token to token on every rotation, so we can
-- enforce a hard 90-day maximum: after that, they must log in again even if they use the app daily.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 2026-11-15: Tickets API
-- When a ticket was marked resolved (empty while open / in progress). Cleared if it's reopened.
-- Needed later for the Phase 3 dashboard's "average time to resolve".
-- ---------------------------------------------------------------------------
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2026-11-15: Categories (a list admins manage, instead of free text)
-- Free text let "Network", "network" and "Wifi" become three different categories.
-- Now tickets point to one row in this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL,
    active     BOOLEAN NOT NULL DEFAULT TRUE,   -- FALSE = archived: hidden for new tickets, kept on old ones
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No duplicates, ignoring capital letters: "Network" and "network" can't both exist
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_lower ON categories (LOWER(name));

-- Starter list, added only when the table is empty (so a re-run never brings back
-- a category an admin renamed)
INSERT INTO categories (name)
SELECT starter.name
  FROM (VALUES ('Network'), ('Hardware'), ('Software'), ('Printer'),
               ('Email'), ('Account & Access'), ('Other')) AS starter(name)
 WHERE NOT EXISTS (SELECT 1 FROM categories);

-- Tickets now point to a category by id (empty = no category yet)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);
CREATE INDEX IF NOT EXISTS idx_tickets_category_id ON tickets(category_id);

-- One-time move from the old free-text column, then remove it.
-- The DO block only runs the steps if the old column still exists, so this is safe to re-run.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'tickets' AND column_name = 'category') THEN
        -- Turn each distinct old text value into a category (skipping ones that already exist)
        INSERT INTO categories (name)
        SELECT DISTINCT TRIM(category) FROM tickets
         WHERE category IS NOT NULL AND TRIM(category) <> ''
        ON CONFLICT DO NOTHING;

        -- Point each ticket at the matching category
        UPDATE tickets t SET category_id = c.id
          FROM categories c
         WHERE LOWER(c.name) = LOWER(TRIM(t.category));

        ALTER TABLE tickets DROP COLUMN category;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2026-11-15: Ticket comments
-- The conversation on a ticket. is_internal = a staff-only note the user never sees.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_comments (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, -- delete ticket = delete its comments
    author_id   INTEGER NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_id ON ticket_comments(ticket_id);

-- ---------------------------------------------------------------------------
-- 2026-11-15: Owner role (ranked above admin)
-- Owners manage admins; they're created only on the server (npm run make-owner).
-- The original CHECK was written inside CREATE TABLE, so PostgreSQL named it
-- users_role_check. Drop it and add the four-role version. Safe to re-run.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('user', 'technician', 'admin', 'owner'));

-- ---------------------------------------------------------------------------
-- 2026-11-15: Disabled accounts
-- Accounts are disabled, not deleted, so their tickets and comments stay.
-- Empty = active. A time = disabled since then (can't log in; sessions revoked).
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2026-11-15: Ticket history ("who changed what, and when"), shown on the ticket itself
-- One row per change. Values are saved as the TEXT that was shown at the time
-- (e.g. the assignee's name), so history still reads correctly if a name changes later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_events (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor_id   INTEGER NOT NULL REFERENCES users(id),            -- who did it
    action     TEXT NOT NULL CHECK (action IN ('created', 'changed')),
    field      TEXT CHECK (field IN ('title', 'description', 'status', 'priority', 'category', 'assignee')),
    old_value  TEXT,                                             -- empty for 'created', or when it was blank
    new_value  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 'created' rows have no field; 'changed' rows must say which field changed
    CONSTRAINT ticket_events_field_matches_action
        CHECK ((action = 'created' AND field IS NULL) OR (action = 'changed' AND field IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON ticket_events(ticket_id);

-- ---------------------------------------------------------------------------
-- 2026-11-15: Account history (role changes, disable, enable)
-- actor_id is empty when the change came from a server command (make-admin / make-owner).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_events (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),            -- whose account
    actor_id   INTEGER REFERENCES users(id),                     -- who did it (empty = server command)
    action     TEXT NOT NULL CHECK (action IN ('role_changed', 'disabled', 'enabled')),
    old_value  TEXT,                                             -- e.g. 'technician'
    new_value  TEXT,                                             -- e.g. 'admin'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_events_user_id ON account_events(user_id);
CREATE INDEX IF NOT EXISTS idx_account_events_created_at ON account_events(created_at);

-- ---------------------------------------------------------------------------
-- 2026-11-15: Editable comments, with every earlier version kept
-- edited_at = when the comment was last edited (empty = never).
-- comment_edits = one row per edit, holding the text as it was BEFORE that edit.
-- Only the author can edit, so the editor is always the comment's author.
-- ---------------------------------------------------------------------------
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS comment_edits (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    comment_id INTEGER NOT NULL REFERENCES ticket_comments(id) ON DELETE CASCADE,
    old_body   TEXT NOT NULL,
    edited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comment_edits_comment_id ON comment_edits(comment_id);
