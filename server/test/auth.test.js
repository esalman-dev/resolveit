// Sign-up, password login, and the access token
import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer, refreshCookie, decodeJwt } from './helpers.js';

describe('POST /api/auth/register', () => {
  it('creates a user with a lowercased email and returns a token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'Ada@Example.COM', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: 1, name: 'Ada', email: 'ada@example.com', role: 'user' });
    expect(res.body.token).toBeTypeOf('string');
  });

  it('never sends the password hash back', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
  });

  it('stores a bcrypt hash, not the password', async () => {
    await signUp({ password: 'password123' });
    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/); // bcrypt, cost 12
    expect(rows[0].password_hash).not.toContain('password123');
  });

  it('ignores a role in the request (no signing yourself up as admin)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Sneaky', email: 'sneaky@example.com', password: 'password123', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
  });

  it('rejects a duplicate email, even with different capitals (409)', async () => {
    await signUp({ email: 'ada@example.com' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada 2', email: 'ADA@example.com', password: 'password123' });
    expect(res.status).toBe(409);
  });

  it.each([
    ['missing name', { email: 'a@example.com', password: 'password123' }],
    ['invalid email', { name: 'A', email: 'not-an-email', password: 'password123' }],
    ['short password', { name: 'A', email: 'a@example.com', password: 'short' }],
  ])('rejects %s (400)', async (_label, body) => {
    const res = await request(app).post('/api/auth/register').send(body);
    expect(res.status).toBe(400);
  });

  it('sets the refresh cookie as httpOnly and SameSite=Strict', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('resolveit_refresh='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/auth');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with the right password', async () => {
    await signUp({ email: 'ada@example.com', password: 'password123' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('ada@example.com');
    expect(refreshCookie(res)).toBeDefined();
  });

  it('gives the SAME error for a wrong password and an unknown email (no account fishing)', async () => {
    await signUp({ email: 'ada@example.com', password: 'password123' });
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error).toBe(unknownEmail.body.error);
  });

  it('refuses password login for a Google-only account (no password set)', async () => {
    await pool.query("INSERT INTO users (name, email, google_id) VALUES ('G', 'g@example.com', 'google-1')");
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'g@example.com', password: 'anything123' });
    expect(res.status).toBe(401);
  });
});

describe('access token and GET /api/auth/me', () => {
  it('contains only the user id and role, and lasts 15 minutes', async () => {
    const { token } = await signUp();
    const payload = decodeJwt(token);
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'role', 'sub']);
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  it('returns the logged-in user with a valid token', async () => {
    const { token } = await signUp({ email: 'ada@example.com' });
    const res = await request(app).get('/api/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('ada@example.com');
  });

  it('rejects a missing token (401)', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a token with one character changed (401)', async () => {
    const { token } = await signUp();
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const res = await request(app).get('/api/auth/me').set(bearer(tampered));
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret (401)', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const forged = jwt.sign({ sub: 1, role: 'admin' }, 'attackers-guess', { expiresIn: '15m' });
    const res = await request(app).get('/api/auth/me').set(bearer(forged));
    expect(res.status).toBe(401);
  });
});
