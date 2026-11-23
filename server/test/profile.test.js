// Tests for profiles: changing your own details and password, your numbers, and admins editing
// someone else's details (with the usual ranking rule and the account history).

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, signUpAdmin, signUpOwner, bearer } from './helpers.js';

const me = (token) => request(app).get('/api/profile').set(bearer(token));
const edit = (token, body) => request(app).patch('/api/profile').set(bearer(token)).send(body);
const changePassword = (account, body) => account.agent.post('/api/auth/password').set(bearer(account.token)).send(body);
const history = async (userId) =>
  (await pool.query('SELECT action, actor_id, old_value, new_value FROM account_events WHERE user_id = $1 ORDER BY id', [userId])).rows;

describe('your profile', () => {
  it('shows your details and how you sign in, never the password hash', async () => {
    const jo = await signUp({ name: 'J S', email: 'jo@example.com' });
    const res = await me(jo.token);
    expect(res.body.user).toMatchObject({ name: 'J S', email: 'jo@example.com', job_title: null, department: null, has_password: true, has_google: false });
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
    expect(res.body.stats).toBeUndefined(); // numbers are for staff
  });

  it('saves your name, job title and department, and logs the rename', async () => {
    const jo = await signUp({ name: 'J S', email: 'jo@example.com' });
    const res = await edit(jo.token, { name: '  Joanna Smith ', job_title: 'Accountant', department: 'Finance' });
    expect(res.body.user).toMatchObject({ name: 'Joanna Smith', job_title: 'Accountant', department: 'Finance' });
    // The new name is what logging in, the session and tickets now show.
    expect((await request(app).get('/api/auth/me').set(bearer(jo.token))).body.user).toMatchObject({ name: 'Joanna Smith', job_title: 'Accountant' });
    expect(await history(jo.user.id)).toEqual([{ action: 'renamed', actor_id: jo.user.id, old_value: 'J S', new_value: 'Joanna Smith' }]);

    // Clearing the job title alone keeps the rest, and isn't logged.
    expect((await edit(jo.token, { job_title: '' })).body.user).toMatchObject({ name: 'Joanna Smith', job_title: null, department: 'Finance' });
    expect(await history(jo.user.id)).toHaveLength(1);
  });

  it('refuses an empty or too-long name, and too-long work details', async () => {
    const jo = await signUp();
    expect((await edit(jo.token, { name: '   ' })).status).toBe(400);
    expect((await edit(jo.token, { name: 'x'.repeat(101) })).status).toBe(400);
    expect((await edit(jo.token, { department: 'x'.repeat(81) })).status).toBe(400);
    expect((await edit(jo.token, { job_title: 5 })).status).toBe(400);
  });

  it('shows staff their own numbers for the last 30 days', async () => {
    const jo = await signUp({ email: 'jo@example.com' });
    const tech = await signUp({ name: 'Sam', email: 'sam@example.com' });
    await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [tech.user.id]);
    expect((await me(tech.token)).body.stats).toBeNull(); // no tickets yet
    const ticket = (await request(app).post('/api/tickets').set(bearer(jo.token)).send({ title: 'VPN', description: 'Down' })).body.ticket;
    await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(tech.token)).send({ assigned_to: tech.user.id, status: 'resolved' });
    const res = await me(tech.token);
    expect(res.body).toMatchObject({ stats_days: 30, stats: { id: tech.user.id, resolved: 1, open_now: 0 } });
  });
});

describe('changing your password', () => {
  it('needs the current password, then works, and logs you out everywhere else', async () => {
    const jo = await signUp({ email: 'jo@example.com', password: 'old-password-1' });
    const otherDevice = request.agent(app);
    await otherDevice.post('/api/auth/login').send({ email: 'jo@example.com', password: 'old-password-1' });

    const wrong = await changePassword(jo, { current_password: 'nope', new_password: 'new-password-1' });
    expect(wrong.status).toBe(400); // not 401, which the app would treat as "logged out"
    expect((await changePassword(jo, { current_password: 'old-password-1', new_password: 'short' })).status).toBe(400);

    expect((await changePassword(jo, { current_password: 'old-password-1', new_password: 'new-password-1' })).status).toBe(204);
    expect((await request(app).post('/api/auth/login').send({ email: 'jo@example.com', password: 'new-password-1' })).status).toBe(200);
    expect((await otherDevice.post('/api/auth/refresh')).status).toBe(401); // the other device is logged out
    expect((await jo.agent.post('/api/auth/refresh')).status).toBe(200); // this one isn't
    expect((await history(jo.user.id)).map((e) => e.action)).toEqual(['password_changed']);
  });

  it('tells a Google-only account there is no password to change', async () => {
    const jo = await signUp({ email: 'jo@example.com' });
    await pool.query("UPDATE users SET google_id = 'g-1', password_hash = NULL WHERE id = $1", [jo.user.id]);
    const res = await changePassword(jo, { current_password: 'x', new_password: 'new-password-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Google/);
  });
});

describe('admins editing details on the Users screen', () => {
  const editUser = (token, id, body) => request(app).patch(`/api/users/${id}/details`).set(bearer(token)).send(body);

  it('lets an admin fix the name of someone ranked below, and logs who did it', async () => {
    const admin = await signUpAdmin();
    const jo = await signUp({ name: 'J S', email: 'jo@example.com' });
    const res = await editUser(admin.token, jo.user.id, { name: 'Joanna Smith', department: 'Finance' });
    expect(res.body.user).toMatchObject({ name: 'Joanna Smith', department: 'Finance' });
    expect(await history(jo.user.id)).toEqual([{ action: 'renamed', actor_id: admin.user.id, old_value: 'J S', new_value: 'Joanna Smith' }]);
    const listed = (await request(app).get('/api/users?q=joanna').set(bearer(admin.token))).body.users[0];
    expect(listed).toMatchObject({ job_title: null, department: 'Finance' });
  });

  it('follows the ranking rule: not yourself, not an equal or higher, not as a user', async () => {
    const owner = await signUpOwner();
    const admin = await signUpAdmin();
    const other = await signUp({ email: 'other-admin@example.com' });
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [other.user.id]);
    const jo = await signUp({ email: 'jo@example.com' });
    expect((await editUser(admin.token, admin.user.id, { name: 'Me' })).status).toBe(400); // use the Profile page
    expect((await editUser(admin.token, other.user.id, { name: 'X' })).status).toBe(403);
    expect((await editUser(admin.token, owner.user.id, { name: 'X' })).status).toBe(403);
    expect((await editUser(owner.token, other.user.id, { name: 'Ann' })).status).toBe(200); // an owner may
    expect((await editUser(jo.token, admin.user.id, { name: 'X' })).status).toBe(403);
    expect((await editUser(admin.token, jo.user.id, { name: '' })).status).toBe(400);
  });
});

describe('details on tickets', () => {
  it("shows the opener's job title and department on their ticket", async () => {
    const jo = await signUp({ email: 'jo@example.com' });
    await edit(jo.token, { job_title: 'Accountant', department: 'Finance' });
    const ticket = (await request(app).post('/api/tickets').set(bearer(jo.token)).send({ title: 'VPN', description: 'Down' })).body.ticket;
    expect(ticket).toMatchObject({ created_by_job_title: 'Accountant', created_by_department: 'Finance' });
  });
});
