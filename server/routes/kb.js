// Knowledge base API: how-to articles, drafted by the AI from resolved tickets and published by
// staff. Get help searches the published ones before asking the AI (see routes/help.js).
//
//   draft      only staff see it; created from a resolved ticket (draftFromTicket) or by hand
//   published  everyone can read it, and Get help suggests it
//   archived   hidden; admins and owners archive and restore
//
// Security: every step is checked by the same word check as Get help. A draft with a blocked
// step is flagged, and publishing re-checks every step, so a risky step can never go live.
//
// Mounted at /api/kb (see app.js).

import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ADMINS, ROLES, STAFF } from '../roles.js';
import { draftArticle, isAiConfigured, AiUnavailableError } from '../services/ai.js';
import { findBlockedTopic, MAX_STEPS } from '../services/guardrails.js';
import { parseId } from './tickets.js';

const router = Router();

const MAX_TITLE = 200;
const MAX_PROBLEM = 2000;
const MAX_STEP_TITLE = 120;
const MAX_STEP_DETAIL = 600;

const isStaff = (user) => STAFF.includes(user.role);

/** The columns sent back for an article. */
const ARTICLE_SELECT = `
  SELECT a.id, a.title, a.problem, a.steps, a.status, a.flagged, a.category_id, c.name AS category_name,
         a.source_ticket_id, a.helpful_count, a.not_helpful_count, a.created_at, a.updated_at, a.published_at,
         creator.name AS created_by_name, publisher.name AS published_by_name
    FROM kb_articles a
    LEFT JOIN categories c        ON c.id = a.category_id
    LEFT JOIN users creator       ON creator.id = a.created_by
    LEFT JOIN users publisher     ON publisher.id = a.published_by`;

// --- Helpers ---

/** The first blocked topic in any step, or null. */
const blockedIn = (steps) =>
  steps.map((s) => findBlockedTopic(`${s.title} ${s.detail}`)).find((topic) => topic) ?? null;

/** Checks and tidies steps from a request or the AI. Returns { steps } or { error }. */
function cleanSteps(value) {
  if (!Array.isArray(value)) return { error: 'steps must be a list of { title, detail }' };
  const steps = value
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({ title: s.title.trim().slice(0, MAX_STEP_TITLE), detail: String(s.detail ?? '').trim().slice(0, MAX_STEP_DETAIL) }));
  if (steps.length === 0) return { error: 'An article needs at least one step' };
  if (steps.length > MAX_STEPS) return { error: `An article can have at most ${MAX_STEPS} steps` };
  return { steps };
}

/** Checks an article's text fields from a request. Returns the fields to save, or { error }. */
function checkFields(body, { partial = false } = {}) {
  const fields = {};
  for (const [name, max, label] of [['title', MAX_TITLE, 'Title'], ['problem', MAX_PROBLEM, 'Problem']]) {
    if (body[name] === undefined && partial) continue;
    const text = typeof body[name] === 'string' ? body[name].trim() : '';
    if (!text) return { error: `${label} is required` };
    if (text.length > max) return { error: `${label} must be ${max} characters or fewer` };
    fields[name] = text;
  }
  if (body.steps !== undefined || !partial) {
    const checked = cleanSteps(body.steps);
    if (checked.error) return { error: checked.error };
    fields.steps = checked.steps;
  }
  if (body.category_id !== undefined) {
    if (body.category_id !== null && !parseId(body.category_id)) return { error: 'Invalid category' };
    fields.category_id = body.category_id;
  }
  return { fields };
}

/**
 * Finds published articles that match some text, best first.
 *
 * How: PostgreSQL turns the text into word stems ("printers" → "printer", common words dropped),
 * then counts how many of those stems each article contains. An article must contain at least
 * `minMatched` of them, and at least `minShare` of them, so one shared everyday word ("laptop")
 * isn't enough for Get help to suggest it.
 *
 * @returns {Promise<object[]>} articles with `matched` (stems found) and `total` (stems asked)
 */
export async function searchArticles(text, { limit = 3, minMatched = 2, minShare = 0.25 } = {}) {
  const result = await pool.query(
    `WITH q AS (
       SELECT ARRAY(SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', $1)))) AS stems
     ),
     scored AS (
       SELECT a.id,
              (SELECT COUNT(*) FROM unnest(q.stems) s WHERE a.search_text @@ quote_literal(s)::tsquery)::int AS matched,
              cardinality(q.stems) AS total
         FROM kb_articles a, q
        WHERE a.status = 'published'
     )
     SELECT art.*, scored.matched, scored.total
       FROM scored
       JOIN (${ARTICLE_SELECT}) art ON art.id = scored.id
      WHERE scored.matched >= $2::int AND scored.matched >= scored.total * $3::float
      ORDER BY scored.matched DESC, art.helpful_count DESC, art.id
      LIMIT $4`,
    [String(text ?? ''), minMatched, minShare, limit]
  );
  return result.rows;
}

