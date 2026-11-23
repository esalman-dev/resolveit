// Target times API: how fast each priority should get a first reply and be fixed (the SLA).
//
// Staff read the targets (the ticket list and dashboard use them); admins and owners change
// them. Each ticket's due times are worked out from these on every read (see TICKET_SELECT in
// routes/tickets.js), so a change applies to every open ticket at once.
//
// Mounted at /api/sla-targets (see app.js).

import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ADMINS, STAFF } from '../roles.js';
import { blockDemo } from '../services/demo.js';

const router = Router();

const PRIORITIES = ['urgent', 'high', 'medium', 'low']; // most urgent first, as shown on screen
const MAX_MINUTES = 90 * 24 * 60; // 90 days: anything longer isn't a target

router.use(requireAuth);

/** The targets, most urgent first. */
async function loadTargets() {
  const result = await pool.query(
    `SELECT s.priority, s.first_response_minutes, s.resolve_minutes, s.updated_at, u.name AS updated_by_name
       FROM sla_targets s
       LEFT JOIN users u ON u.id = s.updated_by
      ORDER BY array_position($1::text[], s.priority)`,
    [PRIORITIES]
  );
  return result.rows;
}

/** Checks one minutes value. Returns an error message, or null when it's fine. */
function checkMinutes(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MINUTES) {
    return `${label} must be a whole number of minutes from 1 to ${MAX_MINUTES} (90 days)`;
  }
  return null;
}

/**
 * GET /api/sla-targets
 * The target times per priority.
 * Access: staff.
 */
router.get('/', requireRole(...STAFF), async (req, res) => {
  res.json({ targets: await loadTargets() });
});

/**
 * PUT /api/sla-targets
 * Replaces the target times. Every priority must be included, and the fix target can't be
 * shorter than the first-reply target.
 * Access: admins and owners.
 * Body: { targets: [{ priority, first_response_minutes, resolve_minutes }] } (all four priorities)
 */
router.put('/', requireRole(...ADMINS), blockDemo, async (req, res) => {
  const targets = req.body?.targets;
  if (!Array.isArray(targets) || targets.length !== PRIORITIES.length) {
    return res.status(400).json({ error: 'Send a target for each priority: urgent, high, medium and low' });
  }
  for (const priority of PRIORITIES) {
    const target = targets.find((t) => t?.priority === priority);
    if (!target) return res.status(400).json({ error: `Missing the target for ${priority}` });
    const error =
      checkMinutes(target.first_response_minutes, `First reply for ${priority}`) ??
      checkMinutes(target.resolve_minutes, `Fixed for ${priority}`);
    if (error) return res.status(400).json({ error });
    if (target.resolve_minutes < target.first_response_minutes) {
      return res.status(400).json({ error: `The fix target for ${priority} can't be shorter than its first-reply target` });
    }
  }

  await withTransaction(async (db) => {
    for (const t of targets) {
      await db.query(
        `UPDATE sla_targets
            SET first_response_minutes = $2, resolve_minutes = $3, updated_by = $4, updated_at = NOW()
          WHERE priority = $1`,
        [t.priority, t.first_response_minutes, t.resolve_minutes, req.user.id]
      );
    }
  });
  res.json({ targets: await loadTargets() });
});

export default router;
