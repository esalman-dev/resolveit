// Categories API: the list of ticket categories ("Network", "Printer", ...).
//
// Everyone logged in can read the list. Admins and owners add, rename, archive and restore.
// There is no delete: archiving hides a category from new tickets but keeps it on old ones,
// so past tickets and reports stay correct.
//
// Mounted at /api/categories (see app.js).

import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, ADMINS } from '../roles.js';

const router = Router();
const MAX_NAME = 50;

// Every route needs a login. Listing every role blocks no one, but requireRole refreshes
// req.user.role from the database and refuses disabled accounts.
router.use(requireAuth, requireRole(...ROLES));

// --- Helpers ---

/** Turns "42" into 42, or null if it isn't a positive whole number. */
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Checks a category name. Returns { name } or { error }. */
function checkName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { error: 'Category name is required' };
  if (name.length > MAX_NAME) return { error: `Category name must be ${MAX_NAME} characters or fewer` };
  return { name };
}

/**
 * True if PostgreSQL refused a duplicate name (error 23505, "unique violation").
 *
 * Why: the database is the judge, not a SELECT beforehand. Two admins clicking at the same
 * moment could both pass a "does it exist?" check; the unique index can't be raced, and it
 * ignores capital letters.
 */
const isDuplicate = (err) => err.code === '23505';

// --- Routes ---

/**
 * GET /api/categories
 * The active categories, A to Z. Admins and owners can add ?all=true to include archived ones.
 * Access: anyone logged in.
 */
router.get('/', async (req, res) => {
  const includeArchived = req.query.all === 'true' && ADMINS.includes(req.user.role);
  const result = await pool.query(
    `SELECT id, name, active FROM categories
      WHERE active OR $1
      ORDER BY LOWER(name)`,
    [includeArchived]
  );
  res.json({ categories: result.rows });
});

/**
 * POST /api/categories
 * Adds a category. Answers 409 if the name exists (ignoring capital letters).
 * Access: admins and owners.
 * Body: { name }
 */
router.post('/', requireRole(...ADMINS), async (req, res) => {
  const { name, error } = checkName(req.body?.name);
  if (error) return res.status(400).json({ error });

  try {
    const result = await pool.query(
      'INSERT INTO categories (name) VALUES ($1) RETURNING id, name, active',
      [name]
    );
    res.status(201).json({ category: result.rows[0] });
  } catch (err) {
    if (isDuplicate(err)) return res.status(409).json({ error: 'A category with that name already exists' });
    throw err; // anything else goes to the error handler in app.js (500)
  }
});

/**
 * PATCH /api/categories/:id
 * Renames, archives or restores a category.
 * Access: admins and owners.
 * Body (any of): { name, active }
 */
router.patch('/:id', requireRole(...ADMINS), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid category id' });

  const body = req.body ?? {};
  const changes = {};

  if (body.name !== undefined) {
    const { name, error } = checkName(body.name);
    if (error) return res.status(400).json({ error });
    changes.name = name;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      return res.status(400).json({ error: 'active must be true or false' });
    }
    changes.active = body.active;
  }

  const columns = Object.keys(changes);
  if (columns.length === 0) {
    return res.status(400).json({ error: 'Nothing to update: send name or active' });
  }

  // Security: column names come from our own code, never the request; values go through
  // $1, $2 placeholders. That keeps the built-up UPDATE safe from SQL injection.
  const setList = columns.map((column, i) => `${column} = $${i + 1}`);
  const values = [...columns.map((column) => changes[column]), id];

  try {
    const result = await pool.query(
      `UPDATE categories SET ${setList.join(', ')} WHERE id = $${values.length} RETURNING id, name, active`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    res.json({ category: result.rows[0] });
  } catch (err) {
    if (isDuplicate(err)) return res.status(409).json({ error: 'A category with that name already exists' });
    throw err;
  }
});

export default router;
