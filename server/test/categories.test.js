// Tests for categories: everyone can read the list; only admins and owners can add, rename,
// archive or restore.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, signUpAdmin, bearer } from './helpers.js';

/** Adds a category straight into the database and returns its id. setup.js empties the table before each test. */
async function addCategory(name, active = true) {
  const result = await pool.query('INSERT INTO categories (name, active) VALUES ($1, $2) RETURNING id', [name, active]);
  return result.rows[0].id;
}

describe('GET /api/categories', () => {
  it('requires login (401)', async () => {
    expect((await request(app).get('/api/categories')).status).toBe(401);
  });

  it('lists active categories A to Z, ignoring capital letters', async () => {
    await addCategory('printer');
    await addCategory('Network');
    await addCategory('Archived one', false);
    const { token } = await signUp();

    const res = await request(app).get('/api/categories').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c) => c.name)).toEqual(['Network', 'printer']);
  });

  it('includes archived ones with ?all=true, for admins only', async () => {
    await addCategory('Network');
    await addCategory('Archived one', false);
    const admin = await signUpAdmin();
    const user = await signUp({ email: 'user@example.com' });

    const asAdmin = await request(app).get('/api/categories?all=true').set(bearer(admin.token));
    expect(asAdmin.body.categories).toHaveLength(2);

    const asUser = await request(app).get('/api/categories?all=true').set(bearer(user.token));
    expect(asUser.body.categories).toHaveLength(1); // the flag is ignored for non-admins
  });
});

describe('POST /api/categories', () => {
  it('lets an admin add a category', async () => {
    const { token } = await signUpAdmin();
    const res = await request(app).post('/api/categories').set(bearer(token)).send({ name: '  VPN  ' });
    expect(res.status).toBe(201);
    expect(res.body.category).toMatchObject({ name: 'VPN', active: true });
  });

  it.each(['user', 'technician'])('refuses a %s (403)', async (role) => {
    const { token, user } = await signUp();
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, user.id]);
    const res = await request(app).post('/api/categories').set(bearer(token)).send({ name: 'VPN' });
    expect(res.status).toBe(403);
  });

  it('refuses a duplicate name, even with different capital letters (409)', async () => {
    await addCategory('Network');
    const { token } = await signUpAdmin();
    const res = await request(app).post('/api/categories').set(bearer(token)).send({ name: 'NETWORK' });
    expect(res.status).toBe(409);
  });

  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '   ' }],
    ['a name that is too long', { name: 'x'.repeat(51) }],
    ['a name that is not text', { name: 42 }],
  ])('rejects %s (400)', async (_label, body) => {
    const { token } = await signUpAdmin();
    expect((await request(app).post('/api/categories').set(bearer(token)).send(body)).status).toBe(400);
  });
});

describe('PATCH /api/categories/:id', () => {
  it('renames, archives and restores a category', async () => {
    const id = await addCategory('Wifi');
    const { token } = await signUpAdmin();
    const patch = (body) => request(app).patch(`/api/categories/${id}`).set(bearer(token)).send(body);

    expect((await patch({ name: 'Wi-Fi' })).body.category.name).toBe('Wi-Fi');
    expect((await patch({ active: false })).body.category.active).toBe(false);
    expect((await patch({ active: true })).body.category.active).toBe(true);
  });

  it('keeps an archived category on tickets that already use it', async () => {
    const id = await addCategory('Fax machines');
    const user = await signUp();
    const created = await request(app)
      .post('/api/tickets')
      .set(bearer(user.token))
      .send({ title: 'Fax broken', description: 'It beeps', category_id: id });

    const { token } = await signUpAdmin();
    await request(app).patch(`/api/categories/${id}`).set(bearer(token)).send({ active: false });

    const ticket = await request(app).get(`/api/tickets/${created.body.ticket.id}`).set(bearer(user.token));
    expect(ticket.body.ticket.category_name).toBe('Fax machines');
  });

  it('refuses renaming to an existing name (409)', async () => {
    await addCategory('Network');
    const id = await addCategory('Wifi');
    const { token } = await signUpAdmin();
    const res = await request(app).patch(`/api/categories/${id}`).set(bearer(token)).send({ name: 'network' });
    expect(res.status).toBe(409);
  });

  it.each([
    ['an empty update', {}],
    ['active that is not true/false', { active: 'no' }],
  ])('rejects %s (400)', async (_label, body) => {
    const id = await addCategory('Network');
    const { token } = await signUpAdmin();
    expect((await request(app).patch(`/api/categories/${id}`).set(bearer(token)).send(body)).status).toBe(400);
  });

  it('returns 400 for a bad id and 404 for a missing category', async () => {
    const { token } = await signUpAdmin();
    const send = (id) => request(app).patch(`/api/categories/${id}`).set(bearer(token)).send({ active: false });
    expect((await send('abc')).status).toBe(400);
    expect((await send(99999)).status).toBe(404);
  });

  it('refuses non-admins (403)', async () => {
    const id = await addCategory('Network');
    const { token } = await signUp();
    const res = await request(app).patch(`/api/categories/${id}`).set(bearer(token)).send({ active: false });
    expect(res.status).toBe(403);
  });
});
