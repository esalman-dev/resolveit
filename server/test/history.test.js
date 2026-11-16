// History and accountability: ticket history, comment edit history, account history,
// and disabling accounts
import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, signUpAdmin, signUpOwner, bearer } from './helpers.js';

async function signUpAs(role, email) {
  const account = await signUp({ name: email.split('@')[0], email });
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, account.user.id]);
  return account;
}

async function createTicket(token, fields = {}) {
  const res = await request(app)
    .post('/api/tickets')
    .set(bearer(token))
    .send({ title: 'Wi-Fi is down', description: 'Laptop will not connect', ...fields });
  return res.body;
}

const patchTicket = (token, id, body) => request(app).patch(`/api/tickets/${id}`).set(bearer(token)).send(body);

describe('ticket history (shown on the ticket itself)', () => {
  it('starts with a "created" entry, returned with the new ticket', async () => {
    const alice = await signUp({ email: 'alice@example.com', name: 'Alice' });
    const { history } = await createTicket(alice.token);
    expect(history).toEqual([
      expect.objectContaining({ action: 'created', field: null, actor_id: alice.user.id, actor_name: 'Alice' }),
    ]);
  });

  it('records each changed field with who, before and after, using names', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const tech = await signUpAs('technician', 'tech@example.com');
    const network = (await pool.query("INSERT INTO categories (name) VALUES ('Network') RETURNING id")).rows[0].id;
    const { ticket } = await createTicket(alice.token);

    await patchTicket(tech.token, ticket.id, {
      status: 'in_progress',
      priority: 'high',
      category_id: network,
      assigned_to: tech.user.id,
    });

    const res = await request(app).get(`/api/tickets/${ticket.id}`).set(bearer(alice.token)); // the creator sees it too
    const changes = res.body.history.filter((e) => e.action === 'changed');
    expect(changes.map(({ field, old_value, new_value, actor_name }) => ({ field, old_value, new_value, actor_name }))).toEqual([
      { field: 'status', old_value: 'open', new_value: 'in_progress', actor_name: 'tech' },
      { field: 'priority', old_value: 'medium', new_value: 'high', actor_name: 'tech' },
      { field: 'category', old_value: null, new_value: 'Network', actor_name: 'tech' },
      { field: 'assignee', old_value: null, new_value: 'tech', actor_name: 'tech' },
    ]);
  });

  it("records a user's own edits and closing", async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const { ticket } = await createTicket(alice.token);
    await patchTicket(alice.token, ticket.id, { title: 'Wi-Fi drops hourly' });
    const res = await patchTicket(alice.token, ticket.id, { status: 'resolved' });

    expect(res.body.history.map((e) => e.field)).toEqual([null, 'title', 'status']);
    expect(res.body.history[1]).toMatchObject({ old_value: 'Wi-Fi is down', new_value: 'Wi-Fi drops hourly' });
  });

  it('does not log anything when the value did not actually change', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const admin = await signUpAdmin();
    const { ticket } = await createTicket(alice.token);
    const res = await patchTicket(admin.token, ticket.id, { priority: 'medium' }); // already medium
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(1); // just "created"
  });

  it('saves nothing at all if any part of the change is invalid (all or nothing)', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const admin = await signUpAdmin();
    const { ticket } = await createTicket(alice.token);
    const res = await patchTicket(admin.token, ticket.id, { status: 'in_progress', priority: 'critical' });
    expect(res.status).toBe(400);

    const after = await request(app).get(`/api/tickets/${ticket.id}`).set(bearer(admin.token));
    expect(after.body.ticket.status).toBe('open');
    expect(after.body.history).toHaveLength(1);
  });

  it('refuses to assign a ticket to a disabled technician (400), and hides them from the list', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const admin = await signUpAdmin();
    const tech = await signUpAs('technician', 'tech@example.com');
    await pool.query('UPDATE users SET disabled_at = NOW() WHERE id = $1', [tech.user.id]);
    const { ticket } = await createTicket(alice.token);

    expect((await patchTicket(admin.token, ticket.id, { assigned_to: tech.user.id })).status).toBe(400);
    const list = await request(app).get('/api/tickets/assignees').set(bearer(admin.token));
    expect(list.body.assignees.map((a) => a.id)).not.toContain(tech.user.id);
  });
});

