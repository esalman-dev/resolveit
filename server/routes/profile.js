// Profile API: your own details and (for staff) your numbers. The Profile page.
// Changing your password is POST /api/auth/password (in auth.js, where the session cookie is sent).
//
// Admins change other people's details on the Users screen (PATCH /api/users/:id/details); this
// file is only ever about the person who is logged in.
//
// Mounted at /api/profile (see app.js).

import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF } from '../roles.js';
import { technicianRows } from './dashboard.js';
import { PROFILE_COLUMNS, checkProfileFields, saveProfile } from '../services/profile.js';
import { blockDemo } from '../services/demo.js';

const router = Router();
const STATS_DAYS = 30; // "Your last 30 days"
const DAY_MS = 24 * 60 * 60 * 1000;

router.use(requireAuth, requireRole(...ROLES));

/** Your row, without the internal columns. */
async function loadMe(id) {
  const { disabled_at, ...me } = (await pool.query(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [id])).rows[0];
  return me;
}

/**
 * GET /api/profile
 * Your details, how you sign in, and (staff) your numbers for the last 30 days: the same figures
 * as your row in the dashboard's "You and the team" table, or null if you haven't had any tickets.
 * Access: anyone logged in; only their own.
 */
router.get('/', async (req, res) => {
  const user = await loadMe(req.user.id);
  let stats;
  if (STAFF.includes(user.role)) {
    const to = new Date();
    stats = (await technicianRows(new Date(to - STATS_DAYS * DAY_MS), to, user.id))[0] ?? null;
  }
  res.json({ user, stats, stats_days: STATS_DAYS });
});

/**
 * PATCH /api/profile
 * Changes your name, job title or department. A new name is written to the account history.
 * Access: anyone logged in; only their own.
 * Body (any of): { name, job_title, department } (job_title / department: '' clears it)
 */
router.patch('/', blockDemo, async (req, res) => {
  const checked = checkProfileFields(req.body ?? {});
  if (checked.error) return res.status(400).json({ error: checked.error });
  const user = await withTransaction(async (db) => {
    const me = (await db.query('SELECT id, name, job_title, department FROM users WHERE id = $1 FOR UPDATE', [req.user.id])).rows[0];
    return saveProfile(db, me, checked.fields, req.user.id);
  });
  const { disabled_at, ...safe } = user;
  res.json({ user: safe });
});

export default router;
