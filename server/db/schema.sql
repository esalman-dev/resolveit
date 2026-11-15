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
