// Authentication middleware: the "bouncer" that checks a login token before a route runs.
// Usage: app.get('/api/something', requireAuth, handler)
import jwt from 'jsonwebtoken';
import pool from '../db/index.js';

export function requireAuth(req, res, next) {
  // The client sends the token in a header like:  Authorization: Bearer eyJhbGciOi...
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Not logged in' }); // 401 = Unauthorized (we don't know who you are)
  }

  try {
    // verify() checks the signature AND the expiry. If either is bad, it throws.
    // algorithms: only accept the one method we sign with (HS256). Old JWT libraries could be
    // tricked by a token claiming a different method; naming ours closes that door for good.
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // Attach the logged-in user to the request so later code can use req.user.id / req.user.role
    req.user = { id: Number(payload.sub), role: payload.role }; // Number(): so id comparisons work with ===
    next(); // let the request continue to the route
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid, please log in again' });
  }
}

// Authorization middleware: "you're logged in, but are you ALLOWED to do this?"
// Usage: router.get('/api/users', requireAuth, requireRole('admin'), handler)
// Must run AFTER requireAuth, which is what sets req.user.
export function requireRole(...allowedRoles) {
  // This returns the actual middleware. Writing it as a function that builds middleware lets
  // each route list its own allowed roles: requireRole('admin') or requireRole('technician', 'admin').
  return async (req, res, next) => {
    // Check the role in the DATABASE, not the one inside the token. A token is a snapshot from
    // when it was issued (up to 15 min ago), and we can't delete a token that's already in
    // someone's browser. Looking it up here makes demotions instant: one fast primary-key
    // lookup, and only on routes that need a specific role.
    // The same lookup also catches DISABLED accounts, so disabling someone locks them out
    // at once, even with a 15-minute access token still in their browser.
    const result = await pool.query('SELECT role, disabled_at FROM users WHERE id = $1', [req.user.id]);
    const account = result.rows[0]; // undefined if the account was deleted
    const currentRole = account?.role;

    if (!account) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }
    if (account.disabled_at) {
      return res.status(401).json({ error: 'This account has been disabled. Contact an administrator.' });
    }
    req.user.role = currentRole; // later code sees the up-to-date role too

    if (!allowedRoles.includes(currentRole)) {
      // 403 = Forbidden: we know who you are (unlike 401), you just don't have permission
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}
