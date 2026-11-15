// Load variables from .env into process.env (must run before anything reads them)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pool from './db/index.js';
import authRoutes from './routes/auth.js';

// Fail fast: without a secret, login tokens can't be signed or checked safely
if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET in server/.env (see .env.example). Server not started.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware: runs on every request before it reaches a route
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' })); // only our React app may call the API
app.use(express.json()); // parse JSON request bodies into req.body

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

// Error handler: catches anything a route throws (Express 5 forwards async errors here automatically).
// Logs the details for us, but only sends a generic message so internals never leak to the browser.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, () => {
  console.log(`ResolveIT API listening on http://localhost:${PORT}`);
});
