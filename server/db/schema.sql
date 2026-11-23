-- Database schema: every table, column and rule ResolveIT uses.
--
-- Run with: psql -U postgres -d resolveit -f server/db/schema.sql
-- Safe to run again (IF NOT EXISTS everywhere), but it only creates what's missing: it never
-- changes a table that already exists. To change a table, edit its CREATE TABLE here and rebuild
-- the database (see "Changing the schema" in the README). The tests rebuild theirs every run.
--
-- Tables are in an order where everything a table points to is created before it.

-- ============================================================================================
-- People and logins
-- ============================================================================================

-- Everyone who can log in.
--   role: ranked user < technician < admin < owner; owners are created only on the server
--         (npm run make-owner)
--   google_id: Google's permanent id for the account (its "sub" field). Users are matched on
--         this, not on email, because an email can change but this id can't.
--   disabled_at: accounts are disabled, not deleted, so their tickets and comments stay.
--         Empty = active; a time = disabled since then (can't log in, sessions revoked).
--   Online status: last_seen_at is the last check-in from an open app (once a minute while the
--         tab is visible); last_active_at the last check-in with mouse or keyboard use since the
--         one before; availability the staff member's own choice. What others see is worked out
--         from all three (routes/presence.js): not seen for 2 minutes = offline; idle for 15 = away.
--   last_assigned_at: when they were last given a ticket. Auto-assign breaks ties with it:
--         whoever waited longest goes next, so the work takes turns.
CREATE TABLE IF NOT EXISTS users (
    id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- auto-numbered: 1, 2, 3...
    name             TEXT NOT NULL,
    job_title        TEXT CHECK (char_length(job_title) <= 80),            -- optional, shown next to the name
    department       TEXT CHECK (char_length(department) <= 80),           -- optional
    email            TEXT NOT NULL UNIQUE,                               -- no two accounts with the same email
    password_hash    TEXT,                                               -- bcrypt hash, never the real password; empty for Google-only accounts
    google_id        TEXT UNIQUE,
    role             TEXT NOT NULL DEFAULT 'user'
                     CHECK (role IN ('user', 'technician', 'admin', 'owner')),
    disabled_at      TIMESTAMPTZ,
    last_seen_at     TIMESTAMPTZ,
    last_active_at   TIMESTAMPTZ,
    availability     TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'busy', 'away')),
    last_assigned_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Every account needs at least one way to log in.
    CONSTRAINT users_has_login_method CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL)
);

-- Staying logged in: one row per logged-in browser. The browser holds the raw token in an
-- httpOnly cookie.
-- Security: only its SHA-256 hash is stored, so a database leak can't be used to log in.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- deleting a user deletes their sessions
    token_hash         TEXT NOT NULL UNIQUE,
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,              -- set when used (rotated) or logged out; kept to detect reuse
    -- When the user originally logged in. Copied to each new token on rotation, to enforce the
    -- 90-day maximum: after that they must log in again, however often they use the app.
    session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- Account history: role changes, disables and enables. actor_id is empty when a server command
-- (make-admin, make-owner) made the change.
CREATE TABLE IF NOT EXISTS account_events (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),            -- whose account
    actor_id   INTEGER REFERENCES users(id),                     -- who did it (empty = server command)
    action     TEXT NOT NULL CHECK (action IN ('role_changed', 'disabled', 'enabled', 'renamed', 'password_changed')),
    old_value  TEXT,                                             -- e.g. 'technician'
    new_value  TEXT,                                             -- e.g. 'admin'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_events_user_id ON account_events(user_id);
CREATE INDEX IF NOT EXISTS idx_account_events_created_at ON account_events(created_at);

-- ============================================================================================
-- Tickets
-- ============================================================================================

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

