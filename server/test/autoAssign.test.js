// Tests for auto-assign: who gets a new ticket (available technicians only, fewest open tickets,
// taking turns on a tie), the history line and notification it leaves, and the admin switch.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

/** Signs up, then sets the role directly in the database. */
async function signUpAs(role, name) {
  const account = await signUp({ name, email: `${name.toLowerCase()}@example.com` });
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, account.user.id]);
  return account;
}

/** Makes someone count as online and active right now, with the given status. */
const setStatus = (account, availability = 'available') =>
  pool.query("UPDATE users SET last_seen_at = NOW(), last_active_at = NOW(), availability = $2 WHERE id = $1", [
    account.user.id,
    availability,
  ]);

const openTicket = async (token, title = 'Printer offline') =>
  (await request(app).post('/api/tickets').set(bearer(token)).send({ title, description: 'Since 9 am' })).body;

const setAutoAssign = (token, value) => request(app).put('/api/settings').set(bearer(token)).send({ auto_assign: value });

describe('auto-assign', () => {
  it('gives a new ticket to the available technician with the fewest open tickets', async () => {
    const user = await signUp({ email: 'jo@example.com' });
    const sam = await signUpAs('technician', 'Sam');
    const priya = await signUpAs('technician', 'Priya');
    await Promise.all([setStatus(sam), setStatus(priya)]);
    // Sam already has an open ticket; Priya has none.
    const busyWith = await openTicket(user.token, 'Old one');
    await pool.query('UPDATE tickets SET assigned_to = $1 WHERE id = $2', [sam.user.id, busyWith.ticket.id]);

    const { ticket } = await openTicket(user.token);
    expect(ticket.assigned_to).toBe(priya.user.id);
  });

  it('takes turns when technicians have the same number of open tickets', async () => {
    const user = await signUp({ email: 'jo@example.com' });
    const sam = await signUpAs('technician', 'Sam');
    const priya = await signUpAs('technician', 'Priya');
    await Promise.all([setStatus(sam), setStatus(priya)]);

    const first = await openTicket(user.token, 'One');
    // Resolve it, so both have zero open tickets again: the tie goes to whoever waited longest.
    await pool.query("UPDATE tickets SET status = 'resolved' WHERE id = $1", [first.ticket.id]);
    const second = await openTicket(user.token, 'Two');

    expect(new Set([first.ticket.assigned_to, second.ticket.assigned_to])).toEqual(new Set([sam.user.id, priya.user.id]));
  });

  it('skips busy, away and offline technicians, and never picks admins or owners', async () => {
    const user = await signUp({ email: 'jo@example.com' });
    const busy = await signUpAs('technician', 'Busy');
    const away = await signUpAs('technician', 'Away');
    await signUpAs('technician', 'Offline'); // never checked in
    const admin = await signUpAs('admin', 'Ada');
    await Promise.all([setStatus(busy, 'busy'), setStatus(away, 'away'), setStatus(admin)]);

    const { ticket } = await openTicket(user.token);
    expect(ticket.assigned_to).toBeNull();
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n).toBe(0);
  });

  it('records "assigned automatically" in the history and tells the technician', async () => {
    const user = await signUp({ email: 'jo@example.com' });
    const sam = await signUpAs('technician', 'Sam');
    await setStatus(sam);

    const { ticket, history } = await openTicket(user.token);
    expect(history.at(-1)).toMatchObject({ field: 'assignee', old_value: null, new_value: 'Sam', actor_id: null, actor_name: null });

    const bell = await request(app).get('/api/notifications').set(bearer(sam.token));
    expect(bell.body.notifications).toEqual([
      expect.objectContaining({ kind: 'assigned', ticket_id: ticket.id, actor_name: null, read_at: null }),
    ]);
  });
});

describe('the auto-assign switch', () => {
  it('when off, new tickets stay unassigned', async () => {
    const admin = await signUpAs('admin', 'Ada');
    const sam = await signUpAs('technician', 'Sam');
    await setStatus(sam);

    const res = await setAutoAssign(admin.token, false);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ auto_assign: false, updated_by_name: 'Ada' });
    expect((await openTicket(admin.token)).ticket.assigned_to).toBeNull();
  });

  it('staff can read it; only admins and owners can change it', async () => {
    const user = await signUp({ email: 'jo@example.com' });
    const sam = await signUpAs('technician', 'Sam');

    expect((await request(app).get('/api/settings').set(bearer(sam.token))).body.settings.auto_assign).toBe(true);
    expect((await request(app).get('/api/settings').set(bearer(user.token))).status).toBe(403);
    expect((await setAutoAssign(sam.token, false)).status).toBe(403);
    expect((await setAutoAssign(user.token, false)).status).toBe(403);
  });

  it('accepts only true or false', async () => {
    const admin = await signUpAs('admin', 'Ada');
    expect((await setAutoAssign(admin.token, 'no')).status).toBe(400);
    expect((await request(app).put('/api/settings').set(bearer(admin.token)).send({})).status).toBe(400);
  });
});
