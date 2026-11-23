# Architecture: folders and database

[← Back to the README](../README.md)

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
│   │   │   ├── SlaTargetsPage.jsx   Admin/owner: target times per priority
│   │   │   ├── ReviewsPage.jsx      Staff: "How did we do?" reviews and their summary
│   │   │   ├── dashboard/           Staff dashboard: the page and its hand-built charts
│   │   │   ├── kb/                  Knowledge base: the article list and one article
│   │   │   └── ticket/              One ticket's page
│   │   │       ├── TicketPage.jsx       Loads it, saves changes, asks "Are you sure?" for big ones
│   │   │       ├── TicketSidePanel.jsx  Status, priority, category, assignee (dropdowns for staff)
│   │   │       ├── TicketActivity.jsx   Comments and history in one timeline, plus the comment box
│   │   │       └── ReviewCard.jsx       "How did we do?" once the ticket is resolved
│   │   ├── components/          Pieces shared by several screens
│   │   │   ├── AppShell.jsx         Sidebar and header around every page after login
│   │   │   ├── ConfirmDialog.jsx    Reusable "Are you sure?" box
│   │   │   ├── EmptyState.jsx       Reusable "nothing here yet" box
│   │   │   ├── Badges.jsx           Status and priority labels
│   │   │   ├── CountCards.jsx       Number cards that double as filters
│   │   │   ├── RelativeTime.jsx     "2 hours ago", with the exact time on hover
│   │   │   ├── Attachments.jsx      The file picker and the list of files on a ticket or comment
│   │   │   ├── DueBadge.jsx         "Reply due in 3 h" / overdue, against the target time
│   │   │   ├── Stars.jsx            Show or pick a 1-5 star rating
│   │   │   ├── StatusDot.jsx        Online status dot, always with the word beside it
│   │   │   └── GoogleButton.jsx     Sign in with Google
│   │   ├── lib/                 Helpers with no screen of their own
│   │   │   ├── api.js               All API calls: attaches and renews the login token
│   │   │   ├── attachments.js       Uploads picked files and tracks them until the form is sent
│   │   │   ├── drafts.js            Unsent Get help text, kept per account in the browser
│   │   │   ├── presence.js          Who's online, and the once-a-minute check-in for staff
│   │   │   ├── sla.js               Where a ticket stands against its target times
│   │   │   ├── roles.js             Role ranking (mirrors the server, for a tidy UI)
│   │   │   ├── ticketLabels.js      Status and priority names in words
│   │   │   └── usePageTitle.js      Lets a page set the header and browser tab title
│   │   ├── styles/
│   │   │   └── theme.css            Colors, spacing and fonts in one place (contrast-checked)
│   │   └── assets/              Logos as SVG: stacked (login screen) and horizontal (sidebar), each with a dark-mode version
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
    │   ├── reviews.js       The Reviews page: reviews and their summary, anonymous for technicians
    │   ├── dashboard.js     The dashboard numbers and team goals
    │   ├── presence.js      Who's online: check-ins and staff status
    │   └── kb.js            Knowledge base: articles, drafting from tickets, search
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
- **`attachments`**: one row per uploaded file (its real type, size, and the ticket, comment or Get help request it belongs to). The files themselves are stored under random names.
- **`sla_targets`**: the first-reply and fixed target times for each priority.
- **`ticket_ratings`**: "How did we do?" reviews, crediting the technician assigned when the review was given.
- **`team_goals`**: the dashboard's goals (self-solved rate, average rating, fixed on time).
- **`kb_articles`**: knowledge base articles (draft, published or archived), with a full-text search column PostgreSQL keeps up to date.

Allowed values for role, status, and priority are enforced by the database itself with `CHECK` constraints. See [`server/db/schema.sql`](../server/db/schema.sql).
