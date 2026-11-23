// Users API: list accounts, change roles, disable or enable accounts, and read the account history.
//
// Every change follows the ranking rule in roles.js (you can only manage people ranked below
// you) and is logged in account_events in the same transaction as the change itself.
//
// Mounted at /api/users (see app.js). Admins and owners only.

import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, ADMINS, canManage, canGrant } from '../roles.js';
import { clampPage, containsPattern, readPaging } from '../services/paging.js';
import { PROFILE_COLUMNS, checkProfileFields, saveProfile } from '../services/profile.js';

const router = Router();

// Applied to every route in this file, so a route added later can't forget the check.
router.use(requireAuth, requireRole(...ADMINS));

// --- Helpers ---

/** Turns "42" into 42, or null if it isn't a positive whole number. */
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Checks shared by "change role", "edit details" and "disable/enable": the target exists,
 * isn't the caller, and is ranked below the caller. Returns { target } or { status, error }.
 */
async function checkTarget(req, id) {
  if (!id) return { status: 400, error: 'Invalid user id' };
  // Why: nobody can change their own account. That's also what guarantees at least one owner
  // (or admin) always remains: removing one always takes someone else, ranked higher.
  if (id === req.user.id) return { status: 400, error: "You can't change your own account" };

  const result = await pool.query('SELECT id, role, disabled_at FROM users WHERE id = $1', [id]);
  const target = result.rows[0];
  if (!target) return { status: 404, error: 'User not found' };

  // req.user.role is fresh from the database (requireRole re-reads it).
  if (!canManage(req.user.role, target.role)) {
    return { status: 403, error: `You can't change an ${target.role}'s account` };
  }
  return { target };
}

// --- Routes ---

/**
 * GET /api/users
 * One page of accounts, oldest first, including whether each is disabled, with the filters
 * applied by the database. `total` matches the filters; `total_all` counts every account.
 * Access: admins and owners.
 * Query (all optional): q (words in the name or email), role, page, per_page
 */
router.get('/', async (req, res) => {
  const { role } = req.query;
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const values = [];
  const value = (v) => `$${values.push(v)}`;
  const where = [];
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  if (q) {
    const pattern = value(containsPattern(q));
    where.push(`(name ILIKE ${pattern} OR email ILIKE ${pattern})`);
  }
  if (role) where.push(`role = ${value(role)}`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const counted = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${where.length ? where.join(' AND ') : 'TRUE'})::int AS total, COUNT(*)::int AS total_all FROM users`,
    values
  );
  const { total, total_all: totalAll } = counted.rows[0];
  const { page: asked, perPage } = readPaging(req.query);
  const { page, offset } = clampPage(asked, perPage, total);
  const result = await pool.query(
    `SELECT ${PROFILE_COLUMNS}
       FROM users
      ${whereSql}
      ORDER BY id
      LIMIT ${perPage} OFFSET ${offset}`,
    values
  );
  res.json({ users: result.rows, total, total_all: totalAll, page, per_page: perPage });
});

/**
 * GET /api/users/history
 * The account history, newest first: role changes, disables and enables (last 200 entries).
 * Add ?user_id=5 for one person's history. actor_name is empty when a server command
 * (make-admin, make-owner) made the change.
 * Access: admins and owners.
 */
router.get('/history', async (req, res) => {
  const userId = req.query.user_id === undefined ? null : parseId(req.query.user_id);
  if (req.query.user_id !== undefined && !userId) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  // "$1::int IS NULL OR ..." handles both cases in one query: with no user_id, $1 is null and
  // every row matches. ::int tells PostgreSQL the type of that empty value.
  const result = await pool.query(
    `SELECT e.id, e.action, e.old_value, e.new_value, e.created_at,
            e.user_id,  target.name AS user_name,
            e.actor_id, actor.name  AS actor_name
       FROM account_events e
       JOIN users target     ON target.id = e.user_id
       LEFT JOIN users actor ON actor.id  = e.actor_id
      WHERE $1::int IS NULL OR e.user_id = $1
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 200`,
    [userId]
  );
  res.json({ history: result.rows });
});

/**
 * PATCH /api/users/:id/role
 * Changes someone's role: only someone ranked below you, and only to a role below yours.
 * Answers 409 if their role changed since it was checked.
 * Access: admins and owners.
 * Body: { role }
 */
router.patch('/:id/role', async (req, res) => {
  const id = parseId(req.params.id);
  const { role } = req.body ?? {};

  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  }
  // Owners are created only on the server (npm run make-owner), never through the website.
  if (role === 'owner') {
    return res.status(403).json({ error: 'Owners can only be created on the server' });
  }

  const { target, status, error } = await checkTarget(req, id);
  if (error) return res.status(status).json({ error });

  if (!canGrant(req.user.role, role)) {
    return res.status(403).json({ error: `You can't make someone an ${role}` });
  }
  if (role === target.role) {
    return res.json({ user: { id, role } }); // nothing to change, nothing to log
  }

  // The role change and its history entry are saved together, or not at all.
  const updated = await withTransaction(async (db) => {
    // Why "AND role = $3": only save if their role is still the one checked above. If someone
    // else changed it in the meantime, nothing is updated (optimistic concurrency).
    const result = await db.query(
      'UPDATE users SET role = $1 WHERE id = $2 AND role = $3 RETURNING id, name, email, role',
      [role, id, target.role]
    );
    if (result.rowCount === 0) return null;
    await db.query(
      `INSERT INTO account_events (user_id, actor_id, action, old_value, new_value)
       VALUES ($1, $2, 'role_changed', $3, $4)`,
      [id, req.user.id, target.role, role]
    );
    return result.rows[0];
  });

  if (!updated) {
    return res.status(409).json({ error: 'Their role was changed by someone else just now. Reload and try again.' });
  }
  // Takes effect at once: requireRole reads the role from the database on every request.
  res.json({ user: updated });
});

