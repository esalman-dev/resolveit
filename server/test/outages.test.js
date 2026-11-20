// Tests for outage spotting: when tickets add up to a suspected outage (3 in one category within
// 15 minutes), confirming and dismissing it, "This is my problem", fixing it (which resolves its
// tickets and tells everyone affected), and linking tickets by hand.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

/** A user (Jo), a technician (Sam), and the Network and Printer categories. */
async function setUp() {
  const jo = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const sam = await signUp({ name: 'Sam', email: 'sam@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [sam.user.id]);
  const add = async (name) => (await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  return { jo, sam, network: await add('Network'), printer: await add('Printer') };
}

const openTicket = async (token, categoryId, title = 'Wi-Fi is down') =>
  (await request(app).post('/api/tickets').set(bearer(token)).send({ title, description: 'No connection', category_id: categoryId }))
    .body.ticket;
const outages = async (token) => (await request(app).get('/api/outages').set(bearer(token))).body.outages;
const act = (token, id, action, body = {}) => request(app).post(`/api/outages/${id}/${action}`).set(bearer(token)).send(body);
const ticketRow = async (id) => (await pool.query('SELECT * FROM tickets WHERE id = $1', [id])).rows[0];
const kinds = async (userId) =>
  (await pool.query('SELECT kind FROM notifications WHERE user_id = $1 ORDER BY id', [userId])).rows.map((r) => r.kind);

/** Opens `count` Network tickets as Jo and returns them. */
async function burst({ jo, network }, count = 3) {
  const tickets = [];
  for (let i = 0; i < count; i++) tickets.push(await openTicket(jo.token, network, `Wi-Fi is down ${i + 1}`));
  return tickets;
}

/** Three Network tickets, then Sam confirms the outage. Returns the outage id and the tickets. */
async function confirmedOutage(people) {
  const tickets = await burst(people);
  const [outage] = await outages(people.sam.token);
  await act(people.sam.token, outage.id, 'confirm', { message: 'Wi-Fi down in Building B' });
  return { outageId: outage.id, tickets };
}

describe('spotting an outage', () => {
  it('3 tickets in one category within 15 minutes become a suspected outage, and staff are told', async () => {
    const people = await setUp();
    const tickets = await burst(people);

    const [outage] = await outages(people.sam.token);
    expect(outage).toMatchObject({ status: 'suspected', category_name: 'Network', ticket_count: 3, report_count: 0 });
    for (const t of tickets) expect((await ticketRow(t.id)).outage_id).toBe(outage.id);
    expect(await kinds(people.sam.user.id)).toEqual(['outage_suspected']);
    expect(await kinds(people.jo.user.id)).toEqual([]);
  });

  it('needs 3: two tickets, other categories, or no category are not an outage', async () => {
    const people = await setUp();
    await burst(people, 2);
    await openTicket(people.jo.token, people.printer);
    await openTicket(people.jo.token, null);
    expect(await outages(people.sam.token)).toEqual([]);
  });

  it('ignores tickets older than 15 minutes or already resolved', async () => {
    const people = await setUp();
    const [old, done] = await burst(people, 2);
    await pool.query("UPDATE tickets SET created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1", [old.id]);
    await pool.query("UPDATE tickets SET status = 'resolved' WHERE id = $1", [done.id]);
    await burst(people, 1);
    expect(await outages(people.sam.token)).toEqual([]);
  });

  it('new tickets in the same category join the open outage', async () => {
    const people = await setUp();
    await burst(people);
    const late = await openTicket(people.jo.token, people.network, 'Me too');
    const [outage] = await outages(people.sam.token);
    expect(outage.ticket_count).toBe(4);
    expect((await ticketRow(late.id)).outage_id).toBe(outage.id);
  });
});

describe('confirming or dismissing', () => {
  it('users never see a suspected outage; once confirmed, everyone sees its message', async () => {
    const people = await setUp();
    await burst(people);
    expect(await outages(people.jo.token)).toEqual([]);

    const [outage] = await outages(people.sam.token);
    const res = await act(people.sam.token, outage.id, 'confirm', { message: '  Wi-Fi down in Building B ' });
    expect(res.status).toBe(200);
    expect(await outages(people.jo.token)).toEqual([
      { id: outage.id, status: 'confirmed', message: 'Wi-Fi down in Building B', confirmed_at: expect.any(String), reported_by_me: false },
    ]);
  });

  it('only staff confirm, with a message of up to 200 characters, and only once', async () => {
    const people = await setUp();
    await burst(people);
    const [outage] = await outages(people.sam.token);

    expect((await act(people.jo.token, outage.id, 'confirm', { message: 'Hi' })).status).toBe(403);
    expect((await act(people.sam.token, outage.id, 'confirm', { message: '   ' })).status).toBe(400);
    expect((await act(people.sam.token, outage.id, 'confirm', { message: 'x'.repeat(201) })).status).toBe(400);
    expect((await act(people.sam.token, outage.id, 'confirm', { message: 'Down' })).status).toBe(200);
    expect((await act(people.sam.token, outage.id, 'confirm', { message: 'Down' })).status).toBe(409);
    expect((await act(people.sam.token, 999, 'confirm', { message: 'Down' })).status).toBe(404);
  });

  it('a dismissed outage disappears, and its tickets never count toward a new one', async () => {
    const people = await setUp();
    await burst(people);
    const [outage] = await outages(people.sam.token);
    expect((await act(people.sam.token, outage.id, 'dismiss')).status).toBe(200);
    expect(await outages(people.sam.token)).toEqual([]);

    await burst(people, 2); // 2 new + 3 dismissed: still not 3 unlinked ones
    expect(await outages(people.sam.token)).toEqual([]);
    await burst(people, 1); // now 3 new ones
    expect(await outages(people.sam.token)).toHaveLength(1);
  });

  it('staff can change a confirmed outage\'s message', async () => {
    const people = await setUp();
    const { outageId } = await confirmedOutage(people);
    const res = await request(app).patch(`/api/outages/${outageId}`).set(bearer(people.sam.token)).send({ message: 'Also Building C' });
    expect(res.status).toBe(200);
    expect((await outages(people.jo.token))[0].message).toBe('Also Building C');
  });
});

describe('"This is my problem"', () => {
  it('adds you to a confirmed outage once, without opening a ticket', async () => {
    const people = await setUp();
    const { outageId } = await confirmedOutage(people);
    const ana = await signUp({ name: 'Ana', email: 'ana@example.com' });

    expect((await act(ana.token, outageId, 'report')).status).toBe(200);
    expect((await act(ana.token, outageId, 'report')).status).toBe(200); // twice: no change
    expect((await outages(ana.token))[0].reported_by_me).toBe(true);
    expect((await outages(people.sam.token))[0]).toMatchObject({ ticket_count: 3, report_count: 1 });
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM tickets WHERE created_by = $1', [ana.user.id])).rows[0].n).toBe(0);
  });

  it('answers 404 for a suspected outage, so users never learn about one', async () => {
    const people = await setUp();
    await burst(people);
    const [outage] = await outages(people.sam.token);
    expect((await act(people.jo.token, outage.id, 'report')).status).toBe(404);
  });
});

describe('marking it fixed', () => {
  it('resolves every linked ticket with the message as a reply, and tells everyone affected', async () => {
    const people = await setUp();
    const { outageId, tickets } = await confirmedOutage(people);
    const ana = await signUp({ name: 'Ana', email: 'ana@example.com' });
    await act(ana.token, outageId, 'report');
    await pool.query("UPDATE tickets SET status = 'resolved' WHERE id = $1", [tickets[0].id]); // already done by hand
    await pool.query('DELETE FROM notifications');

    const res = await act(people.sam.token, outageId, 'fix', { message: 'The access point was restarted.' });
    expect(res.status).toBe(200);
    expect(res.body.outages).toEqual([]); // the banner is gone

    for (const t of tickets.slice(1)) {
      expect(await ticketRow(t.id)).toMatchObject({ status: 'resolved', resolved_at: expect.any(Date), first_response_at: expect.any(Date) });
      const reply = await pool.query('SELECT author_id, body, is_internal FROM ticket_comments WHERE ticket_id = $1', [t.id]);
      expect(reply.rows).toEqual([{ author_id: people.sam.user.id, body: 'The access point was restarted.', is_internal: false }]);
      const history = await request(app).get(`/api/tickets/${t.id}`).set(bearer(people.sam.token));
      expect(history.body.history.at(-1)).toMatchObject({ field: 'status', new_value: 'resolved', actor_name: 'Sam' });
    }
    // The ticket resolved by hand earlier got no extra reply.
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM ticket_comments WHERE ticket_id = $1', [tickets[0].id])).rows[0].n).toBe(0);

    expect(await kinds(people.jo.user.id)).toEqual(['resolved', 'resolved']);
    expect(await kinds(ana.user.id)).toEqual(['outage_fixed']);
    const bell = await request(app).get('/api/notifications').set(bearer(ana.token));
    expect(bell.body.notifications[0]).toMatchObject({ kind: 'outage_fixed', ticket_id: null, outage_message: 'Wi-Fi down in Building B' });
  });

  it('needs a message, staff, and a confirmed outage', async () => {
    const people = await setUp();
    await burst(people);
    const [outage] = await outages(people.sam.token);
    expect((await act(people.sam.token, outage.id, 'fix', { message: 'Done' })).status).toBe(409); // still suspected

    await act(people.sam.token, outage.id, 'confirm', { message: 'Down' });
    expect((await act(people.sam.token, outage.id, 'fix', {})).status).toBe(400);
    expect((await act(people.jo.token, outage.id, 'fix', { message: 'Done' })).status).toBe(403);
    expect((await act(people.sam.token, outage.id, 'fix', { message: 'Done' })).status).toBe(200);
    expect((await act(people.sam.token, outage.id, 'fix', { message: 'Done' })).status).toBe(409); // already fixed
  });
});

describe('linking a ticket by hand', () => {
  it('staff link a ticket to an open outage, or unlink it', async () => {
    const people = await setUp();
    const { outageId } = await confirmedOutage(people);
    const printer = await openTicket(people.jo.token, people.printer, 'Can not print');
    const link = (token, outage_id) =>
      request(app).put(`/api/outages/tickets/${printer.id}`).set(bearer(token)).send({ outage_id });

    expect((await link(people.sam.token, outageId)).status).toBe(204);
    expect((await ticketRow(printer.id)).outage_id).toBe(outageId);
    expect((await link(people.sam.token, null)).status).toBe(204);
    expect((await ticketRow(printer.id)).outage_id).toBeNull();

    expect((await link(people.jo.token, outageId)).status).toBe(403);
    expect((await link(people.sam.token, 'x')).status).toBe(400);
    await act(people.sam.token, outageId, 'fix', { message: 'Done' });
    expect((await link(people.sam.token, outageId)).status).toBe(400); // closed: pick an open one
  });
});
