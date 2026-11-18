// Help API: AI self-service fixes, tried before a ticket is opened.
//
// 1. POST /suggest: the user describes a problem; the AI suggests safe steps, or the problem
//    goes straight to a technician (a ticket is opened at once).
// 2. POST /:id/outcome: after trying the steps, "fixed" (no ticket needed) or "still_broken"
//    (a ticket is opened with the steps already tried).
// 3. GET /sessions: staff see every attempt and its result, including what users fixed alone.
// 4. GET /mine and GET /:id: a user comes back to an unfinished request without asking again.
// 5. POST /ask and GET /questions/mine: Ask IT, one quick question and its answer.
//
// Every request is saved in help_sessions, whatever happens. Daily limits count those rows, and
// the dashboard's self-solved rate comes from their outcomes.
//
// Mounted at /api/help (see app.js).

import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF } from '../roles.js';
import { askForFix, askQuestion, isAiConfigured, currentModel, AiUnavailableError } from '../services/ai.js';
import { reviewAnswer, reviewSuggestion } from '../services/guardrails.js';
import { checkText, checkCategory, parseId, MAX_TITLE, MAX_DESCRIPTION } from './tickets.js';
import { ATTACHMENT_SELECT, checkAttachmentIds, claimAttachments, publicAttachment } from './attachments.js';
import { readFile } from '../services/storage.js';
import { searchArticles } from './kb.js';

// Images larger than this aren't sent to the AI (its limit is 5 MB once encoded as text, which
// adds a third). They stay attached to the request and the ticket either way.
const MAX_AI_IMAGE_BYTES = 3.5 * 1024 * 1024;

const router = Router();

// Every route needs a login; requireRole also refuses disabled accounts.
router.use(requireAuth, requireRole(...ROLES));

const UNAVAILABLE = "Automatic help isn't available right now. You can still open a ticket.";

/**
 * AI requests allowed per rolling 24 hours: per person, and for the whole site. Get help and
 * Ask IT share them.
 * Why: each request costs money. These cap the bill even if someone scripts requests or a bug
 * loops, on top of the monthly limit set on the AI account. Read on every request, so the
 * numbers can change in .env without code changes.
 */
function dailyLimits() {
  const read = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  return { perUser: read('AI_DAILY_LIMIT_PER_USER', 20), site: read('AI_DAILY_LIMIT_SITE', 300) };
}

// --- Helpers ---

/** The session fields the browser needs. */
const publicSession = (row) => ({
  id: row.id,
  outcome: row.outcome,
  steps: row.steps,
  escalate_reason: row.escalate_reason,
  ticket_id: row.ticket_id,
});

/**
 * Opens a ticket from a help session, with a "created" history entry marked 'get_help' (its new_value).
 * Must run inside a transaction (`db`), together with the session update.
 *
 * Why not reuse POST /api/tickets? Here the server sets the priority (from the AI) and the steps
 * tried, which users can't set through the normal ticket form.
 */
async function openTicket(db, session, stepsTried) {
  // The user's own category wins; otherwise the AI's suggestion. Either one may have been
  // archived since, so only an active category is kept.
  const inserted = await db.query(
    `INSERT INTO tickets (title, description, priority, category_id, steps_tried, created_by)
     VALUES ($1, $2, $3,
             (SELECT id FROM categories WHERE id = COALESCE($4::int, $5::int) AND active),
             $6, $7)
     RETURNING id`,
    [
      session.title,
      session.description,
      session.suggested_priority ?? 'medium',
      session.category_id,
      session.suggested_category_id,
      JSON.stringify(stepsTried),
      session.user_id,
    ]
  );
  const ticketId = inserted.rows[0].id;
  await db.query(`INSERT INTO ticket_events (ticket_id, actor_id, action, new_value) VALUES ($1, $2, 'created', 'get_help')`, [
    ticketId,
    session.user_id,
  ]);
  // Files sent with the request move onto the ticket, so the technician sees them too.
  await db.query('UPDATE attachments SET ticket_id = $1 WHERE help_session_id = $2', [ticketId, session.id]);
  return ticketId;
}