/**
 * Drafts an article from a resolved ticket with the AI, unless the ticket already has one.
 * Runs in the background after a ticket is resolved, so the technician doesn't wait for it.
 *
 * Security: sends the ticket's title, description, steps tried and public comments (authors as
 * "Employee" or "Technician"). Never internal notes, names or emails.
 *
 * @returns {Promise<{ article?: object, skipped?: string }>}
 */
export async function draftFromTicket(ticketId, createdBy) {
  if (!isAiConfigured()) return { skipped: 'AI is not set up' };
  const ticket = (await pool.query('SELECT id, title, description, steps_tried, created_by FROM tickets WHERE id = $1', [ticketId])).rows[0];
  if (!ticket) return { skipped: 'Ticket not found' };
  const existing = await pool.query('SELECT id FROM kb_articles WHERE source_ticket_id = $1', [ticketId]);
  if (existing.rows[0]) return { skipped: 'This ticket already has an article' };

  const comments = await pool.query(
    `SELECT c.body, u.role FROM ticket_comments c JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = $1 AND NOT c.is_internal ORDER BY c.created_at, c.id`,
    [ticketId]
  );
  const categories = (await pool.query('SELECT id, name FROM categories WHERE active ORDER BY name')).rows;

  let result;
  try {
    result = await draftArticle({
      title: ticket.title,
      description: ticket.description,
      stepsTried: ticket.steps_tried ?? [],
      comments: comments.rows.map((c) => ({ from: c.role === 'user' ? 'Employee' : 'Technician', body: c.body })),
      categoryNames: categories.map((c) => c.name),
    });
  } catch (err) {
    if (err instanceof AiUnavailableError) return { skipped: 'The AI is not available right now' };
    throw err;
  }

  const draft = result.answer;
  if (draft.skip) return { skipped: draft.skip_reason || 'Nothing reusable to write up' };
  const checked = cleanSteps(draft.steps);
  if (checked.error || !draft.title?.trim() || !draft.problem?.trim()) return { skipped: 'The draft was incomplete' };
  const categoryId = categories.find((c) => c.name.toLowerCase() === String(draft.suggested_category).toLowerCase())?.id ?? null;

  const inserted = await pool.query(
    `INSERT INTO kb_articles (title, problem, steps, category_id, flagged, source_ticket_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_ticket_id) WHERE source_ticket_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      draft.title.trim().slice(0, MAX_TITLE),
      draft.problem.trim().slice(0, MAX_PROBLEM),
      JSON.stringify(checked.steps),
      categoryId,
      blockedIn(checked.steps) !== null,
      ticketId,
      createdBy,
    ]
  );
  if (!inserted.rows[0]) return { skipped: 'This ticket already has an article' }; // drafted twice at once
  return { article: (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1`, [inserted.rows[0].id])).rows[0] };
}

