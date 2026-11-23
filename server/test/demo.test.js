// Tests for the live demo: the "Try as…" login, what demo accounts can't change, and switching
// sign-up off. The switches are environment variables, set and cleared around each test.

import { describe, it, expect, afterEach } from 'vitest';
import { app, pool, request, signUp, signUpAdmin, bearer } from './helpers.js';

afterEach(() => {
  delete process.env.DEMO_MODE;
  delete process.env.ALLOW_SIGNUP;
});

/** The shared demo admin and demo user, as the demo script makes them (just the accounts). */
async function demoAccounts() {
  const admin = await signUp({ name: 'Demo Admin', email: 'demo.admin@demo.example.com' });
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.user.id]);
  const user = await signUp({ name: 'Demo User', email: 'demo.user@demo.example.com' });
  return { admin, user };
}

const tryAs = (as) => request(app).post('/api/auth/demo').send({ as });

describe('Try as… (POST /api/auth/demo)', () => {
  it("doesn't exist unless the site is in demo mode", async () => {
    await demoAccounts();
    expect((await tryAs('admin')).status).toBe(404);
  });

  it('logs straight into a demo account in demo mode, and only those', async () => {
    process.env.DEMO_MODE = 'true';
    const { admin } = await demoAccounts();
    const res = await tryAs('admin');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: admin.user.id, email: 'demo.admin@demo.example.com', role: 'admin' });
    expect((await request(app).get('/api/auth/me').set(bearer(res.body.token))).status).toBe(200);
    expect((await tryAs('owner')).status).toBe(400);
    expect((await tryAs('constructor')).status).toBe(400); // not a property of every object
    expect((await tryAs('technician')).status).toBe(503); // not seeded here: "being reset"
  });

  it('says whether the switches are on in the health check', async () => {
    process.env.DEMO_MODE = 'true';
    process.env.ALLOW_SIGNUP = 'false';
    expect((await request(app).get('/api/health')).body).toMatchObject({ demo: true, signup: false });
  });
});

describe('what demo accounts can do in demo mode', () => {
  it('refuses admin changes from the demo admin, but not from a real admin', async () => {
    process.env.DEMO_MODE = 'true';
    const { admin: demo, user } = await demoAccounts();
    const real = await signUpAdmin();
    const changes = [
      (token) => request(app).patch(`/api/users/${user.user.id}/role`).set(bearer(token)).send({ role: 'technician' }),
      (token) => request(app).patch(`/api/users/${user.user.id}/disabled`).set(bearer(token)).send({ disabled: true }),
      (token) => request(app).patch(`/api/users/${user.user.id}/details`).set(bearer(token)).send({ name: 'Renamed' }),
      (token) => request(app).put('/api/settings').set(bearer(token)).send({ auto_assign: false }),
      (token) => request(app).post('/api/categories').set(bearer(token)).send({ name: 'Demo category' }),
      (token) => request(app).patch('/api/profile').set(bearer(token)).send({ name: 'Me' }),
    ];
    for (const change of changes) {
      const res = await change(demo.token);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/shared demo account/);
    }
    // A real admin isn't affected (the first three change the demo user, which is allowed).
    expect((await changes[2](real.token)).status).toBe(200);
    expect((await changes[4](real.token)).status).toBe(201);
  });

  it("refuses a password change, but still lets the demo user use the help desk", async () => {
    process.env.DEMO_MODE = 'true';
    const { user } = await demoAccounts();
    const password = await user.agent.post('/api/auth/password').set(bearer(user.token)).send({ current_password: 'password123', new_password: 'new-password-1' });
    expect(password.status).toBe(403);
    const ticket = await request(app).post('/api/tickets').set(bearer(user.token)).send({ title: 'VPN down', description: 'From home' });
    expect(ticket.status).toBe(201);
  });

  it('leaves demo accounts alone outside demo mode (a developer testing admin pages)', async () => {
    const { admin, user } = await demoAccounts();
    expect((await request(app).patch(`/api/users/${user.user.id}/details`).set(bearer(admin.token)).send({ job_title: 'Tester' })).status).toBe(200);
  });
});

describe('sign-up switched off', () => {
  it('refuses new accounts, while existing ones still log in', async () => {
    await signUp({ email: 'staff@example.com', password: 'password123' });
    process.env.ALLOW_SIGNUP = 'false';
    const res = await request(app).post('/api/auth/register').send({ name: 'Stranger', email: 'x@example.com', password: 'password123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/switched off/);
    expect((await request(app).post('/api/auth/login').send({ email: 'staff@example.com', password: 'password123' })).status).toBe(200);
  });
});
