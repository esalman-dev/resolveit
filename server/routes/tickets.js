// Tickets: create, list, view, assign, and update help desk requests, plus their comments.
// Mounted in app.js at /api/tickets
//
// Who can do what:
//   user  -> create tickets, see ONLY their own, comment on their own
//   staff -> (technician, admin, owner) see ALL tickets, change status / priority / category,
//            assign them, comment on any ticket, and write internal (staff-only) notes
import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF } from '../roles.js';

const router = Router();

// Allowed values. Must match the CHECK constraints in schema.sql.
const STATUSES = ['open', 'in_progress', 'resolved'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
// STAFF (technician, admin, owner) comes from roles.js

// Length limits, so nobody can store a 10 MB "title"
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_COMMENT = 5000;

// Every route: must be logged in. requireRole with ALL three roles never blocks anyone,
// but it re-reads the role from the database, so req.user.role is always up to date
// (a user promoted to technician 1 minute ago sees all tickets right away).
router.use(requireAuth, requireRole(...ROLES));

const isStaff = (user) => STAFF.includes(user.role);

// The columns we send back for a ticket. The JOINs swap ids for names:
// "created_by: 4" becomes "created_by_name: 'Alice'". LEFT (not plain) JOIN for the assignee
// and category because those can be empty, and a plain JOIN would drop those tickets.
const TICKET_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority,
         t.category_id, category.name AS category_name,
         t.created_by,  creator.name  AS created_by_name,
         t.assigned_to, assignee.name AS assigned_to_name,
         t.created_at, t.updated_at, t.resolved_at
    FROM tickets t
    JOIN users creator            ON creator.id  = t.created_by
    LEFT JOIN users assignee      ON assignee.id = t.assigned_to
    LEFT JOIN categories category ON category.id = t.category_id`;

// Turn "42" into 42, or null if it isn't a positive whole number
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Clean up optional text: trim spaces; empty or missing becomes null
function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

// Check a category_id from the request. null means "no category".
// Returns { id } or { error }. Archived categories can't be picked for new changes.
async function checkCategory(value) {
  if (value === null) return { id: null };
  const id = parseId(value);
  const result = id ? await pool.query('SELECT active FROM categories WHERE id = $1', [id]) : { rows: [] };
  if (!result.rows[0]?.active) return { error: 'Pick an existing, active category' };
  return { id };
}

// Load a ticket the current user is allowed to see, or null.
// Someone else's ticket counts as "not found" too (see GET /:id for why).
async function findVisibleTicket(id, user) {
  const result = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [id]);
  const ticket = result.rows[0];
  if (!ticket || (!isStaff(user) && ticket.created_by !== user.id)) return null;
  return ticket;
}

// POST /api/tickets: anyone logged in can open a ticket.
// Body: { "title": "...", "description": "...", "priority"?: "high", "category_id"?: 3 }
router.post('/', async (req, res) => {
  const body = req.body ?? {}; // Express 5 leaves req.body undefined if no JSON was sent
  const title = cleanText(body.title);
  const description = cleanText(body.description);
  const priority = body.priority ?? 'medium';

  if (!title || !description) {
    return res.status(400).json({ error: 'Title and description are required' });
  }
  if (title.length > MAX_TITLE) {
    return res.status(400).json({ error: `Title must be ${MAX_TITLE} characters or fewer` });
  }
  if (description.length > MAX_DESCRIPTION) {
    return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION} characters or fewer` });
  }
  if (!PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `Priority must be one of: ${PRIORITIES.join(', ')}` });
  }
  const category = await checkCategory(body.category_id ?? null); // optional
  if (category.error) return res.status(400).json({ error: category.error });

  // created_by comes from the login token, NEVER from the body: you can't open a ticket as someone else.
  // status and assigned_to aren't accepted here either: new tickets always start open and unassigned.
  const inserted = await pool.query(
    `INSERT INTO tickets (title, description, priority, category_id, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [title, description, priority, category.id, req.user.id]
  );

  const ticket = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [inserted.rows[0].id]);
  res.status(201).json({ ticket: ticket.rows[0] }); // 201 = Created
});

// GET /api/tickets: the ticket list, newest first.
// Staff see every ticket; regular users see only the ones they created.
router.get('/', async (req, res) => {
  const result = isStaff(req.user)
    ? await pool.query(`${TICKET_SELECT} ORDER BY t.created_at DESC, t.id DESC`)
    : await pool.query(`${TICKET_SELECT} WHERE t.created_by = $1 ORDER BY t.created_at DESC, t.id DESC`, [
        req.user.id,
      ]);
  res.json({ tickets: result.rows });
});

// GET /api/tickets/assignees: who a ticket can be assigned to (for the dropdown). Staff only.
// Defined BEFORE /:id, otherwise Express would treat "assignees" as a ticket id.
router.get('/assignees', requireRole(...STAFF), async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, role FROM users WHERE role = ANY($1) ORDER BY name`,
    [STAFF]
  );
  res.json({ assignees: result.rows });
});

