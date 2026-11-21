// Notifications API: the bell in the header. Anyone logged in reads and clears their own.
//
// The app checks once a minute while the tab is visible. Each check also adds any overdue
// warnings that are due (nothing "happens" when a deadline passes, so this is when they're
// noticed) and deletes the person's notifications older than 30 days.
//
// Mounted at /api/notifications (see app.js).

import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES } from '../roles.js';
import { parseId } from './tickets.js';

const router = Router();

const SHOWN = 30; // the panel shows the newest 30
const KEEP_FOR = '30 days';

router.use(requireAuth, requireRole(...ROLES));

/**
 * Adds an overdue warning for each unresolved ticket assigned to this person that passed a
 * target: the reply target (no first reply yet) or the fix target. The unique index
 * idx_notifications_overdue_once makes each one happen only once per person and ticket.
 */
async function addOverdue(userId) {
  await pool.query(
    `INSERT INTO notifications (user_id, ticket_id, kind)
     SELECT $1, t.id, due.kind
       FROM tickets t
       JOIN sla_targets sla ON sla.priority = t.priority
      CROSS JOIN LATERAL (VALUES
             ('overdue_reply', t.first_response_at IS NULL
                               AND t.created_at + make_interval(mins => sla.first_response_minutes) < NOW()),
             ('overdue_fix',   COALESCE(t.due_at, t.created_at + make_interval(mins => sla.resolve_minutes)) < NOW())
           ) AS due(kind, is_due)
      WHERE t.assigned_to = $1 AND t.status <> 'resolved' AND due.is_due
     ON CONFLICT (user_id, ticket_id, kind) WHERE kind IN ('overdue_reply', 'overdue_fix') DO NOTHING`,
    [userId]
  );
}

/**
 * GET /api/notifications
 * Your newest notifications (up to 30) and how many are unread.
 * Access: anyone logged in; only ever your own.
 */
router.get('/', async (req, res) => {
  await pool.query(`DELETE FROM notifications WHERE user_id = $1 AND created_at < NOW() - INTERVAL '${KEEP_FOR}'`, [req.user.id]);
  await addOverdue(req.user.id);

  // A notification is about a ticket, an outage, or both, so both joins are LEFT.
  const result = await pool.query(
    `SELECT n.id, n.kind, n.ticket_id, t.title AS ticket_title,
            n.outage_id, o.message AS outage_message, c.name AS outage_category,
            actor.name AS actor_name, n.read_at, n.created_at
       FROM notifications n
       LEFT JOIN tickets t ON t.id = n.ticket_id
       LEFT JOIN outages o ON o.id = n.outage_id
       LEFT JOIN categories c ON c.id = o.category_id
       LEFT JOIN users actor ON actor.id = n.actor_id -- empty = automatic
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${SHOWN}`,
    [req.user.id]
  );
  const unread = await pool.query('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL', [
    req.user.id,
  ]);
  res.json({ notifications: result.rows, unread: unread.rows[0].count });
});

/**
 * POST /api/notifications/read-all
 * Marks all your notifications as read.
 * Access: anyone logged in.
 *
 * Note: defined before /:id/read, so "read-all" is never mistaken for an id.
 */
router.post('/read-all', async (req, res) => {
  await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.status(204).end();
});

/**
 * POST /api/notifications/:id/read
 * Marks one notification as read (when it's clicked).
 * Access: anyone logged in. Someone else's notification answers 404.
 */
router.post('/:id/read', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid notification id' });
  // Security: "AND user_id = $2" means you can only ever mark your own.
  const result = await pool.query(
    'UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, req.user.id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Notification not found' });
  res.status(204).end();
});

export default router;