/**
 * The request's images, ready to send to the AI: [{ media_type, data (base64) }].
 * PDFs and text logs aren't sent; they're for the technician.
 */
async function imagesFor(sessionId) {
  const result = await pool.query(
    `SELECT storage_key, content_type FROM attachments
      WHERE help_session_id = $1 AND content_type LIKE 'image/%' AND size_bytes <= $2
      ORDER BY id`,
    [sessionId, MAX_AI_IMAGE_BYTES]
  );
  return Promise.all(
    result.rows.map(async (row) => ({
      media_type: row.content_type,
      data: (await readFile(row.storage_key)).toString('base64'),
    }))
  );
}

/**
 * Checks the limits and, if there's room, saves a pending session for this request.
 * Returns { session } or { limit: 'user' | 'site' }.
 *
 * Why the lock: two requests at the same moment could both count 9 of 10 and both go ahead.
 * The lock makes count-then-insert happen one request at a time. It's held for two quick
 * queries, never during the AI call.
 */
async function reserveSession(user, { kind = 'fix', title, description, categoryId = null, attachmentIds = [] }) {
  const limits = dailyLimits();
  return withTransaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('help_sessions_limit'))"); // released at COMMIT
    const counts = await db.query(
      `SELECT COUNT(*) FILTER (WHERE user_id = $1)::int AS mine, COUNT(*)::int AS everyone
         FROM help_sessions
        WHERE created_at > NOW() - INTERVAL '24 hours'
          AND article_id IS NULL -- solved by a knowledge base article: no AI was used, so it's free`,
      [user.id]
    );
    const { mine, everyone } = counts.rows[0];
    if (mine >= limits.perUser) return { limit: 'user' };
    if (everyone >= limits.site) return { limit: 'site' };

    const inserted = await db.query(
      `INSERT INTO help_sessions (user_id, kind, title, description, category_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user.id, kind, title, description, categoryId]
    );
    await claimAttachments(db, attachmentIds, user, { helpSessionId: inserted.rows[0].id });
    return { session: inserted.rows[0] };
  });
}

/**
 * Closes a session as failed after the AI call went wrong, keeping any tokens spent.
 * An unavailable AI is expected (the caller answers 503); anything else is a bug and is rethrown.
 */
async function markFailed(sessionId, err) {
  // Any failure closes the session, so it isn't left looking abandoned.
  await pool.query(
    `UPDATE help_sessions
        SET outcome = 'failed', finished_at = NOW(), model = $2, input_tokens = $3, output_tokens = $4
      WHERE id = $1`,
    [sessionId, currentModel(), err.usage?.input_tokens ?? null, err.usage?.output_tokens ?? null]
  );
  // Why: the browser falls back to the plain ticket form with the same files, so they're
  // released for it to attach.
  await pool.query('UPDATE attachments SET help_session_id = NULL, attached_at = NULL WHERE help_session_id = $1', [
    sessionId,
  ]);
  if (!(err instanceof AiUnavailableError)) throw err;
  console.error('AI help unavailable:', err.message);
}

/** The 429 answer when a daily limit is reached. */
const limitReached = (limit) => ({
  error:
    limit === 'user'
      ? `You've used all ${dailyLimits().perUser} automatic answers for the last 24 hours. You can still open a ticket.`
      : UNAVAILABLE,
  limit,
});

// --- Routes ---

/**
 * POST /api/help/match
 * Published knowledge base articles that match a problem, best first (at most 3). Get help
 * shows these before asking the AI. No AI call, so it doesn't count toward the daily limit.
 * Access: anyone logged in.
 * Body: { title, description }
 */
router.post('/match', async (req, res) => {
  const body = req.body ?? {};
  const title = checkText(body.title, 'Title', MAX_TITLE);
  if (title.error) return res.status(400).json({ error: title.error });
  const description = checkText(body.description, 'Description', MAX_DESCRIPTION);
  if (description.error) return res.status(400).json({ error: description.error });
  const articles = await searchArticles(`${title.text} ${description.text}`);
  res.json({ articles: articles.map(({ id, title: t, problem, steps, category_name }) => ({ id, title: t, problem, steps, category_name })) });
});

