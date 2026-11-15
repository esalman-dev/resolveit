// Account routes: sign up, log in, and "who am I?"
// Mounted in index.js at /api/auth, so these become /api/auth/register, /api/auth/login, /api/auth/me
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const googleClient = new OAuth2Client(); // checks Google ID tokens (downloads + caches Google's public keys)

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

  // bcrypt.compare hashes the attempt with the stored salt and checks for a match.
  // Google-only accounts have no password_hash, so they can't log in this way.
  const passwordOk = user?.password_hash && (await bcrypt.compare(password, user.password_hash));

  // Same message whether the email or the password was wrong, so attackers
  // can't use this form to discover which emails have accounts
  if (!passwordOk) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { password_hash, ...safeUser } = user; // strip the hash before sending the user back
  res.json({ user: safeUser, token: createToken(safeUser) });
});

// POST /api/auth/google: "Sign in with Google"
// The browser gets an ID token from Google and sends it here as { credential }.
// We verify it really came from Google, then log the person in with OUR OWN token.
router.post('/google', async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({ error: 'Google sign-in is not set up on this server' });
  }
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential' });
  }

  // 1. Verify Google's token: checks Google's signature, that it was issued FOR OUR APP
  //    (audience = our client ID, so a token made for some other website is rejected), and expiry.
  let google;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
    google = ticket.getPayload(); // { sub, email, email_verified, name, ... }
  } catch {
    return res.status(401).json({ error: 'Google sign-in failed, please try again' });
  }

  const fields = 'id, name, email, role';

  // 2. Returning Google user? Match on Google's permanent ID.
  let result = await pool.query(`SELECT ${fields} FROM users WHERE google_id = $1`, [google.sub]);
  let user = result.rows[0];

  if (!user) {
    // Only trust the email if Google has verified the person owns it. Otherwise someone could
    // create a Google account using YOUR email address and take over your ResolveIT account.
    if (!google.email_verified) {
      return res.status(401).json({ error: 'Your Google email address is not verified' });
    }
    const email = google.email.toLowerCase();

    // 3. Already signed up with a password using this email? Link Google to that account.
    result = await pool.query(
      `UPDATE users SET google_id = $1 WHERE email = $2 RETURNING ${fields}`,
      [google.sub, email]
    );
    user = result.rows[0];

    // 4. Brand-new person: create the account (no password, role defaults to 'user')
    if (!user) {
      result = await pool.query(
        `INSERT INTO users (name, email, google_id) VALUES ($1, $2, $3) RETURNING ${fields}`,
        [google.name || email.split('@')[0], email, google.sub]
      );
      user = result.rows[0];
    }
  }

  res.json({ user, token: createToken(user) });
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
