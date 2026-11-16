// Account routes: sign up, log in (password or Google), stay logged in (refresh), log out, "who am I?"
// Mounted in index.js at /api/auth, so these become /api/auth/register, /api/auth/login, etc.
//
// Two tokens:
//   ACCESS token  = short-lived JWT (15 min). Kept in the browser's memory, sent in the Authorization header.
//   REFRESH token = long-lived random string (30 days). Kept in an httpOnly cookie that JavaScript can't read.
//                   Its only job is getting a new access token. Stored (hashed) in the DB so we can revoke it.
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import pool from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, signupLimiter } from '../middleware/rateLimit.js';

const router = Router();
const googleClient = new OAuth2Client(); // checks Google ID tokens (downloads + caches Google's public keys)

const SALT_ROUNDS = 12;              // how slow bcrypt is: 2^12 rounds (~0.25s). Slow = hard to brute-force.
const ACCESS_TOKEN_LIFETIME = '15m'; // if one is ever stolen, it's useless within minutes
const REFRESH_DAYS = 30;             // "stay logged in" window; resets every time the app is used
const MAX_SESSION_DAYS = 90;         // hard limit: log in again after 90 days, however active you are
const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_COOKIE = 'resolveit_refresh';
const MAX_NAME = 100;                // characters
const MAX_EMAIL = 254;               // the longest an email address can legally be
const MAX_PASSWORD_BYTES = 72;       // bcrypt silently ignores everything after 72 bytes, so refuse longer ones

// A real bcrypt hash of a throwaway password, made once when the server starts.
// Login compares against it when the email doesn't exist, so "unknown email" takes as long
// as "wrong password" (~0.25 s). Otherwise the speed of the answer would reveal which emails
// have accounts, even though the message is the same.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);
const DISABLED_MESSAGE = 'This account has been disabled. Contact an administrator.';

const cookieOptions = {
  httpOnly: true,                                // JavaScript can't read it, so an XSS bug can't steal it
  secure: process.env.NODE_ENV === 'production', // HTTPS only once deployed (localhost is plain http)
  sameSite: 'strict',                            // never sent on requests started by other websites (blocks CSRF)
  path: '/api/auth',                             // only sent to auth routes, not with every API call
};

// Build a signed access token holding only the user's id and role (anyone can READ a JWT, so no secrets inside)
function createAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role }, // "sub" (subject) is the standard JWT field for "who this is"
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_LIFETIME }
  );
}

// SHA-256 (fast) is fine here, unlike passwords: the token is 256 random bits, so there's nothing to guess
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// Save a new refresh token, set the cookie, return a fresh access token.
// sessionStartedAt = when the user originally logged in: "now" for a new login,
// or carried over from the old token when /refresh rotates it.
async function startSession(res, user, sessionStartedAt = new Date()) {
  const raw = crypto.randomBytes(32).toString('base64url'); // 256 bits of randomness

  // Expires 30 days from now, but never later than 90 days after the original login
  const expiresAt = new Date(Math.min(
    Date.now() + REFRESH_DAYS * DAY_MS,
    sessionStartedAt.getTime() + MAX_SESSION_DAYS * DAY_MS
  ));

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_started_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, hashToken(raw), expiresAt, sessionStartedAt]
  );
  // Housekeeping: expired rows are useless, so clear them out while we're here
  await pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');

  res.cookie(REFRESH_COOKIE, raw, { ...cookieOptions, expires: expiresAt });
  return createAccessToken(user);
}

function endSession(res, status, error) {
  res.clearCookie(REFRESH_COOKIE, cookieOptions); // same options, or the browser won't match the cookie
  return res.status(status).json({ error });
}