describe('editing comments (every earlier version is kept and visible)', () => {
  const postComment = (token, ticketId, body) =>
    request(app).post(`/api/tickets/${ticketId}/comments`).set(bearer(token)).send(body);
  const editComment = (token, ticketId, commentId, text) =>
    request(app).patch(`/api/tickets/${ticketId}/comments/${commentId}`).set(bearer(token)).send({ body: text });

  it('lets the author edit, and keeps each old version in order', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const tech = await signUpAs('technician', 'tech@example.com');
    const { ticket } = await createTicket(alice.token);
    const { comment } = (await postComment(alice.token, ticket.id, { body: 'Version 1' })).body;
    expect(comment).toMatchObject({ edited_at: null, edits: [] });

    await editComment(alice.token, ticket.id, comment.id, 'Version 2');
    const res = await editComment(alice.token, ticket.id, comment.id, 'Version 3');
    expect(res.status).toBe(200);
    expect(res.body.comment.body).toBe('Version 3');
    expect(res.body.comment.edited_at).not.toBeNull();
    expect(res.body.comment.edits.map((e) => e.old_body)).toEqual(['Version 1', 'Version 2']);

    // Anyone who can see the comment can see what it used to say
    const asTech = await request(app).get(`/api/tickets/${ticket.id}/comments`).set(bearer(tech.token));
    expect(asTech.body.comments[0].edits).toHaveLength(2);
  });

  it("does not let anyone edit someone else's comment, not even an owner (403)", async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const owner = await signUpOwner();
    const { ticket } = await createTicket(alice.token);
    const { comment } = (await postComment(alice.token, ticket.id, { body: 'Mine' })).body;
    expect((await editComment(owner.token, ticket.id, comment.id, 'Changed')).status).toBe(403);
  });

  it('treats an internal note as not found for a regular user (404)', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const tech = await signUpAs('technician', 'tech@example.com');
    const { ticket } = await createTicket(alice.token);
    const { comment } = (await postComment(tech.token, ticket.id, { body: 'secret', is_internal: true })).body;
    expect((await editComment(alice.token, ticket.id, comment.id, 'x')).status).toBe(404);
  });

  it('saves no version when the text is unchanged, and rejects empty text (400)', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const { ticket } = await createTicket(alice.token);
    const { comment } = (await postComment(alice.token, ticket.id, { body: 'Same' })).body;

    const same = await editComment(alice.token, ticket.id, comment.id, 'Same');
    expect(same.body.comment.edits).toEqual([]);
    expect((await editComment(alice.token, ticket.id, comment.id, '   ')).status).toBe(400);
  });

  it('returns 404 for a comment that belongs to a different ticket', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const { ticket: first } = await createTicket(alice.token);
    const { ticket: second } = await createTicket(alice.token);
    const { comment } = (await postComment(alice.token, first.id, { body: 'hi' })).body;
    expect((await editComment(alice.token, second.id, comment.id, 'moved?')).status).toBe(404);
  });
});