/**
 * POST /api/help/article-fixed
 * "That fixed it" on a knowledge base article in Get help. Saved as a Get help request that was
 * fixed (so the dashboard's self-solved rate counts it), with the article it used. No AI was
 * used, so it doesn't count toward the daily limit. Any files added are kept with it.
 * Access: anyone logged in.
 * Body: { article_id, title, description, category_id?, attachment_ids? }
 */
router.post('/article-fixed', async (req, res) => {
  const body = req.body ?? {};
  const articleId = parseId(body.article_id);
  const title = checkText(body.title, 'Title', MAX_TITLE);
  if (title.error) return res.status(400).json({ error: title.error });
  const description = checkText(body.description, 'Description', MAX_DESCRIPTION);
  if (description.error) return res.status(400).json({ error: description.error });
  const category = await checkCategory(body.category_id ?? null);
  if (category.error) return res.status(400).json({ error: category.error });
  const files = await checkAttachmentIds(body.attachment_ids, req.user);
  if (files.error) return res.status(400).json({ error: files.error });
  const article = articleId
    ? (await pool.query("SELECT id, steps FROM kb_articles WHERE id = $1 AND status = 'published'", [articleId])).rows[0]
    : null;
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const session = await withTransaction(async (db) => {
    const inserted = await db.query(
      `INSERT INTO help_sessions (user_id, kind, title, description, category_id, steps, outcome, finished_at, article_id)
       VALUES ($1, 'fix', $2, $3, $4, $5, 'fixed', NOW(), $6)
       RETURNING *`,
      [req.user.id, title.text, description.text, category.id, JSON.stringify(article.steps), article.id]
    );
    await db.query('UPDATE kb_articles SET helpful_count = helpful_count + 1 WHERE id = $1', [article.id]);
    await claimAttachments(db, files.ids, req.user, { helpSessionId: inserted.rows[0].id });
    return inserted.rows[0];
  });
  res.status(201).json({ session: publicSession(session) });
});

/**
 * POST /api/help/suggest
 * Asks the AI for safe steps for a problem.
 * - 200 { session }: steps to try (outcome "pending"); answer with POST /:id/outcome.
 * - 201 { session, ticket_id }: needs a technician; a ticket was opened straight away.
 * - 429: a daily limit was reached. 503: the AI isn't available. In both cases the browser
 *   offers the normal ticket form instead.
 * Images in attachment_ids are sent to the AI with the text (the form says so). If the AI
 * fails, the files are released, so the plain ticket form can attach them instead.
 * Articles in skipped_article_ids were shown and passed on: they count as not helpful.
 * Access: anyone logged in.
 * Body: { title, description, category_id?, attachment_ids?, skipped_article_ids? }
 */
