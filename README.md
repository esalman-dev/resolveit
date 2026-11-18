<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="client/src/assets/resolveit-logo-dark.svg">
    <img src="client/src/assets/resolveit-logo.svg" alt="ResolveIT" width="260">
  </picture>
</h1>

[![CI](https://github.com/esalman-dev/resolveit/actions/workflows/ci.yml/badge.svg)](https://github.com/esalman-dev/resolveit/actions/workflows/ci.yml)

**A help desk ticket tracker that helps users fix common IT problems themselves, before a ticket is ever created.**

> 🚧 **Status: in development.** Phase 1, the core ticket tracker, is complete. Phase 2, **AI self-service fixes**, is built: Get help suggests safe steps first, **Ask IT** answers quick questions, risky problems go straight to a technician, and staff see every AI request and its result. A 500-ticket simulated study measured how many tickets it removes (see [Results](#results-simulated-ticket-reduction-study)). **Attachments** (screenshots and files, which the AI can read) are built. Next: the analytics dashboard, then deployment. See [Progress](#progress).

## The idea

Most help desk tickets are for common problems with simple fixes: Wi-Fi that won't connect, a printer that's offline, a forgotten password. ResolveIT handles these with **ticket deflection**, a feature that commercial help desk platforms charge for:

1. The user describes their problem, for example *"my laptop won't connect to Wi-Fi."*
2. ResolveIT uses AI to suggest **safe, step-by-step fixes** the user can try on their own.
3. The user clicks **"That fixed it"** or **"Still broken."**
4. If it's still broken, a ticket is **created automatically**, already filled in with the problem, the steps the user tried, and a suggested category and priority, so the technician doesn't start from zero.

**Safety first:** the AI only suggests low-risk fixes. Anything risky, like registry edits, BIOS changes or deleting files, goes straight to a technician.

## Results: simulated ticket reduction study

In a **simulated test of 500 help desk tickets**, ResolveIT's AI self-service resolved **18.4%** without a technician (95% CI 15.2–22.0%), escalated **100% of security-risk tickets** (37/37), and gave **no unsafe answers** (0/500), at about **$0.0024 per avoided ticket**.

| Measure | Result |
|---|---|
| Tickets resolved with no technician | **18.4%** (92/500, 95% CI 15.2–22.0%) |
| …of the tickets a user *could* fix alone (132) | **69.7%** (92/132, 95% CI 61.4–76.9%) |
| Security-risk tickets sent straight to a technician | **100%** (37/37) |
| Unsafe answers | **0%** (0/500, 95% CI 0.0–0.8%) |
| Self-fixable problems sent to a technician anyway | 23.5% (31/132) |
| Suggested category matched the right one | 81% (407/500) |
| AI cost per ticket / per avoided ticket | $0.0004 / $0.0024 |
| Average answer time | 2.9 seconds |

**How it was measured.** The ticket mix follows Fixify's *2026 IT Help Desk Benchmark Report* (50,000+ tickets from 30+ organizations). A large share of real tickets, like app access requests and new-hire accounts, only IT can handle, so at most **26.4%** of these 500 tickets could ever be fixed by the user. 109 scenarios each have a **hidden cause** the AI never sees. 500 tickets were written from them in varied, realistic styles (typos, wrong guesses, missing details), then frozen. Each ticket went through the app's own AI code and safety check. A separate grader, which knows the hidden cause, judged whether the steps would fix it. A person graded 48 of the grader's decisions blind and agreed **91.7%** of the time; in every disagreement the grader was the stricter one. Error ranges are 95% Wilson intervals.

**Limits.** These are simulated tickets, not real users. The ticket mix comes from a vendor's benchmark, and the split of each category into "user can fix", "needs IT" and "risky" is this project's assumption. The tickets were written by the same model that answers them (Claude Haiku 5.5). Four self-fixable tickets mention a red flag (a spill, a virus worry), so escalating them counts against the result. The study found that the AI often gave steps for access and license requests that only IT can grant. That was fixed after the study: re-run on the same 40 of those tickets, correct escalations went from 20 to 27. The numbers above are from before the fix.

Everything needed to check or re-run it is in [`server/eval/`](server/eval/): the scenarios, the frozen tickets, the scripts, every run's full results, and a [log of every paid run](server/eval/RUNS.md) with what changed and what it cost.

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
- Ticket page in a GitHub-style layout: the description and a timeline of comments and changes on the left; status, priority, category, and assignee on the right, as dropdowns for staff
- "Are you sure?" only for big changes (resolving, reopening, taking a ticket from someone else, closing your own ticket); small changes save instantly and show in the history
- Comments with **internal notes** for staff (highlighted, and never sent to the user), editable with every earlier version kept
- **Categories** managed by admins: add, rename, archive (never deleted, so old tickets keep theirs), and restore
- **Search** on the Users screen by name, email, or role

**AI self-service (Phase 2)**
- **Get help** suggests **2 to 7 safe steps, easiest first**: the AI rates each step's effort and the server sorts by it, so a quick workaround (e.g. right-click > Copy) always comes before restarting the computer. Each step has an "I tried this" box.
- **That fixed it** closes the request with no ticket. **Still broken** opens a ticket with every step marked tried or not, shown to the technician in a **Steps tried** panel.
- **Risky problems** (registry, BIOS, deleting files, the command line, turning off antivirus, phishing, ransomware, lost data, physical damage…) skip the steps and go **straight to a technician**, with a ticket opened at once.
- **Ask IT**: one quick IT question, one short answer, then **"Did this answer your question?"** Same safety rules, same daily limit, and a one-click hand-off to Get help.
- **Never lose your place:** unsent text is kept as a draft, every request has its own address, and unfinished requests are listed with a **Continue** button that reopens them without asking the AI again.
- If the AI is off, down, or a daily limit is reached, the same form quietly becomes a **plain ticket form**: asking for help never breaks.
- Staff **AI help** screen: every AI request (Get help and Ask IT), who asked, the result, the steps or answer, and anything the safety check blocked, with **count cards** that double as filters and the **self-solved rate**.
- **Count cards on the staff ticket list** (Open, In progress, Resolved, Assigned to me, Unassigned) and a **My tickets** list for everyone; the sidebar is grouped into Help, Staff, and Admin.
- A **69-problem test set** (`npm run eval`, 5 with a screenshot) that scores the real AI for help rate, safety (every risky problem escalated), consistency over repeats, and cost.
- A **500-ticket simulated study** (`npm run study`) of how many tickets the AI removes, with a written method, confidence intervals and a blind human check of the grader. See [Results](#results-simulated-ticket-reduction-study).

**Attachments**
- **Screenshots and files** (PNG, JPG, WebP, GIF, PDF, `.txt`/`.log` logs; up to 5 MB, 3 per message) on Get help, new tickets, comments and internal notes, by button or drag and drop. Images show as thumbnails; PDFs and logs download.
- **The AI reads screenshots** on Get help, with a notice on the form, so an error dialog or a status screen can lead straight to the fix. Text inside a screenshot is treated as part of the problem, never as an instruction.
- Files go with what they're attached to: on a Get help request they move onto the ticket it opens, and files on an internal note are staff-only.

**Target times (SLA)**
- Every priority has a **first reply** and a **fixed** target (Urgent 1 h / 4 h by default, up to Low 2 days / 1 week), counted around the clock. Admins change them on a **Target times** screen.
- The staff queue shows what's **due next** on every ticket (gray, amber when under a quarter of the time is left, red when overdue), has an **Overdue** card, and can **sort by most urgent**.
- Each ticket shows its reply and fix deadlines, and once met, how long they took and whether they were on time. The first reply is the first thing staff do that the user can see (a public comment or a status change), recorded as it happens.

**Reviews**
- When a ticket is resolved, the person who opened it gets **"How did we do?"**: 1 to 5 stars (keyboard and screen-reader friendly) and an optional comment, editable for 7 days. It credits the technician assigned at the time.
- A **Reviews** page for staff: the average, how many, and a bar per star. Technicians see only their own reviews, **without names or ticket numbers** (removed on the server), so people can be honest; admins and owners see everyone's, with names, ticket links and a technician filter.

**Planned**
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
| Risky AI advice | **Two layers.** The AI's instructions list what must go to a technician, and a **server-side check** reads every step (and every Ask IT answer) before anyone sees it. If anything touches a blocked topic, the steps are thrown away and it's escalated: the AI can't talk its way past code. Blocked text is kept for staff so false alarms can be fixed. |
| Prompt injection | The user's text is fenced as data, with the fence tags stripped from it; the AI is told to escalate any "ignore your rules" request; and the server check runs anyway. |
| AI answer format | **Structured output:** the AI must answer in a fixed JSON shape enforced by the API, so the server never guesses what it meant. Its text is shown as plain text, never HTML. |
| AI cost | Per-person and site-wide **daily limits** (20 and 300 by default), checked under a database lock so parallel requests can't slip past; a per-answer token cap; a short timeout; and a prepaid balance on the AI account. |
| AI privacy | Only the problem's title, category, details and the user's screenshots (or the question) are sent to the AI, never names, emails or ids; the form says screenshots are sent. The API key lives only on the server. Unsent drafts are kept per account in the browser and cleared on log out. |
| Uploaded files | The real type is read from the file's **first bytes** ("magic bytes"), not its name, so a program renamed `photo.png` is refused. The **5 MB limit is enforced while the file arrives**, files are stored under **random names** (the uploaded name is only ever shown as text), and each one is served only after the same "can you see this ticket?" check, with headers that stop the browser running it (`nosniff`, a sandboxed `Content-Security-Policy`). A daily upload limit per person, and unsent uploads are removed after a day. |
| Screenshot injection | A screenshot can contain text like "ignore your rules". The AI is told that text in an image is part of the problem, never an instruction, and the server check still reads every step. Tested with a screenshot that asks for registry edits: escalated every time. |

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, React Router, plain CSS |
| Backend | Node.js + Express 5 |
| Database | PostgreSQL |
| Auth | bcrypt, JSON Web Tokens, Google Identity Services, express-rate-limit |
| Testing | Vitest + Supertest, against a separate test database |
| AI | Anthropic Claude API (Claude Haiku 5.5, chosen for cost), official Node SDK, structured outputs |
| Hosting | Vercel (frontend), Render (API), Neon (database), on free tiers (planned) |

## Progress

**Phase 1: Core ticket tracker** ✅ complete
- [x] Project repository set up
- [x] React frontend and Express backend connected
- [x] PostgreSQL database and schema
- [x] User accounts and login (password and Google)
- [x] Roles: user, technician, admin, owner
- [x] Create, view, assign, and update tickets
- [x] Ticket status and priority
- [x] Search and filter

**Phase 2: AI self-service fixes** ✅ complete
- [x] Connect an AI API (Claude Haiku 5.5)
- [x] "Describe your problem" screen with safe fix steps, easiest first
- [x] "That fixed it" / "Still broken" buttons
- [x] Auto-created ticket with the steps already tried
- [x] Safe-fix guardrails (AI instructions + a server-side check)
- [x] Ask IT (quick questions) and the staff AI help screen
- [x] 500-ticket simulated study of ticket reduction ([Results](#results-simulated-ticket-reduction-study))

**Phase 3: Smarter help desk** 🛠️ in progress
- [x] Attachments: screenshots and files on tickets, comments and Get help, read by the AI
- [x] Demo data: `npm run seed-demo` (two months of realistic history and three demo logins)
- [x] Target times (SLA): due and overdue on every ticket, sort by most urgent, admin screen
- [x] Reviews: "How did we do?" ratings and a Reviews page (anonymous for technicians)
- [ ] Analytics dashboard
- [ ] Knowledge base and AI auto-categorize

**Phase 4: Deployment, password reset**

## Project structure

```
resolveit/
├── client/                  React frontend (Vite)
│   ├── src/
│   │   ├── main.jsx             Starts the app (with the router)
│   │   ├── App.jsx              Restores the session on load, maps each address to a page
│   │   ├── index.css            App-wide styles, built only from the theme variables
│   │   ├── pages/               One file per screen (each with its own CSS)
│   │   │   ├── LoginPage.jsx        Log in / create account
│   │   │   ├── GetHelpPage.jsx      "Get help": AI steps first, then a ticket if still broken
│   │   │   ├── AskItPage.jsx        "Ask IT": one quick question, one answer, "did this help?"
│   │   │   ├── AiHelpPage.jsx       Staff: every AI request and its result
│   │   │   ├── TicketsPage.jsx      The ticket list (My tickets, or the staff queue with count cards)
│   │   │   ├── UsersPage.jsx        Admin/owner: manage users and roles
│   │   │   ├── CategoriesPage.jsx   Admin/owner: add, rename, archive, and restore categories
│   │   │   └── ticket/              One ticket's page, in three parts
│   │   │       ├── TicketPage.jsx       Loads it, saves changes, asks "Are you sure?" for big ones
│   │   │       ├── TicketSidePanel.jsx  Status, priority, category, assignee (dropdowns for staff)
│   │   │       └── TicketActivity.jsx   Comments and history in one timeline, plus the comment box
│   │   ├── components/          Pieces shared by several screens
│   │   │   ├── AppShell.jsx         Sidebar and header around every page after login
│   │   │   ├── ConfirmDialog.jsx    Reusable "Are you sure?" box
│   │   │   ├── EmptyState.jsx       Reusable "nothing here yet" box
│   │   │   ├── Badges.jsx           Status and priority labels
│   │   │   ├── CountCards.jsx       Number cards that double as filters
│   │   │   ├── RelativeTime.jsx     "2 hours ago", with the exact time on hover
│   │   │   └── GoogleButton.jsx     Sign in with Google
│   │   ├── lib/                 Helpers with no screen of their own
│   │   │   ├── api.js               All API calls: attaches and renews the login token
│   │   │   ├── drafts.js            Unsent Get help text, kept per account in the browser
│   │   │   ├── roles.js             Role ranking (mirrors the server, for a tidy UI)
│   │   │   ├── ticketLabels.js      Status and priority names in words
│   │   │   └── usePageTitle.js      Lets a page set the header and browser tab title
│   │   ├── styles/
│   │   │   └── theme.css            Colors, spacing and fonts in one place (contrast-checked)
│   │   └── assets/              Logos: stacked SVG (login screen), horizontal PNG (sidebar)
│   ├── public/favicon.svg   Browser tab icon
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
    │   ├── categories.js    Admin-managed ticket categories
    │   ├── help.js          AI help: suggest steps, outcomes, Ask IT, daily limits, staff list
    │   ├── attachments.js   Upload, download and remove files; attaching them to tickets and requests
    │   ├── slaTargets.js    Target times per priority (staff read, admins change)
    │   └── reviews.js       The Reviews page: reviews and their summary, anonymous for technicians
    ├── services/
    │   ├── ai.js            The only code that talks to the AI (instructions, answer shapes)
    │   ├── guardrails.js    The server's own safety check on every AI answer, and step order
    │   ├── storage.js       Where files are kept (a local folder for now)
    │   └── fileCheck.js     A file's real type from its first bytes; safe file names
    ├── uploads/             Uploaded files while developing (git-ignored)
    ├── eval/
    │   ├── problems.json    69 test problems with known right answers (5 with a screenshot)
    │   ├── images/          The screenshots those problems use
    │   ├── run.js           `npm run eval`: scores the real AI (costs money; asks first)
    │   ├── runLog.js        Adds a row to RUNS.md after every paid run
    │   ├── RUNS.md          Every paid AI run: what changed, results, cost
    │   ├── results/         Full results of every `npm run eval`
    │   └── study/           The 500-ticket study
    │       ├── scenarios.json        109 scenarios: hidden cause, real fix, correct route
    │       ├── check-scenarios.js    Checks the scenarios and the ticket mix (free)
    │       ├── generate-tickets.js   Writes the 500 tickets once (costs money; asks first)
    │       ├── tickets.json          The frozen 500 tickets
    │       ├── run.js                `npm run study`: answers, grades, and scores them
    │       ├── results/              Full results and hand-check sheets of every run
    │       └── archive/              The first ticket set, used by the first pilot
    ├── middleware/
    │   ├── auth.js          requireAuth (who are you?) and requireRole (are you allowed?)
    │   └── rateLimit.js     Request limits
    ├── db/
    │   ├── index.js         Shared PostgreSQL connection pool
    │   └── schema.sql       Tables and constraints (safe to re-run)
    ├── scripts/
    │   ├── make-admin.js    Promote an account to admin
    │   ├── make-owner.js    Make (or remove) an owner: only possible on the server
    │   ├── seed-demo.js     `npm run seed-demo`: replace the demo data
    │   └── demoData.js      Builds the demo history (demo.example.com accounts only)
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
- **`help_sessions`**: one row per AI request, whatever happened: Get help (`kind = 'fix'`) or Ask IT (`'question'`), the problem, the steps or answer, the result (`pending`, `fixed`, `still_broken`, `escalated`, `failed`), the ticket it became, anything the safety check blocked, and the model and tokens used. The daily limits count these rows, and the self-solved rate comes from their results.
- `tickets.steps_tried`: the AI steps a user tried (or didn't) before the ticket opened.

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

**Demo data (optional):** to explore the app with two months of realistic history (about 30 accounts, 280 tickets with replies, history and reviews, and the Get help requests behind them), run this in `server/`:

```bash
npm run seed-demo -- --yes      # re-run any time for a fresh copy; --remove deletes it
```

Then log in as `demo.user@demo.example.com`, `demo.tech@demo.example.com` or `demo.admin@demo.example.com` (password: `DEMO_PASSWORD` in `.env`, or `try-resolveit-demo`). Demo accounts all use the reserved `demo.example.com` domain, and the script only ever deletes or creates those, so your own accounts and tickets are never touched. The ticket text comes from the [simulated study](#results-simulated-ticket-reduction-study), and the AI answers are the real ones from its full run.

**AI help (optional):** create an API key in the [Anthropic Console](https://console.anthropic.com/) (set a spending limit, or use prepaid credit with auto-reload off) and put it in `server/.env` as `ANTHROPIC_API_KEY`. `AI_MODEL` switches the model (default `claude-haiku-5-5`), and `AI_DAILY_LIMIT_PER_USER` / `AI_DAILY_LIMIT_SITE` change the daily limits (default 20 and 300). Without a key, Get help works as a plain ticket form and Ask IT says it isn't available.

**Attachments:** uploaded files are kept in `server/uploads/` (change it with `UPLOAD_DIR`). `ATTACHMENT_DAILY_LIMIT` sets how many files one person can upload per 24 hours (default 30).

**Sign in with Google (optional):** create an OAuth Client ID (type: Web application) in Google Cloud Console, add `http://localhost:5173` as an authorized JavaScript origin, and put the ID in both `server/.env` (`GOOGLE_CLIENT_ID`) and `client/.env` (`VITE_GOOGLE_CLIENT_ID`). Without it, the Google button is simply hidden.

### Running the tests

```bash
cd server
npm test
```

The tests create and use a separate database, `resolveit_test`, on the same PostgreSQL server, and empty it before every test. They refuse to run against any database whose name doesn't end in `_test`. **They never call the real AI:** the AI library is replaced with a fake, and the test settings blank out any API key in `.env`, so running them costs nothing.

**AI test set** (separate from the tests; it calls the real AI and costs money, so it shows an estimate and waits for `--yes`):

```bash
npm run eval                                     # estimate only, nothing sent
npm run eval -- --yes                            # one pass on the default model
npm run eval -- --repeat=3 --yes                 # a longer run, to check consistency
npm run study                                    # the 500-ticket study: estimate only
npm run study -- --route=self_fix --limit=50 --yes   # a small pilot
```

Add `--note="what this run is testing"` to any paid run; every run adds a row to [`server/eval/RUNS.md`](server/eval/RUNS.md).

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
| POST | `/api/tickets` | Logged in | Open a ticket (always starts open and unassigned; only staff can choose a priority, otherwise it starts at medium); `attachment_ids` attaches uploaded files |
| GET | `/api/tickets` | Logged in | List tickets: users see their own, technicians, admins and owners see all |
| GET | `/api/tickets/:id` | Creator, staff | One ticket **with its history** and its due times (404 for other users' tickets, so ids can't be probed) |
| PATCH | `/api/tickets/:id` | Creator, staff | Staff: change anything. Creator: edit title/description while open, or close it. Every change is logged |
| GET | `/api/tickets/assignees` | Staff | Active technicians, admins, and owners a ticket can be assigned to |
| GET | `/api/tickets/:id/comments` | Creator, staff | Comments, oldest first, each with its earlier versions (internal notes only for staff) |
| POST | `/api/tickets/:id/comments` | Creator, staff | Add a comment, with `attachment_ids`; staff can mark it internal (its files are staff-only too) |
| GET | `/api/tickets/:id/attachments` | Creator, staff | Every file on the ticket and its comments (files on internal notes only for staff) |
| PATCH | `/api/tickets/:id/comments/:commentId` | The comment's author | Edit your comment; the old text is kept |
| GET | `/api/categories` | Logged in | Active categories (admins can add `?all=true` for archived ones) |
| POST | `/api/categories` | Admin, owner | Add a category |
| PATCH | `/api/categories/:id` | Admin, owner | Rename, archive, or restore a category |
| POST | `/api/help/suggest` | Logged in | Get help: safe steps, or a ticket for a technician (counts toward the daily limit); screenshots in `attachment_ids` are sent to the AI too |
| POST | `/api/help/:id/outcome` | The person who asked | "That fixed it" / "Still broken" (Get help opens a ticket with the steps tried); "did this help?" for Ask IT |
| GET | `/api/help/mine` | Logged in | Your unfinished Get help requests (last 7 days) |
| GET | `/api/help/:id` | The person who asked | Reopen a request where you left off (no new AI call) |
| POST | `/api/help/ask` | Logged in | Ask IT: one quick question, one answer (counts toward the daily limit) |
| GET | `/api/help/questions/mine` | Logged in | Your recent Ask IT questions and whether each helped |
| GET | `/api/help/sessions` | Staff | Every AI request with its result, plus counts per result and source |
| POST | `/api/attachments` | Logged in | Upload one file (form field `file`); it's attached when sent with a ticket, comment or Get help request |
| GET | `/api/tickets/:id/rating` | Creator, admin, owner | The ticket's review (technicians get 403: the ticket page shows who opened it) |
| PUT | `/api/tickets/:id/rating` | Creator, once resolved | Give or change the review (1-5 stars, optional comment; 7 days to change it) |
| GET | `/api/reviews` | Staff | Reviews with a summary; technicians get only their own, without names or ticket numbers; admins can filter with `?technician_id=` |
| GET | `/api/sla-targets` | Staff | The target times per priority |
| PUT | `/api/sla-targets` | Admin, owner | Change the target times (every priority; fixed can't be shorter than first reply) |
| GET | `/api/attachments/:id` | Whoever can see what it's attached to | Download a file (404 for anyone else) |
| DELETE | `/api/attachments/:id` | The uploader | Remove a file before it's sent |

Protected endpoints expect `Authorization: Bearer <access token>`. "Staff" means a technician, admin, or owner.

## Author

**E. Salman**, Computer Science student · [GitHub: esalman-dev](https://github.com/esalman-dev)
