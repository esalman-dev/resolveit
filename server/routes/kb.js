// Knowledge base API: how-to articles, drafted by the AI (from resolved tickets, or from a
// problem a technician types) and published by staff. Get help shows matching published ones
// before asking the AI (matchArticles, used by routes/help.js).
//
//   draft      only staff see it; drafted by the AI or written by hand
//   published  everyone can read it, and Get help suggests it
//   archived   hidden; admins and owners archive and restore
//
// Security: every step (and the "If it still doesn't work" text) is checked by the same word
// check as Get help. A draft with a blocked word is flagged, and publishing re-checks it, so a
// risky step can never go live.
//
// Mounted at /api/kb (see app.js).

import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ADMINS, ROLES, STAFF } from '../roles.js';
import { draftArticle, findMissingArticles, isAiConfigured, pickArticles, writeArticle, AiUnavailableError } from '../services/ai.js';
import { findBlockedTopic, MAX_STEPS } from '../services/guardrails.js';
import { checkText, parseId } from './tickets.js';
import { clampPage, readPaging } from '../services/paging.js';

const router = Router();

const MAX_TITLE = 200;
const MAX_PROBLEM = 2000;
const MAX_STEP_TITLE = 120;
const MAX_STEP_DETAIL = 600;
const MAX_ALSO_CALLED = 8; // phrases
const MAX_PHRASE = 60;
const MAX_IF_STILL_BROKEN = 1000; // matches the CHECK in schema.sql
const MISSING_DAYS = 30; // how far back "Missing articles" looks

const isStaff = (user) => STAFF.includes(user.role);

const UNAVAILABLE = "The AI isn't available right now. Try again later, or write the article by hand.";

/** The columns sent back for an article. */
const ARTICLE_SELECT = `
  SELECT a.id, a.title, a.problem, a.also_called, a.steps, a.if_still_broken, a.status, a.flagged,
         a.category_id, c.name AS category_name,
         a.source_ticket_id, a.helpful_count, a.not_helpful_count, a.created_at, a.updated_at, a.published_at,
         creator.name AS created_by_name, publisher.name AS published_by_name
    FROM kb_articles a
    LEFT JOIN categories c        ON c.id = a.category_id
    LEFT JOIN users creator       ON creator.id = a.created_by
    LEFT JOIN users publisher     ON publisher.id = a.published_by`;

// --- Helpers ---

/** The first blocked topic in any step or in the "If it still doesn't work" text, or null. */
const blockedIn = (steps, ifStillBroken = '') =>
  [...steps.map((s) => `${s.title} ${s.detail}`), ifStillBroken].map((text) => findBlockedTopic(text)).find((topic) => topic) ?? null;

