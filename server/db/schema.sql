-- Database schema: every table, column and rule ResolveIT uses.
--
-- Run with: psql -U postgres -d resolveit -f server/db/schema.sql
-- Safe to run any number of times (IF NOT EXISTS / IF EXISTS everywhere); the tests and CI run
-- it before every test run. Changes are added at the bottom, in order, and never edited later,
-- so an existing database and a brand-new one end up the same.

-- --- Base tables ---

-- Everyone who can log in.
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- auto-numbered: 1, 2, 3...
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,                               -- no two accounts with the same email
    password_hash TEXT NOT NULL,                                      -- bcrypt hash, never the real password
    role          TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'technician', 'admin')),    -- replaced below (owner role)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Help desk tickets.
CREATE TABLE IF NOT EXISTS tickets (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'in_progress', 'resolved')),
    priority    TEXT NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    category    TEXT,                                                 -- replaced below by category_id (categories)

    -- Foreign keys point to a row in users instead of copying the person's details.
    created_by  INTEGER NOT NULL REFERENCES users(id),                -- who opened it
    assigned_to INTEGER REFERENCES users(id),                         -- which staff member (empty = unassigned)

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes on the columns the app filters by most, so those lookups stay fast.
CREATE INDEX IF NOT EXISTS idx_tickets_status      ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by  ON tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);

-- --- Sign in with Google ---
-- ALTER, not CREATE, because the users table already exists.

-- Google's permanent id for the account (its "sub" field); one Google account per user.
-- Why: users are matched on this, not on email, because an email can change but this id can't.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;

-- Google users have no ResolveIT password, so the hash is optional...
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- ...but every account still needs at least one way to log in.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_has_login_method;
ALTER TABLE users ADD CONSTRAINT users_has_login_method
    CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL);

-- --- Refresh tokens (staying logged in) ---
-- One row per logged-in browser. The browser holds the raw token in an httpOnly cookie.
-- Security: only its SHA-256 hash is stored, so a database leak can't be used to log in.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- deleting a user deletes their sessions
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,              -- set when used (rotated) or logged out; kept to detect reuse
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- When the user originally logged in. Copied to each new token on rotation, to enforce the
-- 90-day maximum: after that they must log in again, however often they use the app.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- --- Resolution time ---
-- When a ticket was resolved (empty while open or in progress; cleared if reopened).
-- Used for the dashboard's average time to resolve.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- --- Categories ---
-- A list admins manage, instead of free text, which let "Network", "network" and "Wifi"
-- become three different categories. Tickets point to one row in this table.
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL,
    active     BOOLEAN NOT NULL DEFAULT TRUE,   -- false = archived: hidden for new tickets, kept on old ones
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No duplicate names, ignoring capital letters: "Network" and "network" can't both exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_lower ON categories (LOWER(name));

-- Starter list, added only when the table is empty.
-- Why: a re-run must never bring back a category an admin renamed.
INSERT INTO categories (name)
SELECT starter.name
  FROM (VALUES ('Network'), ('Hardware'), ('Software'), ('Printer'),
               ('Email'), ('Account & Access'), ('Other')) AS starter(name)
 WHERE NOT EXISTS (SELECT 1 FROM categories);

-- Tickets point to a category by id (empty = no category yet).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);
CREATE INDEX IF NOT EXISTS idx_tickets_category_id ON tickets(category_id);

-- One-time move from the old free-text column, then remove it. The DO block only runs these
-- steps while the old column still exists, so it's safe to re-run.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'tickets' AND column_name = 'category') THEN
        -- Turn each distinct old value into a category, skipping ones that already exist.
        INSERT INTO categories (name)
        SELECT DISTINCT TRIM(category) FROM tickets
         WHERE category IS NOT NULL AND TRIM(category) <> ''
        ON CONFLICT DO NOTHING;

        -- Point each ticket at its matching category.
        UPDATE tickets t SET category_id = c.id
          FROM categories c
         WHERE LOWER(c.name) = LOWER(TRIM(t.category));

        ALTER TABLE tickets DROP COLUMN category;
    END IF;
END $$;

-- --- Ticket comments ---
-- The conversation on a ticket. is_internal marks a staff-only note the user never sees.
CREATE TABLE IF NOT EXISTS ticket_comments (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, -- deleting a ticket deletes its comments
    author_id   INTEGER NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_id ON ticket_comments(ticket_id);

-- --- Owner role ---
-- Owners rank above admins and are created only on the server (npm run make-owner).
-- Note: the original CHECK was written inside CREATE TABLE, so PostgreSQL named it
-- users_role_check. Drop it and add the four-role version.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('user', 'technician', 'admin', 'owner'));

