// Tests for a new-hire ticket's checklist: ticking, skipping, adding and removing steps, the
// history lines, who may change it, and that the ticket can't be resolved until it's finished.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

/** A user (Jo), a technician (Sam), and a new-hire ticket Sam opened. */
async function setUp() {
  const jo = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const sam = await signUp({ name: 'Sam', email: 'sam@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [sam.user.id]);
  const created = await request(app).post('/api/tickets/new-hire').set(bearer(sam.token))
    .send({ name: 'Jane Doe', job_title: 'Sales Associate', ready_by: new Date(Date.now() + 7 * 864e5).toISOString() });
  return { jo, sam, ticket: created.body.ticket, steps: created.body.checklist };
}

const setState = (token, ticketId, stepId, state) =>
  request(app).patch(`/api/tickets/${ticketId}/checklist/${stepId}`).set(bearer(token)).send({ state });
const addStep = (token, ticketId, title) => request(app).post(`/api/tickets/${ticketId}/checklist`).set(bearer(token)).send({ title });
const removeStep = (token, ticketId, stepId) => request(app).delete(`/api/tickets/${ticketId}/checklist/${stepId}`).set(bearer(token));
const resolve = (token, ticketId) => request(app).patch(`/api/tickets/${ticketId}`).set(bearer(token)).send({ status: 'resolved' });

/** The checklist history lines, oldest first, as [title, what happened]. */
const checklistHistory = (res) => res.body.history.filter((e) => e.field === 'checklist').map((e) => [e.old_value, e.new_value]);

describe('a new-hire ticket', () => {
  it('comes with its checklist, every step to do', async () => {
    const { sam, ticket } = await setUp();
    const res = await request(app).get(`/api/tickets/${ticket.id}`).set(bearer(sam.token));
    expect(res.body.checklist.map((s) => [s.title, s.state])).toEqual([
      ['Create account', 'todo'], ['Set up email', 'todo'], ['Prepare laptop', 'todo'],
      ['Install software', 'todo'], ['Building access', 'todo'], ['First-day check-in', 'todo'],
    ]);
  });

  it('other tickets have an empty checklist', async () => {
    const { jo } = await setUp();
    const created = await request(app).post('/api/tickets').set(bearer(jo.token)).send({ title: 'Printer', description: 'Jammed' });
    expect(created.body.checklist).toEqual([]);
  });
});

describe('PATCH /api/tickets/:id/checklist/:stepId', () => {
  it('ticks, skips and unticks a step, saying who and logging each change', async () => {
    const { sam, ticket, steps } = await setUp();

    let res = await setState(sam.token, ticket.id, steps[2].id, 'done');
    expect(res.status).toBe(200);
    expect(res.body.checklist[2]).toMatchObject({ title: 'Prepare laptop', state: 'done', changed_by_name: 'Sam' });

    await setState(sam.token, ticket.id, steps[4].id, 'not_needed');
    res = await setState(sam.token, ticket.id, steps[2].id, 'todo');
    expect(res.body.checklist[2].state).toBe('todo');
    expect(checklistHistory(res)).toEqual([['Prepare laptop', 'done'], ['Building access', 'not_needed'], ['Prepare laptop', 'todo']]);
  });

  it('logs nothing when the step is already in that state', async () => {
    const { sam, ticket, steps } = await setUp();
    await setState(sam.token, ticket.id, steps[0].id, 'done');
    const res = await setState(sam.token, ticket.id, steps[0].id, 'done');
    expect(checklistHistory(res)).toHaveLength(1);
  });

  it.each([
    ['an unknown state', 'finished'],
    ['no state', undefined],
  ])('refuses %s', async (_, state) => {
    const { sam, ticket, steps } = await setUp();
    expect((await setState(sam.token, ticket.id, steps[0].id, state)).status).toBe(400);
  });

  it("refuses a step from another ticket (404), and a ticket that isn't a new hire (400)", async () => {
    const { jo, sam, ticket, steps } = await setUp();
    const other = (await request(app).post('/api/tickets/new-hire').set(bearer(sam.token))
      .send({ name: 'Omar', job_title: 'Tech', ready_by: new Date(Date.now() + 864e5).toISOString() })).body.ticket;
    expect((await setState(sam.token, other.id, steps[0].id, 'done')).status).toBe(404);

    const plain = (await request(app).post('/api/tickets').set(bearer(jo.token)).send({ title: 'Printer', description: 'Jammed' })).body.ticket;
    expect((await setState(sam.token, plain.id, steps[0].id, 'done')).status).toBe(400);
    expect((await setState(sam.token, ticket.id, steps[0].id, 'done')).status).toBe(200);
  });

  it('refuses users, even on a ticket they can see', async () => {
    const { jo, sam, ticket, steps } = await setUp();
    // Even if a user were the creator, the checklist is staff work.
    await pool.query('UPDATE tickets SET created_by = $1 WHERE id = $2', [jo.user.id, ticket.id]);
    expect((await setState(jo.token, ticket.id, steps[0].id, 'done')).status).toBe(403);
    expect((await setState(sam.token, ticket.id, steps[0].id, 'done')).status).toBe(200);
  });
});

describe('adding and removing steps', () => {
  it('adds a step at the end of this ticket only, and logs it', async () => {
    const { sam, ticket } = await setUp();
    const res = await addStep(sam.token, ticket.id, '  Order a monitor ');
    expect(res.status).toBe(200);
    expect(res.body.checklist.at(-1)).toMatchObject({ title: 'Order a monitor', state: 'todo' });
    expect(checklistHistory(res)).toEqual([['Order a monitor', 'added']]);
    expect((await request(app).get('/api/new-hire-steps').set(bearer(sam.token))).body.steps).not.toContain('Order a monitor');
  });

  it('refuses a blank or too-long step, and a 31st step', async () => {
    const { sam, ticket } = await setUp();
    expect((await addStep(sam.token, ticket.id, '   ')).status).toBe(400);
    expect((await addStep(sam.token, ticket.id, 'x'.repeat(121))).status).toBe(400);
    for (let i = 7; i <= 30; i++) await addStep(sam.token, ticket.id, `Step ${i}`);
    expect((await addStep(sam.token, ticket.id, 'One too many')).status).toBe(400);
  });

  it('removes a step and logs it, but never the last one', async () => {
    const { sam, ticket, steps } = await setUp();
    const res = await removeStep(sam.token, ticket.id, steps[1].id);
    expect(res.status).toBe(200);
    expect(res.body.checklist.map((s) => s.title)).not.toContain('Set up email');
    expect(checklistHistory(res)).toEqual([['Set up email', 'removed']]);

    for (const step of res.body.checklist.slice(1)) await removeStep(sam.token, ticket.id, step.id);
    const last = await removeStep(sam.token, ticket.id, res.body.checklist[0].id);
    expect(last.status).toBe(400);
  });
});

describe('resolving a new-hire ticket', () => {
  it('is refused while steps are left, and allowed once each is done or not needed', async () => {
    const { sam, ticket, steps } = await setUp();
    let res = await resolve(sam.token, ticket.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Finish the checklist first: 6 steps left');

    for (const step of steps.slice(0, 5)) await setState(sam.token, ticket.id, step.id, 'done');
    expect((await resolve(sam.token, ticket.id)).body.error).toBe('Finish the checklist first: 1 step left');

    await setState(sam.token, ticket.id, steps[5].id, 'not_needed');
    res = await resolve(sam.token, ticket.id);
    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe('resolved');
  });

  it("freezes the checklist once resolved, until it's reopened", async () => {
    const { sam, ticket, steps } = await setUp();
    for (const step of steps) await setState(sam.token, ticket.id, step.id, 'done');
    await resolve(sam.token, ticket.id);

    expect((await setState(sam.token, ticket.id, steps[0].id, 'todo')).status).toBe(409);
    expect((await addStep(sam.token, ticket.id, 'Late step')).status).toBe(409);

    await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(sam.token)).send({ status: 'open' });
    expect((await setState(sam.token, ticket.id, steps[0].id, 'todo')).status).toBe(200);
  });

  it("can't be linked to an outage (fixing it would skip the checklist)", async () => {
    const { sam, ticket } = await setUp();
    const network = (await pool.query("INSERT INTO categories (name) VALUES ('Network') RETURNING id")).rows[0].id;
    const outage = (await pool.query('INSERT INTO outages (category_id) VALUES ($1) RETURNING id', [network])).rows[0].id;
    const res = await request(app).put(`/api/outages/tickets/${ticket.id}`).set(bearer(sam.token)).send({ outage_id: outage });
    expect(res.status).toBe(400);
  });
});