/** Tidies "Also called" phrases: trimmed, no repeats (ignoring case), at most 8. */
function cleanAlsoCalled(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .filter((p) => typeof p === 'string')
    .map((p) => p.trim().slice(0, MAX_PHRASE))
    .filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .slice(0, MAX_ALSO_CALLED);
}

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
  if (body.also_called !== undefined) {
    if (!Array.isArray(body.also_called)) return { error: 'also_called must be a list of phrases' };
    fields.also_called = cleanAlsoCalled(body.also_called);
  }
  if (body.if_still_broken !== undefined) {
    if (typeof body.if_still_broken !== 'string') return { error: 'if_still_broken must be text' };
    if (body.if_still_broken.trim().length > MAX_IF_STILL_BROKEN) {
      return { error: `"If it still doesn't work" must be ${MAX_IF_STILL_BROKEN} characters or fewer` };
    }
    fields.if_still_broken = body.if_still_broken.trim();
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
 * Best first: most stems matched, then where they matched (ts_rank weighs a word in the title
 * or "Also called" above one in the steps), then the most "fixed it" votes.
 *
 * The knowledge base page also passes `offset` (to skip earlier pages) and `categoryId`.
 *
 * @returns {Promise<object[]>} articles with `matched` (stems found), `total` (stems asked) and
 *   `found` (how many articles match in all, for the page count)
 */
export async function searchArticles(text, { limit = 3, minMatched = 2, minShare = 0.25, offset = 0, categoryId = null } = {}) {
  const result = await pool.query(
    `WITH q AS (
       SELECT ARRAY(SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', $1)))) AS stems
     ),
     scored AS (
       SELECT a.id,
              (SELECT COUNT(*) FROM unnest(q.stems) s WHERE a.search_text @@ quote_literal(s)::tsquery)::int AS matched,
              cardinality(q.stems) AS total,
              -- Any of the stems ("vpn | home"); quoted the same way as the count above.
              ts_rank(a.search_text, (SELECT string_agg(quote_literal(s), ' | ') FROM unnest(q.stems) s)::tsquery) AS rank
         FROM kb_articles a, q
        WHERE a.status = 'published'
     )
     SELECT art.*, scored.matched, scored.total, COUNT(*) OVER ()::int AS found
       FROM scored
       JOIN (${ARTICLE_SELECT}) art ON art.id = scored.id
      WHERE scored.matched >= $2::int AND scored.matched >= scored.total * $3::float
        AND ($5::int IS NULL OR art.category_id = $5)
      ORDER BY scored.matched DESC, scored.rank DESC, art.helpful_count DESC, art.id
      LIMIT $4 OFFSET $6`,
    [String(text ?? ''), minMatched, minShare, limit, categoryId, offset]
  );
  return result.rows;
}

/** A loose shortlist: published articles sharing any word with the text, most shared first. */
const shortlist = (text, limit = 8) => searchArticles(text, { limit, minMatched: 1, minShare: 0 });

/**
 * The published articles that really match a Get help problem, best first (at most 3).
 *
 * How: the word search makes a loose shortlist (any shared word), then one small AI call keeps
 * only the articles about the same problem. Why both: words alone matched "Outlook won't open"
 * to a Wi-Fi article (both say "won't"), and missed "wifi" vs "Wi-Fi"; the AI alone would have
 * to read every article on every request.
 *
 * If the AI is off or fails, or `useAi` is false (the person has used their hourly AI checks),
 * the old strict word rule decides: at least 2 shared words, and at least a quarter of them.
 *
 * @returns {Promise<{ articles: object[], checkedBy: 'ai' | 'words' | 'none' }>}
 */
export async function matchArticles({ title, description }, { useAi = true } = {}) {
  const candidates = await shortlist(`${title} ${description}`);
  if (candidates.length === 0) return { articles: [], checkedBy: 'none' };
  if (useAi && isAiConfigured()) {
    try {
      const { ids } = await pickArticles({ title, description }, candidates);
      return { articles: ids.map((id) => candidates.find((a) => a.id === id)), checkedBy: 'ai' };
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) throw err;
      console.error('Article check unavailable, using word matching:', err.message);
    }
  }
  const strict = candidates.filter((a) => a.matched >= 2 && a.matched >= a.total * 0.25).slice(0, 3);
  return { articles: strict, checkedBy: 'words' };
}

/** The active categories, for the AI's suggestion and for saving it. */
const activeCategories = async () => (await pool.query('SELECT id, name FROM categories WHERE active ORDER BY name')).rows;

/**
 * Saves an AI draft as a draft article, after tidying it and running the word check.
 * @returns {Promise<{ article?: object, skipped?: string }>} skipped when the draft was unusable
 *   or another one was saved for the same ticket at the same moment
 */
async function saveDraft(draft, { categories, sourceTicketId = null, createdBy }) {
  const checked = cleanSteps(draft.steps);
  if (checked.error || !draft.title?.trim() || !draft.problem?.trim()) return { skipped: 'The draft was incomplete' };
  const ifStillBroken = String(draft.if_still_broken ?? '').trim().slice(0, MAX_IF_STILL_BROKEN);
  const categoryId = categories.find((c) => c.name.toLowerCase() === String(draft.suggested_category).toLowerCase())?.id ?? null;
  const inserted = await pool.query(
    `INSERT INTO kb_articles (title, problem, also_called, steps, if_still_broken, category_id, flagged, source_ticket_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_ticket_id) WHERE source_ticket_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      draft.title.trim().slice(0, MAX_TITLE),
      draft.problem.trim().slice(0, MAX_PROBLEM),
      JSON.stringify(cleanAlsoCalled(draft.also_called)),
      JSON.stringify(checked.steps),
      ifStillBroken,
      categoryId,
      blockedIn(checked.steps, ifStillBroken) !== null,
      sourceTicketId,
      createdBy,
    ]
  );
  if (!inserted.rows[0]) return { skipped: 'This ticket already has an article' }; // drafted twice at once
  return { article: (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1`, [inserted.rows[0].id])).rows[0] };
}