router.post('/suggest', async (req, res) => {
  const body = req.body ?? {};
  const title = checkText(body.title, 'Title', MAX_TITLE);
  if (title.error) return res.status(400).json({ error: title.error });
  const description = checkText(body.description, 'Description', MAX_DESCRIPTION);
  if (description.error) return res.status(400).json({ error: description.error });
  const category = await checkCategory(body.category_id ?? null);
  if (category.error) return res.status(400).json({ error: category.error });
  const files = await checkAttachmentIds(body.attachment_ids, req.user);
  if (files.error) return res.status(400).json({ error: files.error });

  // No key means AI help is switched off: nothing to count or save.
  if (!isAiConfigured()) return res.status(503).json({ error: UNAVAILABLE });

  const reserved = await reserveSession(req.user, {
    title: title.text,
    description: description.text,
    categoryId: category.id,
    attachmentIds: files.ids,
  });
  if (reserved.limit) return res.status(429).json(limitReached(reserved.limit));
  const sessionId = reserved.session.id;

  const categories = (await pool.query('SELECT id, name FROM categories WHERE active ORDER BY name')).rows;

  // Articles the user was shown and passed on ("None of these") count as not helpful, and the
  // best matches go to the AI as background, so its steps follow how this help desk does things.
  const skipped = Array.isArray(body.skipped_article_ids) ? body.skipped_article_ids.filter(Number.isInteger).slice(0, 5) : [];
  if (skipped.length) {
    await pool.query("UPDATE kb_articles SET not_helpful_count = not_helpful_count + 1 WHERE id = ANY($1) AND status = 'published'", [skipped]);
  }
  const background = await searchArticles(`${title.text} ${description.text}`, { limit: 2 });

  // Security: only the problem itself (and its screenshots) is sent, never the user's name,
  // email or id.
  let result;
  try {
    result = await askForFix({
      title: title.text,
      description: description.text,
      category: category.name,
      categoryNames: categories.map((c) => c.name),
      images: await imagesFor(sessionId),
      articles: background.map((a) => ({ title: a.title, steps: a.steps })),
    });
  } catch (err) {
    await markFailed(sessionId, err); // rethrows a bug, so the error handler answers 500
    return res.status(503).json({ error: UNAVAILABLE });
  }

  // Security: the server's own check runs on every answer, whatever the AI said.
  const decision = reviewSuggestion(result.answer, { categories });
  const answered = [
    sessionId,
    JSON.stringify(decision.steps),
    decision.suggested_category_id,
    decision.suggested_priority,
    result.model,
    result.usage.input_tokens,
    result.usage.output_tokens,
  ];

  if (!decision.escalate) {
    const updated = await pool.query(
      `UPDATE help_sessions
          SET steps = $2, suggested_category_id = $3, suggested_priority = $4,
              model = $5, input_tokens = $6, output_tokens = $7
        WHERE id = $1
        RETURNING *`,
      answered
    );
    return res.json({ session: publicSession(updated.rows[0]) });
  }

  // Needs a technician: open the ticket and close the session together, or neither.
  const session = await withTransaction(async (db) => {
    const updated = await db.query(
      `UPDATE help_sessions
          SET steps = $2, suggested_category_id = $3, suggested_priority = $4,
              model = $5, input_tokens = $6, output_tokens = $7, escalate_reason = $8, blocked_steps = $9
        WHERE id = $1
        RETURNING *`,
      [...answered, decision.reason, JSON.stringify(decision.blocked)] // blocked: staff only
    );
    const ticketId = await openTicket(db, updated.rows[0], []);
    const finished = await db.query(
      `UPDATE help_sessions SET outcome = 'escalated', ticket_id = $2, finished_at = NOW()
        WHERE id = $1 RETURNING *`,
      [sessionId, ticketId]
    );
    return finished.rows[0];
  });
  res.status(201).json({ session: publicSession(session), ticket_id: session.ticket_id });
});

/**
 * POST /api/help/:id/outcome
 * Records how the suggested steps (or an Ask IT answer) went.
 * - "fixed": the session is closed; no ticket.
 * - "still_broken": for Get help, a ticket is opened with the steps shown, each marked tried or
 *   not. For an Ask IT question ("No, it didn't help"), it's only recorded: the user goes on to
 *   Get help, which is its own request.
 * Access: only the person who asked (anyone else gets 404).
 * Body: { outcome: 'fixed' | 'still_broken', tried?: [step numbers, from 0] }
 *   tried defaults to every step.
 */
