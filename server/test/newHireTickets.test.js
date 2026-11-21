// Tests for opening new-hire setup tickets (POST /api/tickets/new-hire): who can, what's
// checked, the copied checklist, the start-date deadline, and that outage spotting skips them.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, signUpAdmin, bearer } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

/** A user (Jo) and a technician (Sam). */
async function people() {
  const jo = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const sam = await signUp({ name: 'Sam', email: 'sam@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [sam.user.id]);
  return { jo, sam };
}

const JANE = { name: 'Jane Doe', job_title: 'Sales Associate', ready_by: inDays(7) };

const openNewHire = (token, body = JANE) => request(app).post('/api/tickets/new-hire').set(bearer(token)).send(body);

/** A ticket's checklist straight from the database, in order. */
const checklist = async (ticketId) =>
  (await pool.query('SELECT title, state FROM ticket_checklist_items WHERE ticket_id = $1 ORDER BY position', [ticketId])).rows;

describe('POST /api/tickets/new-hire', () => {
  it('opens a new-hire ticket with its title, description, deadline and a copy of the steps', async () => {
    const { sam } = await people();
    const res = await openNewHire(sam.token, { ...JANE, notes: '  Needs a second monitor.  ' });

    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({
      kind: 'new_hire',
      title: 'New hire: Jane Doe, Sales Associate',
      description: 'Setup for Jane Doe (Sales Associate).\n\nNeeds a second monitor.',
      status: 'open',
      priority: 'medium',
      created_by_name: 'Sam',
    });
    // The deadline is the start date sent, not the priority's 3 days.
    expect(new Date(res.body.ticket.resolve_due_at).toISOString()).toBe(JANE.ready_by);
    expect(res.body.history).toEqual([expect.objectContaining({ action: 'created', actor_name: 'Sam' })]);

    const steps = await checklist(res.body.ticket.id);
    expect(steps.map((s) => s.title)).toEqual(['Create account', 'Set up email', 'Prepare laptop', 'Install software', 'Building access', 'First-day check-in']);
    expect(steps.every((s) => s.state === 'todo')).toBe(true);
  });

  it('leaves out the notes paragraph when there are no notes', async () => {
    const { sam } = await people();
    const res = await openNewHire(sam.token);
    expect(res.body.ticket.description).toBe('Setup for Jane Doe (Sales Associate).');
  });

  it("keeps a ticket's own steps when the standard list changes later", async () => {
    const { sam } = await people();
    const admin = await signUpAdmin();
    const ticket = (await openNewHire(sam.token)).body.ticket;

    await request(app).put('/api/new-hire-steps').set(bearer(admin.token)).send({ steps: ['Order a monitor'] });

    expect((await checklist(ticket.id)).length).toBe(6);
    const next = (await openNewHire(sam.token)).body.ticket;
    expect((await checklist(next.id)).map((s) => s.title)).toEqual(['Order a monitor']);
  });

  it('refuses users (only staff start new-hire tickets)', async () => {
    const { jo } = await people();
    expect((await openNewHire(jo.token)).status).toBe(403);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM tickets')).rows[0].n).toBe(0);
  });

  it.each([
    ['no name', { ...JANE, name: '  ' }],
    ['no job title', { ...JANE, job_title: undefined }],
    ['a name over 80 characters', { ...JANE, name: 'x'.repeat(81) }],
    ['no start date', { ...JANE, ready_by: undefined }],
    ['a start date that is not a date', { ...JANE, ready_by: 'next Tuesday' }],
    ['a start date in the past', { ...JANE, ready_by: inDays(-3) }],
    ['a start date more than a year away', { ...JANE, ready_by: inDays(400) }],
    ['notes too long for a description', { ...JANE, notes: 'x'.repeat(5000) }],
  ])('refuses %s', async (_, body) => {
    const { sam } = await people();
    const res = await openNewHire(sam.token, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('counts as replied at once, so it never goes "reply overdue" or skews the first-reply average', async () => {
    const { sam } = await people();
    const ticket = (await openNewHire(sam.token)).body.ticket;
    expect(ticket.first_response_at).toBeTruthy();

    // Two days later, still nothing due: the bell gives no overdue reply warning.
    await pool.query("UPDATE tickets SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [ticket.id]);
    await pool.query('UPDATE tickets SET assigned_to = $1 WHERE id = $2', [sam.user.id, ticket.id]);
    const bell = await request(app).get('/api/notifications').set(bearer(sam.token));
    expect(bell.body.notifications.filter((n) => n.kind === 'overdue_reply')).toEqual([]);

    const dashboard = await request(app).get('/api/dashboard?days=7').set(bearer(sam.token));
    expect(dashboard.body.current.first_reply.average).toBeNull();
  });

  it('is never counted toward an outage, even with a category', async () => {
    const { jo, sam } = await people();
    const network = (await pool.query("INSERT INTO categories (name) VALUES ('Network') RETURNING id")).rows[0].id;

    // A new-hire ticket given the Network category, then two Network problems: 3 tickets in the
    // category, but only 2 are problems, so no outage.
    const hire = (await openNewHire(sam.token)).body.ticket;
    await request(app).patch(`/api/tickets/${hire.id}`).set(bearer(sam.token)).send({ category_id: network });
    for (const title of ['Wi-Fi down', 'No internet']) {
      await request(app).post('/api/tickets').set(bearer(jo.token)).send({ title, description: 'No connection', category_id: network });
    }

    expect((await pool.query('SELECT COUNT(*)::int AS n FROM outages')).rows[0].n).toBe(0);
  });
});
