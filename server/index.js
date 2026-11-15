// Load variables from .env into process.env (must run before anything reads them)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pool from './db/index.js';

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

app.listen(PORT, () => {
  console.log(`ResolveIT API listening on http://localhost:${PORT}`);
});
