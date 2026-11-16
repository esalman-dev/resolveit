// Auth middleware: checks who is calling (requireAuth) and what they may do (requireRole).
//
// Usage: router.get('/path', requireAuth, requireRole('admin', 'owner'), handler)

import jwt from 'jsonwebtoken';
import pool from '../db/index.js';

/**
 * Checks the access token and sets req.user = { id, role }.
 * Answers 401 if the token is missing, forged or expired.
 *
 * The client sends the token in a header: `Authorization: Bearer eyJhbGciOi...`
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Not logged in' }); // 401: we don't know who you are
  }

  try {
    // verify() checks the signature and the expiry, and throws if either is bad.
    // Security: only accept HS256, the one algorithm we sign with. Some JWT libraries could be
    // tricked by a token that names a different algorithm in its header.
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    req.user = { id: Number(payload.sub), role: payload.role }; // Number() so id comparisons work with ===
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid, please log in again' });
  }
}

/**
 * Builds middleware that only lets the listed roles through. Must run after requireAuth.
 * Answers 401 for a deleted or disabled account, and 403 for a role that isn't allowed.
 *
 * Why: the role is read from the database, not from the token. A token is a snapshot from when
 * it was issued (up to 15 minutes ago) and can't be taken back from a browser. Reading the
 * database makes demotions and disabled accounts take effect at once, for the cost of one fast
 * primary-key lookup. It also refreshes req.user.role for the route.
 *
 * @param {...string} allowedRoles e.g. requireRole('technician', 'admin', 'owner')
 */
export function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    const result = await pool.query('SELECT role, disabled_at FROM users WHERE id = $1', [req.user.id]);
    const account = result.rows[0]; // undefined if the account was deleted
    const currentRole = account?.role;

    if (!account) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    if (account.disabled_at) {
      return res.status(401).json({ error: 'This account has been disabled. Contact an administrator.' });
    }
    req.user.role = currentRole; // later code sees the up-to-date role

    if (!allowedRoles.includes(currentRole)) {
      // 403: we know who you are (unlike 401), but you don't have permission.
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}