describe('disabling accounts', () => {
  const setDisabled = (token, id, disabled) =>
    request(app).patch(`/api/users/${id}/disabled`).set(bearer(token)).send({ disabled });

  it('locks the person out at once: login refused, sessions ended, old token refused', async () => {
    const admin = await signUpAdmin();
    const bob = await signUp({ email: 'bob@example.com' });

    const res = await setDisabled(admin.token, bob.user.id, true);
    expect(res.status).toBe(200);
    expect(res.body.user.disabled_at).not.toBeNull();

    // Their still-unexpired access token no longer works
    expect((await request(app).get('/api/tickets').set(bearer(bob.token))).status).toBe(401);
    // Their "stay logged in" cookie no longer works
    expect((await bob.agent.post('/api/auth/refresh')).status).toBe(401);
    // They can't log in again (after a CORRECT password, they're told why)
    const login = await request(app).post('/api/auth/login').send({ email: 'bob@example.com', password: 'password123' });
    expect(login.status).toBe(403);
  });

  it('keeps their tickets, and re-enabling lets them log in again', async () => {
    const admin = await signUpAdmin();
    const bob = await signUp({ email: 'bob@example.com' });
    await createTicket(bob.token);

    await setDisabled(admin.token, bob.user.id, true);
    expect((await request(app).get('/api/tickets').set(bearer(admin.token))).body.tickets).toHaveLength(1);

    await setDisabled(admin.token, bob.user.id, false);
    const login = await request(app).post('/api/auth/login').send({ email: 'bob@example.com', password: 'password123' });
    expect(login.status).toBe(200);
  });

  it('follows the ranking rule: admins cannot disable admins or owners; owners can disable admins', async () => {
    const admin = await signUpAdmin();
    const otherAdmin = await signUpAdmin({ email: 'admin2@example.com' });
    const owner = await signUpOwner();

    expect((await setDisabled(admin.token, otherAdmin.user.id, true)).status).toBe(403);
    expect((await setDisabled(admin.token, owner.user.id, true)).status).toBe(403);
    expect((await setDisabled(owner.token, otherAdmin.user.id, true)).status).toBe(200);
  });

  it('cannot disable yourself (400), needs a true/false value (400), and is admin-only (403)', async () => {
    const admin = await signUpAdmin();
    const bob = await signUp({ email: 'bob@example.com' });
    expect((await setDisabled(admin.token, admin.user.id, true)).status).toBe(400);
    expect((await setDisabled(admin.token, bob.user.id, 'yes')).status).toBe(400);
    expect((await setDisabled(bob.token, admin.user.id, true)).status).toBe(403);
  });
});

describe('account history (role changes, disables, enables)', () => {
  it('logs who did what to whom, newest first, for admins and owners', async () => {
    const owner = await signUpOwner({ name: 'Olivia' });
    const bob = await signUp({ email: 'bob@example.com', name: 'Bob' });

    await request(app).patch(`/api/users/${bob.user.id}/role`).set(bearer(owner.token)).send({ role: 'technician' });
    await request(app).patch(`/api/users/${bob.user.id}/disabled`).set(bearer(owner.token)).send({ disabled: true });

    const res = await request(app).get('/api/users/history').set(bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.history.map(({ action, old_value, new_value, user_name, actor_name }) => ({ action, old_value, new_value, user_name, actor_name }))).toEqual([
      { action: 'disabled', old_value: null, new_value: null, user_name: 'Bob', actor_name: 'Olivia' },
      { action: 'role_changed', old_value: 'user', new_value: 'technician', user_name: 'Bob', actor_name: 'Olivia' },
    ]);
  });

  it("filters to one person's history with ?user_id=", async () => {
    const owner = await signUpOwner();
    const bob = await signUp({ email: 'bob@example.com' });
    const carol = await signUp({ email: 'carol@example.com' });
    await request(app).patch(`/api/users/${bob.user.id}/role`).set(bearer(owner.token)).send({ role: 'technician' });
    await request(app).patch(`/api/users/${carol.user.id}/role`).set(bearer(owner.token)).send({ role: 'technician' });

    const res = await request(app).get(`/api/users/history?user_id=${carol.user.id}`).set(bearer(owner.token));
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].user_id).toBe(carol.user.id);
    expect((await request(app).get('/api/users/history?user_id=abc').set(bearer(owner.token))).status).toBe(400);
  });

  it('does not log a "change" to the same role', async () => {
    const admin = await signUpAdmin();
    const bob = await signUp({ email: 'bob@example.com' });
    await request(app).patch(`/api/users/${bob.user.id}/role`).set(bearer(admin.token)).send({ role: 'user' });
    const res = await request(app).get('/api/users/history').set(bearer(admin.token));
    expect(res.body.history).toEqual([]);
  });

  it('is hidden from technicians and users (403)', async () => {
    const tech = await signUpAs('technician', 'tech@example.com');
    expect((await request(app).get('/api/users/history').set(bearer(tech.token))).status).toBe(403);
  });
});
