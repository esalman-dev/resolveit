// Presence API: which staff are online, and each staff member's own status.
//
// While staff have the app open, their browser checks in once a minute (POST /heartbeat),
// saying whether the mouse or keyboard was used since the last check-in. From that and their
// own choice (Available / Busy / Away), STATUS_SQL works out what others see:
//   offline    not heard from for 2 minutes (the app is closed, or the computer asleep)
//   away       chose Away, or no mouse or keyboard for 15 minutes
//   busy       chose Busy
//   available  otherwise
//
// Why check-ins instead of a live connection: the free server sleeps when idle, and a status
// that's a minute old is plenty for "is anyone around?".
//
// Mounted at /api/presence (see app.js).

import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF } from '../roles.js';

const router = Router();

const OFFLINE_AFTER = '2 minutes';
const IDLE_AFTER = '15 minutes';
const AVAILABILITY = ['available', 'busy', 'away'];

/**
 * The SQL for a user's status, from a users table aliased `alias`.
 * Shared by the dashboard and the "Assign to" list, so every screen agrees.
 * @example `SELECT u.name, ${STATUS_SQL('u')} AS status FROM users u`
 */
export const STATUS_SQL = (alias) => `
  CASE
    WHEN ${alias}.last_seen_at IS NULL OR ${alias}.last_seen_at < NOW() - INTERVAL '${OFFLINE_AFTER}' THEN 'offline'
    WHEN ${alias}.availability = 'away'
      OR ${alias}.last_active_at IS NULL OR ${alias}.last_active_at < NOW() - INTERVAL '${IDLE_AFTER}' THEN 'away'
    WHEN ${alias}.availability = 'busy' THEN 'busy'
    ELSE 'available'
  END`;

router.use(requireAuth);

/** The status of one user, after a change. */
async function myStatus(id) {
  const result = await pool.query(`SELECT u.availability, ${STATUS_SQL('u')} AS status FROM users u WHERE u.id = $1`, [id]);
  return result.rows[0];
}

/**
 * GET /api/presence
 * How many staff are online, and who. Staff also get their own status.
 * Access: anyone logged in. Users get first names and status only.
 */
router.get('/', requireRole(...ROLES), async (req, res) => {
  const result = await pool.query(
    `SELECT u.id, u.name, u.role, ${STATUS_SQL('u')} AS status
       FROM users u
      WHERE u.role <> 'user' AND u.disabled_at IS NULL
      ORDER BY u.name`
  );
  const online = result.rows.filter((r) => r.status !== 'offline');
  const body = { online: online.length, available: online.filter((r) => r.status === 'available').length };
  if (STAFF.includes(req.user.role)) {
    body.staff = online;
    body.me = await myStatus(req.user.id);
  } else {
    // Security: users see who's around on Get help, but only first names and status: no ids,
    // roles or full names (decision P4, changed 2026-11-18).
    body.staff = online.map((r) => ({ name: r.name.split(' ')[0], status: r.status }));
  }
  res.json(body);
});

/**
 * POST /api/presence/heartbeat
 * The once-a-minute check-in while the app is open and visible.
 * Access: staff.
 * Body: { active: boolean } whether the mouse or keyboard was used since the last check-in
 */
router.post('/heartbeat', requireRole(...STAFF), async (req, res) => {
  const active = req.body?.active === true;
  await pool.query(
    `UPDATE users SET last_seen_at = NOW(), last_active_at = CASE WHEN $2 THEN NOW() ELSE last_active_at END
      WHERE id = $1`,
    [req.user.id, active]
  );
  res.json({ me: await myStatus(req.user.id) });
});

/**
 * POST /api/presence/leave
 * Marks you offline at once, when the tab closes or you log out. Without it, you would stay
 * online until the 2 minutes without a check-in run out, and auto-assign could still pick you.
 * Access: anyone logged in (for a user it changes nothing anyone sees).
 */
router.post('/leave', requireRole(...ROLES), async (req, res) => {
  await pool.query('UPDATE users SET last_seen_at = NULL WHERE id = $1', [req.user.id]);
  res.status(204).end();
});

/**
 * PUT /api/presence/me
 * Sets your own status. It counts as a check-in with activity (you just clicked something).
 * Access: staff.
 * Body: { availability: 'available' | 'busy' | 'away' }
 */
router.put('/me', requireRole(...STAFF), async (req, res) => {
  const availability = req.body?.availability;
  if (!AVAILABILITY.includes(availability)) {
    return res.status(400).json({ error: 'Status must be available, busy or away' });
  }
  await pool.query(
    'UPDATE users SET availability = $2, last_seen_at = NOW(), last_active_at = NOW() WHERE id = $1',
    [req.user.id, availability]
  );
  res.json({ me: await myStatus(req.user.id) });
});

export default router;