/** Loads one article this user may see, or null. Drafts and archived articles are staff-only. */
async function findVisibleArticle(id, user) {
  const article = (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1`, [id])).rows[0];
  if (!article || (article.status !== 'published' && !isStaff(user))) return null;
  return article;
}

// --- Routes ---

router.use(requireAuth, requireRole(...ROLES));

/**
 * GET /api/kb
 * Articles, newest first, or the best matches for `q`.
 * Access: anyone logged in. Users only ever get published articles.
 * Query: q (search words), status (staff: draft, published, archived; default published),
 *   source_ticket (staff: the article drafted from that ticket, any status)
 */
router.get('/', async (req, res) => {
  const staff = isStaff(req.user);
  if (staff && req.query.source_ticket !== undefined) {
    const ticketId = parseId(req.query.source_ticket);
    if (!ticketId) return res.status(400).json({ error: 'Invalid ticket id' });
    const found = await pool.query(`${ARTICLE_SELECT} WHERE a.source_ticket_id = $1`, [ticketId]);
    return res.json({ articles: found.rows });
  }
  const status = staff && ['draft', 'archived'].includes(req.query.status) ? req.query.status : 'published';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  if (q && status === 'published') {
    // A short search is a few words, so one matching word is enough here (unlike Get help).
    return res.json({ articles: await searchArticles(q, { limit: 50, minMatched: 1, minShare: 0 }) });
  }
  const list = await pool.query(`${ARTICLE_SELECT} WHERE a.status = $1 ORDER BY a.updated_at DESC LIMIT 200`, [status]);
  const counts = staff
    ? (await pool.query("SELECT COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts FROM kb_articles")).rows[0]
    : undefined;
  res.json({ articles: list.rows, counts });
});

/**
 * GET /api/kb/:id
 * One article. Drafts and archived articles answer 404 for users.
 * Access: anyone logged in.
 */
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const article = id ? await findVisibleArticle(id, req.user) : null;
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json({ article });
});

/**
 * POST /api/kb
 * Writes an article by hand. It starts as a draft.
 * Access: staff.
 * Body: { title, problem, steps: [{ title, detail }], category_id? }
 */
router.post('/', requireRole(...STAFF), async (req, res) => {
  const checked = checkFields(req.body ?? {});
  if (checked.error) return res.status(400).json({ error: checked.error });
  const f = checked.fields;
  const inserted = await pool.query(
    `INSERT INTO kb_articles (title, problem, steps, category_id, flagged, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [f.title, f.problem, JSON.stringify(f.steps), f.category_id ?? null, blockedIn(f.steps) !== null, req.user.id]
  );
  res.status(201).json({ article: (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1`, [inserted.rows[0].id])).rows[0] });
});

/**
 * PATCH /api/kb/:id
 * Edits an article. Editing a published article keeps it published, but it's checked again.
 * Access: staff.
 * Body: any of { title, problem, steps, category_id }
 */
router.patch('/:id', requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  const article = id ? await findVisibleArticle(id, req.user) : null;
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const checked = checkFields(req.body ?? {}, { partial: true });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const f = { title: article.title, problem: article.problem, steps: article.steps, category_id: article.category_id, ...checked.fields };
  const blocked = blockedIn(f.steps);
  if (article.status === 'published' && blocked) {
    return res.status(409).json({ error: `A step mentions ${blocked}, which needs a technician. Published articles can't include it.` });
  }
  await pool.query(
    `UPDATE kb_articles SET title = $2, problem = $3, steps = $4, category_id = $5, flagged = $6, updated_at = NOW()
      WHERE id = $1`,
    [id, f.title, f.problem, JSON.stringify(f.steps), f.category_id, blocked !== null]
  );
  res.json({ article: (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1`, [id])).rows[0] });
});

/**
 * POST /api/kb/:id/publish
 * Publishes a draft (or restores an archived article). Every step is checked first.
 * Access: staff (restoring an archived article: admins and owners).
 */
router.post('/:id/publish', requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  const article = id ? await findVisibleArticle(id, req.user) : null;
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status === 'archived' && !ADMINS.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins and owners can restore an archived article' });
  }
  // Security: checked again here, whatever the draft said, so nothing risky goes live.
  const blocked = blockedIn(article.steps);
  if (blocked) {
    return res.status(409).json({ error: `A step mentions ${blocked}, which needs a technician. Remove or rewrite it before publishing.` });
  }
  await pool.query(
    `UPDATE kb_articles SET status = 'published', flagged = FALSE, published_by = $2, published_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id, req.user.id]
  );
  res.json({ article: (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1`, [id])).rows[0] });
});

/**
 * POST /api/kb/:id/archive
 * Hides a published article (kept, can be restored).
 * Access: admins and owners.
 */
router.post('/:id/archive', requireRole(...ADMINS), async (req, res) => {
  const id = parseId(req.params.id);
  const updated = id
    ? await pool.query("UPDATE kb_articles SET status = 'archived', updated_at = NOW() WHERE id = $1 AND status = 'published' RETURNING id", [id])
    : { rows: [] };
  if (!updated.rows[0]) return res.status(404).json({ error: 'Published article not found' });
  res.json({ article: (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1`, [id])).rows[0] });
});

/**
 * DELETE /api/kb/:id
 * Discards a draft. Published and archived articles can't be deleted, only archived.
 * Access: staff.
 */
router.delete('/:id', requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  const removed = id ? await pool.query("DELETE FROM kb_articles WHERE id = $1 AND status = 'draft' RETURNING id", [id]) : { rows: [] };
  if (!removed.rows[0]) return res.status(404).json({ error: 'Draft not found' });
  res.status(204).end();
});

/**
 * POST /api/kb/:id/feedback
 * "Was this helpful?" on an article page.
 * Access: anyone logged in, on a published article.
 * Body: { helpful: boolean }
 */
router.post('/:id/feedback', async (req, res) => {
  const id = parseId(req.params.id);
  if (typeof req.body?.helpful !== 'boolean') return res.status(400).json({ error: 'helpful must be true or false' });
  const column = req.body.helpful ? 'helpful_count' : 'not_helpful_count'; // fixed names, never from the request
  const updated = id
    ? await pool.query(`UPDATE kb_articles SET ${column} = ${column} + 1 WHERE id = $1 AND status = 'published' RETURNING id`, [id])
    : { rows: [] };
  if (!updated.rows[0]) return res.status(404).json({ error: 'Article not found' });
  res.status(204).end();
});

export default router;
