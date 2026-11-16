# ResolveIT

[![CI](https://github.com/esalman-dev/resolveit/actions/workflows/ci.yml/badge.svg)](https://github.com/esalman-dev/resolveit/actions/workflows/ci.yml)

**A help desk ticket tracker that helps users fix common IT problems themselves, before a ticket is ever created.**

> 🚧 **Status: in development.** Accounts, login (password or Google), roles, and the ticket API (with categories and comments) are done and covered by automated tests. The ticket screens are being built: the app layout, the "Get help" form, the ticket list with search and filters, and a ticket page with its history are done. See [Progress](#progress).

## The idea

Most help desk tickets are for common problems with simple fixes: Wi-Fi that won't connect, a printer that's offline, a forgotten password. ResolveIT handles these with **ticket deflection**, a feature that commercial help desk platforms charge for:

1. The user describes their problem, for example *"my laptop won't connect to Wi-Fi."*
2. ResolveIT uses AI to suggest **safe, step-by-step fixes** the user can try on their own.
3. The user clicks **"That fixed it"** or **"Still broken."**
4. If it's still broken, a ticket is **created automatically**, already filled in with the problem, the steps the user tried, and a suggested category and priority, so the technician doesn't start from zero.

**Safety first:** the AI only suggests low-risk fixes. Anything risky, like registry edits, BIOS changes or deleting files, goes straight to a technician.

## Features

**Done**
- Accounts with email and password, or **Sign in with Google**
- Stay logged in for up to 30 days, with a hard 90-day maximum
- Roles: **user**, **technician**, **admin**, and **owner**, ranked so you can only manage people below you, with an admin screen for managing users and an "Are you sure?" step before each change
- Admins and owners can **disable** accounts (logged out everywhere at once; their tickets stay), and see an **account history** of every role change and disable
- Ticket API: users open tickets, edit them while still open, and close them; staff assign, prioritize, categorize, and add internal notes
- **Ticket history** on every ticket: who changed what, from what, to what, and when
- **Comments** that the author can edit, with every earlier version kept and visible
- App layout with a role-based sidebar; every screen has its own address, so links, refresh, and the Back button work
- **Get help** form to open a ticket, with tips for a faster fix
- **Ticket list** with search (title or number) and filters for status, priority, category, and "assigned to me", kept in the address so a refresh or a shared link keeps them
- Ticket page in a GitHub-style layout: the description and an activity timeline on the left, status, priority, category, and assignee on the right

**Planned**
- Ticket screens still to come: staff controls and comments on the ticket page, and category management
- AI self-service troubleshooting with safe-fix guardrails
- A knowledge base that learns from tickets technicians have solved
- An analytics dashboard: self-solved rate, escalations, most common problems, average resolution time

## Security

Authentication is built by hand rather than with an auth service, so each decision is visible and tested:

| Concern | How ResolveIT handles it |
|---|---|
| Stored passwords | Hashed with **bcrypt** (cost 12, salted). The real password is never stored or returned. |
| Login tokens | Short-lived **JWT access token** (15 minutes) kept only in memory, never in `localStorage`. |
| Staying logged in | **Refresh token** in an `httpOnly`, `SameSite=Strict` cookie that JavaScript can't read. Stored as a SHA-256 hash, valid for 30 days of inactivity and at most 90 days in total. |
| Stolen refresh tokens | **Rotation:** every refresh token works once. **Reuse detection:** if an old one is presented again, all of that user's sessions are revoked. |
| Logging out | The server revokes the session, not just the browser. |
| Permissions | Role checks read the **current role from the database**, so promotions, demotions, disabled accounts, and deleted accounts take effect immediately. 401 = not logged in, 403 = not allowed. |
| Self-promotion | Sign-up always creates a `user`, whatever the request says. The first admin is created from the server with `npm run make-admin`, and owners only with `npm run make-owner`: no website request can create an owner. Nobody can change their own role. |
| Role hierarchy | user < technician < admin < owner. You can only change the role of someone **ranked below you**, and only give roles **below your own**: admins manage technicians and users, owners also manage admins, and owners can't demote each other. A role change is saved only if the person's role hasn't changed since it was checked (no race between two editors). |
| Password guessing | **Rate limits:** 10 failed logins per 15 minutes, 10 sign-ups per hour, and a general API cap. |
| Account fishing | Login gives the same error **and takes the same time** for an unknown email and a wrong password: it checks against a dummy bcrypt hash, so response timing can't reveal which emails have accounts. |
| Input limits | Names, emails, titles, descriptions, and comments have maximum lengths. Passwords are capped at **72 bytes**, because bcrypt silently ignores anything longer. |
| Disabled accounts | Disabling revokes every session at once; the next request, refresh, or login is refused. |
| Accountability | Every ticket change, role change, and disable is logged with who did it, in the **same database transaction** as the change, so the log can't miss anything. Comment edits keep every earlier version. |
| SQL injection | Every value goes through parameters (`$1`, `$2`). Where column names are built into SQL, they come from fixed lists in the code, never from the request. |
| Login tokens (JWT) | Verified with the algorithm pinned to HS256, so a token can't choose a different signing method. |
| Google sign-in | Google's ID token is verified (signature, audience, expiry). An existing account is linked only if Google confirms the email is verified **and** the account isn't already linked to a different Google account. |

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, React Router, plain CSS |
| Backend | Node.js + Express 5 |
| Database | PostgreSQL |
| Auth | bcrypt, JSON Web Tokens, Google Identity Services, express-rate-limit |
| Testing | Vitest + Supertest, against a separate test database |
| AI | AI model API for fix suggestions (planned) |
| Hosting | Vercel (frontend), Render (API), Neon (database), on free tiers (planned) |

## Progress

**Phase 1: Core ticket tracker**
- [x] Project repository set up
- [x] React frontend and Express backend connected
- [x] PostgreSQL database and schema
- [x] User accounts and login (password and Google)
- [x] Roles: user, technician, admin, owner
- [ ] Create, view, assign, and update tickets
- [ ] Ticket status and priority
- [x] Search and filter

**Phase 2: AI self-service fixes** · **Phase 3: Knowledge base and analytics** · **Phase 4: Deployment, CI, password reset**

## Project structure

```
resolveit/
├── client/                  React frontend (Vite)
│   ├── src/
│   │   ├── api.js           All API calls: attaches and renews the login token
│   │   ├── App.jsx          Restores the session on load, maps each address to a page
│   │   ├── AppShell.jsx     Sidebar and header around every page after login
│   │   ├── LoginPage.jsx    Log in / create account form
│   │   ├── GoogleButton.jsx Sign in with Google
│   │   ├── GetHelpPage.jsx  "Get help": the form that opens a ticket
│   │   ├── TicketsPage.jsx  The ticket list: search and filters
│   │   ├── TicketPage.jsx   One ticket: description, activity timeline, details panel
│   │   ├── UsersPage.jsx    Admin/owner: manage users and roles
│   │   ├── ConfirmDialog.jsx Reusable "Are you sure?" box
│   │   ├── Badges.jsx       Status and priority labels
│   │   ├── EmptyState.jsx   Reusable "nothing here yet" box
│   │   ├── RelativeTime.jsx "2 hours ago", with the exact time on hover
│   │   ├── usePageTitle.js  Lets a page set the header and browser tab title
│   │   ├── ticketLabels.js  Status and priority names in words
│   │   ├── roles.js         Role ranking (mirrors the server, for a tidy UI)
│   │   ├── index.css        App-wide styles, built only from the theme variables
│   │   └── styles/
│   │       └── theme.css    Colors, spacing and fonts in one place (contrast-checked)
│   ├── vite.config.js       Dev proxy: forwards /api to the Express server
│   └── vercel.json          Production: forwards /api to the hosted API, every other address to the app
└── server/                  Express API
    ├── app.js               Builds the app: middleware and routes
    ├── index.js             Starts the server
    ├── roles.js             The four roles, their ranking, and who may manage whom
    ├── routes/
    │   ├── auth.js          Register, login, Google, refresh, logout, /me
    │   ├── users.js         Admin user management
    │   ├── tickets.js       Tickets and their comments: create, list, view, assign, update
    │   └── categories.js    Admin-managed ticket categories
    ├── middleware/
    │   ├── auth.js          requireAuth (who are you?) and requireRole (are you allowed?)
    │   └── rateLimit.js     Request limits
    ├── db/
    │   ├── index.js         Shared PostgreSQL connection pool
    │   └── schema.sql       Tables and constraints (safe to re-run)
    ├── scripts/
    │   ├── make-admin.js    Promote an account to admin
    │   └── make-owner.js    Make (or remove) an owner: only possible on the server
    └── test/                Automated tests
```

## Database

- **`users`**: name, unique email, an optional bcrypt password hash, an optional Google ID, and a role (`user`, `technician`, `admin`, or `owner`). A `CHECK` constraint requires at least one way to log in. `disabled_at` marks disabled accounts.
- **`tickets`**: title, description, status, and priority, plus foreign keys to the user who created it, the technician it's assigned to, and its category. `resolved_at` records when it was resolved (for average resolution time).
- **`categories`**: the list of ticket categories, managed by admins. Names are unique ignoring capital letters, and categories are archived (`active = false`) rather than deleted, so old tickets keep their label.
- **`ticket_comments`**: the conversation on a ticket. `is_internal` marks staff-only notes that the ticket's creator never sees. `edited_at` shows when it was last edited.
- **`comment_edits`**: every earlier version of an edited comment.
- **`ticket_events`**: the ticket history: one row per change, with who, which field, and the before/after values as people saw them.
- **`account_events`**: the account history: role changes, disables, and enables, with who did them (empty = a server command).
- **`refresh_tokens`**: one row per logged-in browser. Stores a hash of the token, its expiry, when the session started, and when it was revoked.

Allowed values for role, status, and priority are enforced by the database itself with `CHECK` constraints. See [`server/db/schema.sql`](server/db/schema.sql).

## Running locally

**Requirements:** [Node.js](https://nodejs.org/) 22 or newer and [PostgreSQL](https://www.postgresql.org/) 17.

```bash
# 1. Clone the repo
git clone https://github.com/esalman-dev/resolveit.git
cd resolveit

# 2. Create the database and tables
psql -U postgres -c "CREATE DATABASE resolveit;"
psql -U postgres -d resolveit -f server/db/schema.sql

# 3. Configure and start the backend (http://localhost:5000)
cd server
npm install
cp .env.example .env    # put your PostgreSQL password in DATABASE_URL and generate a JWT_SECRET
npm run dev

# 4. In a second terminal, start the frontend (http://localhost:5173)
cd client
npm install
cp .env.example .env    # optional: add a Google Client ID to show the Google button
npm run dev
```

Open http://localhost:5173 and create an account.

**Make yourself an admin or owner** (from the `server` folder, after signing up). Owners can only be created this way, and `npm run make-owner -- --remove you@example.com` turns an owner back into an admin:

```bash
npm run make-admin -- you@example.com
# or, for full control including over admins:
npm run make-owner -- you@example.com
```

**Sign in with Google (optional):** create an OAuth Client ID (type: Web application) in Google Cloud Console, add `http://localhost:5173` as an authorized JavaScript origin, and put the ID in both `server/.env` (`GOOGLE_CLIENT_ID`) and `client/.env` (`VITE_GOOGLE_CLIENT_ID`). Without it, the Google button is simply hidden.

### Running the tests

```bash
cd server
npm test
```

The tests create and use a separate database, `resolveit_test`, on the same PostgreSQL server, and empty it before every test. They refuse to run against any database whose name doesn't end in `_test`.

**GitHub Actions** runs the server tests (against a PostgreSQL 17 container) and lints and builds the client on every push and pull request. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

> **Windows + Git Bash:** if Vitest says it "failed to find the runner," open the folder with an uppercase drive letter (`cd /C/Users/...`) or run the tests from PowerShell.

### API

| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/api/health` | Anyone | Checks the server and database |
| POST | `/api/auth/register` | Anyone | Create an account. Returns the user and an access token, and sets the refresh cookie |
| POST | `/api/auth/login` | Anyone | Log in with email and password |
| POST | `/api/auth/google` | Anyone | Log in with a Google ID token |
| POST | `/api/auth/refresh` | Refresh cookie | Get a new access token (rotates the refresh token) |
| POST | `/api/auth/logout` | Refresh cookie | Revoke this session |
| GET | `/api/auth/me` | Logged in | The current user |
| GET | `/api/users` | Admin, owner | List all users |
| PATCH | `/api/users/:id/role` | Admin, owner | Change a role: only for people ranked below you, and only to a role below yours |
| PATCH | `/api/users/:id/disabled` | Admin, owner | Disable or re-enable an account ranked below you |
| GET | `/api/users/history` | Admin, owner | Account history, newest first (`?user_id=` for one person) |
| POST | `/api/tickets` | Logged in | Open a ticket (always starts open and unassigned; only staff can choose a priority, otherwise it starts at medium) |
| GET | `/api/tickets` | Logged in | List tickets: users see their own, technicians, admins and owners see all |
| GET | `/api/tickets/:id` | Creator, staff | One ticket **with its history** (404 for other users' tickets, so ids can't be probed) |
| PATCH | `/api/tickets/:id` | Creator, staff | Staff: change anything. Creator: edit title/description while open, or close it. Every change is logged |
| GET | `/api/tickets/assignees` | Staff | Active technicians, admins, and owners a ticket can be assigned to |
| GET | `/api/tickets/:id/comments` | Creator, staff | Comments, oldest first, each with its earlier versions (internal notes only for staff) |
| POST | `/api/tickets/:id/comments` | Creator, staff | Add a comment; staff can mark it internal |
| PATCH | `/api/tickets/:id/comments/:commentId` | The comment's author | Edit your comment; the old text is kept |
| GET | `/api/categories` | Logged in | Active categories (admins can add `?all=true` for archived ones) |
| POST | `/api/categories` | Admin, owner | Add a category |
| PATCH | `/api/categories/:id` | Admin, owner | Rename, archive, or restore a category |

Protected endpoints expect `Authorization: Bearer <access token>`. "Staff" means a technician, admin, or owner.

## Author

**E. Salman**, Computer Science student · [GitHub: esalman-dev](https://github.com/esalman-dev)