router.post('/:id/outcome', async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body ?? {};
  const { outcome } = body;
  if (!['fixed', 'still_broken'].includes(outcome)) {
    return res.status(400).json({ error: 'Outcome must be fixed or still_broken' });
  }
  if (body.tried !== undefined && (!Array.isArray(body.tried) || !body.tried.every(Number.isInteger))) {
    return res.status(400).json({ error: 'tried must be a list of step numbers' });
  }

  const result = await withTransaction(async (db) => {
    // FOR UPDATE: a double click can't record two outcomes or open two tickets.
    // Security: user_id is part of the lookup, so someone else's session is "not found".
    const found = id
      ? await db.query('SELECT * FROM help_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id])
      : { rows: [] };
    const session = found.rows[0];
    if (!session) return { status: 404, body: { error: 'Help session not found' } };
    if (session.outcome !== 'pending') {
      return { status: 409, body: { error: 'This help session is already finished' } };
    }

    // Ask IT: just record whether the answer helped.
    if (session.kind === 'question') {
      if (!session.answer) return { status: 409, body: { error: 'This question has no answer yet' } };
      const updated = await db.query(
        `UPDATE help_sessions SET outcome = $2, finished_at = NOW() WHERE id = $1 RETURNING *`,
        [session.id, outcome]
      );
      return { status: 200, body: { question: publicQuestion(updated.rows[0]) } };
    }

    if (outcome === 'fixed') {
      const updated = await db.query(
        `UPDATE help_sessions SET outcome = 'fixed', finished_at = NOW() WHERE id = $1 RETURNING *`,
        [session.id]
      );
      return { status: 200, body: { session: publicSession(updated.rows[0]) } };
    }

    const tried = new Set(body.tried ?? session.steps.map((_, i) => i));
    const stepsTried = session.steps.map((step, i) => ({ ...step, tried: tried.has(i) }));
    const ticketId = await openTicket(db, session, stepsTried);
    const updated = await db.query(
      `UPDATE help_sessions SET outcome = 'still_broken', ticket_id = $2, finished_at = NOW()
        WHERE id = $1 RETURNING *`,
      [session.id, ticketId]
    );
    return { status: 201, body: { session: publicSession(updated.rows[0]), ticket_id: ticketId } };
  });

  res.status(result.status).json(result.body);
});

// The outcomes a session can have, in the order the AI help screen shows them.
const OUTCOMES = ['fixed', 'still_broken', 'escalated', 'pending', 'failed'];

/**
 * GET /api/help/sessions
 * Every AI help attempt, newest first (the latest 500), plus a count of each outcome across
 * all of them. This is how staff see what users fixed on their own, since fixes never become
 * tickets.
 * Access: technicians, admins and owners.
 */
router.get('/sessions', requireRole(...STAFF), async (req, res) => {
  // Security: the person's name only, not their email, the same as on tickets.
  // steps_tried comes from the ticket, when the session went on to one.
  const sessions = await pool.query(
    `SELECT s.id, s.kind, s.title, s.description, s.outcome, s.steps, s.answer, s.blocked_steps, s.escalate_reason, s.ticket_id,
            s.article_id, article.title AS article_title,
            s.created_at, s.finished_at, s.suggested_priority,
            s.user_id, asker.name AS user_name,
            category.name AS category_name, suggested.name AS suggested_category_name,
            t.steps_tried
       FROM help_sessions s
       JOIN users asker               ON asker.id = s.user_id
       LEFT JOIN categories category  ON category.id = s.category_id
       LEFT JOIN categories suggested ON suggested.id = s.suggested_category_id
       LEFT JOIN tickets t            ON t.id = s.ticket_id
       LEFT JOIN kb_articles article  ON article.id = s.article_id
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 500`
  );
  const totals = await pool.query('SELECT kind, outcome, COUNT(*)::int AS n FROM help_sessions GROUP BY kind, outcome');

  // Counts for everything, and for each source on its own, so the screen's cards can follow its
  // Source filter. Every outcome is listed, even at 0.
  const zeros = () => Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  const counts = { all: zeros(), fix: zeros(), question: zeros() };
  for (const row of totals.rows) {
    counts.all[row.outcome] += row.n;
    counts[row.kind][row.outcome] += row.n;
  }
  res.json({ sessions: sessions.rows, counts });
});

// --- Coming back to a request ---

/** A request as its owner sees it when coming back: the problem they wrote and the steps. */
const resumableSession = (row) => ({
  ...publicSession(row),
  title: row.title,
  description: row.description,
  category_id: row.category_id,
  created_at: row.created_at,
});

/**
 * GET /api/help/mine
 * The user's unfinished requests: steps were shown, but no answer yet. Last 7 days, newest
 * first, at most 5, so an old abandoned one doesn't hang around forever.
 * Access: anyone logged in; only their own.
 */
