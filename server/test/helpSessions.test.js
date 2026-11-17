// Tests for the AI help tables: help_sessions and tickets.steps_tried.
//
// These check the database rules directly with SQL, so bad data is refused even if a route
// has a bug.

import { describe, it, expect } from 'vitest';
import { pool, signUp } from './helpers.js';

/** Creates a user and a ticket by SQL; returns { userId, ticketId }. */
async function userAndTicket() {
  const { user } = await signUp();
  const ticket = await pool.query(
    "INSERT INTO tickets (title, description, created_by) VALUES ('Wi-Fi is down', 'No connection', $1) RETURNING id",
    [user.id],
  );
  return { userId: user.id, ticketId: ticket.rows[0].id };
}

/** Inserts a help session with sensible defaults; `fields` overrides any column. */
function insertSession(userId, fields = {}) {
  const row = { user_id: userId, title: 'Wi-Fi is down', description: 'No connection', ...fields };
  const columns = Object.keys(row);
  const values = Object.values(row).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  return pool.query(
    `INSERT INTO help_sessions (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values,
  );
}

describe('help_sessions', () => {
  it('starts pending, with no steps, ticket or finish time', async () => {
    const { userId } = await userAndTicket();
    const { rows } = await insertSession(userId);
    expect(rows[0]).toMatchObject({ outcome: 'pending', steps: [], ticket_id: null, finished_at: null });
  });

  it('stores the steps as a list and reads them back as objects', async () => {
    const { userId } = await userAndTicket();
    const steps = [{ title: 'Restart the router', detail: 'Unplug it for 30 seconds.' }];
    const { rows } = await insertSession(userId, { steps, model: 'test-model', input_tokens: 1200, output_tokens: 300 });
    expect(rows[0].steps).toEqual(steps);
  });

  it('refuses steps that are not a list', async () => {
    const { userId } = await userAndTicket();
    await expect(insertSession(userId, { steps: { title: 'Restart' } })).rejects.toThrow(/help_sessions_steps_is_list/);
  });

  it('refuses an unknown outcome or priority', async () => {
    const { userId } = await userAndTicket();
    await expect(insertSession(userId, { outcome: 'abandoned', finished_at: new Date() })).rejects.toThrow(/outcome_check/);
    await expect(insertSession(userId, { suggested_priority: 'critical' })).rejects.toThrow(/suggested_priority_check/);
  });

  it('accepts each finished outcome when its rules are met', async () => {
    const { userId, ticketId } = await userAndTicket();
    const now = new Date();
    await insertSession(userId, { outcome: 'fixed', finished_at: now });
    await insertSession(userId, { outcome: 'failed', finished_at: now });
    await insertSession(userId, { outcome: 'still_broken', ticket_id: ticketId, finished_at: now });
    await insertSession(userId, { outcome: 'escalated', escalate_reason: 'Registry edit', ticket_id: ticketId, finished_at: now });
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM help_sessions');
    expect(count.rows[0].n).toBe(4);
  });

  it('needs a ticket for still_broken and escalated, and none otherwise', async () => {
    const { userId, ticketId } = await userAndTicket();
    const now = new Date();
    await expect(insertSession(userId, { outcome: 'still_broken', finished_at: now })).rejects.toThrow(
      /help_sessions_ticket_matches_outcome/,
    );
    await expect(insertSession(userId, { outcome: 'fixed', ticket_id: ticketId, finished_at: now })).rejects.toThrow(
      /help_sessions_ticket_matches_outcome/,
    );
  });

  it('needs a reason for an escalation', async () => {
    const { userId, ticketId } = await userAndTicket();
    await expect(
      insertSession(userId, { outcome: 'escalated', ticket_id: ticketId, finished_at: new Date() }),
    ).rejects.toThrow(/help_sessions_escalation_has_reason/);
  });

  it('has a finish time exactly when the outcome is decided', async () => {
    const { userId } = await userAndTicket();
    await expect(insertSession(userId, { outcome: 'fixed' })).rejects.toThrow(/help_sessions_finished_matches_outcome/);
    await expect(insertSession(userId, { finished_at: new Date() })).rejects.toThrow(
      /help_sessions_finished_matches_outcome/,
    );
  });

  it('refuses negative token counts', async () => {
    const { userId } = await userAndTicket();
    await expect(insertSession(userId, { input_tokens: -1 })).rejects.toThrow(/input_tokens_check/);
  });
});

describe('tickets.steps_tried', () => {
  it('is an empty list for tickets opened without the AI helper', async () => {
    const { ticketId } = await userAndTicket();
    const { rows } = await pool.query('SELECT steps_tried FROM tickets WHERE id = $1', [ticketId]);
    expect(rows[0].steps_tried).toEqual([]);
  });

  it('refuses anything that is not a list', async () => {
    const { ticketId } = await userAndTicket();
    await expect(
      pool.query(`UPDATE tickets SET steps_tried = '"restart"' WHERE id = $1`, [ticketId]),
    ).rejects.toThrow(/tickets_steps_tried_is_list/);
  });
});

describe('help_sessions kinds (Get help vs Ask IT)', () => {
  it("defaults to 'fix', with no blocked steps", async () => {
    const { userId } = await userAndTicket();
    const { rows } = await insertSession(userId);
    expect(rows[0]).toMatchObject({ kind: 'fix', blocked_steps: [], answer: null });
  });

  it('lets a question use every Get help outcome, without a ticket', async () => {
    const { userId } = await userAndTicket();
    const now = new Date();
    const answer = 'Restart it.';
    await insertSession(userId, { kind: 'question', answer }); // pending: waiting for Yes / No
    await insertSession(userId, { kind: 'question', answer, outcome: 'fixed', finished_at: now });
    await insertSession(userId, { kind: 'question', answer, outcome: 'still_broken', finished_at: now });
    await insertSession(userId, { kind: 'question', answer, outcome: 'escalated', escalate_reason: 'Needs IT.', finished_at: now });
    await insertSession(userId, { kind: 'question', outcome: 'failed', finished_at: now });
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM help_sessions WHERE kind = 'question'")).rows[0].n).toBe(5);
  });

  it('never links a question to a ticket, and no longer accepts the old "answered" outcome', async () => {
    const { userId, ticketId } = await userAndTicket();
    const now = new Date();
    await expect(
      insertSession(userId, { kind: 'question', outcome: 'still_broken', ticket_id: ticketId, finished_at: now })
    ).rejects.toThrow(/ticket_matches_outcome/);
    await expect(insertSession(userId, { kind: 'question', outcome: 'answered', finished_at: now })).rejects.toThrow(/outcome_check/);
  });

  it('refuses an unknown kind, and blocked steps that are not a list', async () => {
    const { userId } = await userAndTicket();
    await expect(insertSession(userId, { kind: 'chat' })).rejects.toThrow(/help_sessions_kind_check/);
    await expect(insertSession(userId, { blocked_steps: { title: 'x' } })).rejects.toThrow(/blocked_steps_is_list/);
  });
});