// GET /api/tickets/:id: one ticket
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });

  // Someone else's ticket gets the SAME 404 as a ticket that doesn't exist.
  // A 403 would confirm "ticket 57 exists", which leaks information.
  const ticket = await findVisibleTicket(id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket });
});

// GET /api/tickets/:id/comments: the conversation on a ticket, oldest first.
// The creator and staff can read it. Internal notes are left out for regular users.
router.get('/:id/comments', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  // "is_internal = FALSE OR $2": staff pass TRUE (see everything), users pass FALSE (public only).
  // The filtering happens in SQL, so internal notes never leave the database for a user.
  const result = await pool.query(
    `SELECT c.id, c.body, c.is_internal, c.created_at,
            c.author_id, author.name AS author_name, author.role AS author_role
       FROM ticket_comments c
       JOIN users author ON author.id = c.author_id
      WHERE c.ticket_id = $1 AND (c.is_internal = FALSE OR $2)
      ORDER BY c.created_at, c.id`,
    [id, isStaff(req.user)]
  );
  res.json({ comments: result.rows });
});

// POST /api/tickets/:id/comments: add a comment. Body: { "body": "...", "is_internal"?: true }
router.post('/:id/comments', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  const body = req.body ?? {};
  const text = cleanText(body.body);
  const isInternal = body.is_internal === true;

  if (!text) return res.status(400).json({ error: 'Comment text is required' });
  if (text.length > MAX_COMMENT) {
    return res.status(400).json({ error: `Comment must be ${MAX_COMMENT} characters or fewer` });
  }
  if (isInternal && !isStaff(req.user)) {
    return res.status(403).json({ error: 'Only technicians and admins can write internal notes' });
  }

  // author_id comes from the login token, never the body (same rule as created_by on tickets)
  const inserted = await pool.query(
    `INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal)
     VALUES ($1, $2, $3, $4)
     RETURNING id, body, is_internal, created_at, author_id`,
    [id, req.user.id, text, isInternal]
  );
  // A new comment counts as activity on the ticket
  await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [id]);

  const author = await pool.query('SELECT name, role FROM users WHERE id = $1', [req.user.id]);
  res.status(201).json({
    comment: { ...inserted.rows[0], author_name: author.rows[0].name, author_role: author.rows[0].role },
  });
});

// PATCH /api/tickets/:id: staff update a ticket. Send only the fields you want to change.
// Body (any of): { "status": "in_progress", "priority": "high", "category_id": 2, "assigned_to": 3 }
// null for assigned_to or category_id clears it.
router.patch('/:id', requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });

  const body = req.body ?? {};
  const changes = {}; // column name -> new value, filled in as each field passes its check

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
    }
    changes.status = body.status;
  }

  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) {
      return res.status(400).json({ error: `Priority must be one of: ${PRIORITIES.join(', ')}` });
    }
    changes.priority = body.priority;
  }

  if (body.category_id !== undefined) {
    const category = await checkCategory(body.category_id);
    if (category.error) return res.status(400).json({ error: category.error });
    changes.category_id = category.id;
  }

  if (body.assigned_to !== undefined) {
    if (body.assigned_to === null) {
      changes.assigned_to = null; // unassign
    } else {
      const assigneeId = parseId(body.assigned_to);
      // Only staff can be assigned a ticket: check the person exists AND is a technician/admin
      const assignee = assigneeId
        ? await pool.query('SELECT role FROM users WHERE id = $1', [assigneeId])
        : { rows: [] };
      if (!STAFF.includes(assignee.rows[0]?.role)) {
        return res.status(400).json({ error: 'Tickets can only be assigned to a technician or admin' });
      }
      changes.assigned_to = assigneeId;
    }
  }

  const columns = Object.keys(changes);
  if (columns.length === 0) {
    return res.status(400).json({ error: 'Nothing to update: send status, priority, category_id, or assigned_to' });
  }

  // Build "status = $1, priority = $2" from the changes. Safe from SQL injection because the
  // column NAMES come from our own code above (never from the request), and the VALUES go
  // through $1, $2 placeholders like every other query.
  const setList = columns.map((column, i) => `${column} = $${i + 1}`);
  const values = columns.map((column) => changes[column]);

  // resolved_at records WHEN a ticket was resolved (for "average time to fix" in Phase 3).
  // Set it when the status becomes resolved; clear it if the ticket is reopened.
  if (changes.status === 'resolved') {
    setList.push('resolved_at = COALESCE(resolved_at, NOW())'); // keep the first time if already resolved
  } else if (changes.status) {
    setList.push('resolved_at = NULL');
  }

  values.push(id);
  const updated = await pool.query(
    `UPDATE tickets SET ${setList.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id`,
    values
  );
  if (updated.rowCount === 0) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const ticket = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [id]);
  res.json({ ticket: ticket.rows[0] });
});

export default router;
