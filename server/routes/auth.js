// Auth API: sign up, log in (password or Google), stay logged in, log out, change your password,
// and "who am I?".
//
// Two tokens:
//   Access token:  a short-lived JWT (15 minutes), kept in the browser's memory and sent in the
//                  Authorization header.
//   Refresh token: a random string (30 days), kept in an httpOnly cookie that JavaScript can't
//                  read. Its only job is getting a new access token. Stored hashed in the
//                  refresh_tokens table, so it can be revoked.
//
// Mounted at /api/auth (see app.js).

import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, signupLimiter } from '../middleware/rateLimit.js';
import { DEMO_LOGINS, blockDemo, demoMode, signupOpen } from '../services/demo.js';

const router = Router();
const googleClient = new OAuth2Client(); // checks Google ID tokens (downloads and caches Google's public keys)

// --- Settings ---

const SALT_ROUNDS = 12; // bcrypt cost: 2^12 rounds, about 0.25 s per hash; slow on purpose
const ACCESS_TOKEN_LIFETIME = '15m'; // a stolen access token is useless within minutes
const REFRESH_DAYS = 30; // "stay logged in" window; resets every time the app is used
const MAX_SESSION_DAYS = 90; // hard limit: log in again after 90 days, however active you are
const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_COOKIE = 'resolveit_refresh';
export const MAX_NAME = 100; // characters
const MAX_EMAIL = 254; // the longest a valid email address can be
const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything past 72 bytes, so longer passwords are refused

/**
 * A real bcrypt hash of a throwaway password, made once at startup.
 *
 * Security: login compares against it when the email doesn't exist, so an unknown email takes
 * as long as a wrong password. Otherwise the response time would reveal which emails have
 * accounts (a timing attack), even though the message is the same.
 */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);
const DISABLED_MESSAGE = 'This account has been disabled. Contact an administrator.';
const SIGNUP_CLOSED = 'New accounts are switched off on this site. Use the Try the demo buttons instead.';

const cookieOptions = {
  httpOnly: true, // JavaScript can't read it, so an XSS bug can't steal it
  secure: process.env.NODE_ENV === 'production', // HTTPS only once deployed (localhost is plain http)
  sameSite: 'strict', // never sent on requests started by other websites (blocks CSRF)
  path: '/api/auth', // only sent to auth routes, not with every API call
};

// --- Helpers ---

/**
 * Signs a 15-minute access token holding the user's id and role.
 * Anyone can read a JWT's contents, so nothing secret goes inside.
 */
function createAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role }, // "sub" (subject) is the standard JWT field for "who"
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_LIFETIME }
  );
}

/**
 * Checks a new password against the rules (sign-up and "Change password" share them).
 * @returns {string | null} what's wrong with it, or null if it's fine
 */
function checkNewPassword(password) {
  if (password.length < 8) return 'Password must be at least 8 characters';
  // Note: this counts bytes, not characters. An emoji is 1 character but 4 bytes, and bcrypt counts bytes.
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return 'Password is too long (maximum 72 bytes, about 72 letters)';
  return null;
}

/**
 * Hashes a refresh token with SHA-256.
 *
 * Why: a fast hash is fine here, unlike for passwords. The token is 256 random bits, so there's
 * nothing to guess; the hash only means a database leak can't be turned into logins.
 */
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * Logs a user in on this browser: saves a new refresh token, sets the cookie, and returns a
 * fresh access token.
 *
 * @param sessionStartedAt when the user originally logged in. "Now" for a new login; carried
 *   over from the old token when /refresh rotates it, so the 90-day limit keeps counting.
 */
async function startSession(res, user, sessionStartedAt = new Date()) {
  const raw = crypto.randomBytes(32).toString('base64url'); // 256 bits of randomness

  // Expires 30 days from now, but never later than 90 days after the original login.
  const expiresAt = new Date(Math.min(
    Date.now() + REFRESH_DAYS * DAY_MS,
    sessionStartedAt.getTime() + MAX_SESSION_DAYS * DAY_MS
  ));

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_started_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, hashToken(raw), expiresAt, sessionStartedAt]
  );
  // Housekeeping: expired rows are useless, so clear them out while we're here.
  await pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');

  res.cookie(REFRESH_COOKIE, raw, { ...cookieOptions, expires: expiresAt });
  return createAccessToken(user);
}

