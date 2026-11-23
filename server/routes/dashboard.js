// Dashboard API: how the help desk is doing, for one period, with the period before for comparison.
//
// Every number is worked out in the database from what's already saved: tickets (opened,
// first reply, resolved), their target times, Get help requests, and reviews. Nothing extra is
// collected for the dashboard.
//
// Who sees what (decision P1): all staff see the team's numbers. In the technicians table,
// technicians get only their own row; admins and owners get everyone's, to compare.
//
// Mounted at /api/dashboard (see app.js).

import { Router } from 'express';
import pool, { withTransaction } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ADMINS, STAFF } from '../roles.js';
import { STATUS_SQL } from './presence.js';

const router = Router();

export const PERIODS = [1, 7, 30, 90]; // days; 1 = the last 24 hours, charted by hour
const DAY = 24 * 60 * 60 * 1000;

const GOALS = {
  self_solved_rate: { min: 1, max: 100 }, // percent
  average_rating: { min: 1, max: 5 }, // stars
  fixed_on_time_rate: { min: 1, max: 100 }, // percent
};

router.use(requireAuth, requireRole(...STAFF));

// --- SQL pieces ---

// When each ticket's reply and fix are due, from its priority's target times (or, for the fix,
// its own set due_at: a new hire's start date).
const DUE = `
  t.created_at + make_interval(mins => sla.first_response_minutes) AS response_due_at,
  COALESCE(t.due_at, t.created_at + make_interval(mins => sla.resolve_minutes)) AS resolve_due_at`;

// Tickets first replied to inside the window ($1 to $2). New-hire tickets are left out: staff
// open them, so they count as replied the moment they're created and would pull the average to 0.
const REPLIED = `kind = 'issue' AND first_response_at >= $1 AND first_response_at < $2`;

// Minutes between two timestamps.
const minutes = (from, to) => `EXTRACT(EPOCH FROM (${to} - ${from})) / 60`;

/**
 * The headline numbers for one window [from, to): new, resolved, reply and fix times (average
 * and median, in minutes), on-time rates, AI self-solved rate, and reviews.
 */
