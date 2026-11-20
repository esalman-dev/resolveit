// Auto-assign: gives a new ticket to the available technician with the fewest open tickets.
//
// Only technicians whose status is Available right now (see STATUS_SQL in routes/presence.js);
// never admins or owners. On a tie, whoever was given a ticket longest ago goes next, so the
// work takes turns. Nobody available, or switched off by an admin: the ticket stays unassigned.

import { STATUS_SQL } from '../routes/presence.js';
import { notify } from './notifications.js';

/**
 * Assigns a new ticket, if auto-assign is on and a technician is available. Must run inside the
 * transaction (`db`) that opened the ticket, so a ticket is never saved half assigned.
 * Returns the technician { id, name }, or null when the ticket stays unassigned.
 */
export async function autoAssign(db, ticketId) {
  const settings = await db.query('SELECT auto_assign FROM app_settings');
  if (!settings.rows[0]?.auto_assign) return null;

  // The pick, in order: fewest open tickets, then waited longest (never assigned = first),
  // then the lowest id, so the result is always the same for the same data.
  const picked = await db.query(
    `SELECT u.id, u.name
       FROM users u
      WHERE u.role = 'technician' AND u.disabled_at IS NULL AND ${STATUS_SQL('u')} = 'available'
      ORDER BY (SELECT COUNT(*) FROM tickets t WHERE t.assigned_to = u.id AND t.status <> 'resolved'),
               u.last_assigned_at NULLS FIRST,
               u.id
      LIMIT 1`
  );
  const technician = picked.rows[0];
  if (!technician) return null;

  await db.query('UPDATE tickets SET assigned_to = $1 WHERE id = $2', [technician.id, ticketId]);
  await db.query('UPDATE users SET last_assigned_at = NOW() WHERE id = $1', [technician.id]);
  // History with no actor: the ticket page shows "Assigned automatically to Sam Rivera".
  await db.query(
    `INSERT INTO ticket_events (ticket_id, actor_id, action, field, old_value, new_value)
     VALUES ($1, NULL, 'changed', 'assignee', NULL, $2)`,
    [ticketId, technician.name]
  );
  await notify(db, { userIds: [technician.id], ticketId, kind: 'assigned' });
  return technician;
}
