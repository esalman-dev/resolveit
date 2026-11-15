// Staying logged in: refresh tokens, rotation, reuse detection, logout, 30/90-day limits
import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, refreshCookie } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Expiry of the newest refresh token in the database, as "days from now"
async function newestExpiryInDays() {
  const { rows } = await pool.query('SELECT expires_at FROM refresh_tokens ORDER BY id DESC LIMIT 1');
  return (rows[0].expires_at.getTime() - Date.now()) / DAY_MS;
}

describe('POST /api/auth/refresh', () => {
  it('restores the session from the cookie (reopening the page)', async () => {
    const { agent } = await signUp({ email: 'ada@example.com' });
    const res = await agent.post('/api/auth/refresh');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('ada@example.com');
    expect(res.body.token).toBeTypeOf('string');
  });

  it('fails without a cookie (401)', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('stores only a hash of the refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
    const raw = refreshCookie(res).split('=')[1];
    const { rows } = await pool.query('SELECT token_hash FROM refresh_tokens');
    expect(rows[0].token_hash).not.toBe(raw);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 in hex
  });

  it('rotates: every refresh issues a new cookie', async () => {
    const first = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
    const cookieA = refreshCookie(first);

    const second = await request(app).post('/api/auth/refresh').set('Cookie', cookieA);
    expect(second.status).toBe(200);
    expect(refreshCookie(second)).not.toBe(cookieA);
  });

  it('detects reuse of an old token and logs out ALL sessions', async () => {
    const first = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
    const cookieA = refreshCookie(first);
    const second = await request(app).post('/api/auth/refresh').set('Cookie', cookieA);
    const cookieB = refreshCookie(second);

    // An attacker replays the old cookie A
    const replay = await request(app).post('/api/auth/refresh').set('Cookie', cookieA);
    expect(replay.status).toBe(401);

    // The real user's newer cookie B was revoked too
    const victim = await request(app).post('/api/auth/refresh').set('Cookie', cookieB);
    expect(victim.status).toBe(401);
  });

  it('reads the role fresh from the database', async () => {
    const { agent, user } = await signUp();
    await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [user.id]);
    const res = await agent.post('/api/auth/refresh');
    expect(res.body.user.role).toBe('technician');
  });
});

describe('session length limits', () => {
  it('a new login stays valid for 30 days', async () => {
    await signUp();
    expect(await newestExpiryInDays()).toBeCloseTo(30, 1);
  });

  it('using the app pushes expiry back to 30 days from now', async () => {
    const { agent } = await signUp();
    await pool.query("UPDATE refresh_tokens SET expires_at = NOW() + INTERVAL '2 days'"); // nearly expired
    const res = await agent.post('/api/auth/refresh');
    expect(res.status).toBe(200);
    expect(await newestExpiryInDays()).toBeCloseTo(30, 1);
  });

  it('never extends past 90 days after the ORIGINAL login', async () => {
    const { agent } = await signUp();
    // Pretend they logged in 80 days ago and have used the app ever since
    await pool.query("UPDATE refresh_tokens SET session_started_at = NOW() - INTERVAL '80 days'");
    const res = await agent.post('/api/auth/refresh');
    expect(res.status).toBe(200);
    expect(await newestExpiryInDays()).toBeCloseTo(10, 1); // 90 - 80, not 30
  });

  it('keeps the original login time across rotations', async () => {
    const { agent } = await signUp();
    await pool.query("UPDATE refresh_tokens SET session_started_at = NOW() - INTERVAL '50 days'");
    await agent.post('/api/auth/refresh');
    await agent.post('/api/auth/refresh');
    const { rows } = await pool.query('SELECT session_started_at FROM refresh_tokens ORDER BY id DESC LIMIT 1');
    const daysAgo = (Date.now() - rows[0].session_started_at.getTime()) / DAY_MS;
    expect(daysAgo).toBeCloseTo(50, 1);
  });

  it('rejects an expired session (401)', async () => {
    const { agent } = await signUp();
    await pool.query("UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 second'");
    const res = await agent.post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session so the cookie stops working', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
    const cookie = refreshCookie(res);

    const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(204);

    const after = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });
});
