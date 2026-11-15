# ResolveIT

**A help desk ticket tracker that helps users fix common IT problems themselves, before a ticket is ever created.**

> 🚧 **Status: in early development.** The project skeleton is set up and the frontend and backend are connected. See [Progress](#progress) for what's done and what's next.

## The idea

Most help desk tickets are for common problems with simple fixes: Wi-Fi that won't connect, a printer that's offline, a forgotten password. ResolveIT handles these with **ticket deflection**, a feature that commercial help desk platforms charge for:

1. The user describes their problem, for example *"my laptop won't connect to Wi-Fi."*
2. ResolveIT uses AI to suggest **safe, step-by-step fixes** the user can try on their own.
3. The user clicks **"That fixed it"** or **"Still broken."**
4. If it's still broken, a ticket is **created automatically**, already filled in with the problem, the steps the user tried, and a suggested category and priority, so the technician doesn't start from zero.

**Safety first:** the AI only suggests low-risk fixes. Anything risky, like registry edits, BIOS changes or deleting files, goes straight to a technician.

## Planned features

- Ticket tracking with **user**, **technician**, and **admin** roles
- AI self-service troubleshooting with safe-fix guardrails
- A knowledge base that learns from tickets technicians have solved
- An analytics dashboard: self-solved rate, escalations, most common problems, average resolution time

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite |
| Backend | Node.js + Express 5 |
| Database | PostgreSQL |
| AI | AI model API for fix suggestions (planned) |
| Hosting | Render / Railway / Vercel (planned) |

## Progress

**Phase 1: Core ticket tracker**
- [x] Project repository set up
- [x] React frontend and Express backend connected (health check endpoint)
- [ ] PostgreSQL database and ticket schema
- [ ] User accounts and login
- [ ] Roles: user, technician, admin
- [ ] Create, view, assign, and update tickets
- [ ] Ticket status and priority
- [ ] Search and filter

**Phase 2: AI self-service fixes** · **Phase 3: Knowledge base and analytics** · **Phase 4: Deployment, automated tests, CI**

## Project structure

```
resolveit/
├── client/          React frontend (Vite)
│   └── src/         Pages and components
└── server/          Express API
    ├── index.js     Server entry point and routes
    └── .env.example Template for environment variables
```

## Running locally

**Requirements:** [Node.js](https://nodejs.org/) 22 or newer. PostgreSQL will be needed once the database is added.

```bash
# 1. Clone the repo
git clone https://github.com/esalman-dev/resolveit.git
cd resolveit

# 2. Start the backend (http://localhost:5000)
cd server
npm install
cp .env.example .env    # then fill in your own values
npm run dev

# 3. In a second terminal, start the frontend (http://localhost:5173)
cd client
npm install
npm run dev
```

Open http://localhost:5173. The page should show **Server status: ok**, which confirms the frontend can reach the API.

### API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Returns `{ "status": "ok" }` when the server is running |

## Author

**[esalman-dev](https://github.com/esalman-dev)**, Computer Science student
