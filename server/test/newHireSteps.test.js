// Tests for the standard new-hire steps: who can read and change them, and what's refused.

import { describe, it, expect } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

const STARTING_STEPS = ['Create account', 'Set up email', 'Prepare laptop', 'Install software', 'Building access', 'First-day check-in'];

/** A user, a technician and an admin. */
async function people() {
  const user = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const tech = await signUp({ name: 'Sam', email: 'sam@example.com' });
  const admin = await signUp({ name: 'Ada', email: 'ada@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [tech.user.id]);
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.user.id]);
  return { user, tech, admin };
}

const getSteps = (token) => request(app).get('/api/new-hire-steps').set(bearer(token));
const putSteps = (token, steps) => request(app).put('/api/new-hire-steps').set(bearer(token)).send({ steps });

describe('GET /api/new-hire-steps', () => {
  it('gives staff the starting list, in order', async () => {
    const { tech } = await people();
    const res = await getSteps(tech.token);
    expect(res.status).toBe(200);
    expect(res.body.steps).toEqual(STARTING_STEPS);
  });

  it('refuses users (they never start new-hire tickets)', async () => {
    const { user } = await people();
    expect((await getSteps(user.token)).status).toBe(403);
  });
});

describe('PUT /api/new-hire-steps', () => {
  it('lets an admin replace the list, keeping the order sent and trimming spaces', async () => {
    const { admin, tech } = await people();
    const res = await putSteps(admin.token, ['  Order a monitor ', 'Create account', 'Set up email']);
    expect(res.status).toBe(200);
    expect(res.body.steps).toEqual(['Order a monitor', 'Create account', 'Set up email']);
    expect((await getSteps(tech.token)).body.steps).toEqual(['Order a monitor', 'Create account', 'Set up email']);
  });

  it('refuses technicians', async () => {
    const { tech } = await people();
    expect((await putSteps(tech.token, ['Create account'])).status).toBe(403);
  });

  it.each([
    ['an empty list', []],
    ['no list at all', undefined],
    ['more than 30 steps', Array.from({ length: 31 }, (_, i) => `Step ${i + 1}`)],
    ['a blank step', ['Create account', '   ']],
    ['a step that is not text', ['Create account', 42]],
    ['a step over 120 characters', ['x'.repeat(121)]],
    ['the same step twice (ignoring capitals)', ['Prepare laptop', 'prepare laptop']],
  ])('refuses %s and leaves the list as it was', async (_, steps) => {
    const { admin } = await people();
    const res = await putSteps(admin.token, steps);
    expect(res.status).toBe(400);
    expect((await getSteps(admin.token)).body.steps).toEqual(STARTING_STEPS);
  });
});
