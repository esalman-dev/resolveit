// User management (admins and owners): list everyone, change someone's role.
// Mounted in app.js at /api/users
import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, ADMINS, canManage, canGrant } from '../roles.js';

const router = Router();

// Every route in this file: must be logged in AND an admin or owner.
// router.use() applies them to all routes below, so no route can accidentally forget the check.
router.use(requireAuth, requireRole(...ADMINS));

// GET /api/users: everyone, oldest first
router.get('/', async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email, role, created_at,
            password_hash IS NOT NULL AS has_password,  -- true/false only; never send the hash itself
            google_id IS NOT NULL     AS has_google
       FROM users
      ORDER BY id`
  );
  res.json({ users: result.rows });
});

// PATCH /api/users/:id/role: change one user's role. Body: { "role": "technician" }
// (PATCH = update part of something; PUT would mean replacing the whole user)
router.patch('/:id/role', async (req, res) => {
  const id = Number(req.params.id);
  const { role } = req.body ?? {};

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  }

  // Nobody can change their OWN role. This is also why there's always at least one owner
  // (or admin): removing one always takes someone else, ranked higher.
  if (id === req.user.id) {
    return res.status(400).json({ error: "You can't change your own role" });
  }

  // Owners are made only on the server (npm run make-owner), never through the website
  if (role === 'owner') {
    return res.status(403).json({ error: 'Owners can only be created on the server' });
  }

  const target = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
  if (target.rowCount === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  // The ranking rule (see roles.js): you can only manage people below you,
  // and only give out roles below your own. req.user.role is fresh from the database (requireRole).
  if (!canManage(req.user.role, target.rows[0].role)) {
    return res.status(403).json({ error: `You can't change the role of an ${target.rows[0].role}` });
  }
  if (!canGrant(req.user.role, role)) {
    return res.status(403).json({ error: `You can't make someone an ${role}` });
  }

  // "AND role = $3": only save if their role is still the one we just checked. If someone else
  // changed it in the split second between the SELECT and now, nothing is updated (no race).
  const result = await pool.query(
    'UPDATE users SET role = $1 WHERE id = $2 AND role = $3 RETURNING id, name, email, role',
    [role, id, target.rows[0].role]
  );
  if (result.rowCount === 0) {
    return res.status(409).json({ error: 'Their role was changed by someone else just now. Reload and try again.' });
  }

  // Takes effect immediately on the server: requireRole reads the role from the database.
  // (Their screen updates on their next token refresh, within 15 minutes.)
  res.json({ user: result.rows[0] });
});

export default router;
