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
    req.user = { id: payload.sub, role: payload.role };
    next(); // let the request continue to the route
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid, please log in again' });
  }
}
