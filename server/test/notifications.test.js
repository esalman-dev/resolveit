// Tests for the notifications bell: who is told about what (never about their own action),
// overdue warnings (once each), reading and clearing, and that people only see their own.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

/** A user (Jo), two technicians (Sam, Priya). Nobody is online, so auto-assign stays out of the way. */
async function people() {
  const jo = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const sam = await signUp({ name: 'Sam', email: 'sam@example.com' });
  const priya = await signUp({ name: 'Priya', email: 'priya@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = ANY($1)", [[sam.user.id, priya.user.id]]);
  return { jo, sam, priya };
}

const openTicket = async (token) =>
  (await request(app).post('/api/tickets').set(bearer(token)).send({ title: 'Printer offline', description: 'Since 9 am' })).body
    .ticket;
const patch = (token, id, body) => request(app).patch(`/api/tickets/${id}`).set(bearer(token)).send(body);
const comment = (token, id, body = {}) =>
  request(app).post(`/api/tickets/${id}/comments`).set(bearer(token)).send({ body: 'On it', ...body });
const bell = async (token) => (await request(app).get('/api/notifications').set(bearer(token))).body;

/** Just the kind and who did it, newest first: easier to compare. */
const kinds = async (token) => (await bell(token)).notifications.map((n) => `${n.kind} by ${n.actor_name ?? 'nobody'}`);

describe('who is told', () => {
  it('the technician a ticket is assigned to, unless they assigned themselves', async () => {
    const { jo, sam, priya } = await people();
    const ticket = await openTicket(jo.token);

    await patch(priya.token, ticket.id, { assigned_to: sam.user.id });
    expect(await kinds(sam.token)).toEqual(['assigned by Priya']);

    await patch(priya.token, ticket.id, { assigned_to: priya.user.id }); // takes it herself
    expect(await kinds(priya.token)).toEqual([]);
  });

  it('a public reply: the creator and the assignee, never the person who wrote it', async () => {
    const { jo, sam, priya } = await people();
    const ticket = await openTicket(jo.token);
    await patch(priya.token, ticket.id, { assigned_to: sam.user.id });

    await comment(priya.token, ticket.id);
    expect(await kinds(jo.token)).toEqual(['reply by Priya']);
    expect(await kinds(sam.token)).toEqual(['reply by Priya', 'assigned by Priya']);
    expect(await kinds(priya.token)).toEqual([]);

    await comment(jo.token, ticket.id); // the creator replies: only the assignee hears
    expect(await kinds(jo.token)).toEqual(['reply by Priya']);
    expect((await kinds(sam.token))[0]).toBe('reply by Jo');
  });

  it('an internal note: only the assignee, never the creator', async () => {
    const { jo, sam, priya } = await people();
    const ticket = await openTicket(jo.token);
    await patch(priya.token, ticket.id, { assigned_to: sam.user.id });

    await comment(priya.token, ticket.id, { is_internal: true });
    expect((await kinds(sam.token))[0]).toBe('internal_note by Priya');
    expect(await kinds(jo.token)).toEqual([]);
  });

  it('the creator, when their ticket is resolved or reopened by someone else', async () => {
    const { jo, sam } = await people();
    const ticket = await openTicket(jo.token);

    await patch(sam.token, ticket.id, { status: 'in_progress' }); // not resolved or reopened: no bell
    await patch(sam.token, ticket.id, { status: 'resolved' });
    await patch(sam.token, ticket.id, { status: 'open' });
    expect(await kinds(jo.token)).toEqual(['reopened by Sam', 'resolved by Sam']);

    await patch(jo.token, ticket.id, { status: 'resolved' }); // closing it herself: no bell
    expect(await kinds(jo.token)).toHaveLength(2);
  });

  it('only once when someone is both the creator and the assignee', async () => {
    const { sam, priya } = await people();
    const ticket = await openTicket(sam.token);
    await patch(sam.token, ticket.id, { assigned_to: sam.user.id });

    await comment(priya.token, ticket.id);
    expect(await kinds(sam.token)).toEqual(['reply by Priya']);
  });
});

describe('overdue warnings', () => {
  it('tell the assignee once per target, however often the bell checks', async () => {
    const { jo, sam } = await people();
    const ticket = await openTicket(jo.token); // medium: reply within 1 day, fixed within 3 days
    await patch(sam.token, ticket.id, { assigned_to: sam.user.id });
    await pool.query('DELETE FROM notifications'); // only the overdue ones matter here

    await pool.query("UPDATE tickets SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [ticket.id]);
    expect(await kinds(sam.token)).toEqual(['overdue_reply by nobody']);

    await pool.query("UPDATE tickets SET created_at = NOW() - INTERVAL '4 days' WHERE id = $1", [ticket.id]);
    await bell(sam.token);
    expect((await kinds(sam.token)).sort()).toEqual(['overdue_fix by nobody', 'overdue_reply by nobody']);
  });

  it('skip tickets that got a first reply, were resolved, or belong to someone else', async () => {
    const { jo, sam, priya } = await people();
    const replied = await openTicket(jo.token);
    const resolved = await openTicket(jo.token);
    const priyas = await openTicket(jo.token);
    await patch(priya.token, replied.id, { assigned_to: sam.user.id });
    await patch(priya.token, resolved.id, { assigned_to: sam.user.id });
    await patch(priya.token, priyas.id, { assigned_to: priya.user.id });
    await comment(sam.token, replied.id); // the first reply
    await patch(sam.token, resolved.id, { status: 'resolved' });
    await pool.query('DELETE FROM notifications');

    await pool.query("UPDATE tickets SET created_at = NOW() - INTERVAL '2 days'"); // past every reply target
    expect(await kinds(sam.token)).toEqual([]);
  });
});

describe('reading the bell', () => {
  it('counts unread, marks one read, then all', async () => {
    const { jo, sam, priya } = await people();
    const ticket = await openTicket(jo.token);
    await comment(sam.token, ticket.id);
    await comment(priya.token, ticket.id);

    const before = await bell(jo.token);
    expect(before.unread).toBe(2);
    expect(before.notifications[0]).toMatchObject({ ticket_id: ticket.id, ticket_title: 'Printer offline' });

    const one = await request(app).post(`/api/notifications/${before.notifications[0].id}/read`).set(bearer(jo.token));
    expect(one.status).toBe(204);
    expect((await bell(jo.token)).unread).toBe(1);

    expect((await request(app).post('/api/notifications/read-all').set(bearer(jo.token))).status).toBe(204);
    expect((await bell(jo.token)).unread).toBe(0);
  });

  it("only ever shows or changes your own: someone else's answers 404", async () => {
    const { jo, sam } = await people();
    const ticket = await openTicket(jo.token);
    await comment(sam.token, ticket.id);
    const josId = (await bell(jo.token)).notifications[0].id;

    expect((await bell(sam.token)).notifications).toEqual([]);
    expect((await request(app).post(`/api/notifications/${josId}/read`).set(bearer(sam.token))).status).toBe(404);
    expect((await bell(jo.token)).unread).toBe(1);
  });

  it('deletes notifications older than 30 days', async () => {
    const { jo, sam } = await people();
    const ticket = await openTicket(jo.token);
    await comment(sam.token, ticket.id);
    await pool.query("UPDATE notifications SET created_at = NOW() - INTERVAL '31 days'");

    expect((await bell(jo.token)).notifications).toEqual([]);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n).toBe(0);
  });

  it('needs a login', async () => {
    expect((await request(app).get('/api/notifications')).status).toBe(401);
  });
});
