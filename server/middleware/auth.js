// Authentication middleware: the "bouncer" that checks a login token before a route runs.
// Usage: app.get('/api/something', requireAuth, handler)
import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  // The client sends the token in a header like:  Authorization: Bearer eyJhbGciOi...
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Not logged in' }); // 401 = Unauthorized (we don't know who you are)
  }

  try {
    // verify() checks the signature AND the expiry. If either is bad, it throws.
    const payload = jwt.verify(token, process.env.JWT_SECRET);

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
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user?.role)) {
      // 403 = Forbidden: we know who you are (unlike 401), you just don't have permission
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}
