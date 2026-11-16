// Tests for login hardening: equal timing for unknown emails, input length limits, the pinned
// JWT algorithm, and 401 from /me for accounts that no longer work.

import { describe, it, expect, vi, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { app, pool, request, signUp, bearer } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('login timing: unknown emails cost as much as wrong passwords', () => {
  it('still runs bcrypt when the email does not exist', async () => {
    // A spy watches a function and counts its calls, without changing what it does.
    const compare = vi.spyOn(bcrypt, 'compare');
    const res = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'password123' });
    expect(res.status).toBe(401);
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    await signUp({ email: 'real@example.com' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'password123' });
    const wrong = await request(app).post('/api/auth/login').send({ email: 'real@example.com', password: 'wrong-password' });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('length limits on sign-up', () => {
  const register = (fields) =>
    request(app).post('/api/auth/register').send({ name: 'Ada', email: 'ada@example.com', password: 'password123', ...fields });

  it('rejects a password over 72 bytes (bcrypt would silently ignore the rest)', async () => {
    expect((await register({ password: 'a'.repeat(73) })).status).toBe(400);
  });

  it('counts BYTES, not letters: 19 emoji = 76 bytes is too long', async () => {
    expect((await register({ password: '🔒'.repeat(19) })).status).toBe(400);
  });

  it('accepts exactly 72 bytes', async () => {
    expect((await register({ password: 'a'.repeat(72) })).status).toBe(201);
  });

  it('rejects a name over 100 characters', async () => {
    expect((await register({ name: 'x'.repeat(101) })).status).toBe(400);
  });

  it('rejects fields that are not text (e.g. a number for the password)', async () => {
    expect((await register({ password: 12345678 })).status).toBe(400);
  });
});

describe('the JWT algorithm is pinned to HS256', () => {
  it('refuses a token signed with a different algorithm, even using our secret', async () => {
    const { user } = await signUp();
    const hs512 = jwt.sign({ sub: user.id, role: 'user' }, 'test-only-secret', { algorithm: 'HS512' });
    const res = await request(app).get('/api/auth/me').set(bearer(hs512));
    expect(res.status).toBe(401);
  });
});

describe('/me answers 401 (not 404) for an account that no longer works', () => {
  it('deleted account -> 401', async () => {
    const { token, user } = await signUp();
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    expect((await request(app).get('/api/auth/me').set(bearer(token))).status).toBe(401);
  });

  it('disabled account -> 401', async () => {
    const { token, user } = await signUp();
    await pool.query('UPDATE users SET disabled_at = NOW() WHERE id = $1', [user.id]);
    expect((await request(app).get('/api/auth/me').set(bearer(token))).status).toBe(401);
  });
});