-- Outages: several tickets about the same kind of problem at once (3 in one category within 15
-- minutes, services/outages.js) are probably one big problem. The app opens a suspected outage;
-- staff confirm it (with a message everyone sees) or dismiss it; fixing it resolves its tickets.
-- It comes before tickets because each ticket can point to one.
--   status: suspected (the app noticed) → confirmed (staff said yes) → fixed,
--           or suspected → dismissed (staff said no)
--   message: the banner everyone sees, written by the staff member who confirmed it
--   fix_message: what fixed it, posted as a public reply on every linked ticket
CREATE TABLE IF NOT EXISTS outages (
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id  INTEGER NOT NULL REFERENCES categories(id),
    status       TEXT NOT NULL DEFAULT 'suspected' CHECK (status IN ('suspected', 'confirmed', 'fixed', 'dismissed')),
    message      TEXT CHECK (char_length(message) BETWEEN 1 AND 200),
    fix_message  TEXT CHECK (char_length(fix_message) BETWEEN 1 AND 2000),
    detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_at    TIMESTAMPTZ,                                       -- fixed or dismissed
    closed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    -- Everyone sees a confirmed outage's banner, so it must have one; a fixed one says what fixed it.
    CONSTRAINT outages_confirmed_has_message CHECK (status NOT IN ('confirmed', 'fixed') OR message IS NOT NULL),
    CONSTRAINT outages_fixed_has_fix_message CHECK (status <> 'fixed' OR fix_message IS NOT NULL)
);

-- At most one open (suspected or confirmed) outage per category: new tickets join it instead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outages_one_open ON outages(category_id) WHERE status IN ('suspected', 'confirmed');

-- Help desk tickets.
--   kind: a problem (issue) or setting up someone who's joining (new_hire). Outage spotting
--         skips new-hire tickets: three hires on one day isn't an outage.
--   steps_tried: the AI steps a user tried before the ticket was opened, shown to staff on the
--         ticket. Empty for tickets opened without the AI helper.
--   first_response_at: when staff first did something the user could see (a public comment or
--         a status change). Empty = no reply yet. Kept as a column so lists and the dashboard
--         don't search the history.
--   due_at: a set time it must be fixed by, used instead of the priority's fix target (a new
--         hire's start date). Empty = the priority's target, as for every other ticket.
--   resolved_at: when it was resolved (empty while open or in progress; cleared if reopened).
--   outage_id: which outage it belongs to (empty = none). A ticket linked to a dismissed outage
--         keeps the link, so it never counts toward a new one.
CREATE TABLE IF NOT EXISTS tickets (
    id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind              TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'new_hire')),
    title             TEXT NOT NULL,
    description       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'in_progress', 'resolved')),
    priority          TEXT NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    category_id       INTEGER REFERENCES categories(id),             -- empty = no category yet
    steps_tried       JSONB NOT NULL DEFAULT '[]',

    -- Foreign keys point to a row in users instead of copying the person's details.
    created_by        INTEGER NOT NULL REFERENCES users(id),         -- who opened it
    assigned_to       INTEGER REFERENCES users(id),                  -- which staff member (empty = unassigned)

    first_response_at TIMESTAMPTZ,
    due_at            TIMESTAMPTZ,
    resolved_at       TIMESTAMPTZ,
    outage_id         INTEGER REFERENCES outages(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT tickets_steps_tried_is_list CHECK (jsonb_typeof(steps_tried) = 'array')
);

-- Indexes on the columns the app filters by most, so those lookups stay fast.
CREATE INDEX IF NOT EXISTS idx_tickets_status      ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by  ON tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tickets_category_id ON tickets(category_id);
CREATE INDEX IF NOT EXISTS idx_tickets_outage      ON tickets(outage_id) WHERE outage_id IS NOT NULL;

