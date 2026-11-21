// New-hire steps API: the standard checklist every new-hire setup ticket starts with
// ("Create account", "Prepare laptop"…).
//
// Staff read it (the New hire form shows it); admins and owners change it. Each ticket copies
// the list when it's opened, so a change only affects new-hire tickets opened afterwards.
//
// Mounted at /api/new-hire-steps (see app.js).

import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ADMINS, STAFF } from '../roles.js';

const router = Router();

export const MAX_STEPS = 30;
export const MAX_STEP_LENGTH = 120;

router.use(requireAuth);

/** The step titles, in order. */
export async function loadSteps(db = pool) {
  const result = await db.query('SELECT title FROM new_hire_steps ORDER BY position');
  return result.rows.map((r) => r.title);
}

/**
 * GET /api/new-hire-steps
 * The standard steps, in order.
 * Access: staff.
 * Returns: { steps: ['Create account', ...] }
 */
router.get('/', requireRole(...STAFF), async (req, res) => {
  res.json({ steps: await loadSteps() });
});

/**
 * PUT /api/new-hire-steps
 * Replaces the whole list. The order sent is the order saved.
 * Access: admins and owners.
 * Body: { steps: ['Create account', ...] } (1 to 30 steps, each 1 to 120 characters, no repeats)
 */
router.put('/', requireRole(...ADMINS), async (req, res) => {
  const sent = req.body?.steps;
  if (!Array.isArray(sent) || sent.length < 1 || sent.length > MAX_STEPS) {
    return res.status(400).json({ error: `Send a list of 1 to ${MAX_STEPS} steps` });
  }

  const steps = [];
  for (const step of sent) {
    const title = typeof step === 'string' ? step.trim() : '';
    if (!title || title.length > MAX_STEP_LENGTH) {
      return res.status(400).json({ error: `Each step needs a name of 1 to ${MAX_STEP_LENGTH} characters` });
    }
    // "Prepare laptop" and "prepare laptop" twice is almost certainly a mistake.
    if (steps.some((s) => s.toLowerCase() === title.toLowerCase())) {
      return res.status(400).json({ error: `"${title}" is in the list twice` });
    }
    steps.push(title);
  }

  // Why delete and re-insert: positions are the primary key, so moving steps around in place
  // would clash halfway through. Inside a transaction, nobody ever sees the list half-saved.
  await withTransaction(async (db) => {
    await db.query('DELETE FROM new_hire_steps');
    await db.query(
      'INSERT INTO new_hire_steps (position, title) SELECT n, title FROM unnest($1::text[]) WITH ORDINALITY AS s(title, n)',
      [steps]
    );
  });
  res.json({ steps: await loadSteps() });
});

export default router;