/** Clears the refresh cookie and sends an error. */
function endSession(res, status, error) {
  res.clearCookie(REFRESH_COOKIE, cookieOptions); // same options, or the browser won't match the cookie
  return res.status(status).json({ error });
}

// --- Routes ---

/**
 * POST /api/auth/register
 * Creates an account and logs it in. Answers 409 if the email is taken.
 * Access: anyone (rate limited).
 * Body: { name, email, password }
 */
router.post('/register', signupLimiter, async (req, res) => {
  if (!signupOpen()) return res.status(403).json({ error: SIGNUP_CLOSED });
  const body = req.body ?? {};
  // Anything that isn't text (a number, a list) counts as missing.
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''; // "Bob@X.com" = "bob@x.com"
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (name.length > MAX_NAME) {
    return res.status(400).json({ error: `Name must be ${MAX_NAME} characters or fewer` });
  }
  if (email.length > MAX_EMAIL || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  const passwordProblem = checkNewPassword(password);
  if (passwordProblem) return res.status(400).json({ error: passwordProblem });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS); // the real password is never stored

  try {
    // Security: the role is never taken from the request. Everyone signs up as 'user' (the
    // column default), otherwise anyone could send { role: 'admin' } and promote themselves.
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role, job_title, department`,
      [name, email, passwordHash]
    );
    const user = result.rows[0];
    res.status(201).json({ user, token: await startSession(res, user) });
  } catch (err) {
    if (err.code === '23505') { // PostgreSQL: unique constraint violated (email taken)
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    throw err; // anything else goes to the error handler in app.js (500)
  }
});

/**
 * POST /api/auth/login
 * Checks an email and password and logs the user in.
 * Answers 401 for a wrong email or password, 403 for a disabled account.
 * Access: anyone (rate limited).
 * Body: { email, password }
 */
router.post('/login', loginLimiter, async (req, res) => {
  const body = req.body ?? {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const result = await pool.query(
    'SELECT id, name, email, role, job_title, department, password_hash, disabled_at FROM users WHERE email = $1',
    [email]
  );
  const user = result.rows[0];

  // Security: always run bcrypt, against DUMMY_HASH when there's no such user, so every failed
  // login takes the same time. Google-only accounts have no password_hash and can't log in here.
  const matches = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  const passwordOk = Boolean(user?.password_hash) && matches;

  // Security: the same message for a wrong email and a wrong password, so this form can't be
  // used to find out which emails have accounts.
  if (!passwordOk) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Only revealed after a correct password, so a stranger learns nothing.
  if (user.disabled_at) {
    return res.status(403).json({ error: DISABLED_MESSAGE });
  }

  const { password_hash, disabled_at, ...safeUser } = user; // strip internal fields before sending
  res.json({ user: safeUser, token: await startSession(res, safeUser) });
});

/**
 * POST /api/auth/google
 * Signs in with Google. The browser gets an ID token from Google and sends it here; we check
 * it really came from Google for our app, then log the person in with our own tokens.
 * Access: anyone (rate limited).
 * Body: { credential }
 */
router.post('/google', loginLimiter, async (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({ error: 'Google sign-in is not set up on this server' });
  }
  const { credential } = req.body ?? {};
  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential' });
  }

  // Step 1: verify the token. Checks Google's signature, the expiry, and that it was issued for
  // our app (audience = our client ID), so a token made for another website is rejected.
  let google;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
    google = ticket.getPayload(); // { sub, email, email_verified, name, ... }
  } catch {
    return res.status(401).json({ error: 'Google sign-in failed, please try again' });
  }

  const fields = 'id, name, email, role, job_title, department, disabled_at'; // fixed text from our code, safe to build into SQL
  const googleEmail = google.email?.toLowerCase();

  // Step 2: a returning Google user, matched on Google's permanent id ("sub"), not the email.
  let result = await pool.query(`SELECT ${fields} FROM users WHERE google_id = $1`, [google.sub]);
  let user = result.rows[0];

  if (user) {
    // Keep the email in sync if it changed at Google (only a verified one). If another account
    // already uses the new email, the unique rule refuses (23505) and we keep the old one:
    // logging in matters more than the sync.
    if (google.email_verified && googleEmail && googleEmail !== user.email) {
      try {
        result = await pool.query(`UPDATE users SET email = $1 WHERE id = $2 RETURNING ${fields}`, [googleEmail, user.id]);
        user = result.rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
  } else {
    // Security: only trust the email if Google verified that the person owns it. Otherwise
    // someone could make a Google account with your address and take over your account.
    if (!google.email_verified) {
      return res.status(401).json({ error: 'Your Google email address is not verified' });
    }

    // Step 3: an existing password account with this email gets Google linked to it.
    // Security: only if it has no Google link yet (AND google_id IS NULL). Otherwise a second
    // Google account with the same email would silently replace the first link.
    result = await pool.query(
      `UPDATE users SET google_id = $1 WHERE email = $2 AND google_id IS NULL RETURNING ${fields}`,
      [google.sub, googleEmail]
    );
    user = result.rows[0];

    if (!user) {
      const taken = await pool.query('SELECT 1 FROM users WHERE email = $1', [googleEmail]);
      if (taken.rowCount > 0) {
        // The email exists but is linked to a different Google account.
        return res.status(409).json({ error: 'This email is already linked to a different Google account' });
      }

      // Step 4: a brand-new person. No password; the role defaults to 'user'.
      if (!signupOpen()) return res.status(403).json({ error: SIGNUP_CLOSED });
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

/**
 * POST /api/auth/refresh
 * Swaps the refresh cookie for a new access token (and a new refresh cookie).
 * Called when the app opens, to restore the login, and whenever the access token expires.
 * Access: anyone with a valid refresh cookie.
 */
router.post('/refresh', async (req, res) => {
  const raw = req.cookies[REFRESH_COOKIE];
  if (!raw) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  // Joined with users, so the name, role and disabled state come fresh from the database.
  const result = await pool.query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.session_started_at,
            u.name, u.email, u.role, u.job_title, u.department, u.disabled_at
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`,
    [hashToken(raw)]
  );
  const session = result.rows[0];

  if (!session) {
    return endSession(res, 401, 'Not logged in');
  }

  // Security (reuse detection): each refresh token works once. If a used one comes back,
  // someone copied it. We can't tell whether the attacker or the real user holds the newer
  // one, so every session this user has is revoked.
  if (session.revoked_at) {
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [session.user_id]
    );
    return endSession(res, 401, 'Session ended for your security, please log in again');
  }

  // Disabling an account already revokes its sessions; this is a backstop.
  if (session.disabled_at) {
    return endSession(res, 401, DISABLED_MESSAGE);
  }

  // Covers both limits: 30 days unused, and 90 days in total (expires_at was capped at creation).
  if (session.expires_at < new Date()) {
    return endSession(res, 401, 'Session expired, please log in again');
  }

  // Rotation: retire this token and issue a new one. "AND revoked_at IS NULL" makes it atomic:
  // if two requests race with the same token, only one of them wins.
  const retired = await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
    [session.id]
  );
  if (retired.rowCount === 0) {
    return endSession(res, 401, 'Session expired, please log in again');
  }

  const user = {
    id: session.user_id,
    name: session.name,
    email: session.email,
    role: session.role,
    job_title: session.job_title,
    department: session.department,
  };
  // Pass the original login time along, so the 90-day clock keeps running across rotations.
  res.json({ user, token: await startSession(res, user, session.session_started_at) });
});

