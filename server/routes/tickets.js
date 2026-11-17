// Tickets API: open, list, view and update help desk tickets, and read or write their comments.
//
// Every change to a ticket is saved in ticket_events (its history) in the same transaction as
// the change, and returned with the ticket.
//
// Who can do what:
//   User (the ticket's creator): open tickets, see only their own, comment on them, edit the
//     title and description while the ticket is still open, and close (resolve) it.
//   Staff (technician, admin, owner): see every ticket, change anything on it, assign it,
//     comment on any ticket, and write internal notes that users never see.
//   Anyone: edit their own comments. Every earlier version is kept and returned.
//
// Mounted at /api/tickets (see app.js).

import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF } from '../roles.js';
import { ATTACHMENT_SELECT, checkAttachmentIds, claimAttachments, publicAttachment } from './attachments.js';

const router = Router();

// Allowed values. Must match the CHECK constraints in db/schema.sql.
const STATUSES = ['open', 'in_progress', 'resolved'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// Length limits, so nobody can store a 10 MB "title".
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 5000;
const MAX_COMMENT = 5000;

// Every route needs a login. Listing every role blocks no one, but requireRole refreshes
// req.user.role from the database and refuses disabled accounts.
router.use(requireAuth, requireRole(...ROLES));

/** True for technicians, admins and owners. */
const isStaff = (user) => STAFF.includes(user.role);

// --- Queries ---

/**
 * The columns sent back for a ticket. The joins swap stored ids for names
 * (created_by 4 becomes created_by_name 'Alice'). The assignee and category use LEFT JOIN
 * because they can be empty, and a plain JOIN would drop those tickets.
 *
 * response_due_at and resolve_due_at come from the target times for the ticket's priority
 * (sla_targets), worked out on every read, so changing a priority or a target moves them at once.
 */
const TICKET_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority,
         t.category_id, category.name AS category_name,
         t.created_by,  creator.name  AS created_by_name,
         t.assigned_to, assignee.name AS assigned_to_name,
         t.created_at, t.updated_at, t.resolved_at, t.steps_tried, t.first_response_at,
         t.created_at + make_interval(mins => sla.first_response_minutes) AS response_due_at,
         t.created_at + make_interval(mins => sla.resolve_minutes)        AS resolve_due_at
    FROM tickets t
    JOIN users creator            ON creator.id  = t.created_by
    LEFT JOIN users assignee      ON assignee.id = t.assigned_to
    LEFT JOIN categories category ON category.id = t.category_id
    LEFT JOIN sla_targets sla     ON sla.priority = t.priority`;

/**
 * The columns sent back for a comment, including `edits`: every earlier version of its text.
 * json_agg gathers the matching comment_edits rows into one JSON list per comment, and
 * COALESCE turns "no edits" (null) into an empty list.
 */
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

// --- Helpers ---

/** Turns "42" into 42, or null if it isn't a positive whole number. */
export function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Trims text. Missing or blank text becomes null. */
function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Checks required text (title, description, comment). Returns { text } or { error }. */
export function checkText(value, label, max) {
  const text = cleanText(value);
  if (!text) return { error: `${label} is required` };
  if (text.length > max) return { error: `${label} must be ${max} characters or fewer` };
  return { text };
}

/**
 * Checks a category_id from the request; null means "no category".
 * Archived categories can't be picked. Returns { id, name } or { error }.
 */
export async function checkCategory(value) {
  if (value === null) return { id: null, name: null };
  const id = parseId(value);
  const result = id ? await pool.query('SELECT name, active FROM categories WHERE id = $1', [id]) : { rows: [] };
  if (!result.rows[0]?.active) return { error: 'Pick an existing, active category' };
  return { id, name: result.rows[0].name };
}

/**
 * Checks an assigned_to from the request; null means "unassigned".
 * Only active staff can be assigned a ticket. Returns { id, name } or { error }.
 */
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

/**
 * Loads a ticket the user is allowed to see, or returns null.
 *
 * Security: someone else's ticket returns null too, so the route answers 404, the same as a
 * ticket that doesn't exist. A 403 would confirm "ticket 57 exists" and leak information.
 */
async function findVisibleTicket(id, user) {
  const result = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [id]);
  const ticket = result.rows[0];
  if (!ticket || (!isStaff(user) && ticket.created_by !== user.id)) return null;
  return ticket;
}

/** A ticket's history, oldest first: who changed what, and when. */
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

/** The ticket plus its history: the response shape for GET, POST and PATCH. */
async function ticketWithHistory(id) {
  const ticket = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [id]);
  return { ticket: ticket.rows[0], history: await loadHistory(id) };
}

// --- Ticket routes ---

/**
 * POST /api/tickets
 * Opens a ticket. It always starts open and unassigned, and records a "created" history entry.
 * Access: anyone logged in.
 * Body: { title, description, category_id?, priority? (staff only), attachment_ids? }
 */
router.post('/', async (req, res) => {
  const body = req.body ?? {}; // Express 5 leaves req.body undefined if no JSON was sent
  const title = checkText(body.title, 'Title', MAX_TITLE);
  if (title.error) return res.status(400).json({ error: title.error });
  const description = checkText(body.description, 'Description', MAX_DESCRIPTION);
  if (description.error) return res.status(400).json({ error: description.error });

  // Why: only staff choose a priority. A priority sent by a regular user is ignored (like
  // created_by below), otherwise everyone would mark everything urgent. New tickets start at
  // medium, and staff (later the AI) adjust it.
  const priority = isStaff(req.user) ? (body.priority ?? 'medium') : 'medium';
  if (!PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `Priority must be one of: ${PRIORITIES.join(', ')}` });
  }
  const category = await checkCategory(body.category_id ?? null); // optional
  if (category.error) return res.status(400).json({ error: category.error });
  const files = await checkAttachmentIds(body.attachment_ids, req.user);
  if (files.error) return res.status(400).json({ error: files.error });

  // The ticket, its "created" history entry and its files are saved together, or not at all.
  // Security: created_by comes from the login token, never the body, so nobody can open a
  // ticket as someone else. status and assigned_to aren't accepted here either.
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
    await claimAttachments(db, files.ids, req.user, { ticketId });
    return ticketId;
  });

  res.status(201).json(await ticketWithHistory(id));
});

/**
 * GET /api/tickets
 * The ticket list, newest first. Staff see every ticket; users see only their own.
 * Access: anyone logged in.
 */
router.get('/', async (req, res) => {
  const result = isStaff(req.user)
    ? await pool.query(`${TICKET_SELECT} ORDER BY t.created_at DESC, t.id DESC`)
    : await pool.query(`${TICKET_SELECT} WHERE t.created_by = $1 ORDER BY t.created_at DESC, t.id DESC`, [
        req.user.id,
      ]);
  res.json({ tickets: result.rows });
});

/**
 * GET /api/tickets/assignees
 * Active staff a ticket can be assigned to, for the "Assign to" dropdown (no emails).
 * Access: staff.
 *
 * Note: defined before /:id, otherwise Express would treat "assignees" as a ticket id.
 */
router.get('/assignees', requireRole(...STAFF), async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, role FROM users WHERE role = ANY($1) AND disabled_at IS NULL ORDER BY name`,
    [STAFF]
  );
  res.json({ assignees: result.rows });
});

