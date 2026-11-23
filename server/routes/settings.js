// Settings API: help desk settings an admin can change from the app. For now, one: whether new
// tickets are auto-assigned (see services/autoAssign.js). Kept in app_settings, a one-row table.
//
// Mounted at /api/settings (see app.js).

import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ADMINS, STAFF } from '../roles.js';
import { blockDemo } from '../services/demo.js';

const router = Router();

router.use(requireAuth);

/** The settings, with who changed them last. */
async function loadSettings() {
  const result = await pool.query(
    `SELECT s.auto_assign, s.updated_at, u.name AS updated_by_name
       FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by`
  );
  return result.rows[0];
}

/**
 * GET /api/settings
 * Access: staff (the Tickets page shows whether auto-assign is on).
 */
router.get('/', requireRole(...STAFF), async (req, res) => {
  res.json({ settings: await loadSettings() });
});

/**
 * PUT /api/settings
 * Turns auto-assign on or off. Tickets already assigned stay as they are.
 * Access: admins and owners.
 * Body: { auto_assign: boolean }
 */
router.put('/', requireRole(...ADMINS), blockDemo, async (req, res) => {
  const autoAssign = req.body?.auto_assign;
  if (typeof autoAssign !== 'boolean') {
    return res.status(400).json({ error: 'auto_assign must be true or false' });
  }
  await pool.query('UPDATE app_settings SET auto_assign = $1, updated_by = $2, updated_at = NOW()', [autoAssign, req.user.id]);
  res.json({ settings: await loadSettings() });
});

export default router;