/** The published article the AI said already covers a problem, or null if that id isn't one. */
async function coveringArticle(draft, similar) {
  const id = similar.some((a) => a.id === draft.already_covered_id) ? draft.already_covered_id : null;
  return id ? (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1 AND a.status = 'published'`, [id])).rows[0] ?? null : null;
}

/**
 * Drafts an article from a resolved ticket with the AI, unless the ticket already has one or a
 * published article already covers the problem. Runs in the background after a ticket is
 * resolved, so the technician doesn't wait for it.
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
  const categories = await activeCategories();
  const similar = (await shortlist(`${ticket.title} ${ticket.description}`, 5)).map((a) => ({ id: a.id, title: a.title }));

  let result;
  try {
    result = await draftArticle({
      title: ticket.title,
      description: ticket.description,
      stepsTried: ticket.steps_tried ?? [],
      comments: comments.rows.map((c) => ({ from: c.role === 'user' ? 'Employee' : 'Technician', body: c.body })),
      categoryNames: categories.map((c) => c.name),
      similar,
    });
  } catch (err) {
    if (err instanceof AiUnavailableError) return { skipped: 'The AI is not available right now' };
    throw err;
  }

  const draft = result.answer;
  if (draft.skip) {
    const covering = await coveringArticle(draft, similar);
    if (covering) return { skipped: `Already covered by "${covering.title}"` };
    return { skipped: draft.skip_reason || 'Nothing reusable to write up' };
  }
  return saveDraft(draft, { categories, sourceTicketId: ticketId, createdBy });
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
 * One page of articles, newest first, or the best matches for `q`, with `total` (how many in
 * all). Published lists also carry each category's article count, for the category buttons.
 * Access: anyone logged in. Users only ever get published articles.
 * Query: q (search words), status (staff: draft, published, archived; default published),
 *   category (a category id: published articles in it), page, per_page, source_ticket (staff:
 *   the article drafted from that ticket, any status)
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
  const categoryId = req.query.category !== undefined ? parseId(req.query.category) : null;
  if (req.query.category !== undefined && !categoryId) return res.status(400).json({ error: 'Invalid category' });

  const counts = staff
    ? (await pool.query("SELECT COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts FROM kb_articles")).rows[0]
    : undefined;
  const categories =
    status === 'published'
      ? (
          await pool.query(
            `SELECT c.id, c.name, COUNT(*)::int AS count
               FROM kb_articles a JOIN categories c ON c.id = a.category_id
              WHERE a.status = 'published'
              GROUP BY c.id, c.name ORDER BY c.name`
          )
        ).rows
      : undefined;

  const { page: asked, perPage } = readPaging(req.query);
  let total;
  let articles;
  if (q && status === 'published') {
    // A short search is a few words, so one matching word is enough here (unlike Get help).
    const search = { minMatched: 1, minShare: 0, categoryId: categoryId ?? null };
    total = (await searchArticles(q, { ...search, limit: 1 }))[0]?.found ?? 0;
    const { offset } = clampPage(asked, perPage, total);
    articles = await searchArticles(q, { ...search, limit: perPage, offset });
  } else {
    const params = [status];
    if (status === 'published' && categoryId) params.push(categoryId);
    const where = `WHERE a.status = $1 ${params.length > 1 ? 'AND a.category_id = $2' : ''}`;
    total = (await pool.query(`SELECT COUNT(*)::int AS n FROM kb_articles a ${where}`, params)).rows[0].n;
    const { offset } = clampPage(asked, perPage, total);
    articles = (await pool.query(`${ARTICLE_SELECT} ${where} ORDER BY a.updated_at DESC, a.id DESC LIMIT ${perPage} OFFSET ${offset}`, params)).rows;
  }
  const { page } = clampPage(asked, perPage, total);
  res.json({ articles, total, page, per_page: perPage, counts, categories });
});

/**
 * POST /api/kb/write
 * "Write with AI": the AI drafts an article for a problem a technician types, from standard
 * fixes. Saved as a draft for a person to check and publish.
 * - 201 { article }: the new draft.
 * - 200 { covered }: a published article already covers it; nothing was saved.
 * - 422: the AI found nothing an employee could do alone (only IT can fix it).
 * - 503: the AI isn't available.
 * Access: staff.
 * Body: { problem }
 */
router.post('/write', requireRole(...STAFF), async (req, res) => {
  const problem = checkText(req.body?.problem, 'Problem', 300);
  if (problem.error) return res.status(400).json({ error: problem.error });
  if (!isAiConfigured()) return res.status(503).json({ error: UNAVAILABLE });

  const categories = await activeCategories();
  const similar = (await shortlist(problem.text, 5)).map((a) => ({ id: a.id, title: a.title }));
  let result;
  try {
    result = await writeArticle({ problem: problem.text, categoryNames: categories.map((c) => c.name), similar });
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    return res.status(503).json({ error: UNAVAILABLE });
  }

  const draft = result.answer;
  if (draft.skip) {
    const covering = await coveringArticle(draft, similar);
    if (covering) return res.json({ covered: covering });
    return res.status(422).json({ error: draft.skip_reason || "That isn't something an employee can fix on their own." });
  }
  const saved = await saveDraft(draft, { categories, createdBy: req.user.id });
  if (!saved.article) return res.status(503).json({ error: UNAVAILABLE });
  res.status(201).json({ article: saved.article });
});

/**
 * POST /api/kb/missing
 * "Missing articles": the most common problems of the last 30 days that no article helped with,
 * grouped by the AI (at most 8, from the newest 150 requests). A POST because each press is a
 * new AI call.
 * Looks at Get help requests that didn't end with an article fixing them, and tickets opened
 * without Get help. Answers { groups: [{ problem, count, examples }], request_count }.
 * Access: staff.
 */
router.post('/missing', requireRole(...STAFF), async (req, res) => {
  if (!isAiConfigured()) return res.status(503).json({ error: UNAVAILABLE });
  // Security: titles only; never who asked, descriptions or comments.
  // Why outages are left out: many reports of one outage aren't a missing how-to.
  const requests = (
    await pool.query(
      `SELECT title FROM (
         SELECT s.title, s.created_at FROM help_sessions s
           LEFT JOIN tickets t ON t.id = s.ticket_id
          WHERE s.kind = 'fix' AND s.article_id IS NULL AND s.outcome <> 'pending' AND t.outage_id IS NULL
            AND s.created_at > NOW() - make_interval(days => $1)
         UNION ALL
         SELECT t.title, t.created_at FROM tickets t
          WHERE t.kind = 'issue' AND t.outage_id IS NULL AND t.created_at > NOW() - make_interval(days => $1)
            AND NOT EXISTS (SELECT 1 FROM help_sessions s WHERE s.ticket_id = t.id)
       ) recent
       ORDER BY created_at DESC
       LIMIT 150`,
      [MISSING_DAYS]
    )
  ).rows.map((r) => r.title);
  // Too few to find a pattern: no AI call.
  if (requests.length < 3) return res.json({ groups: [], request_count: requests.length });

  const articles = (await pool.query("SELECT title FROM kb_articles WHERE status <> 'archived' ORDER BY title")).rows.map((r) => r.title);
  try {
    const { groups } = await findMissingArticles({ requests, articles });
    res.json({ groups, request_count: requests.length });
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    res.status(503).json({ error: UNAVAILABLE });
  }
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
 * Body: { title, problem, steps: [{ title, detail }], also_called?: [phrases], if_still_broken?, category_id? }
 */
router.post('/', requireRole(...STAFF), async (req, res) => {
  const checked = checkFields(req.body ?? {});
  if (checked.error) return res.status(400).json({ error: checked.error });
  const f = { also_called: [], if_still_broken: '', ...checked.fields };
  const inserted = await pool.query(
    `INSERT INTO kb_articles (title, problem, also_called, steps, if_still_broken, category_id, flagged, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      f.title,
      f.problem,
      JSON.stringify(f.also_called),
      JSON.stringify(f.steps),
      f.if_still_broken,
      f.category_id ?? null,
      blockedIn(f.steps, f.if_still_broken) !== null,
      req.user.id,
    ]
  );
  res.status(201).json({ article: (await pool.query(`${ARTICLE_SELECT} WHERE a.id = $1`, [inserted.rows[0].id])).rows[0] });
});