/**
 * PATCH /api/users/:id/details
 * Changes someone's name, job title or department (a company may want official names). The
 * same ranking rule as roles: only people ranked below you, and never yourself here (your own
 * details are on the Profile page). A new name is written to the account history.
 * Access: admins and owners.
 * Body (any of): { name, job_title, department } (job_title / department: '' clears it)
 */
router.patch('/:id/details', async (req, res) => {
  const id = parseId(req.params.id);
  const checked = checkProfileFields(req.body ?? {});
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { status, error } = await checkTarget(req, id);
  if (error) return res.status(status).json({ error });

  const user = await withTransaction(async (db) => {
    const target = (await db.query('SELECT id, name, job_title, department FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    return saveProfile(db, target, checked.fields, req.user.id);
  });
  res.json({ user });
});

/**
 * PATCH /api/users/:id/disabled
 * Disables or re-enables an account ranked below you. A disabled account can't log in and is
 * logged out everywhere at once; its tickets and comments stay (which is why we disable
 * instead of delete).
 * Access: admins and owners.
 * Body: { disabled: true | false }
 */
router.patch('/:id/disabled', async (req, res) => {
  const id = parseId(req.params.id);
  const { disabled } = req.body ?? {};
  if (typeof disabled !== 'boolean') {
    return res.status(400).json({ error: 'disabled must be true or false' });
  }

  const { target, status, error } = await checkTarget(req, id);
  if (error) return res.status(status).json({ error });

  if (disabled === Boolean(target.disabled_at)) {
    return res.json({ user: { id, disabled_at: target.disabled_at } }); // already that way
  }

  const updated = await withTransaction(async (db) => {
    const result = await db.query(
      `UPDATE users SET disabled_at = CASE WHEN $2 THEN NOW() ELSE NULL END
        WHERE id = $1 RETURNING id, name, email, role, disabled_at`,
      [id, disabled]
    );
    if (disabled) {
      // Log them out everywhere by revoking every refresh token. Their current access token is
      // refused too, because requireRole checks disabled_at on every request.
      await db.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    await db.query(
      `INSERT INTO account_events (user_id, actor_id, action) VALUES ($1, $2, $3)`,
      [id, req.user.id, disabled ? 'disabled' : 'enabled']
    );
    return result.rows[0];
  });

  res.json({ user: updated });
});

export default router;