/**
 * GET /api/tickets/:id
 * One ticket with its full history. Someone else's ticket answers 404.
 * Access: the ticket's creator, or staff.
 */
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });

  const ticket = await findVisibleTicket(id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket, history: await loadHistory(id) });
});

/**
 * PATCH /api/tickets/:id
 * Changes a ticket. Send only the fields to change; null clears assigned_to or category_id.
 * Each changed field gets a history entry. Returns the ticket with its history.
 * Access:
 *   Staff: any field.
 *   The creator: title and description while the ticket is still open, and status 'resolved'
 *   (closing it themselves).
 * Body (any of): { title, description, status, priority, category_id, assigned_to }
 */
router.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  const body = req.body ?? {};
  const staff = isStaff(req.user);

  // Step 1: who may send which fields.
  const STAFF_ONLY = ['priority', 'category_id', 'assigned_to'];
  const blocked = STAFF_ONLY.filter((field) => body[field] !== undefined);
  if (!staff && blocked.length > 0) {
    return res.status(403).json({ error: `Only technicians, admins and owners can change: ${blocked.join(', ')}` });
  }
  if (!staff && body.status !== undefined && body.status !== 'resolved') {
    return res.status(403).json({ error: 'You can close your ticket (resolved), but only staff can set other statuses' });
  }

  // Step 2: check each value. `wanted` maps a field to { column, value for the database,
  // text for the history }, e.g. category: { column: 'category_id', value: 2, text: 'Hardware' }.
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

  // Step 3: save the changes and their history together.
  const outcome = await withTransaction(async (db) => {
    // Why: FOR UPDATE locks the ticket's row until COMMIT, so two people saving at the same
    // moment take turns instead of writing conflicting history. "OF t" locks only the ticket
    // row, not the joined users and category rows.
    const locked = await db.query(`${TICKET_SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [id]);
    const current = locked.rows[0];

    // A user may edit the text only while nobody has started on the ticket. Checked after the
    // lock, so the status can't change in between.
    if (!staff && (wanted.title || wanted.description) && current.status !== 'open') {
      return { status: 403, error: 'You can only edit a ticket while it is still open. Add a comment instead.' };
    }

    // Each field as it is now: the database value, and the text for the history.
    const before = {
      title: { value: current.title, text: current.title },
      description: { value: current.description, text: current.description },
      status: { value: current.status, text: current.status },
      priority: { value: current.priority, text: current.priority },
      category: { value: current.category_id, text: current.category_name },
      assignee: { value: current.assigned_to, text: current.assigned_to_name },
    };

    // Keep only fields that actually change; re-sending the current value isn't a change.
    const changed = Object.keys(wanted).filter((field) => wanted[field].value !== before[field].value);
    if (changed.length === 0) return { unchanged: true };

    // Security: builds "title = $1, status = $2". Column names come from the `wanted` table in
    // our own code, never the request, and values go through placeholders, so this is safe
    // from SQL injection.
    const setList = changed.map((field, i) => `${wanted[field].column} = $${i + 1}`);
    const values = changed.map((field) => wanted[field].value);

    // resolved_at records when a ticket was resolved (used for average time to resolve).
    // Set when the status becomes resolved; cleared when it's reopened.
    if (changed.includes('status')) {
      setList.push(wanted.status.value === 'resolved' ? 'resolved_at = NOW()' : 'resolved_at = NULL');
      // A status change by staff is something the user sees, so it counts as the first reply.
      if (staff && current.created_by !== req.user.id) {
        setList.push('first_response_at = COALESCE(first_response_at, NOW())');
      }
    }

    values.push(id);
    await db.query(`UPDATE tickets SET ${setList.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`, values);

    // One history row per changed field. Why: it stores the text people saw (e.g. the
    // assignee's name, not their id), so the history still reads correctly if names change.
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

// --- Comment routes ---

/**
 * GET /api/tickets/:id/comments
 * The conversation on a ticket, oldest first. Each comment includes `edits`, its earlier versions.
 * Access: the ticket's creator, or staff. Internal notes are left out for users.
 */
router.get('/:id/comments', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  // Security: "is_internal = FALSE OR $2" is true for every comment when $2 (is staff) is true,
  // and only for public comments otherwise. Filtering in SQL means internal notes never reach
  // a user's browser, not even in the raw response.
  const result = await pool.query(
    `${COMMENT_SELECT}
      WHERE c.ticket_id = $1 AND (c.is_internal = FALSE OR $2)
      ORDER BY c.created_at, c.id`,
    [id, isStaff(req.user)]
  );
  res.json({ comments: result.rows });
});

/**
 * POST /api/tickets/:id/comments
 * Adds a comment. Only staff can mark it internal; files sent with an internal note are
 * staff-only too.
 * Access: the ticket's creator, or staff.
 * Body: { body, is_internal?, attachment_ids? }
 */
router.post('/:id/comments', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
  const ticket = await findVisibleTicket(id, req.user);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const body = req.body ?? {};
  const text = checkText(body.body, 'Comment text', MAX_COMMENT);
  if (text.error) return res.status(400).json({ error: text.error });
  const isInternal = body.is_internal === true;
  if (isInternal && !isStaff(req.user)) {
    return res.status(403).json({ error: 'Only technicians, admins and owners can write internal notes' });
  }
  const files = await checkAttachmentIds(body.attachment_ids, req.user);
  if (files.error) return res.status(400).json({ error: files.error });

  // Security: the author comes from the login token, never the body.
  // The comment and its files are saved together, or not at all.
  const commentId = await withTransaction(async (db) => {
    const inserted = await db.query(
      `INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [id, req.user.id, text.text, isInternal]
    );
    // A comment counts as activity. A public one from staff (not on their own ticket) is also
    // the first reply, if there wasn't one yet; an internal note isn't, since the user can't see it.
    const firstReply = isStaff(req.user) && !isInternal && ticket.created_by !== req.user.id;
    await db.query(
      `UPDATE tickets SET updated_at = NOW()${firstReply ? ', first_response_at = COALESCE(first_response_at, NOW())' : ''}
        WHERE id = $1`,
      [id]
    );
    await claimAttachments(db, files.ids, req.user, { ticketId: id, commentId: inserted.rows[0].id });
    return inserted.rows[0].id;
  });

  const comment = await pool.query(`${COMMENT_SELECT} WHERE c.id = $1`, [commentId]);
  res.status(201).json({ comment: comment.rows[0] });
});