async function windowNumbers(from, to) {
  const tickets = await pool.query(
    `WITH t AS (
       SELECT t.*, ${DUE}
         FROM tickets t
         LEFT JOIN sla_targets sla ON sla.priority = t.priority
     )
     SELECT
       COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS new_tickets,
       COUNT(*) FILTER (WHERE resolved_at >= $1 AND resolved_at < $2)::int AS resolved,
       AVG(${minutes('created_at', 'first_response_at')}) FILTER (WHERE ${REPLIED}) AS reply_avg,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${minutes('created_at', 'first_response_at')})
         FILTER (WHERE ${REPLIED}) AS reply_median,
       AVG(${minutes('created_at', 'resolved_at')}) FILTER (WHERE resolved_at >= $1 AND resolved_at < $2) AS fix_avg,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${minutes('created_at', 'resolved_at')})
         FILTER (WHERE resolved_at >= $1 AND resolved_at < $2) AS fix_median,
       COUNT(*) FILTER (WHERE ${REPLIED} AND first_response_at <= response_due_at)::int AS replied_on_time,
       COUNT(*) FILTER (WHERE ${REPLIED})::int AS replied,
       COUNT(*) FILTER (WHERE resolved_at >= $1 AND resolved_at < $2 AND resolved_at <= resolve_due_at)::int AS fixed_on_time
     FROM t`,
    [from, to]
  );
  const ai = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE outcome = 'fixed')::int AS fixed,
            COUNT(*) FILTER (WHERE outcome IN ('fixed', 'still_broken', 'escalated'))::int AS answered
       FROM help_sessions
      WHERE kind = 'fix' AND created_at >= $1 AND created_at < $2`,
    [from, to]
  );
  const reviews = await pool.query(
    'SELECT AVG(stars)::float AS average, COUNT(*)::int AS count FROM ticket_ratings WHERE created_at >= $1 AND created_at < $2',
    [from, to]
  );
  const t = tickets.rows[0];
  const a = ai.rows[0];
  const r = reviews.rows[0];
  const rate = (part, whole) => (whole ? (100 * part) / whole : null); // null = nothing to measure
  const round = (n, places = 1) => (n === null || n === undefined ? null : Number(Number(n).toFixed(places)));
  return {
    new_tickets: t.new_tickets,
    resolved: t.resolved,
    first_reply: { average: round(t.reply_avg), median: round(t.reply_median) }, // minutes
    time_to_fix: { average: round(t.fix_avg), median: round(t.fix_median) }, // minutes
    replied_on_time_rate: round(rate(t.replied_on_time, t.replied)),
    fixed_on_time_rate: round(rate(t.fixed_on_time, t.resolved)),
    self_solved_rate: round(rate(a.fixed, a.answered)),
    ai_answered: a.answered,
    average_rating: round(r.average, 2),
    reviews: r.count,
  };
}

/** Opened and resolved per day (or per hour for the last 24 hours), oldest first, gaps as 0. */
async function perBucket(from, to, hourly) {
  const unit = hourly ? 'hour' : 'day';
  const result = await pool.query(
    `WITH buckets AS (
       SELECT generate_series(date_trunc('${unit}', $1::timestamptz), date_trunc('${unit}', $2::timestamptz), INTERVAL '1 ${unit}') AS at
     )
     SELECT b.at,
            (SELECT COUNT(*) FROM tickets WHERE date_trunc('${unit}', created_at) = b.at AND created_at >= $1)::int AS opened,
            (SELECT COUNT(*) FROM tickets WHERE date_trunc('${unit}', resolved_at) = b.at AND resolved_at >= $1)::int AS resolved
       FROM buckets b
      ORDER BY b.at`,
    [from, to]
  );
  return result.rows;
}

/**
 * Each technician's numbers for the window (only staff who were assigned or credited), or just
 * one person's with `userId` (the Profile page's "Your last 30 days").
 */
export async function technicianRows(from, to, userId = null) {
  const result = await pool.query(
    `WITH t AS (
       SELECT t.*, ${DUE} FROM tickets t LEFT JOIN sla_targets sla ON sla.priority = t.priority
     )
     SELECT u.id, u.name, ${STATUS_SQL('u')} AS status,
            (SELECT COUNT(*) FROM t WHERE t.assigned_to = u.id AND t.status <> 'resolved')::int AS open_now,
            (SELECT COUNT(*) FROM t WHERE t.assigned_to = u.id AND t.resolved_at >= $1 AND t.resolved_at < $2)::int AS resolved,
            (SELECT ROUND((AVG(${minutes('t.created_at', 't.resolved_at')}))::numeric, 1)::float FROM t
              WHERE t.assigned_to = u.id AND t.resolved_at >= $1 AND t.resolved_at < $2) AS fix_avg,
            (SELECT ROUND((100.0 * COUNT(*) FILTER (WHERE t.resolved_at <= t.resolve_due_at) / NULLIF(COUNT(*), 0))::numeric, 1)::float
               FROM t WHERE t.assigned_to = u.id AND t.resolved_at >= $1 AND t.resolved_at < $2) AS fixed_on_time_rate,
            (SELECT ROUND(AVG(stars)::numeric, 2)::float FROM ticket_ratings r
              WHERE r.technician_id = u.id AND r.created_at >= $1 AND r.created_at < $2) AS average_rating,
            (SELECT COUNT(*) FROM ticket_ratings r WHERE r.technician_id = u.id AND r.created_at >= $1 AND r.created_at < $2)::int AS reviews
       FROM users u
      WHERE u.role <> 'user' AND u.disabled_at IS NULL
        AND (EXISTS (SELECT 1 FROM tickets WHERE assigned_to = u.id) OR EXISTS (SELECT 1 FROM ticket_ratings WHERE technician_id = u.id))
        AND ($3::int IS NULL OR u.id = $3)
      ORDER BY u.name`,
    [from, to, userId]
  );
  return result.rows;
}

/** The team goals, in a fixed order. */
async function loadGoals() {
  const result = await pool.query(
    `SELECT g.metric, g.target::float AS target, g.updated_at, u.name AS updated_by_name
       FROM team_goals g LEFT JOIN users u ON u.id = g.updated_by
      ORDER BY array_position(ARRAY['self_solved_rate', 'average_rating', 'fixed_on_time_rate'], g.metric)`
  );
  return result.rows;
}

// --- Routes ---

/**
 * GET /api/dashboard
 * Everything the dashboard shows, for the last `days` days, with the same numbers for the
 * period before (to show the change).
 * Access: staff. Technicians get only their own row in `technicians`.
 * Query: days = 1, 7 (default), 30 or 90
 */
router.get('/', async (req, res) => {
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  if (!PERIODS.includes(days)) return res.status(400).json({ error: `days must be one of ${PERIODS.join(', ')}` });

  const now = new Date();
  const from = new Date(now.getTime() - days * DAY);
  const before = new Date(from.getTime() - days * DAY);

  const snapshot = await pool.query(
    `WITH t AS (
       SELECT t.*, ${DUE} FROM tickets t LEFT JOIN sla_targets sla ON sla.priority = t.priority WHERE t.status <> 'resolved'
     )
     SELECT COUNT(*)::int AS open_now,
            COUNT(*) FILTER (WHERE (first_response_at IS NULL AND response_due_at < NOW()) OR resolve_due_at < NOW())::int AS overdue_now
       FROM t`
  );

  const [current, previous, buckets, technicians] = await Promise.all([
    windowNumbers(from, now),
    windowNumbers(before, from),
    perBucket(from, now, days === 1),
    technicianRows(from, now),
  ]);

  const byCategory = await pool.query(
    `SELECT COALESCE(c.name, 'Not set') AS name, COUNT(*)::int AS count
       FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.created_at >= $1
      GROUP BY 1 ORDER BY 2 DESC, 1`,
    [from]
  );
  const byPriority = await pool.query(
    `SELECT p.priority, COUNT(t.id)::int AS count
       FROM unnest(ARRAY['urgent', 'high', 'medium', 'low']) WITH ORDINALITY AS p(priority, n)
       LEFT JOIN tickets t ON t.priority = p.priority AND t.created_at >= $1
      GROUP BY p.priority, p.n ORDER BY p.n`,
    [from]
  );
  const aiResults = await pool.query(
    `SELECT outcome, COUNT(*)::int AS count FROM help_sessions
      WHERE kind = 'fix' AND created_at >= $1 GROUP BY outcome`,
    [from]
  );
  // The tickets that need someone next: what's due soonest, overdue first.
  const attention = await pool.query(
    `WITH t AS (
       SELECT t.id, t.title, t.priority, t.created_at, t.first_response_at, a.name AS assigned_to_name, ${DUE}
         FROM tickets t
         LEFT JOIN sla_targets sla ON sla.priority = t.priority
         LEFT JOIN users a ON a.id = t.assigned_to
        WHERE t.status <> 'resolved'
     )
     SELECT id, title, priority, assigned_to_name,
            CASE WHEN first_response_at IS NULL THEN 'reply' ELSE 'fix' END AS target,
            CASE WHEN first_response_at IS NULL THEN response_due_at ELSE resolve_due_at END AS due_at
       FROM t
      ORDER BY due_at
      LIMIT 10`
  );

  // Security: technicians see only their own row (decision P1); the comparison is for admins.
  const admin = ADMINS.includes(req.user.role);
  res.json({
    days,
    from,
    to: now,
    now: { ...snapshot.rows[0] },
    current,
    previous,
    per_bucket: { unit: days === 1 ? 'hour' : 'day', rows: buckets },
    by_category: byCategory.rows,
    by_priority: byPriority.rows,
    ai_results: Object.fromEntries(aiResults.rows.map((r) => [r.outcome, r.count])),
    technicians: admin ? technicians : technicians.filter((t) => t.id === req.user.id),
    attention: attention.rows,
    goals: await loadGoals(),
  });
});

/**
 * PUT /api/dashboard/goals
 * Changes the team goals.
 * Access: admins and owners.
 * Body: { goals: { self_solved_rate?, average_rating?, fixed_on_time_rate? } } (percent, stars, percent)
 */
router.put('/goals', requireRole(...ADMINS), async (req, res) => {
  const goals = req.body?.goals;
  if (!goals || typeof goals !== 'object' || Array.isArray(goals) || Object.keys(goals).length === 0) {
    return res.status(400).json({ error: 'Send goals as { self_solved_rate, average_rating, fixed_on_time_rate }' });
  }
  for (const [metric, value] of Object.entries(goals)) {
    const limits = GOALS[metric];
    if (!limits) return res.status(400).json({ error: `Unknown goal: ${metric}` });
    if (typeof value !== 'number' || !Number.isFinite(value) || value < limits.min || value > limits.max) {
      return res.status(400).json({ error: `${metric} must be a number from ${limits.min} to ${limits.max}` });
    }
  }
  await withTransaction(async (db) => {
    for (const [metric, value] of Object.entries(goals)) {
      await db.query('UPDATE team_goals SET target = $2, updated_by = $3, updated_at = NOW() WHERE metric = $1', [
        metric,
        value,
        req.user.id,
      ]);
    }
  });
  res.json({ goals: await loadGoals() });
});

export default router;
