// Outages API: what staff do with an outage the app spotted (services/outages.js), and what
// everyone else sees of it.
//
//   suspected → confirmed (staff write the banner everyone sees) → fixed (resolves its tickets)
//   suspected → dismissed ("not an outage": its tickets carry on as normal)
//
// Everyone sees confirmed outages (the banner and Get help's "Known issues right now") and can
// say "This is my problem". Staff also see suspected ones, with counts.
//
// Mounted at /api/outages (see app.js).

import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF } from '../roles.js';
import { notify } from '../services/notifications.js';
import { parseId } from './tickets.js';

const router = Router();

const MAX_MESSAGE = 200; // the banner: one line
const MAX_FIX_MESSAGE = 2000; // posted as a reply on every ticket

router.use(requireAuth, requireRole(...ROLES));

const isStaff = (user) => STAFF.includes(user.role);

/** Checks a required message. Returns { text } or { error }. */
function checkMessage(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { error: `${label} is required` };
  if (text.length > max) return { error: `${label} must be ${max} characters or fewer` };
  return { text };
}

/**
 * Runs `work` on one outage, locked, if it's in one of the allowed statuses. Answers 404 if it
 * doesn't exist and 409 (conflict) if it's moved on, e.g. someone else just fixed it.
 */
async function changeOutage(req, res, allowed, work) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid outage id' });
  const outcome = await withTransaction(async (db) => {
    // FOR UPDATE: two staff pressing "Mark fixed" at once take turns; the second gets 409.
    const outage = (await db.query('SELECT * FROM outages WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!outage) return { status: 404, error: 'Outage not found' };
    if (!allowed.includes(outage.status)) return { status: 409, error: `This outage is already ${outage.status}` };
    await work(db, outage);
    return { status: 200 };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json({ outages: await openOutages(req.user) });
}

/**
 * The open outages this person may see, oldest first.
 * Everyone: confirmed ones, and whether they said "This is my problem" (reported_by_me).
 * Staff: suspected ones too, with the category and how many tickets and reports each has.
 */
async function openOutages(user) {
  const staff = isStaff(user);
  const result = await pool.query(
    `SELECT o.id, o.status, o.message, o.detected_at, o.confirmed_at, o.category_id, c.name AS category_name,
            (SELECT COUNT(*)::int FROM tickets t WHERE t.outage_id = o.id) AS ticket_count,
            (SELECT COUNT(*)::int FROM outage_reports r WHERE r.outage_id = o.id) AS report_count,
            EXISTS (SELECT 1 FROM outage_reports r WHERE r.outage_id = o.id AND r.user_id = $1) AS reported_by_me
       FROM outages o JOIN categories c ON c.id = o.category_id
      WHERE o.status = 'confirmed' OR (o.status = 'suspected' AND $2)
      ORDER BY o.detected_at`,
    [user.id, staff]
  );
  // Users don't need the staff numbers.
  return staff
    ? result.rows
    : result.rows.map(({ id, status, message, confirmed_at, reported_by_me }) => ({ id, status, message, confirmed_at, reported_by_me }));
}

/**
 * GET /api/outages
 * The open outages (see openOutages). The app checks this for the banner.
 * Access: anyone logged in.
 */
router.get('/', async (req, res) => {
  res.json({ outages: await openOutages(req.user) });
});

/**
 * POST /api/outages/:id/confirm
 * "Yes, it's an outage": everyone sees the banner from now on.
 * Access: staff. Body: { message } (the banner, up to 200 characters)
 */
router.post('/:id/confirm', requireRole(...STAFF), async (req, res) => {
  const message = checkMessage(req.body?.message, 'The message', MAX_MESSAGE);
  if (message.error) return res.status(400).json({ error: message.error });
  await changeOutage(req, res, ['suspected'], (db, outage) =>
    db.query(
      "UPDATE outages SET status = 'confirmed', message = $2, confirmed_at = NOW(), confirmed_by = $3 WHERE id = $1",
      [outage.id, message.text, req.user.id]
    )
  );
});

/**
 * POST /api/outages/:id/dismiss
 * "Not an outage". Its tickets keep the link, so they never count toward a new one.
 * Access: staff.
 */
router.post('/:id/dismiss', requireRole(...STAFF), async (req, res) => {
  await changeOutage(req, res, ['suspected'], (db, outage) =>
    db.query("UPDATE outages SET status = 'dismissed', closed_at = NOW(), closed_by = $2 WHERE id = $1", [
      outage.id,
      req.user.id,
    ])
  );
});

/**
 * PATCH /api/outages/:id
 * Changes a confirmed outage's banner (e.g. "now also Building C").
 * Access: staff. Body: { message }
 */
router.patch('/:id', requireRole(...STAFF), async (req, res) => {
  const message = checkMessage(req.body?.message, 'The message', MAX_MESSAGE);
  if (message.error) return res.status(400).json({ error: message.error });
  await changeOutage(req, res, ['confirmed'], (db, outage) =>
    db.query('UPDATE outages SET message = $2 WHERE id = $1', [outage.id, message.text])
  );
});

/**
 * POST /api/outages/:id/fix
 * "It's fixed": closes the outage and resolves every linked ticket that isn't resolved yet, with
 * the message as a public reply from this staff member. The bell tells each ticket's creator,
 * and everyone who said "This is my problem". All in one transaction.
 * Access: staff. Body: { message } (what fixed it, up to 2,000 characters)
 */
router.post('/:id/fix', requireRole(...STAFF), async (req, res) => {
  const message = checkMessage(req.body?.message, 'What fixed it', MAX_FIX_MESSAGE);
  if (message.error) return res.status(400).json({ error: message.error });
  const actor = req.user.id;

  await changeOutage(req, res, ['confirmed'], async (db, outage) => {
    await db.query(
      "UPDATE outages SET status = 'fixed', fix_message = $2, closed_at = NOW(), closed_by = $3 WHERE id = $1",
      [outage.id, message.text, actor]
    );

    const tickets = await db.query(
      "SELECT id, status, created_by FROM tickets WHERE outage_id = $1 AND status <> 'resolved' ORDER BY id FOR UPDATE",
      [outage.id]
    );
    // The same steps as a staff member replying and then resolving each ticket by hand.
    for (const ticket of tickets.rows) {
      await db.query('INSERT INTO ticket_comments (ticket_id, author_id, body) VALUES ($1, $2, $3)', [ticket.id, actor, message.text]);
      await db.query(
        `UPDATE tickets
            SET status = 'resolved', resolved_at = NOW(), updated_at = NOW(),
                first_response_at = CASE WHEN created_by <> $2 THEN COALESCE(first_response_at, NOW()) ELSE first_response_at END
          WHERE id = $1`,
        [ticket.id, actor]
      );
      await db.query(
        `INSERT INTO ticket_events (ticket_id, actor_id, action, field, old_value, new_value)
         VALUES ($1, $2, 'changed', 'status', $3, 'resolved')`,
        [ticket.id, actor, ticket.status]
      );
      await notify(db, { userIds: [ticket.created_by], ticketId: ticket.id, kind: 'resolved', actorId: actor });
    }

    const reporters = await db.query('SELECT user_id FROM outage_reports WHERE outage_id = $1', [outage.id]);
    await notify(db, { userIds: reporters.rows.map((r) => r.user_id), outageId: outage.id, kind: 'outage_fixed', actorId: actor });
  });
});

/**
 * POST /api/outages/:id/report
 * "This is my problem" (Get help): adds you to a confirmed outage without opening a ticket.
 * Saying it twice changes nothing.
 * Access: anyone logged in.
 */
router.post('/:id/report', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid outage id' });
  // Only a confirmed outage: users never learn about suspected ones (they answer 404 too).
  const open = await pool.query("SELECT 1 FROM outages WHERE id = $1 AND status = 'confirmed'", [id]);
  if (open.rowCount === 0) return res.status(404).json({ error: 'That issue is no longer open' });
  await pool.query(
    'INSERT INTO outage_reports (outage_id, user_id) VALUES ($1, $2) ON CONFLICT (outage_id, user_id) DO NOTHING',
    [id, req.user.id]
  );
  res.json({ outages: await openOutages(req.user) });
});

/**
 * PUT /api/outages/tickets/:ticketId
 * Links a ticket to an open outage, or unlinks it (outage_id: null). For the ticket page's
 * Outage dropdown, when the app's guess was wrong or a ticket was filed under another category.
 * Access: staff. Body: { outage_id: number | null }
 */
router.put('/tickets/:ticketId', requireRole(...STAFF), async (req, res) => {
  const ticketId = parseId(req.params.ticketId);
  if (!ticketId) return res.status(400).json({ error: 'Invalid ticket id' });
  const wanted = req.body?.outage_id;
  const outageId = wanted === null ? null : parseId(wanted);
  if (wanted !== null && !outageId) return res.status(400).json({ error: 'outage_id must be an outage id or null' });

  if (outageId) {
    const open = await pool.query("SELECT 1 FROM outages WHERE id = $1 AND status IN ('suspected', 'confirmed')", [outageId]);
    if (open.rowCount === 0) return res.status(400).json({ error: 'Pick an open outage' });
    // Fixing an outage resolves its tickets, which would skip a new hire's checklist.
    const hire = await pool.query("SELECT 1 FROM tickets WHERE id = $1 AND kind = 'new_hire'", [ticketId]);
    if (hire.rowCount > 0) return res.status(400).json({ error: "A new-hire ticket can't be part of an outage" });
  }
  const updated = await pool.query('UPDATE tickets SET outage_id = $2, updated_at = NOW() WHERE id = $1', [ticketId, outageId]);
  if (updated.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
  res.status(204).end();
});

export default router;
