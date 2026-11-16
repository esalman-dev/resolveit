// Tickets: create, list, view, assign, and update help desk requests, plus their comments.
// Every change is written to the ticket's HISTORY (ticket_events), which comes back with the ticket.
// Mounted in app.js at /api/tickets
//
// Who can do what:
//   user  -> create tickets, see ONLY their own, comment on their own,
//            edit the title/description while the ticket is still open, and close (resolve) it
//   staff -> (technician, admin, owner) see ALL tickets, change anything on them, assign them,
//            comment on any ticket, and write internal (staff-only) notes
//   anyone -> edit their OWN comments; every earlier version is kept and shown
import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
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

// Every route: must be logged in. requireRole with EVERY role never blocks anyone by role,
// but it re-reads the role from the database (so req.user.role is always up to date) and
// refuses disabled accounts.
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

// The columns we send back for a comment, including every earlier version ("edits").
// json_agg gathers the matching comment_edits rows into one JSON list per comment;
// COALESCE turns "no edits" (NULL) into an empty list.
const COMMENT_SELECT = `
  SELECT c.id, c.ticket_id, c.body, c.is_internal, c.created_at, c.edited_at,
         c.author_id, author.name AS author_name, author.role AS author_role,
         COALESCE(
           (SELECT json_agg(json_build_object('old_body', ce.old_body, 'edited_at', ce.edited_at)
                            ORDER BY ce.edited_at, ce.id)
              FROM comment_edits ce WHERE ce.comment_id = c.id),
           '[]'::json
         ) AS edits
    FROM ticket_comments c
    JOIN users author ON author.id = c.author_id`;

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

// Check a title or description. Returns { text } or { error }.
function checkText(value, label, max) {
  const text = cleanText(value);
  if (!text) return { error: `${label} is required` };
  if (text.length > max) return { error: `${label} must be ${max} characters or fewer` };
  return { text };
}

// Check a category_id from the request. null means "no category".
// Returns { id, name } or { error }. Archived categories can't be picked for new changes.
async function checkCategory(value) {
  if (value === null) return { id: null, name: null };
  const id = parseId(value);
  const result = id ? await pool.query('SELECT name, active FROM categories WHERE id = $1', [id]) : { rows: [] };
  if (!result.rows[0]?.active) return { error: 'Pick an existing, active category' };
  return { id, name: result.rows[0].name };
}

// Check an assigned_to from the request. null means "unassigned".
// Only active staff can be assigned a ticket. Returns { id, name } or { error }.
async function checkAssignee(value) {
  if (value === null) return { id: null, name: null };
  const id = parseId(value);
  const result = id ? await pool.query('SELECT name, role, disabled_at FROM users WHERE id = $1', [id]) : { rows: [] };
  const person = result.rows[0];
  if (!person || !STAFF.includes(person.role) || person.disabled_at) {
    return { error: 'Tickets can only be assigned to an active technician, admin or owner' };
  }
  return { id, name: person.name };
}

// Load a ticket the current user is allowed to see, or null.
// Someone else's ticket counts as "not found" too (see GET /:id for why).
async function findVisibleTicket(id, user) {
  const result = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [id]);
  const ticket = result.rows[0];
  if (!ticket || (!isStaff(user) && ticket.created_by !== user.id)) return null;
  return ticket;
}

// A ticket's history, oldest first: who changed what, and when
async function loadHistory(ticketId) {
  const result = await pool.query(
    `SELECT e.id, e.action, e.field, e.old_value, e.new_value, e.created_at,
            e.actor_id, actor.name AS actor_name
       FROM ticket_events e
       JOIN users actor ON actor.id = e.actor_id
      WHERE e.ticket_id = $1
      ORDER BY e.created_at, e.id`,
    [ticketId]
  );
  return result.rows;
}

// The ticket plus its history: what GET, POST and PATCH all send back
async function ticketWithHistory(id) {
  const ticket = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [id]);
  return { ticket: ticket.rows[0], history: await loadHistory(id) };
}

