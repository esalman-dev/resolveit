// Outage spotting: several tickets about the same kind of problem at once are probably one big
// problem, like the Wi-Fi being down for a whole building.
//
// The rule: 3 tickets in the same category, opened within 15 minutes, not resolved and not
// already part of an outage. Tickets with no category never count. Checked each time a ticket is
// opened; there's no background job. Staff then confirm or dismiss it (routes/outages.js).

import { STAFF } from '../roles.js';
import { notify } from './notifications.js';

export const OUTAGE_THRESHOLD = 3;
export const OUTAGE_WINDOW = '15 minutes';

/**
 * Links a new ticket to its category's open outage, or opens a suspected outage when this ticket
 * makes enough recent ones. Must run inside the transaction that opened the ticket.
 * Returns { outageId, opened: true } for a new suspected outage, { outageId, opened: false }
 * when the ticket joined one, or null.
 */
export async function checkForOutage(db, ticketId) {
  const ticket = (await db.query('SELECT category_id FROM tickets WHERE id = $1', [ticketId])).rows[0];
  if (!ticket?.category_id) return null;

  // Already an open outage for this category: the new ticket joins it.
  const open = await db.query(
    "SELECT id FROM outages WHERE category_id = $1 AND status IN ('suspected', 'confirmed')",
    [ticket.category_id]
  );
  if (open.rows[0]) {
    await db.query('UPDATE tickets SET outage_id = $1 WHERE id = $2', [open.rows[0].id, ticketId]);
    return { outageId: open.rows[0].id, opened: false };
  }

  // NOW() is when this transaction started, so the new ticket itself is inside the window.
  const recent = await db.query(
    `SELECT id FROM tickets
      WHERE category_id = $1 AND outage_id IS NULL AND status <> 'resolved'
        AND created_at > NOW() - INTERVAL '${OUTAGE_WINDOW}'`,
    [ticket.category_id]
  );
  if (recent.rows.length < OUTAGE_THRESHOLD) return null;

  // Why ON CONFLICT: two tickets opened at the same moment could both get here. The unique index
  // idx_outages_one_open lets only one outage in; the other transaction just carries on.
  const created = await db.query(
    `INSERT INTO outages (category_id) VALUES ($1)
     ON CONFLICT (category_id) WHERE status IN ('suspected', 'confirmed') DO NOTHING
     RETURNING id`,
    [ticket.category_id]
  );
  const outageId = created.rows[0]?.id;
  if (!outageId) return null;

  await db.query('UPDATE tickets SET outage_id = $1 WHERE id = ANY($2)', [outageId, recent.rows.map((r) => r.id)]);
  const staff = await db.query('SELECT id FROM users WHERE role = ANY($1) AND disabled_at IS NULL', [STAFF]);
  await notify(db, { userIds: staff.rows.map((s) => s.id), outageId, kind: 'outage_suspected' });
  return { outageId, opened: true };
}
