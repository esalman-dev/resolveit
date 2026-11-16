// Tests for roles: who can manage users, and role changes taking effect immediately.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, signUpAdmin, signUpOwner, bearer } from './helpers.js';

describe('GET /api/users (admins only)', () => {
  it('requires login (401)', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('refuses regular users (403)', async () => {
    const { token } = await signUp();
    const res = await request(app).get('/api/users').set(bearer(token));
    expect(res.status).toBe(403);
  });

  it('refuses technicians (403)', async () => {
    const { token, user } = await signUp();
    await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [user.id]);
    const res = await request(app).get('/api/users').set(bearer(token));
    expect(res.status).toBe(403);
  });

  it('lists users for an admin, without password hashes', async () => {
    const { token } = await signUpAdmin();
    await signUp({ email: 'bob@example.com' });
    const res = await request(app).get('/api/users').set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users[1]).toMatchObject({ email: 'bob@example.com', has_password: true, has_google: false });
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
  });
});

describe('PATCH /api/users/:id/role', () => {
  it('lets an admin change someone else\'s role', async () => {
    const { token } = await signUpAdmin();
    const { user: bob } = await signUp({ email: 'bob@example.com' });
    const res = await request(app)
      .patch(`/api/users/${bob.id}/role`)
      .set(bearer(token))
      .send({ role: 'technician' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('technician');
  });

  it('does not let an admin change their own role (so one admin always remains)', async () => {
    const { token, user } = await signUpAdmin();
    const res = await request(app).patch(`/api/users/${user.id}/role`).set(bearer(token)).send({ role: 'user' });
    expect(res.status).toBe(400);
  });

  it.each([
    ['an unknown role', 'superuser', 2, 400],
    ['a non-numeric id', 'user', 'abc', 400],
    ['a user that does not exist', 'user', 99999, 404],
  ])('rejects %s', async (_label, role, id, expected) => {
    const { token } = await signUpAdmin();
    await signUp({ email: 'bob@example.com' }); // id 2
    const res = await request(app).patch(`/api/users/${id}/role`).set(bearer(token)).send({ role });
    expect(res.status).toBe(expected);
  });

  it('does not let a non-admin promote themselves (403)', async () => {
    const { token, user } = await signUp();
    const res = await request(app).patch(`/api/users/${user.id}/role`).set(bearer(token)).send({ role: 'admin' });
    expect(res.status).toBe(403);
  });
});

describe('role changes take effect immediately', () => {
  it('a demoted admin loses access at once, even with a token that still says "admin"', async () => {
    const { token: aliceToken } = await signUpOwner({ email: 'alice@example.com' });
    const { token: bobToken, user: bob } = await signUpAdmin({ email: 'bob@example.com', name: 'Bob' });

    // Alice (an owner) demotes Bob. Bob's token was issued while he was an admin and is still valid.
    await request(app).patch(`/api/users/${bob.id}/role`).set(bearer(aliceToken)).send({ role: 'user' });

    const res = await request(app).get('/api/users').set(bearer(bobToken));
    expect(res.status).toBe(403);
  });

  it('a promoted user gains access at once, without logging in again', async () => {
    const { token, user } = await signUp(); // token says "user"
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    const res = await request(app).get('/api/users').set(bearer(token));
    expect(res.status).toBe(200);
  });

  it('a deleted account loses access at once (401)', async () => {
    const { token, user } = await signUpAdmin();
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    const res = await request(app).get('/api/users').set(bearer(token));
    expect(res.status).toBe(401);
  });
});