// POST /api/tickets: anyone logged in can open a ticket.
// Body: { "title": "...", "description": "...", "category_id"?: 3, "priority"?: "high" (staff only) }
router.post('/', async (req, res) => {
  const body = req.body ?? {}; // Express 5 leaves req.body undefined if no JSON was sent
  const title = checkText(body.title, 'Title', MAX_TITLE);
  if (title.error) return res.status(400).json({ error: title.error });
  const description = checkText(body.description, 'Description', MAX_DESCRIPTION);
  if (description.error) return res.status(400).json({ error: description.error });

  // Only staff choose a priority. A priority sent by a regular user is
  // ignored, like created_by: otherwise everyone would mark everything "urgent".
  // New tickets start at medium; staff (and later the AI) adjust it.
  const priority = isStaff(req.user) ? (body.priority ?? 'medium') : 'medium';
  if (!PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `Priority must be one of: ${PRIORITIES.join(', ')}` });
  }
  const category = await checkCategory(body.category_id ?? null); // optional
  if (category.error) return res.status(400).json({ error: category.error });

  // Create the ticket AND its first history entry ("created") together, all or nothing.
  // created_by comes from the login token, NEVER from the body: you can't open a ticket as someone else.
  // status and assigned_to aren't accepted here either: new tickets always start open and unassigned.
  const id = await withTransaction(async (db) => {
    const inserted = await db.query(
      `INSERT INTO tickets (title, description, priority, category_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [title.text, description.text, priority, category.id, req.user.id]
    );
    const ticketId = inserted.rows[0].id;
    await db.query(
      `INSERT INTO ticket_events (ticket_id, actor_id, action) VALUES ($1, $2, 'created')`,
      [ticketId, req.user.id]
    );
    return ticketId;
  });

  res.status(201).json(await ticketWithHistory(id)); // 201 = Created
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
    `SELECT id, name, role FROM users WHERE role = ANY($1) AND disabled_at IS NULL ORDER BY name`,
    [STAFF]
  );
  res.json({ assignees: result.rows });
});

// GET /api/tickets/:id: one ticket, with its full history
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });

  // Someone else's ticket gets the SAME 404 as a ticket that doesn't exist.
  // A 403 would confirm "ticket 57 exists", which leaks information.
  const ticket = await findVisibleTicket(id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket, history: await loadHistory(id) });
});

// PATCH /api/tickets/:id: change a ticket. Send only the fields you want to change.
// Body (any of): { "title", "description", "status", "priority", "category_id", "assigned_to" }
// null for assigned_to or category_id clears it.
//   Staff: any field.
//   The ticket's creator (a regular user): title and description while it's still 'open',
//   and status -> 'resolved' (closing it: "never mind, it works now").
router.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  const body = req.body ?? {};
  const staff = isStaff(req.user);

  // ---- 1. Who may send which fields ----
  const STAFF_ONLY = ['priority', 'category_id', 'assigned_to'];
  const blocked = STAFF_ONLY.filter((field) => body[field] !== undefined);
  if (!staff && blocked.length > 0) {
    return res.status(403).json({ error: `Only technicians, admins and owners can change: ${blocked.join(', ')}` });
  }
  if (!staff && body.status !== undefined && body.status !== 'resolved') {
    return res.status(403).json({ error: 'You can close your ticket (resolved), but only staff can set other statuses' });
  }

  // ---- 2. Check each value. `wanted` = field -> { value for the column, text for the history } ----
  const wanted = {};
  for (const [field, label, max] of [['title', 'Title', MAX_TITLE], ['description', 'Description', MAX_DESCRIPTION]]) {
    if (body[field] !== undefined) {
      const checked = checkText(body[field], label, max);
      if (checked.error) return res.status(400).json({ error: checked.error });
      wanted[field] = { column: field, value: checked.text, text: checked.text };
    }
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
    }
    wanted.status = { column: 'status', value: body.status, text: body.status };
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) {
      return res.status(400).json({ error: `Priority must be one of: ${PRIORITIES.join(', ')}` });
    }
    wanted.priority = { column: 'priority', value: body.priority, text: body.priority };
  }
  if (body.category_id !== undefined) {
    const category = await checkCategory(body.category_id);
    if (category.error) return res.status(400).json({ error: category.error });
    wanted.category = { column: 'category_id', value: category.id, text: category.name };
  }
  if (body.assigned_to !== undefined) {
    const assignee = await checkAssignee(body.assigned_to);
    if (assignee.error) return res.status(400).json({ error: assignee.error });
    wanted.assignee = { column: 'assigned_to', value: assignee.id, text: assignee.name };
  }
  if (Object.keys(wanted).length === 0) {
    return res.status(400).json({
      error: 'Nothing to update: send title, description, status, priority, category_id, or assigned_to',
    });
  }

  // ---- 3. Save the changes and their history together ----
  const outcome = await withTransaction(async (db) => {
    // FOR UPDATE locks this ticket's row until we COMMIT, so two people saving at the same
    // moment take turns instead of overwriting each other's history.
    // ("OF t": lock only the ticket row, not the joined users/category rows.)
    const locked = await db.query(`${TICKET_SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [id]);
    const current = locked.rows[0];

    // A regular user may edit the text only while nobody has started on the ticket
    if (!staff && (wanted.title || wanted.description) && current.status !== 'open') {
      return { status: 403, error: 'You can only edit a ticket while it is still open. Add a comment instead.' };
    }

    // What each field looks like right now: the column value, and the text for the history
    const before = {
      title: { value: current.title, text: current.title },
      description: { value: current.description, text: current.description },
      status: { value: current.status, text: current.status },
      priority: { value: current.priority, text: current.priority },
      category: { value: current.category_id, text: current.category_name },
      assignee: { value: current.assigned_to, text: current.assigned_to_name },
    };

    // Keep only the fields that ACTUALLY change (sending the same value isn't a change)
    const changed = Object.keys(wanted).filter((field) => wanted[field].value !== before[field].value);
    if (changed.length === 0) return { unchanged: true };

    // Build "title = $1, status = $2" from the changes. Safe from SQL injection: column NAMES
    // come from our own code (the `wanted` table above), and VALUES go through $1, $2.
    const setList = changed.map((field, i) => `${wanted[field].column} = $${i + 1}`);
    const values = changed.map((field) => wanted[field].value);

    // resolved_at records WHEN a ticket was resolved (for "average time to fix" in Phase 3).
    // Set it when the status becomes resolved; clear it if the ticket is reopened.
    if (changed.includes('status')) {
      setList.push(wanted.status.value === 'resolved' ? 'resolved_at = NOW()' : 'resolved_at = NULL');
    }

    values.push(id);
    await db.query(`UPDATE tickets SET ${setList.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`, values);

    // One history row per changed field, saving the before/after TEXT as people saw it
    for (const field of changed) {
      await db.query(
        `INSERT INTO ticket_events (ticket_id, actor_id, action, field, old_value, new_value)
         VALUES ($1, $2, 'changed', $3, $4, $5)`,
        [id, req.user.id, field, before[field].text, wanted[field].text]
      );
    }
    return {};
  });

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json(await ticketWithHistory(id));
});

