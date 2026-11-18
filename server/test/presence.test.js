// Tests for online status: check-ins, the status rules (offline after 2 minutes, away after 15
// idle, or the staff member's own choice), and who sees what.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

/** A user and two technicians. */
async function people() {
  const user = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const sam = await signUp({ name: 'Sam', email: 'sam@example.com' });
  const priya = await signUp({ name: 'Priya', email: 'priya@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = ANY($1)", [[sam.user.id, priya.user.id]]);
  return { user, sam, priya };
}

const heartbeat = (token, active = true) => request(app).post('/api/presence/heartbeat').set(bearer(token)).send({ active });
const presence = (token) => request(app).get('/api/presence').set(bearer(token));
const setStatus = (token, availability) => request(app).put('/api/presence/me').set(bearer(token)).send({ availability });

/** Moves someone's last check-in and last activity back in time. */
const backdate = (account, seenMinutes, activeMinutes = seenMinutes) =>
  pool.query(
    `UPDATE users SET last_seen_at = NOW() - make_interval(mins => $2), last_active_at = NOW() - make_interval(mins => $3) WHERE id = $1`,
    [account.user.id, seenMinutes, activeMinutes]
  );

describe('online status', () => {
  it('is offline until the first check-in, then available', async () => {
    const { sam } = await people();
    expect((await presence(sam.token)).body.me.status).toBe('offline');
    expect((await heartbeat(sam.token)).body.me.status).toBe('available');
  });

  it('goes offline after 2 minutes without a check-in', async () => {
    const { sam } = await people();
    await heartbeat(sam.token);
    await backdate(sam, 3);
    expect((await presence(sam.token)).body.me.status).toBe('offline');
  });

  it('goes away after 15 minutes without mouse or keyboard, and back on activity', async () => {
    const { sam } = await people();
    await heartbeat(sam.token);
    await backdate(sam, 0, 20);
    expect((await heartbeat(sam.token, false)).body.me.status).toBe('away');
    expect((await heartbeat(sam.token, true)).body.me.status).toBe('available');
  });

  it("uses the staff member's own choice", async () => {
    const { sam } = await people();
    expect((await setStatus(sam.token, 'busy')).body.me).toEqual({ availability: 'busy', status: 'busy' });
    expect((await setStatus(sam.token, 'away')).body.me.status).toBe('away');
    expect((await setStatus(sam.token, 'lunch')).status).toBe(400);
  });
});

describe('who sees what', () => {
  it('gives staff the names of who is online', async () => {
    const { sam, priya } = await people();
    await heartbeat(sam.token);
    await setStatus(priya.token, 'busy');
    const res = await presence(sam.token);
    expect(res.body).toMatchObject({ online: 2, available: 1 });
    expect(res.body.staff.map((s) => [s.name, s.status])).toEqual([['Priya', 'busy'], ['Sam', 'available']]);
  });

  it('gives users only first names and status, not ids, roles or full names', async () => {
    const { user, sam } = await people();
    await pool.query("UPDATE users SET name = 'Sam Rivera' WHERE id = $1", [sam.user.id]);
    await heartbeat(sam.token);
    const res = await presence(user.token);
    expect(res.body).toEqual({ online: 1, available: 1, staff: [{ name: 'Sam', status: 'available' }] });
  });

  it("doesn't let users check in or set a status", async () => {
    const { user } = await people();
    expect((await heartbeat(user.token)).status).toBe(403);
    expect((await setStatus(user.token, 'busy')).status).toBe(403);
  });

  it('shows status in the Assign to list and on the dashboard', async () => {
    const { sam, priya } = await people();
    await setStatus(sam.token, 'busy');
    const assignees = (await request(app).get('/api/tickets/assignees').set(bearer(priya.token))).body.assignees;
    expect(assignees.map((a) => [a.name, a.status])).toEqual([['Priya', 'offline'], ['Sam', 'busy']]);
  });
});
