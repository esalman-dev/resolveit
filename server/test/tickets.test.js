// Tickets: creating, listing, viewing, assigning and updating, and who is allowed to do each
import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, signUpAdmin, bearer } from './helpers.js';

// Sign up, then set the role directly in the database
async function signUpAs(role, email) {
  const account = await signUp({ name: email.split('@')[0], email });
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, account.user.id]);
  return account;
}

// Open a ticket as the given token holder and return it
async function createTicket(token, fields = {}) {
  const res = await request(app)
    .post('/api/tickets')
    .set(bearer(token))
    .send({ title: 'Wi-Fi is down', description: 'Laptop will not connect', ...fields });
  if (res.status !== 201) throw new Error(`createTicket failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.ticket;
}

// Add a category straight into the database and return its id (setup.js empties the table before each test)
async function addCategory(name, active = true) {
  const result = await pool.query('INSERT INTO categories (name, active) VALUES ($1, $2) RETURNING id', [name, active]);
  return result.rows[0].id;
}

describe('POST /api/tickets', () => {
  it('requires login (401)', async () => {
    const res = await request(app).post('/api/tickets').send({ title: 'x', description: 'y' });
    expect(res.status).toBe(401);
  });

  it('creates an open, unassigned ticket owned by the caller', async () => {
    const { token, user } = await signUp();
    const printer = await addCategory('Printer');
    const res = await request(app)
      .post('/api/tickets')
      .set(bearer(token))
      .send({ title: '  Printer jam  ', description: 'Paper stuck', priority: 'high', category_id: printer });

    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({
      title: 'Printer jam', // spaces trimmed
      status: 'open',
      priority: 'high',
      category_id: printer,
      category_name: 'Printer',
      created_by: user.id,
      created_by_name: 'Test User',
      assigned_to: null,
      resolved_at: null,
    });
  });

  it('defaults priority to medium', async () => {
    const { token } = await signUp();
    const ticket = await createTicket(token);
    expect(ticket.priority).toBe('medium');
  });

  it('ignores created_by, status and assigned_to sent in the body', async () => {
    const { token, user } = await signUp();
    const { user: other } = await signUp({ email: 'other@example.com' });
    const ticket = await createTicket(token, { created_by: other.id, status: 'resolved', assigned_to: other.id });
    expect(ticket).toMatchObject({ created_by: user.id, status: 'open', assigned_to: null });
  });

  it.each([
    ['a missing title', { title: '' }],
    ['a blank description', { description: '   ' }],
    ['an unknown priority', { priority: 'critical' }],
    ['a title that is too long', { title: 'x'.repeat(201) }],
    ['a description that is too long', { description: 'x'.repeat(5001) }],
    ['a category that does not exist', { category_id: 99999 }],
  ])('rejects %s (400)', async (_label, fields) => {
    const { token } = await signUp();
    const res = await request(app)
      .post('/api/tickets')
      .set(bearer(token))
      .send({ title: 'Wi-Fi is down', description: 'Laptop will not connect', ...fields });
    expect(res.status).toBe(400);
  });

  it('rejects an archived category (400)', async () => {
    const { token } = await signUp();
    const archived = await addCategory('Old stuff', false);
    const res = await request(app)
      .post('/api/tickets')
      .set(bearer(token))
      .send({ title: 'Wi-Fi is down', description: 'Laptop will not connect', category_id: archived });
    expect(res.status).toBe(400);
  });

  it('rejects a request with no body (400, not a crash)', async () => {
    const { token } = await signUp();
    const res = await request(app).post('/api/tickets').set(bearer(token));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tickets', () => {
  it('shows a regular user only their own tickets', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    await createTicket(alice.token, { title: 'Alice ticket' });
    await createTicket(bob.token, { title: 'Bob ticket' });

    const res = await request(app).get('/api/tickets').set(bearer(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t) => t.title)).toEqual(['Alice ticket']);
  });

  it.each(['technician', 'admin'])('shows a %s every ticket, newest first', async (role) => {
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    await createTicket(alice.token, { title: 'First' });
    await createTicket(bob.token, { title: 'Second' });
    const staff = await signUpAs(role, 'staff@example.com');

    const res = await request(app).get('/api/tickets').set(bearer(staff.token));
    expect(res.body.tickets.map((t) => t.title)).toEqual(['Second', 'First']);
  });

  it('uses the current role from the database, not the one in the token', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    await createTicket(alice.token);
    const bob = await signUp({ email: 'bob@example.com' }); // token says "user"
    await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [bob.user.id]);

    const res = await request(app).get('/api/tickets').set(bearer(bob.token));
    expect(res.body.tickets).toHaveLength(1); // sees Alice's ticket right away
  });
});

describe('GET /api/tickets/:id', () => {
  it('lets the creator view their ticket', async () => {
    const { token } = await signUp();
    const ticket = await createTicket(token);
    const res = await request(app).get(`/api/tickets/${ticket.id}`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.ticket.id).toBe(ticket.id);
  });

  it("gives another user a 404 for someone else's ticket (doesn't reveal it exists)", async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    const ticket = await createTicket(alice.token);
    const res = await request(app).get(`/api/tickets/${ticket.id}`).set(bearer(bob.token));
    expect(res.status).toBe(404);
  });

  it('lets a technician view any ticket', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const tech = await signUpAs('technician', 'tech@example.com');
    const ticket = await createTicket(alice.token);
    const res = await request(app).get(`/api/tickets/${ticket.id}`).set(bearer(tech.token));
    expect(res.status).toBe(200);
  });

  it.each([
    ['a non-numeric id', 'abc', 400],
    ['a ticket that does not exist', 99999, 404],
  ])('rejects %s', async (_label, id, expected) => {
    const { token } = await signUpAdmin();
    const res = await request(app).get(`/api/tickets/${id}`).set(bearer(token));
    expect(res.status).toBe(expected);
  });
});

describe('GET /api/tickets/assignees', () => {
  it('lists technicians and admins only, for staff', async () => {
    await signUp({ email: 'user@example.com' });
    await signUpAs('technician', 'tech@example.com');
    const admin = await signUpAdmin();

    const res = await request(app).get('/api/tickets/assignees').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.assignees.map((a) => a.role).sort()).toEqual(['admin', 'technician']);
    expect(JSON.stringify(res.body)).not.toContain('email'); // only id, name, role
  });

  it('refuses regular users (403)', async () => {
    const { token } = await signUp();
    const res = await request(app).get('/api/tickets/assignees').set(bearer(token));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/tickets/:id', () => {
  it('lets a technician change status, priority and category', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const tech = await signUpAs('technician', 'tech@example.com');
    const ticket = await createTicket(alice.token);
    const network = await addCategory('Network');

    const res = await request(app)
      .patch(`/api/tickets/${ticket.id}`)
      .set(bearer(tech.token))
      .send({ status: 'in_progress', priority: 'urgent', category_id: network });

    expect(res.status).toBe(200);
    expect(res.body.ticket).toMatchObject({
      status: 'in_progress',
      priority: 'urgent',
      category_id: network,
      category_name: 'Network',
    });
    expect(new Date(res.body.ticket.updated_at) >= new Date(ticket.updated_at)).toBe(true);
  });

  it('assigns and unassigns a ticket', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const tech = await signUpAs('technician', 'tech@example.com');
    const ticket = await createTicket(alice.token);

    const assigned = await request(app)
      .patch(`/api/tickets/${ticket.id}`)
      .set(bearer(tech.token))
      .send({ assigned_to: tech.user.id });
    expect(assigned.body.ticket).toMatchObject({ assigned_to: tech.user.id, assigned_to_name: 'tech' });

    const unassigned = await request(app)
      .patch(`/api/tickets/${ticket.id}`)
      .set(bearer(tech.token))
      .send({ assigned_to: null });
    expect(unassigned.body.ticket.assigned_to).toBeNull();
  });

  it('refuses to assign a ticket to a regular user (400)', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const admin = await signUpAdmin();
    const ticket = await createTicket(alice.token);
    const res = await request(app)
      .patch(`/api/tickets/${ticket.id}`)
      .set(bearer(admin.token))
      .send({ assigned_to: alice.user.id });
    expect(res.status).toBe(400);
  });

  it('sets resolved_at when resolved, and clears it when reopened', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const admin = await signUpAdmin();
    const ticket = await createTicket(alice.token);
    const patch = (body) => request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(admin.token)).send(body);

    const resolved = await patch({ status: 'resolved' });
    expect(resolved.body.ticket.resolved_at).not.toBeNull();

    const reopened = await patch({ status: 'open' });
    expect(reopened.body.ticket.resolved_at).toBeNull();
  });

  it('does not let a regular user update their own ticket (403)', async () => {
    const { token } = await signUp();
    const ticket = await createTicket(token);
    const res = await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(token)).send({ status: 'resolved' });
    expect(res.status).toBe(403);
  });

  it.each([
    ['an unknown status', { status: 'closed' }, 400],
    ['an unknown priority', { priority: 'critical' }, 400],
    ['an empty update', {}, 400],
    ['an assignee that does not exist', { assigned_to: 99999 }, 400],
  ])('rejects %s', async (_label, body, expected) => {
    const alice = await signUp({ email: 'alice@example.com' });
    const admin = await signUpAdmin();
    const ticket = await createTicket(alice.token);
    const res = await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(admin.token)).send(body);
    expect(res.status).toBe(expected);
  });

  it('returns 404 for a ticket that does not exist', async () => {
    const { token } = await signUpAdmin();
    const res = await request(app).patch('/api/tickets/99999').set(bearer(token)).send({ status: 'open' });
    expect(res.status).toBe(404);
  });

  it('clears the category with category_id: null', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const admin = await signUpAdmin();
    const ticket = await createTicket(alice.token, { category_id: await addCategory('Network') });
    const res = await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(admin.token)).send({ category_id: null });
    expect(res.body.ticket).toMatchObject({ category_id: null, category_name: null });
  });
});

describe('ticket comments', () => {
  // Shortcuts: post a comment / read the comments as a given token holder
  const postComment = (token, ticketId, body) =>
    request(app).post(`/api/tickets/${ticketId}/comments`).set(bearer(token)).send(body);
  const getComments = (token, ticketId) =>
    request(app).get(`/api/tickets/${ticketId}/comments`).set(bearer(token));

  it('lets the creator and a technician talk on a ticket, oldest first', async () => {
    const alice = await signUp({ email: 'alice@example.com', name: 'Alice' });
    const tech = await signUpAs('technician', 'tech@example.com');
    const ticket = await createTicket(alice.token);

    const first = await postComment(tech.token, ticket.id, { body: 'Did you try restarting?' });
    expect(first.status).toBe(201);
    expect(first.body.comment).toMatchObject({ author_id: tech.user.id, author_role: 'technician', is_internal: false });
    await postComment(alice.token, ticket.id, { body: 'Yes, still broken' });

    const res = await getComments(alice.token, ticket.id);
    expect(res.status).toBe(200);
    expect(res.body.comments.map((c) => c.body)).toEqual(['Did you try restarting?', 'Yes, still broken']);
    expect(res.body.comments[1].author_name).toBe('Alice');
  });

  it('hides internal notes from the user, but shows them to staff', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const tech = await signUpAs('technician', 'tech@example.com');
    const ticket = await createTicket(alice.token);
    await postComment(tech.token, ticket.id, { body: 'Public reply' });
    const note = await postComment(tech.token, ticket.id, { body: 'Laptop is out of warranty', is_internal: true });
    expect(note.body.comment.is_internal).toBe(true);

    const asUser = await getComments(alice.token, ticket.id);
    expect(asUser.body.comments.map((c) => c.body)).toEqual(['Public reply']);

    const asStaff = await getComments(tech.token, ticket.id);
    expect(asStaff.body.comments).toHaveLength(2);
  });

  it('does not let a regular user write an internal note (403)', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const ticket = await createTicket(alice.token);
    const res = await postComment(alice.token, ticket.id, { body: 'secret', is_internal: true });
    expect(res.status).toBe(403);
  });

  it("gives another user a 404 for comments on someone else's ticket (read and write)", async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    const ticket = await createTicket(alice.token);

    expect((await getComments(bob.token, ticket.id)).status).toBe(404);
    expect((await postComment(bob.token, ticket.id, { body: 'hi' })).status).toBe(404);
  });

  it('takes the author from the login, not the request body', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    const ticket = await createTicket(alice.token);
    const res = await postComment(alice.token, ticket.id, { body: 'hi', author_id: bob.user.id });
    expect(res.body.comment.author_id).toBe(alice.user.id);
  });

  it("counts a comment as activity: the ticket's updated_at moves forward", async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const ticket = await createTicket(alice.token);
    await pool.query("UPDATE tickets SET updated_at = NOW() - INTERVAL '1 day' WHERE id = $1", [ticket.id]);

    await postComment(alice.token, ticket.id, { body: 'Any update?' });
    const after = await pool.query(
      "SELECT updated_at > NOW() - INTERVAL '1 minute' AS recent FROM tickets WHERE id = $1",
      [ticket.id]
    );
    expect(after.rows[0].recent).toBe(true);
  });

  it.each([
    ['an empty comment', { body: '   ' }],
    ['a comment that is too long', { body: 'x'.repeat(5001) }],
  ])('rejects %s (400)', async (_label, body) => {
    const alice = await signUp({ email: 'alice@example.com' });
    const ticket = await createTicket(alice.token);
    expect((await postComment(alice.token, ticket.id, body)).status).toBe(400);
  });

  it('returns 400 for a bad ticket id and 404 for a missing ticket', async () => {
    const { token } = await signUpAdmin();
    expect((await getComments(token, 'abc')).status).toBe(400);
    expect((await postComment(token, 99999, { body: 'hi' })).status).toBe(404);
  });

  it('deletes comments along with their ticket (ON DELETE CASCADE)', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const ticket = await createTicket(alice.token);
    await postComment(alice.token, ticket.id, { body: 'hi' });
    await pool.query('DELETE FROM tickets WHERE id = $1', [ticket.id]);
    const left = await pool.query('SELECT COUNT(*)::int AS n FROM ticket_comments');
    expect(left.rows[0].n).toBe(0);
  });
});