/**
 * PATCH /api/kb/:id
 * Edits an article. Editing a published article keeps it published, but it's checked again.
 * Access: staff.
 * Body: any of { title, problem, steps, also_called, if_still_broken, category_id }
 */
router.patch('/:id', requireRole(...STAFF), async (req, res) => {
  const id = parseId(req.params.id);
  const article = id ? await findVisibleArticle(id, req.user) : null;
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const checked = checkFields(req.body ?? {}, { partial: true });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const f = { ...article, ...checked.fields };
  const blocked = blockedIn(f.steps, f.if_still_broken);
  if (article.status === 'published' && blocked) {
    return res.status(409).json({ error: `The article mentions ${blocked}, which needs a technician. Published articles can't include it.` });
  }
  await pool.query(
    `UPDATE kb_articles
        SET title = $2, problem = $3, also_called = $4, steps = $5, if_still_broken = $6, category_id = $7, flagged = $8, updated_at = NOW()
      WHERE id = $1`,
    [id, f.title, f.problem, JSON.stringify(f.also_called), JSON.stringify(f.steps), f.if_still_broken, f.category_id, blocked !== null]
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
  const blocked = blockedIn(article.steps, article.if_still_broken);
  if (blocked) {
    return res.status(409).json({ error: `The article mentions ${blocked}, which needs a technician. Remove or rewrite it before publishing.` });
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

export default router;