/**
 * GET /api/tickets/:id/attachments
 * Every file on a ticket, oldest first: those sent with the ticket (comment_id empty) and those
 * sent with comments. Files on internal notes are left out for users.
 * Access: the ticket's creator, or staff.
 */
router.get('/:id/attachments', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  // Security: filtered in SQL, the same way as internal notes in GET /:id/comments.
  const result = await pool.query(
    `${ATTACHMENT_SELECT}
       LEFT JOIN ticket_comments c ON c.id = a.comment_id
      WHERE a.ticket_id = $1 AND (c.is_internal IS NOT TRUE OR $2)
      ORDER BY a.created_at, a.id`,
    [id, isStaff(req.user)]
  );
  res.json({ attachments: result.rows.map(publicAttachment) });
});

/**
 * PATCH /api/tickets/:id/comments/:commentId
 * Edits your own comment. The old text is saved in comment_edits first, so anyone who can see
 * the comment can see what it said before. Comments can't be deleted.
 * Access: the comment's author.
 * Body: { body }
 */
router.patch('/:id/comments/:commentId', async (req, res) => {
  const id = parseId(req.params.id);
  const commentId = parseId(req.params.commentId);
  if (!id || !commentId) return res.status(400).json({ error: 'Invalid ticket or comment id' });
  if (!(await findVisibleTicket(id, req.user))) return res.status(404).json({ error: 'Ticket not found' });

  const text = checkText(req.body?.body, 'Comment text', MAX_COMMENT);
  if (text.error) return res.status(400).json({ error: text.error });

  const outcome = await withTransaction(async (db) => {
    // Lock the comment, so two quick edits can't lose a version.
    const found = await db.query(
      'SELECT author_id, body, is_internal FROM ticket_comments WHERE id = $1 AND ticket_id = $2 FOR UPDATE',
      [commentId, id]
    );
    const comment = found.rows[0];
    // An internal note is invisible to users, so for them it doesn't exist (404).
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