router.get('/mine', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM help_sessions
      WHERE user_id = $1 AND kind = 'fix' AND outcome = 'pending' AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC, id DESC
      LIMIT 5`,
    [req.user.id]
  );
  res.json({ sessions: result.rows.map(resumableSession) });
});

/**
 * GET /api/help/:id
 * One request, to pick up where the user left off. No AI call, so it doesn't count toward
 * the daily limit.
 * Access: only the person who asked (anyone else gets 404, as with tickets).
 */
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const result = id
    ? await pool.query("SELECT * FROM help_sessions WHERE id = $1 AND user_id = $2 AND kind = 'fix'", [id, req.user.id])
    : { rows: [] };
  if (!result.rows[0]) return res.status(404).json({ error: 'Help request not found' });
  const files = await pool.query(`${ATTACHMENT_SELECT} WHERE a.help_session_id = $1 ORDER BY a.id`, [id]);
  res.json({ session: { ...resumableSession(result.rows[0]), attachments: files.rows.map(publicAttachment) } });
});

// --- Ask IT: one question, one answer ---

const MAX_QUESTION = 500;

/** A question as its asker sees it. */
const publicQuestion = (row) => ({
  id: row.id,
  question: row.title,
  answer: row.answer,
  outcome: row.outcome, // pending = waiting for "Did this answer your question?"
  needs_technician: row.outcome === 'escalated',
  reason: row.escalate_reason,
  created_at: row.created_at,
});

/**
 * POST /api/help/ask
 * Answers one quick IT question. Counts toward the same daily limits as Get help, and is saved
 * in help_sessions (kind 'question') so staff see what was asked and by whom.
 * - 200 { question }: the answer (then pending, until the user says whether it helped), or
 *   "needs a technician" with the reason (escalated).
 * - 429 a daily limit; 503 the AI isn't available.
 * Access: anyone logged in.
 * Body: { question }
 */
router.post('/ask', async (req, res) => {
  const question = checkText(req.body?.question, 'Question', MAX_QUESTION);
  if (question.error) return res.status(400).json({ error: question.error });
  if (!isAiConfigured()) return res.status(503).json({ error: UNAVAILABLE });

  // The question goes in title; questions have no separate details.
  const reserved = await reserveSession(req.user, { kind: 'question', title: question.text, description: '' });
  if (reserved.limit) return res.status(429).json(limitReached(reserved.limit));
  const sessionId = reserved.session.id;

  // Security: only the question is sent, never who asked.
  let result;
  try {
    result = await askQuestion(question.text);
  } catch (err) {
    await markFailed(sessionId, err);
    return res.status(503).json({ error: UNAVAILABLE });
  }

  // Security: the server checks the answer text too, whatever the AI said.
  const review = reviewAnswer(result.answer);
  const blocked = review.blocked ? [{ title: 'Answer', detail: review.blocked }] : []; // staff only
  // Needs a technician: finished now (escalated). Otherwise it stays pending until the user says
  // whether the answer helped (POST /:id/outcome).
  const updated = await pool.query(
    `UPDATE help_sessions
        SET outcome = CASE WHEN $3::text IS NULL THEN 'pending' ELSE 'escalated' END,
            finished_at = CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END,
            answer = $2, escalate_reason = $3,
            blocked_steps = $4, model = $5, input_tokens = $6, output_tokens = $7
      WHERE id = $1
      RETURNING *`,
    [sessionId, review.answer, review.reason, JSON.stringify(blocked), result.model, result.usage.input_tokens, result.usage.output_tokens]
  );
  res.json({ question: publicQuestion(updated.rows[0]) });
});

/**
 * GET /api/help/questions/mine
 * The user's last 10 questions that got an answer, newest first, with whether each helped.
 * Access: anyone logged in; only their own.
 */
router.get('/questions/mine', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM help_sessions
      WHERE user_id = $1 AND kind = 'question' AND answer IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 10`,
    [req.user.id]
  );
  res.json({ questions: result.rows.map(publicQuestion) });
});

export default router;
