// Express app: wires up middleware and routes, without starting a server.
//
// index.js starts it on a port. The automated tests import it directly and send
// requests to it in memory, so they don't need a running server.

import 'dotenv/config'; // loads .env into process.env; must run before anything reads it
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { apiLimiter } from './middleware/rateLimit.js';
import pool from './db/index.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import ticketRoutes from './routes/tickets.js';
import categoryRoutes from './routes/categories.js';
import helpRoutes from './routes/help.js';
import attachmentRoutes from './routes/attachments.js';
import slaTargetRoutes from './routes/slaTargets.js';
import reviewRoutes from './routes/reviews.js';
import dashboardRoutes from './routes/dashboard.js';
import presenceRoutes from './routes/presence.js';
import kbRoutes from './routes/kb.js';
import notificationRoutes from './routes/notifications.js';
import settingsRoutes from './routes/settings.js';
import outageRoutes from './routes/outages.js';
import newHireStepRoutes from './routes/newHireSteps.js';
import checklistRoutes from './routes/checklist.js';
import profileRoutes from './routes/profile.js';
import { demoMode, signupOpen } from './services/demo.js';

// Security: without a secret, login tokens can't be signed or checked, so refuse to start.
if (!process.env.JWT_SECRET) {
  throw new Error('Missing JWT_SECRET in server/.env (see .env.example). Server not started.');
}

const app = express();

// --- Middleware (runs on every request, in this order) ---

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' })); // only our React app may call the API
app.use(express.json()); // parses JSON request bodies into req.body
app.use(cookieParser()); // reads cookies into req.cookies (for the refresh token)

// Why: behind a proxy (Vercel -> Render in production), every request seems to come from the
// proxy's IP, which would make all users share one rate limit. TRUST_PROXY says how many proxy
// hops to trust when reading the real visitor IP from X-Forwarded-For. Unset locally.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY));
}

app.use('/api', apiLimiter); // general request cap on every API route

// --- Routes ---

/**
 * GET /api/health
 * Confirms the server is up and can reach the database, and says whether the live-site switches
 * are on (demo: the Try as… buttons work; signup: new accounts can be made).
 * Access: anyone. Returns 503 if the database is down.
 */
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1'); // the simplest possible query
    res.json({ status: 'ok', database: 'connected', demo: demoMode(), signup: signupOpen() });
  } catch (err) {
    console.error('Database check failed:', err.message);
    res.status(503).json({ status: 'error', database: 'unreachable' });
  }
});

app.use('/api/auth', authRoutes); // sign up, log in, refresh, log out, /me
app.use('/api/users', userRoutes); // user management (admins and owners)
app.use('/api/tickets/:id/checklist', checklistRoutes); // a new-hire ticket's checklist (before the tickets routes, which would run their login check on it first)
app.use('/api/tickets', ticketRoutes); // tickets, their history and comments
app.use('/api/categories', categoryRoutes); // ticket categories (everyone reads, admins manage)
app.use('/api/help', helpRoutes); // AI self-service fixes before a ticket
app.use('/api/attachments', attachmentRoutes); // screenshots and files on tickets and requests
app.use('/api/sla-targets', slaTargetRoutes); // target times per priority (staff read, admins change)
app.use('/api/reviews', reviewRoutes); // "How did we do?" reviews for the Reviews page
app.use('/api/dashboard', dashboardRoutes); // numbers and charts for the staff dashboard
app.use('/api/presence', presenceRoutes); // who's online, and staff check-ins
app.use('/api/kb', kbRoutes); // knowledge base articles
app.use('/api/notifications', notificationRoutes); // the bell: your notifications
app.use('/api/settings', settingsRoutes); // help desk settings (auto-assign on or off)
app.use('/api/outages', outageRoutes); // outages: confirm, dismiss, fix, "This is my problem"
app.use('/api/new-hire-steps', newHireStepRoutes); // the standard new-hire checklist (staff read, admins change)
app.use('/api/profile', profileRoutes); // your own details, password and numbers

// --- Error handling ---

/**
 * Catches anything a route throws. Express 5 forwards errors from async routes here
 * automatically, so routes don't need try/catch everywhere.
 *
 * Security: the full error is logged on the server, but the browser only gets a generic
 * message, so internal details (SQL, file paths) never leak.
 */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

export default app;
