// Tests for the dashboard: its numbers on a small, exactly known help desk, who sees which rows,
// and changing the team goals.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const ago = (hours) => new Date(Date.now() - hours * HOUR);

/** A user, two technicians and an admin. */
async function people() {
  const user = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const sam = await signUp({ name: 'Sam', email: 'sam@example.com' });
  const priya = await signUp({ name: 'Priya', email: 'priya@example.com' });
  const admin = await signUp({ name: 'Ada', email: 'ada@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = ANY($1)", [[sam.user.id, priya.user.id]]);
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.user.id]);
  return { user, sam, priya, admin };
}

/**
 * Adds a ticket with exact times (hours ago). Medium priority: reply target 24 h, fix 72 h.
 * @param {{ opened: number, replied?: number, resolved?: number, tech?: object }} t
 */
async function addTicket(owner, { opened, replied = null, resolved = null, tech = null, priority = 'medium' }) {
  const row = await pool.query(
    `INSERT INTO tickets (title, description, status, priority, created_by, assigned_to, created_at, first_response_at, resolved_at)
     VALUES ('T', 'D', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      resolved !== null ? 'resolved' : 'open',
      priority,
      owner.user.id,
      tech?.user.id ?? null,
      ago(opened),
      replied !== null ? ago(replied) : null,
      resolved !== null ? ago(resolved) : null,
    ]
  );
  return row.rows[0].id;
}

const dashboard = (token, days = 7) => request(app).get(`/api/dashboard?days=${days}`).set(bearer(token));

describe('GET /api/dashboard', () => {
  it('works out the numbers for the period and the one before', async () => {
    const { user, sam, priya, admin } = await people();
    // This week: reply after 2 h and fixed after 10 h (on time); reply after 30 h (late) and
    // fixed after 100 h (late, opened 5 days ago); one still open.
    const a = await addTicket(user, { opened: 20, replied: 18, resolved: 10, tech: sam });
    await addTicket(user, { opened: 120, replied: 90, resolved: 20, tech: priya });
    await addTicket(user, { opened: 5, tech: sam });
    // The week before: one ticket, fixed after 4 h.
    await addTicket(user, { opened: 200, replied: 199, resolved: 196, tech: sam });

    await pool.query('INSERT INTO ticket_ratings (ticket_id, rated_by, technician_id, stars, created_at) VALUES ($1, $2, $3, 4, $4)', [a, user.user.id, sam.user.id, ago(9)]);
    for (const outcome of ['fixed', 'fixed', 'escalated', 'still_broken', 'failed']) {
      await pool.query(
        `INSERT INTO help_sessions (user_id, title, description, outcome, finished_at, escalate_reason, ticket_id)
         VALUES ($1, 'x', 'y', $2, NOW(), $3, $4)`,
        [user.user.id, outcome, outcome === 'escalated' ? 'Needs IT' : null, ['escalated', 'still_broken'].includes(outcome) ? a : null]
      );
    }

    const res = await dashboard(admin.token);
    expect(res.status).toBe(200);
    const { current, previous, now } = res.body;
    expect(now).toEqual({ open_now: 1, overdue_now: 0 });
    expect(current.new_tickets).toBe(3);
    expect(current.resolved).toBe(2);
    expect(current.first_reply.average).toBe(960); // (2 h + 30 h) / 2 = 16 h = 960 min
    expect(current.time_to_fix.average).toBe(3300); // (10 h + 100 h) / 2 = 55 h
    expect(current.replied_on_time_rate).toBe(50);
    expect(current.fixed_on_time_rate).toBe(50);
    expect(current.self_solved_rate).toBe(50); // 2 fixed of 4 answered; "failed" isn't an answer
    expect(current.average_rating).toBe(4);
    expect(previous).toMatchObject({ new_tickets: 1, resolved: 1, time_to_fix: { average: 240, median: 240 } });
    expect(res.body.ai_results).toEqual({ fixed: 2, escalated: 1, still_broken: 1, failed: 1 });
    expect(res.body.per_bucket.rows).toHaveLength(8); // 7 days back to today, both ends counted
  });

  it('counts overdue tickets and lists what needs attention, overdue first', async () => {
    const { user, admin } = await people();
    const late = await addTicket(user, { opened: 30 }); // medium: reply was due 6 h ago
    const soon = await addTicket(user, { opened: 20 }); // reply due in 4 h
    const res = await dashboard(admin.token);
    expect(res.body.now.overdue_now).toBe(1);
    expect(res.body.attention.map((t) => t.id)).toEqual([late, soon]);
    expect(res.body.attention[0].target).toBe('reply');
  });

  it('gives technicians only their own row, and admins every row', async () => {
    const { user, sam, priya, admin } = await people();
    await addTicket(user, { opened: 10, replied: 9, resolved: 8, tech: sam });
    await addTicket(user, { opened: 10, replied: 9, resolved: 8, tech: priya });

    const mine = await dashboard(sam.token);
    expect(mine.body.technicians.map((t) => t.name)).toEqual(['Sam']);
    expect(mine.body.technicians[0]).toMatchObject({ resolved: 1, fix_avg: 120, fixed_on_time_rate: 100 });

    const all = await dashboard(admin.token);
    expect(all.body.technicians.map((t) => t.name)).toEqual(['Priya', 'Sam']);
  });

  it('charts the last 24 hours by hour', async () => {
    const { admin } = await people();
    const res = await dashboard(admin.token, 1);
    expect(res.body.per_bucket.unit).toBe('hour');
    expect(res.body.per_bucket.rows.length).toBeGreaterThanOrEqual(24);
  });

  it('refuses other periods, and users', async () => {
    const { user, admin } = await people();
    expect((await dashboard(admin.token, 14)).status).toBe(400);
    expect((await dashboard(user.token)).status).toBe(403);
  });

  it('gives empty numbers, not errors, when there is no data', async () => {
    const { admin } = await people();
    const res = await dashboard(admin.token);
    expect(res.body.current).toMatchObject({ new_tickets: 0, first_reply: { average: null }, self_solved_rate: null, average_rating: null });
  });
});

describe('PUT /api/dashboard/goals', () => {
  it('lets admins change goals', async () => {
    const { admin } = await people();
    const res = await request(app).put('/api/dashboard/goals').set(bearer(admin.token)).send({ goals: { average_rating: 4.2, self_solved_rate: 30 } });
    expect(res.status).toBe(200);
    expect(res.body.goals).toEqual([
      expect.objectContaining({ metric: 'self_solved_rate', target: 30, updated_by_name: 'Ada' }),
      expect.objectContaining({ metric: 'average_rating', target: 4.2 }),
      expect.objectContaining({ metric: 'fixed_on_time_rate', target: 90 }),
    ]);
  });

  it("doesn't let technicians change goals", async () => {
    const { sam } = await people();
    expect((await request(app).put('/api/dashboard/goals').set(bearer(sam.token)).send({ goals: { average_rating: 3 } })).status).toBe(403);
  });

  it.each([
    ['an unknown goal', { speed: 5 }],
    ['a rating above 5', { average_rating: 6 }],
    ['a rate above 100', { fixed_on_time_rate: 120 }],
    ['text', { self_solved_rate: '30' }],
    ['nothing', {}],
  ])('refuses %s', async (_, goals) => {
    const { admin } = await people();
    expect((await request(app).put('/api/dashboard/goals').set(bearer(admin.token)).send({ goals })).status).toBe(400);
  });
});
