// The owner role and the ranking rule: "you can only manage people below you,
// and only give out roles below your own" (server/roles.js)
import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, signUpAdmin, signUpOwner, bearer } from './helpers.js';

// Sign up, then set the role directly in the database
async function signUpAs(role, email) {
  const account = await signUp({ name: email.split('@')[0], email });
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, account.user.id]);
  return account;
}

const changeRole = (token, id, role) =>
  request(app).patch(`/api/users/${id}/role`).set(bearer(token)).send({ role });

const roleInDb = async (id) => (await pool.query('SELECT role FROM users WHERE id = $1', [id])).rows[0].role;

describe('what an owner can do', () => {
  it('promotes a user to admin, and demotes an admin', async () => {
    const owner = await signUpOwner();
    const bob = await signUp({ email: 'bob@example.com' });

    expect((await changeRole(owner.token, bob.user.id, 'admin')).status).toBe(200);
    expect(await roleInDb(bob.user.id)).toBe('admin');

    expect((await changeRole(owner.token, bob.user.id, 'technician')).status).toBe(200);
    expect(await roleInDb(bob.user.id)).toBe('technician');
  });

  it('cannot demote another owner (403)', async () => {
    const alice = await signUpOwner({ email: 'alice@example.com' });
    const bob = await signUpOwner({ email: 'bob@example.com' });
    const res = await changeRole(alice.token, bob.user.id, 'admin');
    expect(res.status).toBe(403);
    expect(await roleInDb(bob.user.id)).toBe('owner');
  });

  it('cannot make anyone an owner through the website (403)', async () => {
    const owner = await signUpOwner();
    const bob = await signUpAdmin({ email: 'bob@example.com' });
    const res = await changeRole(owner.token, bob.user.id, 'owner');
    expect(res.status).toBe(403);
    expect(await roleInDb(bob.user.id)).toBe('admin');
  });

  it('cannot change their own role (400)', async () => {
    const owner = await signUpOwner();
    expect((await changeRole(owner.token, owner.user.id, 'admin')).status).toBe(400);
  });

  it('has every admin power: user list, categories, and all tickets', async () => {
    const owner = await signUpOwner();
    const alice = await signUp({ email: 'alice@example.com' });
    await request(app).post('/api/tickets').set(bearer(alice.token)).send({ title: 'x', description: 'y' });

    expect((await request(app).get('/api/users').set(bearer(owner.token))).status).toBe(200);
    expect((await request(app).post('/api/categories').set(bearer(owner.token)).send({ name: 'VPN' })).status).toBe(201);
    expect((await request(app).get('/api/tickets').set(bearer(owner.token))).body.tickets).toHaveLength(1);
  });

  it('counts as staff: can be assigned tickets and write internal notes', async () => {
    const owner = await signUpOwner();
    const alice = await signUp({ email: 'alice@example.com' });
    const ticket = (await request(app).post('/api/tickets').set(bearer(alice.token)).send({ title: 'x', description: 'y' })).body.ticket;

    const assigned = await request(app).patch(`/api/tickets/${ticket.id}`).set(bearer(owner.token)).send({ assigned_to: owner.user.id });
    expect(assigned.status).toBe(200);

    const note = await request(app)
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(bearer(owner.token))
      .send({ body: 'internal', is_internal: true });
    expect(note.status).toBe(201);
  });
});

describe('what an admin can no longer do (owners control admins)', () => {
  it('still manages users and technicians', async () => {
    const admin = await signUpAdmin();
    const bob = await signUp({ email: 'bob@example.com' });
    expect((await changeRole(admin.token, bob.user.id, 'technician')).status).toBe(200);
    expect((await changeRole(admin.token, bob.user.id, 'user')).status).toBe(200);
  });

  it('cannot promote anyone to admin (403)', async () => {
    const admin = await signUpAdmin();
    const bob = await signUp({ email: 'bob@example.com' });
    expect((await changeRole(admin.token, bob.user.id, 'admin')).status).toBe(403);
    expect(await roleInDb(bob.user.id)).toBe('user');
  });

  it('cannot demote another admin (403)', async () => {
    const alice = await signUpAdmin({ email: 'alice@example.com' });
    const bob = await signUpAdmin({ email: 'bob@example.com' });
    expect((await changeRole(alice.token, bob.user.id, 'user')).status).toBe(403);
    expect(await roleInDb(bob.user.id)).toBe('admin');
  });

  it('cannot touch an owner (403)', async () => {
    const admin = await signUpAdmin();
    const owner = await signUpOwner();
    expect((await changeRole(admin.token, owner.user.id, 'user')).status).toBe(403);
    expect(await roleInDb(owner.user.id)).toBe('owner');
  });
});

describe('everyone else', () => {
  it.each(['user', 'technician'])('a %s cannot change roles at all (403)', async (role) => {
    const actor = await signUpAs(role, 'actor@example.com');
    const bob = await signUp({ email: 'bob@example.com' });
    expect((await changeRole(actor.token, bob.user.id, 'technician')).status).toBe(403);
  });
});

describe('the database itself', () => {
  it('accepts owner as a role, and still rejects made-up roles', async () => {
    const { user } = await signUp();
    await pool.query("UPDATE users SET role = 'owner' WHERE id = $1", [user.id]);
    await expect(pool.query("UPDATE users SET role = 'superuser' WHERE id = $1", [user.id])).rejects.toThrow(/users_role_check/);
  });
});
