// User management (admins and owners): list everyone, change roles, disable/enable accounts,
// and see the account history (who changed what, and when).
// Mounted in app.js at /api/users
import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, ADMINS, canManage, canGrant } from '../roles.js';

const router = Router();

// Every route in this file: must be logged in AND an admin or owner.
// router.use() applies them to all routes below, so no route can accidentally forget the check.
router.use(requireAuth, requireRole(...ADMINS));

// Turn "42" into 42, or null if it isn't a positive whole number
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Checks shared by "change role" and "disable/enable": the target exists, isn't you,
// and is ranked below you. Returns { target } or { status, error }.
async function checkTarget(req, id) {
  if (!id) return { status: 400, error: 'Invalid user id' };
  // Nobody can change their OWN account here. This is also why there's always at least one
  // owner (or admin): removing one always takes someone else, ranked higher.
  if (id === req.user.id) return { status: 400, error: "You can't change your own account" };

  const result = await pool.query('SELECT id, role, disabled_at FROM users WHERE id = $1', [id]);
  const target = result.rows[0];
  if (!target) return { status: 404, error: 'User not found' };

  // The ranking rule (see roles.js). req.user.role is fresh from the database (requireRole).
  if (!canManage(req.user.role, target.role)) {
    return { status: 403, error: `You can't change an ${target.role}'s account` };
  }
  return { target };
}

// GET /api/users: everyone, oldest first
router.get('/', async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email, role, created_at, disabled_at,
            password_hash IS NOT NULL AS has_password,  -- true/false only; never send the hash itself
            google_id IS NOT NULL     AS has_google
       FROM users
      ORDER BY id`
  );
  res.json({ users: result.rows });
});

// GET /api/users/history: the account log, newest first (role changes, disables, enables).
// Optional ?user_id=5 to see one person's history. Shows the last 200 entries.
router.get('/history', async (req, res) => {
  const userId = req.query.user_id === undefined ? null : parseId(req.query.user_id);
  if (req.query.user_id !== undefined && !userId) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  // "$1::int IS NULL OR ...": one query for both cases. No user_id -> everyone's history.
  // actor_name is empty when the change came from a server command (make-admin / make-owner).
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

// PATCH /api/users/:id/role: change one user's role. Body: { "role": "technician" }
// (PATCH = update part of something; PUT would mean replacing the whole user)
router.patch('/:id/role', async (req, res) => {
  const id = parseId(req.params.id);
  const { role } = req.body ?? {};

  if (!id) return res.status(400).json({ error: 'Invalid user id' });
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  }
  // Owners are made only on the server (npm run make-owner), never through the website
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

  // Change the role AND write the history entry together (all or nothing).
  const updated = await withTransaction(async (db) => {
    // "AND role = $3": only save if their role is still the one we just checked. If someone else
    // changed it in the split second since, nothing is updated (no race).
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
  // Takes effect immediately on the server: requireRole reads the role from the database.
  res.json({ user: updated });
});

// PATCH /api/users/:id/disabled: disable or re-enable an account. Body: { "disabled": true }
// Disabled accounts can't log in, and every session they have is ended at once.
// Their tickets and comments stay (that's why we disable instead of delete).
router.patch('/:id/disabled', async (req, res) => {
  const id = parseId(req.params.id);
  const { disabled } = req.body ?? {};
  if (typeof disabled !== 'boolean') {
    return res.status(400).json({ error: 'disabled must be true or false' });
  }

  // Same ranking rule as roles: admins can disable technicians and users; owners can also
  // disable admins; nobody can disable an owner (or themselves) from the website.
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
      // Log them out everywhere: revoke every refresh token they have.
      // (Their 15-minute access token is refused too: requireRole checks disabled_at.)
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
