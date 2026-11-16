// Ticket categories: a list admins manage ("Network", "Printer", ...).
// Mounted in app.js at /api/categories
//
// Everyone logged in can READ the list (to pick a category for a ticket).
// Only admins and owners can add, rename, archive or restore categories.
// There is no delete: archiving hides a category from new tickets but keeps it on old ones,
// so past tickets and the dashboard's history stay correct.
import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, ADMINS } from '../roles.js';

const router = Router();
const MAX_NAME = 50;

// Logged in, and refresh req.user.role from the database (see tickets.js for why)
router.use(requireAuth, requireRole(...ROLES));

// Turn "42" into 42, or null if it isn't a positive whole number
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Check a category name. Returns { name } or { error }.
function checkName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { error: 'Category name is required' };
  if (name.length > MAX_NAME) return { error: `Category name must be ${MAX_NAME} characters or fewer` };
  return { name };
}

// PostgreSQL error code 23505 = "unique violation": the database refused a duplicate name.
// We let the database be the judge (its unique index ignores capital letters) instead of
// checking first with a SELECT, because two admins clicking at the same moment could both
// pass a SELECT check. The index can't be raced.
const isDuplicate = (err) => err.code === '23505';

// GET /api/categories: the active categories, A to Z.
// Admins can add ?all=true to include archived ones (for the management screen).
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

// POST /api/categories: add one (admins). Body: { "name": "VPN" }
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
    throw err; // anything else: let the error handler in app.js deal with it (500)
  }
});

// PATCH /api/categories/:id: rename, archive, or restore (admins).
// Body (any of): { "name": "Wi-Fi", "active": false }
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

  // Column names come from our own code, values go through placeholders (same as tickets.js)
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
