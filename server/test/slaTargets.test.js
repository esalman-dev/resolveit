// Tests for target times (SLA): due times on tickets, when the first reply is recorded, and
// who can read or change the targets.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

const HOUR = 60 * 60 * 1000;

/** A user, a technician and an admin. */
async function people() {
  const user = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const tech = await signUp({ name: 'Sam', email: 'sam@example.com' });
  const admin = await signUp({ name: 'Ada', email: 'ada@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [tech.user.id]);
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.user.id]);
  return { user, tech, admin };
}

const openTicket = async (token) =>
  (await request(app).post('/api/tickets').set(bearer(token)).send({ title: 'Printer offline', description: 'Since 9 am' })).body.ticket;

const getTicket = async (token, id) => (await request(app).get(`/api/tickets/${id}`).set(bearer(token))).body.ticket;

const comment = (token, id, body = {}) =>
  request(app).post(`/api/tickets/${id}/comments`).set(bearer(token)).send({ body: 'On it', ...body });

/** Hours between two timestamps. */
const hoursBetween = (from, to) => Math.round((new Date(to) - new Date(from)) / HOUR);

const DEFAULTS = [
  { priority: 'urgent', first_response_minutes: 60, resolve_minutes: 240 },
  { priority: 'high', first_response_minutes: 240, resolve_minutes: 1440 },
  { priority: 'medium', first_response_minutes: 1440, resolve_minutes: 4320 },
  { priority: 'low', first_response_minutes: 2880, resolve_minutes: 10080 },
];

describe('due times on tickets', () => {
  it('come from the target times for the priority', async () => {
    const { user } = await people();
    const ticket = await openTicket(user.token); // new tickets are medium: 1 day / 3 days
    expect(hoursBetween(ticket.created_at, ticket.response_due_at)).toBe(24);
    expect(hoursBetween(ticket.created_at, ticket.resolve_due_at)).toBe(72);
    expect(ticket.first_response_at).toBeNull();
  });

  it('move when the priority changes', async () => {
    const { user, tech } = await people();
    const ticket = await openTicket(user.token);
    const res = await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(tech.token)).send({ priority: 'urgent' });
    expect(hoursBetween(res.body.ticket.created_at, res.body.ticket.response_due_at)).toBe(1);
    expect(hoursBetween(res.body.ticket.created_at, res.body.ticket.resolve_due_at)).toBe(4);
  });
});

describe('the first reply', () => {
  it('is recorded by a public comment from staff, and not changed by later ones', async () => {
    const { user, tech } = await people();
    const ticket = await openTicket(user.token);
    await comment(tech.token, ticket.id);
    const first = (await getTicket(user.token, ticket.id)).first_response_at;
    expect(first).not.toBeNull();
    await comment(tech.token, ticket.id, { body: 'Still on it' });
    expect((await getTicket(user.token, ticket.id)).first_response_at).toBe(first);
  });

  it('is recorded by a status change from staff', async () => {
    const { user, tech } = await people();
    const ticket = await openTicket(user.token);
    await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(tech.token)).send({ status: 'in_progress' });
    expect((await getTicket(user.token, ticket.id)).first_response_at).not.toBeNull();
  });

  it("isn't an internal note, the user's own comment, assigning, or staff on their own ticket", async () => {
    const { user, tech } = await people();
    const ticket = await openTicket(user.token);
    await comment(tech.token, ticket.id, { is_internal: true });
    await comment(user.token, ticket.id);
    await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(tech.token)).send({ assigned_to: tech.user.id });
    expect((await getTicket(user.token, ticket.id)).first_response_at).toBeNull();

    const own = await openTicket(tech.token);
    await comment(tech.token, own.id);
    await request(app).patch(`/api/tickets/${own.id}`).set(bearer(tech.token)).send({ status: 'in_progress' });
    expect((await getTicket(tech.token, own.id)).first_response_at).toBeNull();
  });
});

describe('/api/sla-targets', () => {
  it('lets staff read the targets, most urgent first, but not users', async () => {
    const { user, tech } = await people();
    const res = await request(app).get('/api/sla-targets').set(bearer(tech.token));
    expect(res.body.targets.map(({ priority, first_response_minutes, resolve_minutes }) => ({ priority, first_response_minutes, resolve_minutes }))).toEqual(DEFAULTS);
    expect((await request(app).get('/api/sla-targets').set(bearer(user.token))).status).toBe(403);
  });

  it('lets admins change them, which moves due times on open tickets', async () => {
    const { user, admin } = await people();
    const ticket = await openTicket(user.token);
    const targets = DEFAULTS.map((t) => (t.priority === 'medium' ? { ...t, first_response_minutes: 120, resolve_minutes: 480 } : t));
    const res = await request(app).put('/api/sla-targets').set(bearer(admin.token)).send({ targets });
    expect(res.status).toBe(200);
    expect(res.body.targets.find((t) => t.priority === 'medium').updated_by_name).toBe('Ada');

    const after = await getTicket(user.token, ticket.id);
    expect(hoursBetween(after.created_at, after.response_due_at)).toBe(2);
    expect(hoursBetween(after.created_at, after.resolve_due_at)).toBe(8);
  });

  it("doesn't let technicians change them", async () => {
    const { tech } = await people();
    expect((await request(app).put('/api/sla-targets').set(bearer(tech.token)).send({ targets: DEFAULTS })).status).toBe(403);
  });

  it.each([
    ['a priority missing', DEFAULTS.slice(1)],
    ['a fix target shorter than the reply target', DEFAULTS.map((t) => (t.priority === 'low' ? { ...t, resolve_minutes: 60 } : t))],
    ['minutes that are not a whole number', DEFAULTS.map((t) => (t.priority === 'high' ? { ...t, first_response_minutes: 1.5 } : t))],
    ['zero minutes', DEFAULTS.map((t) => (t.priority === 'urgent' ? { ...t, first_response_minutes: 0 } : t))],
    ['more than 90 days', DEFAULTS.map((t) => (t.priority === 'low' ? { ...t, resolve_minutes: 200000 } : t))],
  ])('refuses %s', async (_, targets) => {
    const { admin } = await people();
    expect((await request(app).put('/api/sla-targets').set(bearer(admin.token)).send({ targets })).status).toBe(400);
  });
});