// GET /api/tickets/:id/comments: the conversation on a ticket, oldest first.
// The creator and staff can read it. Internal notes are left out for regular users.
// Each comment includes `edits`: every earlier version of its text.
router.get('/:id/comments', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  // "is_internal = FALSE OR $2": staff pass TRUE (see everything), users pass FALSE (public only).
  // The filtering happens in SQL, so internal notes never leave the database for a user.
  const result = await pool.query(
    `${COMMENT_SELECT}
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
  const text = checkText(body.body, 'Comment text', MAX_COMMENT);
  if (text.error) return res.status(400).json({ error: text.error });
  const isInternal = body.is_internal === true;
  if (isInternal && !isStaff(req.user)) {
    return res.status(403).json({ error: 'Only technicians, admins and owners can write internal notes' });
  }

  // author_id comes from the login token, never the body (same rule as created_by on tickets)
  const inserted = await pool.query(
    `INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [id, req.user.id, text.text, isInternal]
  );
  // A new comment counts as activity on the ticket
  await pool.query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [id]);

  const comment = await pool.query(`${COMMENT_SELECT} WHERE c.id = $1`, [inserted.rows[0].id]);
  res.status(201).json({ comment: comment.rows[0] });
});

// PATCH /api/tickets/:id/comments/:commentId: edit your OWN comment. Body: { "body": "new text" }
// The old text is saved in comment_edits first, so everyone who can see the comment can
// also see exactly what it said before. Comments can't be deleted.
router.patch('/:id/comments/:commentId', async (req, res) => {
  const id = parseId(req.params.id);
  const commentId = parseId(req.params.commentId);
  if (!id || !commentId) return res.status(400).json({ error: 'Invalid ticket or comment id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  const text = checkText(req.body?.body, 'Comment text', MAX_COMMENT);
  if (text.error) return res.status(400).json({ error: text.error });

  const outcome = await withTransaction(async (db) => {
    // Lock the comment so two edits at once can't lose a version
    const found = await db.query(
      'SELECT author_id, body, is_internal FROM ticket_comments WHERE id = $1 AND ticket_id = $2 FOR UPDATE',
      [commentId, id]
    );
    const comment = found.rows[0];
    // An internal note is invisible to regular users, so for them it "doesn't exist" (404)
    if (!comment || (comment.is_internal && !isStaff(req.user))) {
      return { status: 404, error: 'Comment not found' };
    }
    if (comment.author_id !== req.user.id) {
      return { status: 403, error: 'You can only edit your own comments' };
    }
    if (comment.body === text.text) return {}; // same text: nothing to save

    await db.query('INSERT INTO comment_edits (comment_id, old_body) VALUES ($1, $2)', [commentId, comment.body]);
    await db.query('UPDATE ticket_comments SET body = $1, edited_at = NOW() WHERE id = $2', [text.text, commentId]);
    return {};
  });

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  const comment = await pool.query(`${COMMENT_SELECT} WHERE c.id = $1`, [commentId]);
  res.json({ comment: comment.rows[0] });
});

export default router;
