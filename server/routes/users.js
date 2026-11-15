// User management (admins only): list everyone, change someone's role.
// Mounted in index.js at /api/users
import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const ROLES = ['user', 'technician', 'admin']; // must match the CHECK constraint in schema.sql

// Every route in this file: must be logged in AND an admin.
// router.use() applies them to all routes below, so no route can accidentally forget the check.
router.use(requireAuth, requireRole('admin'));

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
  const { role } = req.body;

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  }

  // Admins can't change their OWN role. This guarantees there's always at least one admin:
  // the only way to remove an admin is for a DIFFERENT admin to do it.
  if (id === req.user.id) {
    return res.status(400).json({ error: "You can't change your own role" });
  }

  const result = await pool.query(
    'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role',
    [role, id]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Note: the user's current access token still carries their OLD role for up to 15 minutes.
  // Their next token refresh reads the new role from the database.
  res.json({ user: result.rows[0] });
});

export default router;
