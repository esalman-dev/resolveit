// Tests for reviews: giving one on a resolved ticket, the 7-day edit window, who it credits,
// and who can see what (technicians never see who wrote a review).

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

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

/** Opens a ticket as `owner`, assigns it to `tech` and resolves it. */
async function resolvedTicket(owner, tech) {
  const ticket = (await request(app).post('/api/tickets').set(bearer(owner.token)).send({ title: 'VPN down', description: 'From home' })).body.ticket;
  await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(tech.token)).send({ assigned_to: tech.user.id, status: 'resolved' });
  return ticket;
}

const review = (token, id, body) => request(app).put(`/api/tickets/${id}/rating`).set(bearer(token)).send(body);
const reviews = (token, query = '') => request(app).get(`/api/reviews${query}`).set(bearer(token));

describe('giving a review', () => {
  it('lets the person who opened a resolved ticket review it, crediting the assignee', async () => {
    const { user, sam } = await people();
    const ticket = await resolvedTicket(user, sam);
    const res = await review(user.token, ticket.id, { stars: 4, comment: '  Quick and friendly  ' });
    expect(res.status).toBe(200);
    expect(res.body.rating).toMatchObject({ stars: 4, comment: 'Quick and friendly', technician_name: 'Sam', rated_by_name: 'Jo' });
  });

  it('can be changed, and keeps crediting the first assignee', async () => {
    const { user, sam, priya } = await people();
    const ticket = await resolvedTicket(user, sam);
    await review(user.token, ticket.id, { stars: 2 });
    await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(priya.token)).send({ assigned_to: priya.user.id });
    const res = await review(user.token, ticket.id, { stars: 5, comment: 'Sorted in the end' });
    expect(res.body.rating).toMatchObject({ stars: 5, technician_name: 'Sam' });
    expect(await pool.query('SELECT COUNT(*)::int AS n FROM ticket_ratings').then((r) => r.rows[0].n)).toBe(1);
  });

  it('is fixed after 7 days', async () => {
    const { user, sam } = await people();
    const ticket = await resolvedTicket(user, sam);
    await review(user.token, ticket.id, { stars: 3 });
    await pool.query("UPDATE ticket_ratings SET created_at = NOW() - INTERVAL '8 days'");
    const res = await review(user.token, ticket.id, { stars: 5 });
    expect(res.status).toBe(409);
    expect((await pool.query('SELECT stars FROM ticket_ratings')).rows[0].stars).toBe(3);
  });

  it('waits until the ticket is resolved', async () => {
    const { user } = await people();
    const ticket = (await request(app).post('/api/tickets').set(bearer(user.token)).send({ title: 'x', description: 'y' })).body.ticket;
    expect((await review(user.token, ticket.id, { stars: 5 })).status).toBe(409);
  });

  it('is only for the person who opened the ticket', async () => {
    const { user, sam, admin } = await people();
    const ticket = await resolvedTicket(user, sam);
    expect((await review(sam.token, ticket.id, { stars: 5 })).status).toBe(403);
    expect((await review(admin.token, ticket.id, { stars: 5 })).status).toBe(403);
    const eve = await signUp({ name: 'Eve', email: 'eve@example.com' });
    expect((await review(eve.token, ticket.id, { stars: 1 })).status).toBe(404); // can't even see it
  });

  it("doesn't credit a technician for reviewing their own ticket", async () => {
    const { sam } = await people();
    const ticket = await resolvedTicket(sam, sam);
    const res = await review(sam.token, ticket.id, { stars: 5 });
    expect(res.body.rating.technician_id).toBeNull();
  });

  it.each([
    ['no stars', {}],
    ['0 stars', { stars: 0 }],
    ['6 stars', { stars: 6 }],
    ['half a star', { stars: 3.5 }],
    ['stars as text', { stars: '5' }],
    ['a comment that is too long', { stars: 5, comment: 'x'.repeat(1001) }],
  ])('refuses %s', async (_, body) => {
    const { user, sam } = await people();
    const ticket = await resolvedTicket(user, sam);
    expect((await review(user.token, ticket.id, body)).status).toBe(400);
  });
});

describe('seeing reviews', () => {
  it('shows the review on the ticket to its owner and admins, but not technicians', async () => {
    const { user, sam, admin } = await people();
    const ticket = await resolvedTicket(user, sam);
    await review(user.token, ticket.id, { stars: 4 });
    const get = (token) => request(app).get(`/api/tickets/${ticket.id}/rating`).set(bearer(token));
    expect((await get(user.token)).body.rating.stars).toBe(4);
    expect((await get(admin.token)).body.rating.rated_by_name).toBe('Jo');
    expect((await get(sam.token)).status).toBe(403);
  });

  it('gives technicians only their own reviews, with no names or ticket numbers', async () => {
    const { user, sam, priya } = await people();
    await review(user.token, (await resolvedTicket(user, sam)).id, { stars: 5, comment: 'Great' });
    await review(user.token, (await resolvedTicket(user, sam)).id, { stars: 3 });
    await review(user.token, (await resolvedTicket(user, priya)).id, { stars: 1 });

    const res = await reviews(sam.token, `?technician_id=${priya.user.id}`); // asking for someone else's is ignored
    expect(res.body.summary).toEqual({ count: 2, average: 4, stars: { 5: 1, 4: 0, 3: 1, 2: 0, 1: 0 } });
    expect(res.body.reviews).toHaveLength(2);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('Jo');
    expect(raw).not.toContain('ticket_id');
    expect(raw).not.toContain('rated_by');
    expect(res.body.technicians).toBeUndefined();
  });

  it("gives admins everyone's reviews, with names, and a technician filter", async () => {
    const { user, sam, priya, admin } = await people();
    await review(user.token, (await resolvedTicket(user, sam)).id, { stars: 5 });
    await review(user.token, (await resolvedTicket(user, priya)).id, { stars: 2 });

    const all = await reviews(admin.token);
    expect(all.body.summary.count).toBe(2);
    expect(all.body.reviews[0]).toHaveProperty('rated_by_name', 'Jo');
    expect(all.body.technicians.map((t) => t.name)).toEqual(['Priya', 'Sam']);

    const one = await reviews(admin.token, `?technician_id=${priya.user.id}`);
    expect(one.body.summary).toMatchObject({ count: 1, average: 2 });
    expect((await reviews(admin.token, '?technician_id=none')).body.summary.count).toBe(0);
    expect((await reviews(admin.token, '?technician_id=abc')).status).toBe(400);
  });

  it('is for staff only', async () => {
    const { user } = await people();
    expect((await reviews(user.token)).status).toBe(403);
  });
});

describe('reviews in pages', () => {
  it('sends one page of reviews at a time, while the summary counts them all', async () => {
    const { user, sam, admin } = await people();
    for (const stars of [5, 4, 3]) await review(user.token, (await resolvedTicket(user, sam)).id, { stars });
    const res = await reviews(admin.token, '?per_page=2&page=2');
    expect(res.body.reviews.map((r) => r.stars)).toEqual([5]); // newest first: 3, 4, then 5
    expect(res.body).toMatchObject({ page: 2, per_page: 2, summary: { count: 3 } });
  });
});
