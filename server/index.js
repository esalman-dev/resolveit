// Load variables from .env into process.env (must run before anything reads them)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware: runs on every request before it reaches a route
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' })); // only our React app may call the API
app.use(express.json()); // parse JSON request bodies into req.body

// Health check: a quick way to confirm the server is up
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`ResolveIT API listening on http://localhost:${PORT}`);
});