-- Ticket history: one row per change to a ticket: who changed which field, from what, to what.
-- Why: values are stored as the text shown at the time (e.g. the assignee's name, not their
-- id), so the history still reads correctly if a name changes later.
-- An empty actor means "done automatically" (e.g. auto-assign).
CREATE TABLE IF NOT EXISTS ticket_events (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor_id   INTEGER REFERENCES users(id),                     -- who did it (empty = automatic)
    action     TEXT NOT NULL CHECK (action IN ('created', 'changed')),
    field      TEXT CHECK (field IN ('title', 'description', 'status', 'priority', 'category', 'assignee', 'checklist')),
    old_value  TEXT,                                             -- empty for 'created', or when it was blank
    new_value  TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 'created' rows have no field; 'changed' rows must name the field that changed.
    CONSTRAINT ticket_events_field_matches_action
        CHECK ((action = 'created' AND field IS NULL) OR (action = 'changed' AND field IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON ticket_events(ticket_id);

-- The conversation on a ticket. is_internal marks a staff-only note the user never sees.
CREATE TABLE IF NOT EXISTS ticket_comments (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, -- deleting a ticket deletes its comments
    author_id   INTEGER NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE,
    edited_at   TIMESTAMPTZ,                                                -- when last edited (empty = never)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_id ON ticket_comments(ticket_id);

-- One row per comment edit, holding the text as it was before that edit. Only the author can
-- edit, so the editor is always the comment's author.
CREATE TABLE IF NOT EXISTS comment_edits (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    comment_id INTEGER NOT NULL REFERENCES ticket_comments(id) ON DELETE CASCADE,
    old_body   TEXT NOT NULL,
    edited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comment_edits_comment_id ON comment_edits(comment_id);

-- ============================================================================================
-- AI help and the knowledge base
-- ============================================================================================

-- How-to articles, usually drafted by the AI from a resolved ticket and published by staff.
--   status: draft (only staff see it), published (everyone, and Get help searches it), archived
--   steps: [{ "title": ..., "detail": ... }], like the AI's Get help steps
--   flagged: the server's safety check blocked a step in the draft; publishing re-checks anyway
-- search_text is kept up to date by PostgreSQL itself (a generated column), for full-text search:
-- the title counts most (A), then the problem (B), then the steps (C).
CREATE TABLE IF NOT EXISTS kb_articles (
    id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    problem           TEXT NOT NULL CHECK (char_length(problem) <= 2000),
    steps             JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
    -- Other words people use for the same problem (["wifi", "no internet"]); searched with the
    -- title. JSONB, not TEXT[], because the search column below may only use immutable functions.
    also_called       JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(also_called) = 'array'),
    if_still_broken   TEXT NOT NULL DEFAULT '' CHECK (char_length(if_still_broken) <= 1000), -- what to note for IT, when to stop
    category_id       INTEGER REFERENCES categories(id),
    status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    flagged           BOOLEAN NOT NULL DEFAULT FALSE,
    source_ticket_id  INTEGER REFERENCES tickets(id) ON DELETE SET NULL, -- the ticket it was drafted from
    created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- who resolved it (or wrote it)
    published_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    helpful_count     INTEGER NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
    not_helpful_count INTEGER NOT NULL DEFAULT 0 CHECK (not_helpful_count >= 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at      TIMESTAMPTZ,
    search_text       TSVECTOR GENERATED ALWAYS AS (
                        setweight(to_tsvector('english', title), 'A') ||
                        setweight(to_tsvector('english', also_called::text), 'A') ||
                        setweight(to_tsvector('english', problem), 'B') ||
                        setweight(to_tsvector('english', steps::text), 'C')
                      ) STORED
);

CREATE INDEX IF NOT EXISTS idx_kb_articles_search ON kb_articles USING GIN (search_text);
CREATE INDEX IF NOT EXISTS idx_kb_articles_status ON kb_articles(status);
-- One article per ticket at most, so resolving twice doesn't draft twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_articles_source_ticket ON kb_articles(source_ticket_id) WHERE source_ticket_id IS NOT NULL;

-- One row per request to the AI, whatever happened: steps shown, sent to a technician, or the
-- AI failed. Why: the daily limits count these rows, and the dashboard's self-solved rate is
-- fixed / all finished requests.
--   kind: 'fix' is Get help (steps to try); 'question' is Ask IT (one question, one answer; its
--         text is in title and the answer in answer). Both share the table, so they share the
--         daily limits and the staff AI help screen.
--   outcome:
--     pending      steps (or an answer) shown, waiting for the user's reply
--     fixed        the user fixed it themselves ("Yes, that helped" for a question); no ticket
--     still_broken the steps didn't work; ticket_id is the ticket it opened (a question: "No",
--                  and no ticket: the user can go on to Get help, a separate request)
--     escalated    a technician was needed from the start; ticket_id is the ticket it opened (a
--                  question: no ticket, the user is sent to Get help)
--     failed       the AI was down, out of budget or refused; the user can still open a ticket
--   blocked_steps: the steps (or answer) the AI wrote when the server's safety check overruled
--         it. Staff only. Why: so false alarms can be spotted and fixed; users never see these.
--   article_id: a Get help request solved by a knowledge base article (no AI call).
-- Note: a request left at pending (the user walked away) counts as abandoned; no job changes it.
CREATE TABLE IF NOT EXISTS help_sessions (
    id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id               INTEGER NOT NULL REFERENCES users(id),        -- who asked
    kind                  TEXT NOT NULL DEFAULT 'fix' CHECK (kind IN ('fix', 'question')),

    -- What the user typed. Security: only these three are sent to the AI, never names or emails.
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL,
    category_id           INTEGER REFERENCES categories(id),            -- the user's choice (empty = not sure)

    -- What the AI answered.
    steps                 JSONB NOT NULL DEFAULT '[]',                  -- [{ "title": ..., "detail": ... }]
    answer                TEXT,
    escalate_reason       TEXT,                                         -- why a technician is needed
    suggested_category_id INTEGER REFERENCES categories(id),
    suggested_priority    TEXT CHECK (suggested_priority IN ('low', 'medium', 'high', 'urgent')),
    blocked_steps         JSONB NOT NULL DEFAULT '[]',
    article_id            INTEGER REFERENCES kb_articles(id) ON DELETE SET NULL,

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
    CONSTRAINT help_sessions_blocked_steps_is_list CHECK (jsonb_typeof(blocked_steps) = 'array'),
    -- Get help: a ticket exists exactly when it ended in one. Ask IT never opens a ticket itself.
    CONSTRAINT help_sessions_ticket_matches_outcome
        CHECK (CASE WHEN kind = 'question' THEN ticket_id IS NULL
                    ELSE (outcome IN ('still_broken', 'escalated')) = (ticket_id IS NOT NULL) END),
    -- An escalation always says why, so the technician knows.
    CONSTRAINT help_sessions_escalation_has_reason
        CHECK (outcome <> 'escalated' OR escalate_reason IS NOT NULL),
    -- Only pending requests are unfinished.
    CONSTRAINT help_sessions_finished_matches_outcome
        CHECK ((outcome = 'pending') = (finished_at IS NULL))
);

-- The per-person daily limit counts one user's rows since midnight; the site limit counts all rows.
CREATE INDEX IF NOT EXISTS idx_help_sessions_user_created ON help_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_help_sessions_created_at   ON help_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_help_sessions_ticket_id    ON help_sessions(ticket_id);

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

-- ============================================================================================
-- Targets, reviews and settings
-- ============================================================================================

-- Target times (SLA): how fast each priority should get a first reply and be fixed, in minutes
-- of clock time (24/7) from when the ticket was opened. Admins change them on the Target times
-- screen.
CREATE TABLE IF NOT EXISTS sla_targets (
    priority               TEXT PRIMARY KEY CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    first_response_minutes INTEGER NOT NULL CHECK (first_response_minutes > 0),
    resolve_minutes        INTEGER NOT NULL CHECK (resolve_minutes > 0),
    updated_by             INTEGER REFERENCES users(id) ON DELETE SET NULL, -- empty = the defaults
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT sla_targets_reply_before_fix CHECK (resolve_minutes >= first_response_minutes)
);

-- The defaults, added only for a priority that has no row, so a re-run never undoes an admin's change.
INSERT INTO sla_targets (priority, first_response_minutes, resolve_minutes)
VALUES ('urgent', 60, 240), ('high', 240, 1440), ('medium', 1440, 4320), ('low', 2880, 10080)
ON CONFLICT (priority) DO NOTHING;

-- Reviews ("How did we do?"): one per ticket, from the person who opened it, once it's resolved.
-- technician_id is who it credits: the assignee when the review was first given (empty = no
-- one assigned). Kept as a snapshot, so reassigning a ticket later doesn't move the review.
-- Editable for 7 days after it was first given (checked by the API).
CREATE TABLE IF NOT EXISTS ticket_ratings (
    ticket_id     INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE, -- one per ticket
    rated_by      INTEGER NOT NULL REFERENCES users(id),
    technician_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    stars         SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment       TEXT CHECK (char_length(comment) <= 1000),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The Reviews page and the dashboard group by technician and sort by date.
CREATE INDEX IF NOT EXISTS idx_ticket_ratings_technician ON ticket_ratings(technician_id, created_at);

-- The targets the dashboard measures the team against, set by admins and owners.
--   self_solved_rate    % of answered Get help requests the AI's steps fixed
--   average_rating      average review stars (1-5)
--   fixed_on_time_rate  % of resolved tickets fixed within their target time
CREATE TABLE IF NOT EXISTS team_goals (
    metric     TEXT PRIMARY KEY CHECK (metric IN ('self_solved_rate', 'average_rating', 'fixed_on_time_rate')),
    target     NUMERIC(5, 2) NOT NULL CHECK (target > 0),
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The defaults, added only where missing, so a re-run never undoes an admin's change.
INSERT INTO team_goals (metric, target)
VALUES ('self_solved_rate', 25), ('average_rating', 4.5), ('fixed_on_time_rate', 90)
ON CONFLICT (metric) DO NOTHING;

-- Settings an admin can change from the app. One row only: "id BOOLEAN PRIMARY KEY CHECK (id)"
-- lets id be TRUE and nothing else, so a second row can't exist.
--   auto_assign: new tickets go to the available technician with the fewest open tickets
CREATE TABLE IF NOT EXISTS app_settings (
    id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    auto_assign BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO app_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ============================================================================================
-- Notifications and outages
-- ============================================================================================

-- The bell in the header. One row per person told about something: a ticket, an outage, or both.
--   kind: assigned (to you) · reply (a comment) · internal_note · resolved · reopened (your
--         ticket) · overdue_reply / overdue_fix (a ticket assigned to you passed its target) ·
--         outage_suspected (to all staff) · outage_fixed (to people who said "This is my problem")
--   actor_id: who did it; empty = automatic (auto-assign, overdue)
--   read_at: when they opened it or chose "Mark all as read"; empty = unread
-- Rows older than 30 days are deleted (routes/notifications.js).
CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    outage_id  INTEGER REFERENCES outages(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('assigned', 'reply', 'internal_note', 'resolved', 'reopened',
                                             'overdue_reply', 'overdue_fix', 'outage_suspected', 'outage_fixed')),
    actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT notifications_about_something CHECK (ticket_id IS NOT NULL OR outage_id IS NOT NULL)
);

-- The bell reads one person's newest first.
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
-- Each overdue warning only once per person and ticket, however often the bell checks.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_overdue_once
    ON notifications(user_id, ticket_id, kind) WHERE kind IN ('overdue_reply', 'overdue_fix');

-- "This is my problem" on Get help: people affected by a confirmed outage, without a ticket.
CREATE TABLE IF NOT EXISTS outage_reports (
    outage_id  INTEGER NOT NULL REFERENCES outages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (outage_id, user_id)                                -- once per person
);

-- ============================================================================================
-- New-hire setup checklists
-- ============================================================================================

-- The standard steps every new-hire ticket starts with, in order. Admins edit them on the
-- New-hire steps screen; each ticket gets its own copy, so editing the list never changes a
-- ticket that already exists.
CREATE TABLE IF NOT EXISTS new_hire_steps (
    position INTEGER PRIMARY KEY CHECK (position > 0),              -- 1, 2, 3…
    title    TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120)
);

-- The starting list, added only when the table is empty, so a re-run never undoes an admin's edit.
INSERT INTO new_hire_steps (position, title)
SELECT * FROM (VALUES (1, 'Create account'), (2, 'Set up email'), (3, 'Prepare laptop'),
                      (4, 'Install software'), (5, 'Building access'), (6, 'First-day check-in')) AS d
 WHERE NOT EXISTS (SELECT 1 FROM new_hire_steps);

-- Each ticket's own checklist: one row per step.
--   state: todo → done or not_needed (both count as finished; the ticket can't be resolved until
--          every step is one of them)
--   changed_by / changed_at: who last ticked it and when; empty = never ticked
CREATE TABLE IF NOT EXISTS ticket_checklist_items (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL CHECK (position > 0),               -- a copy, not a link to new_hire_steps
    title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    state      TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo', 'done', 'not_needed')),
    changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ,
    UNIQUE (ticket_id, position)                                     -- no two steps in one spot
);
