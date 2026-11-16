// Builds the Express app (middleware + routes) WITHOUT starting it.
// index.js starts it on a port; the automated tests import it directly and send fake requests.

// Load variables from .env into process.env (must run before anything reads them)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { apiLimiter } from './middleware/rateLimit.js';
import pool from './db/index.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import ticketRoutes from './routes/tickets.js';
import categoryRoutes from './routes/categories.js';

// Fail fast: without a secret, login tokens can't be signed or checked safely
if (!process.env.JWT_SECRET) {
  throw new Error('Missing JWT_SECRET in server/.env (see .env.example). Server not started.');
}

const app = express();

// Middleware: runs on every request before it reaches a route
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' })); // only our React app may call the API
app.use(express.json()); // parse JSON request bodies into req.body
app.use(cookieParser()); // read cookies into req.cookies (for the refresh token)

// Behind a proxy (Vercel -> Render in production), every request seems to come from the proxy's IP,
// which would make ALL users share one rate limit. TRUST_PROXY tells Express how many proxy hops
// to trust when reading the real visitor IP from the X-Forwarded-For header. Unset locally.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY));
}

app.use('/api', apiLimiter); // general cap on every API route

// Health check: confirms the server is up AND can reach the database
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1'); // the simplest possible query: "are you there?"
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error('Database check failed:', err.message);
    res.status(503).json({ status: 'error', database: 'unreachable' }); // 503 = Service Unavailable
  }
});

// Account routes: /api/auth/register, /api/auth/login, /api/auth/me
app.use('/api/auth', authRoutes);

// User management (admins only): /api/users, /api/users/:id/role
app.use('/api/users', userRoutes);

// Tickets and their comments: /api/tickets, /api/tickets/:id, /api/tickets/:id/comments, /api/tickets/assignees
app.use('/api/tickets', ticketRoutes);

// Ticket categories (everyone reads, admins manage): /api/categories, /api/categories/:id
app.use('/api/categories', categoryRoutes);

// Error handler: catches anything a route throws (Express 5 forwards async errors here automatically).
// Logs the details for us, but only sends a generic message so internals never leak to the browser.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

export default app;
