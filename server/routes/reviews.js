// Reviews API: the "How did we do?" reviews, with their average and spread, for the Reviews page.
//
// Technicians see only the reviews that credit them, without who wrote them or which ticket
// (the ticket would show who opened it). Admins and owners see everyone's, with names, and can
// pick one technician. Reviews are given on the ticket (PUT /api/tickets/:id/rating).
//
// Mounted at /api/reviews (see app.js).

import { Router } from 'express';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ADMINS, STAFF } from '../roles.js';
import { RATING_SELECT } from './tickets.js';

const router = Router();
const LIST_LIMIT = 200; // newest first; the summary always counts every review

router.use(requireAuth, requireRole(...STAFF));

/**
 * The SQL condition for whose reviews to include: one technician, the reviews with no
 * technician ('none'), or all ('all'). Returns [condition, params].
 */
function whose(technician) {
  if (technician === 'all') return ['TRUE', []];
  if (technician === 'none') return ['r.technician_id IS NULL', []];
  return ['r.technician_id = $1', [technician]];
}

/**
 * GET /api/reviews
 * Reviews, newest first (at most 200), and a summary of all of them: how many, the average, and
 * how many of each star.
 * Access: staff. Technicians always get their own, without names or ticket numbers.
 * Query: technician_id (admins and owners only): a technician's id, or 'none'; leave out for all.
 */
router.get('/', async (req, res) => {
  const admin = ADMINS.includes(req.user.role);
  let technician = 'all';
  if (!admin) {
    technician = req.user.id; // Security: a technician can't ask for anyone else's
  } else if (req.query.technician_id === 'none') {
    technician = 'none';
  } else if (req.query.technician_id !== undefined) {
    technician = Number(req.query.technician_id);
    if (!Number.isInteger(technician) || technician < 1) return res.status(400).json({ error: 'Invalid technician id' });
  }

  const [condition, params] = whose(technician);
  const summary = await pool.query(
    `SELECT COUNT(*)::int AS count,
            ROUND(AVG(r.stars)::numeric, 2)::float AS average,
            COUNT(*) FILTER (WHERE r.stars = 5)::int AS five,
            COUNT(*) FILTER (WHERE r.stars = 4)::int AS four,
            COUNT(*) FILTER (WHERE r.stars = 3)::int AS three,
            COUNT(*) FILTER (WHERE r.stars = 2)::int AS two,
            COUNT(*) FILTER (WHERE r.stars = 1)::int AS one
       FROM ticket_ratings r
      WHERE ${condition}`,
    params
  );
  const list = await pool.query(
    `${RATING_SELECT} WHERE ${condition} ORDER BY r.created_at DESC LIMIT ${LIST_LIMIT}`,
    params
  );

  const s = summary.rows[0];
  // Security: for technicians, who wrote it and which ticket are removed on the server, so they
  // never reach the browser at all.
  const reviews = list.rows.map((r) =>
    admin
      ? r
      : { stars: r.stars, comment: r.comment, created_at: r.created_at, updated_at: r.updated_at }
  );
  res.json({
    summary: { count: s.count, average: s.average, stars: { 5: s.five, 4: s.four, 3: s.three, 2: s.two, 1: s.one } },
    reviews,
    // Admins also get who can be picked in the filter: every technician who has a review.
    technicians: admin
      ? (
          await pool.query(
            `SELECT DISTINCT u.id, u.name FROM ticket_ratings r JOIN users u ON u.id = r.technician_id ORDER BY u.name`
          )
        ).rows
      : undefined,
  });
});

export default router;
