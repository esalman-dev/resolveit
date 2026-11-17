// Tests for the demo data script (scripts/demoData.js): it builds believable history, can be
// re-run, and never touches real accounts or their tickets.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { pool, signUp, app, request, bearer } from './helpers.js';
import { withTransaction } from '../db/index.js';
import { DEMO_LOGINS, removeDemoData, seedDemoData } from '../scripts/demoData.js';

const readJson = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const study = {
  tickets: readJson('../eval/study/tickets.json').tickets,
  scenarios: readJson('../eval/study/scenarios.json').scenarios,
  studyResults: readJson('../eval/study/results/study-2026-11-17T19-07-22.json').results,
};
const now = new Date('2026-11-17T15:00:00Z');

/** Seeds a small demo (40 study tickets) inside a transaction, like the script does. */
const seed = (options = {}) =>
  withTransaction((db) => seedDemoData(db, { ...study, password: 'demo-password-1', now, count: 40, ...options }));

const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;

/** Adds the starter categories the app normally has. */
async function addCategories() {
  for (const name of ['Network', 'Hardware', 'Software', 'Printer', 'Email', 'Account & Access', 'Other']) {
    await pool.query('INSERT INTO categories (name) VALUES ($1)', [name]);
  }
}

describe('seedDemoData', () => {
  it('creates the three demo logins, which can log in', async () => {
    await addCategories();
    await seed();
    for (const login of Object.values(DEMO_LOGINS)) {
      const res = await request(app).post('/api/auth/login').send({ email: login.email, password: 'demo-password-1' });
      expect(res.status).toBe(200);
      expect(res.body.user.role).toBe(login.role);
    }
  });

  it('builds tickets with history, comments and the Get help requests behind them', async () => {
    await addCategories();
    const stats = await seed();
    expect(stats.tickets).toBeGreaterThan(20);
    expect(await count('SELECT COUNT(*)::int AS n FROM ticket_events')).toBeGreaterThan(stats.tickets);
    expect(await count('SELECT COUNT(*)::int AS n FROM ticket_comments')).toBe(stats.comments);
    expect(await count('SELECT COUNT(*)::int AS n FROM help_sessions')).toBe(stats.helpSessions);
    // Every Get help request that ended in a ticket points at one.
    expect(await count("SELECT COUNT(*)::int AS n FROM help_sessions WHERE outcome IN ('still_broken', 'escalated') AND ticket_id IS NULL")).toBe(0);
  });

  it('keeps every time in order and in the past', async () => {
    await addCategories();
    await seed();
    const wrong = await count(
      `SELECT COUNT(*)::int AS n FROM tickets
        WHERE created_at > $1 OR updated_at < created_at OR resolved_at < created_at
           OR (status = 'resolved') <> (resolved_at IS NOT NULL)`,
      [now]
    );
    expect(wrong).toBe(0);
    expect(await count('SELECT COUNT(*)::int AS n FROM ticket_events WHERE created_at > $1', [now])).toBe(0);
  });

  it('makes the same demo every time, and replaces the old one when re-run', async () => {
    await addCategories();
    const first = await seed();
    const titles = (await pool.query('SELECT title FROM tickets ORDER BY title')).rows;
    const second = await seed();
    expect(second).toEqual(first);
    expect((await pool.query('SELECT title FROM tickets ORDER BY title')).rows).toEqual(titles);
    expect(await count("SELECT COUNT(*)::int AS n FROM users WHERE email = $1", [DEMO_LOGINS.admin.email])).toBe(1);
  });
});

describe('removeDemoData', () => {
  it('removes demo accounts and their data, and leaves real ones alone', async () => {
    await addCategories();
    const real = await signUp({ name: 'Real Person', email: 'real@example.com' });
    const ticket = await request(app)
      .post('/api/tickets')
      .set(bearer(real.token))
      .send({ title: 'My real problem', description: 'Real details' });
    await seed();

    // A demo technician also worked on the real ticket.
    const tech = (await pool.query('SELECT id FROM users WHERE email = $1', [DEMO_LOGINS.technician.email])).rows[0];
    await pool.query('UPDATE tickets SET assigned_to = $1 WHERE id = $2', [tech.id, ticket.body.ticket.id]);
    await pool.query("INSERT INTO ticket_comments (ticket_id, author_id, body) VALUES ($1, $2, 'Demo reply')", [ticket.body.ticket.id, tech.id]);

    await withTransaction((db) => removeDemoData(db));
    expect(await count("SELECT COUNT(*)::int AS n FROM users WHERE email LIKE '%@demo.example.com'")).toBe(0);
    expect(await count('SELECT COUNT(*)::int AS n FROM users')).toBe(1);
    const left = (await pool.query('SELECT title, assigned_to FROM tickets')).rows;
    expect(left).toEqual([{ title: 'My real problem', assigned_to: null }]);
  });
});