/**
 * POST /api/auth/logout
 * Revokes this browser's refresh token and deletes the cookie. The client throws away its
 * 15-minute access token itself. Answers 204 (success, nothing to send back).
 * Access: anyone.
 */
router.post('/logout', async (req, res) => {
  const raw = req.cookies[REFRESH_COOKIE];
  if (raw) {
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(raw)]
    );
  }
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.status(204).end();
});

/**
 * POST /api/auth/demo
 * "Try as a user / technician / admin" on the live site: logs straight into one of the shared
 * demo accounts, no password needed. Only in demo mode; anywhere else it answers 404.
 * Security: only the three demo accounts can be reached this way, and in demo mode they can't
 * make admin changes (blockDemo). They're ordinary accounts otherwise, with the normal limits.
 * Access: anyone.
 * Body: { as: 'user' | 'technician' | 'admin' }
 */
router.post('/demo', loginLimiter, async (req, res) => {
  if (!demoMode()) return res.status(404).json({ error: 'Not found' });
  const login = Object.hasOwn(DEMO_LOGINS, req.body?.as) ? DEMO_LOGINS[req.body.as] : null;
  if (!login) return res.status(400).json({ error: 'as must be user, technician or admin' });
  const found = await pool.query(
    'SELECT id, name, email, role, job_title, department, disabled_at FROM users WHERE email = $1',
    [login.email]
  );
  const user = found.rows[0];
  // Missing between the nightly reset's delete and re-create, or never seeded.
  if (!user || user.disabled_at) return res.status(503).json({ error: 'The demo is being reset. Try again in a minute.' });
  const { disabled_at, ...safeUser } = user;
  res.json({ user: safeUser, token: await startSession(res, safeUser) });
});