// POST /api/auth/register: create a new account
router.post('/register', signupLimiter, async (req, res) => {
  const body = req.body ?? {};
  // typeof checks: someone could send a number or a list instead of text
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''; // "Bob@X.com" = "bob@x.com"
  const password = typeof body.password === 'string' ? body.password : '';

  // Validate input before touching the database
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' }); // 400 = Bad Request
  }
  if (name.length > MAX_NAME) {
    return res.status(400).json({ error: `Name must be ${MAX_NAME} characters or fewer` });
  }
  if (email.length > MAX_EMAIL || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  // Bytes, not characters: an emoji is 1 character but 4 bytes, and bcrypt counts bytes
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return res.status(400).json({ error: 'Password is too long (maximum 72 bytes, about 72 letters)' });
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
    res.status(201).json({ user, token: await startSession(res, user) }); // 201 = Created
  } catch (err) {
    if (err.code === '23505') { // PostgreSQL's code for "UNIQUE constraint violated"
      return res.status(409).json({ error: 'An account with that email already exists' }); // 409 = Conflict
    }
    throw err; // anything else is a real server error (Express 5 sends it to the error handler)
  }
});

// POST /api/auth/login: check email + password, hand back a token
router.post('/login', loginLimiter, async (req, res) => {
  const body = req.body ?? {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const result = await pool.query(
    'SELECT id, name, email, role, password_hash, disabled_at FROM users WHERE email = $1',
    [email]
  );
  const user = result.rows[0];

  // bcrypt.compare hashes the attempt with the stored salt and checks for a match.
  // ALWAYS run it, even when there's no such user (against DUMMY_HASH), so every failed
  // login takes the same time. Google-only accounts have no password_hash, so they can't
  // log in this way either.
  const matches = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  const passwordOk = Boolean(user?.password_hash) && matches;

  // Same message whether the email or the password was wrong, so attackers
  // can't use this form to discover which emails have accounts
  if (!passwordOk) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Only said AFTER a correct password, so it doesn't reveal anything to a stranger
  if (user.disabled_at) {
    return res.status(403).json({ error: DISABLED_MESSAGE });
  }

  const { password_hash, disabled_at, ...safeUser } = user; // strip internal fields before sending the user back
  res.json({ user: safeUser, token: await startSession(res, safeUser) });
});

// POST /api/auth/google: "Sign in with Google"
// The browser gets an ID token from Google and sends it here as { credential }.
// We verify it really came from Google, then log the person in with OUR OWN token.
router.post('/google', loginLimiter, async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({ error: 'Google sign-in is not set up on this server' });
  }
  const { credential } = req.body ?? {};
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

  const fields = 'id, name, email, role, disabled_at';
  const googleEmail = google.email?.toLowerCase();

  // 2. Returning Google user? Match on Google's permanent ID.
  let result = await pool.query(`SELECT ${fields} FROM users WHERE google_id = $1`, [google.sub]);
  let user = result.rows[0];

  if (user) {
    // Keep the email in sync if they changed it at Google (only a verified one).
    // If another ResolveIT account already uses the new email, the UNIQUE rule refuses (23505)
    // and we simply keep the old email: logging in matters more than the sync.
    if (google.email_verified && googleEmail && googleEmail !== user.email) {
      try {
        result = await pool.query(`UPDATE users SET email = $1 WHERE id = $2 RETURNING ${fields}`, [googleEmail, user.id]);
        user = result.rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
  } else {
    // Only trust the email if Google has verified the person owns it. Otherwise someone could
    // create a Google account using YOUR email address and take over your ResolveIT account.
    if (!google.email_verified) {
      return res.status(401).json({ error: 'Your Google email address is not verified' });
    }

    // 3. Already signed up with a password using this email? Link Google to that account,
    //    but ONLY if it isn't linked to a Google account yet ("AND google_id IS NULL").
    //    Otherwise a second Google account with the same email would silently replace the first.
    result = await pool.query(
      `UPDATE users SET google_id = $1 WHERE email = $2 AND google_id IS NULL RETURNING ${fields}`,
      [google.sub, googleEmail]
    );
    user = result.rows[0];

    if (!user) {
      const taken = await pool.query('SELECT 1 FROM users WHERE email = $1', [googleEmail]);
      if (taken.rowCount > 0) {
        // The email exists but is already linked to a DIFFERENT Google account
        return res.status(409).json({ error: 'This email is already linked to a different Google account' });
      }

      // 4. Brand-new person: create the account (no password, role defaults to 'user')
      result = await pool.query(
        `INSERT INTO users (name, email, google_id) VALUES ($1, $2, $3) RETURNING ${fields}`,
        [(google.name || googleEmail.split('@')[0]).slice(0, MAX_NAME), googleEmail, google.sub]
      );
      user = result.rows[0];
    }
  }

  if (user.disabled_at) {
    return res.status(403).json({ error: DISABLED_MESSAGE });
  }
  const { disabled_at, ...safeUser } = user;
  res.json({ user: safeUser, token: await startSession(res, safeUser) });
});

// POST /api/auth/refresh: "I have a refresh cookie, give me a new access token"
// Called when the app opens (to restore your login) and whenever the access token expires.
router.post('/refresh', async (req, res) => {
  const raw = req.cookies[REFRESH_COOKIE];
  if (!raw) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const result = await pool.query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.session_started_at,
            u.name, u.email, u.role, u.disabled_at
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`,
    [hashToken(raw)]
  );
  const session = result.rows[0];

  if (!session) {
    return endSession(res, 401, 'Not logged in');
  }

  // REUSE DETECTION: each refresh token works exactly once (see "rotation" below).
  // If an already-used one shows up again, someone copied it. We can't tell whether the
  // attacker or the real user is holding the newer one, so we log out ALL of this user's sessions.
  if (session.revoked_at) {
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [session.user_id]
    );
    return endSession(res, 401, 'Session ended for your security, please log in again');
  }

  // A disabled account can't refresh. (Disabling also revokes every session, so this is a backstop.)
  if (session.disabled_at) {
    return endSession(res, 401, DISABLED_MESSAGE);
  }

  // Covers both limits: 30 days unused, and the 90-day maximum (expires_at is capped at login + 90 days)
  if (session.expires_at < new Date()) {
    return endSession(res, 401, 'Session expired, please log in again');
  }

  // ROTATION: retire this token and issue a brand-new one (with a fresh 30 days).
  // "AND revoked_at IS NULL" makes this atomic: if two requests race, only one wins.
  const retired = await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
    [session.id]
  );
  if (retired.rowCount === 0) {
    return endSession(res, 401, 'Session expired, please log in again');
  }

  // Name and role come fresh from the database, so a role change takes effect on the next refresh
  const user = { id: session.user_id, name: session.name, email: session.email, role: session.role };
  // Pass the ORIGINAL login time along, so the 90-day clock keeps running across rotations
  res.json({ user, token: await startSession(res, user, session.session_started_at) });
});

// POST /api/auth/logout: revoke this browser's refresh token and delete the cookie.
// (The 15-minute access token in memory is simply thrown away by the client.)
router.post('/logout', async (req, res) => {
  const raw = req.cookies[REFRESH_COOKIE];
  if (raw) {
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(raw)]
    );
  }
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.status(204).end(); // 204 = No Content: success, nothing to send back
});

// GET /api/auth/me: "who am I?" Protected: requireAuth runs first and sets req.user
router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, email, role, created_at, disabled_at FROM users WHERE id = $1',
    [req.user.id]
  );
  const user = result.rows[0];
  // 401 (not 404) for a deleted or disabled account, the same as requireRole:
  // either way the answer is "your session is no good, log in again"
  if (!user || user.disabled_at) {
    return res.status(401).json({ error: user ? DISABLED_MESSAGE : 'Account no longer exists' });
  }
  const { disabled_at, ...safeUser } = user;
  res.json({ user: safeUser });
});

export default router;
