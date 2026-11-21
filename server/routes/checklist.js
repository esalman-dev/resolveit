// Checklist API: tick, untick, skip, add and remove the steps on a new-hire setup ticket.
//
// Every change is saved with a history line ("Sam ticked Prepare laptop") in the same
// transaction, and answers with the whole ticket, history and checklist, like PATCH
// /api/tickets/:id. A resolved ticket's checklist can't change: reopen it first.
//
// Mounted at /api/tickets/:id/checklist (see app.js).

import { Router } from 'express';
import { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { STAFF } from '../roles.js';
import { parseId, ticketWithHistory } from './tickets.js';
import { MAX_STEPS, MAX_STEP_LENGTH } from './newHireSteps.js';

// mergeParams: lets these routes read :id from the address this router is mounted at.
const router = Router({ mergeParams: true });

const STATES = ['todo', 'done', 'not_needed'];

router.use(requireAuth, requireRole(...STAFF));

/**
 * Runs `work(db, ticket)` on a new-hire ticket that isn't resolved, inside a transaction that
 * locks the ticket's row, then answers with the ticket, history and checklist.
 * Why the lock: resolving takes the same lock and counts the steps left, so a step can't be
 * unticked while someone resolves the ticket. `work` returns { status, error } to refuse.
 */
async function changeChecklist(req, res, work) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });

  const outcome = await withTransaction(async (db) => {
    const found = await db.query('SELECT id, kind, status FROM tickets WHERE id = $1 FOR UPDATE', [id]);
    const ticket = found.rows[0];
    if (!ticket) return { status: 404, error: 'Ticket not found' };
    if (ticket.kind !== 'new_hire') return { status: 400, error: 'Only new-hire tickets have a checklist' };
    if (ticket.status === 'resolved') return { status: 409, error: 'This ticket is resolved. Reopen it to change the checklist.' };

    const refused = await work(db, ticket);
    if (refused) return refused;
    await db.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [id]);
    return null;
  });

  if (outcome) return res.status(outcome.status).json({ error: outcome.error });
  res.json(await ticketWithHistory(id));
}

/** One step of this ticket, or null. */
async function findStep(db, ticketId, value) {
  const stepId = parseId(value);
  if (!stepId) return null;
  const result = await db.query('SELECT id, title, state FROM ticket_checklist_items WHERE id = $1 AND ticket_id = $2', [stepId, ticketId]);
  return result.rows[0] ?? null;
}

/** A checklist history line: old_value is the step's title, new_value what happened to it. */
const logStep = (db, ticketId, actorId, title, what) =>
  db.query(
    `INSERT INTO ticket_events (ticket_id, actor_id, action, field, old_value, new_value)
     VALUES ($1, $2, 'changed', 'checklist', $3, $4)`,
    [ticketId, actorId, title, what]
  );

/**
 * PATCH /api/tickets/:id/checklist/:stepId
 * Sets a step to done (ticked), not_needed (skipped) or todo (unticked).
 * Access: staff.
 * Body: { state: 'todo' | 'done' | 'not_needed' }
 * History new_value: the new state.
 */
router.patch('/:stepId', async (req, res) => {
  const state = req.body?.state;
  if (!STATES.includes(state)) return res.status(400).json({ error: `State must be one of: ${STATES.join(', ')}` });

  await changeChecklist(req, res, async (db, ticket) => {
    const step = await findStep(db, ticket.id, req.params.stepId);
    if (!step) return { status: 404, error: 'Step not found' };
    if (step.state === state) return null; // already so: nothing to save or log

    await db.query(
      'UPDATE ticket_checklist_items SET state = $2, changed_by = $3, changed_at = NOW() WHERE id = $1',
      [step.id, state, req.user.id]
    );
    await logStep(db, ticket.id, req.user.id, step.title, state);
    return null;
  });
});

/**
 * POST /api/tickets/:id/checklist
 * Adds a step at the end of this ticket's checklist (the standard list doesn't change).
 * Access: staff.
 * Body: { title } (1 to 120 characters; at most 30 steps per ticket)
 * History new_value: 'added'.
 */
router.post('/', async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title || title.length > MAX_STEP_LENGTH) {
    return res.status(400).json({ error: `A step needs a name of 1 to ${MAX_STEP_LENGTH} characters` });
  }

  await changeChecklist(req, res, async (db, ticket) => {
    const count = await db.query(
      'SELECT COUNT(*)::int AS steps, COALESCE(MAX(position), 0) AS last FROM ticket_checklist_items WHERE ticket_id = $1',
      [ticket.id]
    );
    if (count.rows[0].steps >= MAX_STEPS) return { status: 400, error: `A checklist can have at most ${MAX_STEPS} steps` };

    await db.query(
      'INSERT INTO ticket_checklist_items (ticket_id, position, title) VALUES ($1, $2, $3)',
      [ticket.id, count.rows[0].last + 1, title]
    );
    await logStep(db, ticket.id, req.user.id, title, 'added');
    return null;
  });
});

/**
 * DELETE /api/tickets/:id/checklist/:stepId
 * Removes a step from this ticket. The last step can't be removed: a new-hire ticket always
 * has something to do.
 * Access: staff.
 * History new_value: 'removed'.
 */
router.delete('/:stepId', async (req, res) => {
  await changeChecklist(req, res, async (db, ticket) => {
    const step = await findStep(db, ticket.id, req.params.stepId);
    if (!step) return { status: 404, error: 'Step not found' };
    const count = await db.query('SELECT COUNT(*)::int AS steps FROM ticket_checklist_items WHERE ticket_id = $1', [ticket.id]);
    if (count.rows[0].steps <= 1) return { status: 400, error: "The last step can't be removed" };

    await db.query('DELETE FROM ticket_checklist_items WHERE id = $1', [step.id]);
    await logStep(db, ticket.id, req.user.id, step.title, 'removed');
    return null;
  });
});

export default router;