/**
 * POST /api/auth/password
 * Changes your password, after checking the current one. Logs you out everywhere else (every
 * other "stay logged in" session is ended), and writes "changed their password" to the history.
 * Answers 400 for a wrong current password, not 401: 401 would mean "your session is gone" to the
 * app, and log you out here too.
 * Security: wrong current passwords count toward the same limit as failed logins (10 per 15
 * minutes), so this can't be used to guess someone's password from a borrowed session.
 * Access: anyone logged in with a password (Google-only accounts have none).
 * Body: { current_password, new_password }
 */
router.post('/password', requireAuth, blockDemo, loginLimiter, async (req, res) => {
  const body = req.body ?? {};
  const current = typeof body.current_password === 'string' ? body.current_password : '';
  const next = typeof body.new_password === 'string' ? body.new_password : '';

  const row = (await pool.query('SELECT password_hash, disabled_at FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!row || row.disabled_at) return res.status(401).json({ error: row ? DISABLED_MESSAGE : 'Account no longer exists' });
  if (!row.password_hash) {
    return res.status(400).json({ error: "You sign in with Google, so there's no ResolveIT password to change." });
  }
  if (!current || !(await bcrypt.compare(current, row.password_hash))) {
    return res.status(400).json({ error: 'Your current password is wrong' });
  }
  const problem = checkNewPassword(next);
  if (problem) return res.status(400).json({ error: problem });

  const hash = await bcrypt.hash(next, SALT_ROUNDS);
  // This browser's session stays; every other one ends (another device, or someone else who had
  // the old password). Why this route is under /api/auth: the session cookie is only sent there.
  // Without a cookie there is no "this browser", so all of them end.
  const thisSession = req.cookies[REFRESH_COOKIE] ? hashToken(req.cookies[REFRESH_COOKIE]) : null;
  await withTransaction(async (db) => {
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, hash]);
    // Why delete, not mark revoked: a revoked token coming back trips the reuse alarm in
    // /refresh, which ends every session, this one included. A deleted one is just "not logged in".
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)', [
      req.user.id,
      thisSession,
    ]);
    await db.query("INSERT INTO account_events (user_id, actor_id, action) VALUES ($1, $1, 'password_changed')", [req.user.id]);
  });
  res.status(204).end();
});

/**
 * GET /api/auth/me
 * The logged-in user's profile. Answers 401 for a deleted or disabled account, the same as
 * requireRole: either way the session is no good.
 * Access: anyone logged in.
 */
router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, email, role, job_title, department, created_at, disabled_at FROM users WHERE id = $1',
    [req.user.id]
  );
  const user = result.rows[0];
  if (!user || user.disabled_at) {
    return res.status(401).json({ error: user ? DISABLED_MESSAGE : 'Account no longer exists' });
  }
  const { disabled_at, ...safeUser } = user;
  res.json({ user: safeUser });
});

export default router;