-- --- Disabled accounts ---
-- Accounts are disabled, not deleted, so their tickets and comments stay.
-- Empty = active; a time = disabled since then (can't log in, sessions revoked).
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- --- Ticket history ---
-- One row per change to a ticket: who changed which field, from what, to what.
-- Why: values are stored as the text shown at the time (e.g. the assignee's name, not their
-- id), so the history still reads correctly if a name changes later.
CREATE TABLE IF NOT EXISTS ticket_events (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor_id   INTEGER NOT NULL REFERENCES users(id),            -- who did it
    action     TEXT NOT NULL CHECK (action IN ('created', 'changed')),
    field      TEXT CHECK (field IN ('title', 'description', 'status', 'priority', 'category', 'assignee')),
    old_value  TEXT,                                             -- empty for 'created', or when it was blank
    new_value  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 'created' rows have no field; 'changed' rows must name the field that changed.
    CONSTRAINT ticket_events_field_matches_action
        CHECK ((action = 'created' AND field IS NULL) OR (action = 'changed' AND field IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON ticket_events(ticket_id);

-- --- Account history ---
-- Role changes, disables and enables. actor_id is empty when a server command
-- (make-admin, make-owner) made the change.
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

-- --- Editable comments ---
-- edited_at: when the comment was last edited (empty = never).
-- comment_edits: one row per edit, holding the text as it was before that edit. Only the
-- author can edit, so the editor is always the comment's author.
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS comment_edits (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    comment_id INTEGER NOT NULL REFERENCES ticket_comments(id) ON DELETE CASCADE,
    old_body   TEXT NOT NULL,
    edited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comment_edits_comment_id ON comment_edits(comment_id);

-- --- AI self-service help ---
-- One row per request to the AI helper, whatever happened: steps shown, sent to a technician,
-- or the AI failed. Why: the daily limits count these rows, and the dashboard's self-solved
-- rate is fixed / all finished sessions.
--
-- outcome:
--   pending      steps shown, waiting for "That fixed it" / "Still broken"
--   fixed        the user fixed it themselves; no ticket
--   still_broken the steps didn't work; ticket_id is the ticket it opened
--   escalated    a technician was needed from the start; ticket_id is the ticket it opened
--   failed       the AI was down, out of budget or refused; the user can still open a ticket
-- Note: a session left at pending (the user walked away) counts as abandoned; no job changes it.
CREATE TABLE IF NOT EXISTS help_sessions (
    id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id               INTEGER NOT NULL REFERENCES users(id),        -- who asked

    -- What the user typed. Security: only these three are sent to the AI, never names or emails.
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL,
    category_id           INTEGER REFERENCES categories(id),            -- the user's choice (empty = not sure)

    -- What the AI answered.
    steps                 JSONB NOT NULL DEFAULT '[]',                  -- [{ "title": ..., "detail": ... }]
    escalate_reason       TEXT,                                         -- why a technician is needed
    suggested_category_id INTEGER REFERENCES categories(id),
    suggested_priority    TEXT CHECK (suggested_priority IN ('low', 'medium', 'high', 'urgent')),

    outcome               TEXT NOT NULL DEFAULT 'pending'
                          CHECK (outcome IN ('pending', 'fixed', 'still_broken', 'escalated', 'failed')),
    ticket_id             INTEGER REFERENCES tickets(id),               -- the ticket it became, if any

    -- Cost tracking: which model answered and how many tokens it used (empty when it failed early).
    model                 TEXT,
    input_tokens          INTEGER CHECK (input_tokens >= 0),
    output_tokens         INTEGER CHECK (output_tokens >= 0),

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at           TIMESTAMPTZ,                                  -- when the outcome was decided

    CONSTRAINT help_sessions_steps_is_list CHECK (jsonb_typeof(steps) = 'array'),
    -- A ticket exists exactly when the session ended in one.
    CONSTRAINT help_sessions_ticket_matches_outcome
        CHECK ((outcome IN ('still_broken', 'escalated')) = (ticket_id IS NOT NULL)),
    -- An escalation always says why, so the technician knows.
    CONSTRAINT help_sessions_escalation_has_reason
        CHECK (outcome <> 'escalated' OR escalate_reason IS NOT NULL),
    -- Only pending sessions are unfinished.
    CONSTRAINT help_sessions_finished_matches_outcome
        CHECK ((outcome = 'pending') = (finished_at IS NULL))
);

-- The per-person daily limit counts one user's rows since midnight; the site limit counts all rows.
CREATE INDEX IF NOT EXISTS idx_help_sessions_user_created ON help_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_help_sessions_created_at   ON help_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_help_sessions_ticket_id    ON help_sessions(ticket_id);

-- The AI steps a user tried before the ticket was opened, shown to staff on the ticket.
-- Empty for tickets opened without the AI helper.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS steps_tried JSONB NOT NULL DEFAULT '[]';
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_steps_tried_is_list;
ALTER TABLE tickets ADD CONSTRAINT tickets_steps_tried_is_list CHECK (jsonb_typeof(steps_tried) = 'array');

-- --- Ask IT questions and blocked steps ---
-- kind: 'fix' is Get help (steps to try); 'question' is Ask IT (one question, one answer).
-- Both share the table, so they share the daily limits and the staff AI help screen.
-- A question's text is stored in title and its answer in answer. Questions use the same
-- outcomes as Get help, so staff can filter both the same way:
--   pending      answered, waiting for "Did this answer your question?" (or the AI is still answering)
--   fixed        "Yes, that helped"
--   still_broken "No" (no ticket: the user can go on to Get help, which is a separate request)
--   escalated    needs a technician (no ticket: the user is sent to Get help)
--   failed       the AI couldn't answer
ALTER TABLE help_sessions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'fix';
ALTER TABLE help_sessions DROP CONSTRAINT IF EXISTS help_sessions_kind_check;
ALTER TABLE help_sessions ADD CONSTRAINT help_sessions_kind_check CHECK (kind IN ('fix', 'question'));
ALTER TABLE help_sessions ADD COLUMN IF NOT EXISTS answer TEXT;

-- Note: an earlier version gave questions their own outcome, 'answered'. Any such rows are
-- moved to the shared outcomes before the rules below are put back.
ALTER TABLE help_sessions DROP CONSTRAINT IF EXISTS help_sessions_outcome_check;
ALTER TABLE help_sessions DROP CONSTRAINT IF EXISTS help_sessions_outcome_matches_kind;
ALTER TABLE help_sessions DROP CONSTRAINT IF EXISTS help_sessions_ticket_matches_outcome;
ALTER TABLE help_sessions DROP CONSTRAINT IF EXISTS help_sessions_finished_matches_outcome;
UPDATE help_sessions
   SET outcome = CASE WHEN escalate_reason IS NOT NULL THEN 'escalated' ELSE 'pending' END,
       finished_at = CASE WHEN escalate_reason IS NOT NULL THEN finished_at END
 WHERE outcome = 'answered';
ALTER TABLE help_sessions ADD CONSTRAINT help_sessions_outcome_check
    CHECK (outcome IN ('pending', 'fixed', 'still_broken', 'escalated', 'failed'));
ALTER TABLE help_sessions ADD CONSTRAINT help_sessions_finished_matches_outcome
    CHECK ((outcome = 'pending') = (finished_at IS NULL));
-- Get help: a ticket exists exactly when it ended in one. Ask IT never opens a ticket itself.
ALTER TABLE help_sessions ADD CONSTRAINT help_sessions_ticket_matches_outcome
    CHECK (CASE WHEN kind = 'question' THEN ticket_id IS NULL
                ELSE (outcome IN ('still_broken', 'escalated')) = (ticket_id IS NOT NULL) END);

-- The steps (or answer) the AI wrote when the server's safety check overruled it. Staff only.
-- Why: so false alarms can be spotted and fixed; users never see these.
ALTER TABLE help_sessions ADD COLUMN IF NOT EXISTS blocked_steps JSONB NOT NULL DEFAULT '[]';
ALTER TABLE help_sessions DROP CONSTRAINT IF EXISTS help_sessions_blocked_steps_is_list;
ALTER TABLE help_sessions ADD CONSTRAINT help_sessions_blocked_steps_is_list CHECK (jsonb_typeof(blocked_steps) = 'array');

-- --- Attachments ---
-- Screenshots and files on tickets, comments and Get help requests. The file itself lives in
-- storage (services/storage.js); this row says who may see it.
--
-- A file is uploaded first and attached second: a new row has no ticket, comment or request,
-- and only its uploader can see it. Sending a comment, ticket or Get help request then claims it.
-- Unclaimed rows older than a day are removed, with their files.
--   ticket_id        the ticket it belongs to (set for files on the description and on comments)
--   comment_id       the comment it was sent with (empty = sent with the ticket itself)
--   help_session_id  the Get help request it was sent with (the ticket is filled in if one opens)
CREATE TABLE IF NOT EXISTS attachments (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uploaded_by     INTEGER NOT NULL REFERENCES users(id),
    ticket_id       INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    comment_id      INTEGER REFERENCES ticket_comments(id) ON DELETE CASCADE,
    help_session_id INTEGER REFERENCES help_sessions(id) ON DELETE CASCADE,
    -- Security: shown to people as text only, never used as a file path.
    original_name   TEXT NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 200),
    -- Decided by the server from the file's first bytes, not from what the browser claimed.
    content_type    TEXT NOT NULL
                    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp',
                                            'application/pdf', 'text/plain')),
    size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0),
    storage_key     TEXT NOT NULL UNIQUE,                       -- a random name made by the server
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attached_at     TIMESTAMPTZ,                                -- when it was claimed (empty = not yet)
    -- A file on a comment always knows its ticket, so one "can you see this ticket?" check covers it.
    CONSTRAINT attachments_comment_has_ticket CHECK (comment_id IS NULL OR ticket_id IS NOT NULL),
    CONSTRAINT attachments_attached_matches
        CHECK ((attached_at IS NULL) = (ticket_id IS NULL AND help_session_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_attachments_ticket_id       ON attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_attachments_help_session_id ON attachments(help_session_id);
-- The daily upload limit counts one person's uploads over the last 24 hours.
CREATE INDEX IF NOT EXISTS idx_attachments_uploader_created ON attachments(uploaded_by, created_at);
