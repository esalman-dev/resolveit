// Account routes: sign up, log in, and "who am I?"
// Mounted in index.js at /api/auth, so these become /api/auth/register, /api/auth/login, /api/auth/me
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const SALT_ROUNDS = 12;      // how slow bcrypt is: 2^12 rounds (~0.25s). Slow = hard to brute-force.
const TOKEN_LIFETIME = '1h'; // short expiry limits the damage if a token is ever stolen

// Build a signed token holding only the user's id and role (anyone can READ a JWT, so no secrets inside)
function createToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role }, // "sub" (subject) is the standard JWT field for "who this is"
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_LIFETIME }
  );
}

// POST /api/auth/register: create a new account
router.post('/register', async (req, res) => {
  const name = req.body.name?.trim();
  const email = req.body.email?.trim().toLowerCase(); // so "Bob@X.com" and "bob@x.com" are the same account
  const password = req.body.password;

  // Validate input before touching the database
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' }); // 400 = Bad Request
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS); // never store the real password

  try {
    // $1, $2, $3 are placeholders: pg fills them in safely, which prevents SQL injection.
    // Role is NOT taken from the request: everyone signs up as 'user' (the DB default).
    // Otherwise anyone could send { role: 'admin' } and promote themselves.
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role`,
      [name, email, passwordHash]
    );
    const user = result.rows[0];
    res.status(201).json({ user, token: createToken(user) }); // 201 = Created
  } catch (err) {
    if (err.code === '23505') { // PostgreSQL's code for "UNIQUE constraint violated"
      return res.status(409).json({ error: 'An account with that email already exists' }); // 409 = Conflict
    }
    throw err; // anything else is a real server error (Express 5 sends it to the error handler)
  }
});

// POST /api/auth/login: check email + password, hand back a token
router.post('/login', async (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  const password = req.body.password;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const result = await pool.query(
    'SELECT id, name, email, role, password_hash FROM users WHERE email = $1',
    [email]
  );
  const user = result.rows[0];

  // bcrypt.compare hashes the attempt with the stored salt and checks for a match
  const passwordOk = user && (await bcrypt.compare(password, user.password_hash));

  // Same message whether the email or the password was wrong, so attackers
  // can't use this form to discover which emails have accounts
  if (!passwordOk) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { password_hash, ...safeUser } = user; // strip the hash before sending the user back
  res.json({ user: safeUser, token: createToken(safeUser) });
});

// GET /api/auth/me: "who am I?" Protected: requireAuth runs first and sets req.user
router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, email, role, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ error: 'User no longer exists' });
  }
  res.json({ user: result.rows[0] });
});

export default router;
