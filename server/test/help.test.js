// Tests for the help API (routes/help.js): AI suggestions, Ask IT questions, daily limits, and
// outcomes.
//
// askForFix and askQuestion are replaced with fakes, so each test decides what the "AI"
// answers. Everything else is real: the guardrail check, the database, the tickets that get opened.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';
import { askForFix, askQuestion, AiUnavailableError } from '../services/ai.js';

vi.mock('../services/ai.js', async (importOriginal) => ({
  ...(await importOriginal()),
  askForFix: vi.fn(),
  askQuestion: vi.fn(),
}));

const safeAnswer = {
  escalate: false,
  reason: '',
  steps: [
    { title: 'Restart the router', detail: 'Unplug it for 30 seconds.' },
    { title: 'Forget and rejoin the network', detail: 'Open Wi-Fi settings and reconnect.' },
  ],
  suggested_category: 'Network',
  suggested_priority: 'high',
};

const usage = { input_tokens: 1200, output_tokens: 300 };

/** Makes the fake AI give `answer` (merged over the safe one). */
function aiAnswers(answer = {}, { refused = false } = {}) {
  askForFix.mockResolvedValue({ answer: { ...safeAnswer, ...answer }, refused, model: 'test-model', usage });
}

/** Signs up, then sets the role directly in the database. */
async function signUpAs(role, email) {
  const account = await signUp({ name: email.split('@')[0], email });
  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, account.user.id]);
  return account;
}

/** Adds a category and returns its id. */
const addCategory = async (name, active = true) =>
  (await pool.query('INSERT INTO categories (name, active) VALUES ($1, $2) RETURNING id', [name, active])).rows[0].id;

const suggest = (token, body = {}) =>
  request(app)
    .post('/api/help/suggest')
    .set(bearer(token))
    .send({ title: 'Wi-Fi keeps dropping', description: 'Every hour or so.', ...body });

const sendOutcome = (token, id, body) => request(app).post(`/api/help/${id}/outcome`).set(bearer(token)).send(body);

const sessionRow = async (id) => (await pool.query('SELECT * FROM help_sessions WHERE id = $1', [id])).rows[0];
const ticketRow = async (id) => (await pool.query('SELECT * FROM tickets WHERE id = $1', [id])).rows[0];
const count = async (table) => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'; // turns AI help on; askForFix is fake, so nothing is spent
  askForFix.mockReset();
  askQuestion.mockReset();
  aiAnswers();
  questionAnswered();
});

/** Makes the fake AI answer a question with `fields` (merged over a normal answer). */
function questionAnswered(fields = {}) {
  askQuestion.mockResolvedValue({
    answer: { answer: 'Open Settings, then Printers & scanners, and choose Add device.', needs_technician: false, reason: '', ...fields },
    refused: false,
    model: 'test-model',
    usage,
  });
}

const ask = (token, question = 'How do I add the office printer?') =>
  request(app).post('/api/help/ask').set(bearer(token)).send({ question });

afterEach(() => {
  process.env.ANTHROPIC_API_KEY = '';
  delete process.env.AI_DAILY_LIMIT_PER_USER;
  delete process.env.AI_DAILY_LIMIT_SITE;
});

describe('POST /api/help/suggest', () => {
  it('needs a login', async () => {
    const res = await request(app).post('/api/help/suggest').send({ title: 'x', description: 'y' });
    expect(res.status).toBe(401);
  });

  it('checks the form like a ticket: title, description, active category', async () => {
    const alice = await signUp();
    const archived = await addCategory('Old', false);
    expect((await suggest(alice.token, { title: ' ' })).status).toBe(400);
    expect((await suggest(alice.token, { description: 'x'.repeat(5001) })).status).toBe(400);
    expect((await suggest(alice.token, { category_id: archived })).status).toBe(400);
    expect(askForFix).not.toHaveBeenCalled();
  });

  it('returns safe steps and saves a pending session with the cost', async () => {
    const alice = await signUp();
    const network = await addCategory('Network');
    const res = await suggest(alice.token);

    expect(res.status).toBe(200);
    expect(res.body.session).toEqual({
      id: expect.any(Number),
      outcome: 'pending',
      steps: safeAnswer.steps,
      escalate_reason: null,
      ticket_id: null,
    });
    expect(await sessionRow(res.body.session.id)).toMatchObject({
      user_id: alice.user.id,
      title: 'Wi-Fi keeps dropping',
      outcome: 'pending',
      suggested_category_id: network,
      suggested_priority: 'high',
      model: 'test-model',
      input_tokens: 1200,
      output_tokens: 300,
      finished_at: null,
    });
    expect(await count('tickets')).toBe(0);
  });

  it('sends the AI only the problem and the category names, never who asked', async () => {
    const alice = await signUp({ name: 'Alice Smith', email: 'alice@example.com' });
    const network = await addCategory('Network');
    await addCategory('Printer');
    await suggest(alice.token, { category_id: network });

    expect(askForFix).toHaveBeenCalledWith({
      title: 'Wi-Fi keeps dropping',
      description: 'Every hour or so.',
      category: 'Network',
      categoryNames: ['Network', 'Printer'],
      images: [], // no screenshots attached
      articles: [], // no knowledge base articles matched
    });
    expect(JSON.stringify(askForFix.mock.calls[0])).not.toMatch(/alice/i);
  });

  it('opens a ticket at once when the AI says a technician is needed', async () => {
    const alice = await signUp();
    const network = await addCategory('Network');
    aiAnswers({ escalate: true, reason: 'Possible phishing.', steps: [], suggested_priority: 'urgent' });
    const res = await suggest(alice.token);

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({ outcome: 'escalated', escalate_reason: 'Possible phishing.', steps: [] });
    expect(res.body.ticket_id).toBe(res.body.session.ticket_id);

    const ticket = await ticketRow(res.body.ticket_id);
    expect(ticket).toMatchObject({
      title: 'Wi-Fi keeps dropping',
      created_by: alice.user.id,
      status: 'open',
      priority: 'urgent', // set by the server from the AI, which users can't do themselves
      category_id: network,
      steps_tried: [],
    });
    const history = await pool.query('SELECT action FROM ticket_events WHERE ticket_id = $1', [ticket.id]);
    expect(history.rows).toEqual([{ action: 'created' }]);
  });

  it('escalates when the guardrail blocks a step, and never shows that step', async () => {
    const alice = await signUp();
    aiAnswers({ steps: [{ title: 'Edit the registry', detail: 'Open regedit and change the key.' }] });
    const res = await suggest(alice.token);

    expect(res.status).toBe(201);
    expect(res.body.session.outcome).toBe('escalated');
    expect(res.body.session.escalate_reason).toMatch(/registry/);
    expect(JSON.stringify(res.body)).not.toMatch(/regedit/);
    expect((await sessionRow(res.body.session.id)).steps).toEqual([]);
  });

  it("keeps the user's own category over the AI's suggestion", async () => {
    const alice = await signUp();
    await addCategory('Network');
    const printer = await addCategory('Printer');
    aiAnswers({ escalate: true, reason: 'Needs a technician.', steps: [] }); // AI suggests Network
    const res = await suggest(alice.token, { category_id: printer });
    expect((await ticketRow(res.body.ticket_id)).category_id).toBe(printer);
  });

  it('answers 503 and saves nothing when no API key is set', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const alice = await signUp();
    const res = await suggest(alice.token);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/isn't available/);
    expect(askForFix).not.toHaveBeenCalled();
    expect(await count('help_sessions')).toBe(0);
  });

  it('answers 503 when the AI fails, and saves the session as failed with its cost', async () => {
    const alice = await signUp();
    askForFix.mockRejectedValue(new AiUnavailableError('cut off', { usage }));
    const res = await suggest(alice.token);

    expect(res.status).toBe(503);
    const { rows } = await pool.query('SELECT outcome, finished_at, input_tokens FROM help_sessions');
    expect(rows).toEqual([{ outcome: 'failed', finished_at: expect.any(Date), input_tokens: 1200 }]);
    expect(await count('tickets')).toBe(0);
  });

  it('marks the session failed on an unexpected error too, and answers 500', async () => {
    const alice = await signUp();
    askForFix.mockRejectedValue(new TypeError('bug'));
    vi.spyOn(console, 'error').mockImplementation(() => {}); // keep the expected error out of the test output
    const res = await suggest(alice.token);
    expect(res.status).toBe(500);
    expect((await pool.query('SELECT outcome FROM help_sessions')).rows).toEqual([{ outcome: 'failed' }]);
    vi.restoreAllMocks();
  });
});

describe('daily limits', () => {
  it('stops a person after their limit, counting failed requests too', async () => {
    process.env.AI_DAILY_LIMIT_PER_USER = '2';
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });

    expect((await suggest(alice.token)).status).toBe(200);
    askForFix.mockRejectedValueOnce(new AiUnavailableError('down'));
    expect((await suggest(alice.token)).status).toBe(503);

    const third = await suggest(alice.token);
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ limit: 'user', error: expect.stringMatching(/all 2 automatic answers/) });
    expect(askForFix).toHaveBeenCalledTimes(2); // the blocked request never reached the AI
    expect((await suggest(bob.token)).status).toBe(200); // other people are unaffected
  });

  it('only counts the last 24 hours', async () => {
    process.env.AI_DAILY_LIMIT_PER_USER = '1';
    const alice = await signUp();
    const first = await suggest(alice.token);
    await pool.query("UPDATE help_sessions SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [
      first.body.session.id,
    ]);
    expect((await suggest(alice.token)).status).toBe(200);
  });

  it('stops everyone when the whole site reaches its limit', async () => {
    process.env.AI_DAILY_LIMIT_SITE = '2';
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    await suggest(alice.token);
    await suggest(alice.token);

    const res = await suggest(bob.token);
    expect(res.status).toBe(429);
    expect(res.body.limit).toBe('site');
  });

  it('cannot be passed by sending many requests at once', async () => {
    process.env.AI_DAILY_LIMIT_PER_USER = '3';
    const alice = await signUp();
    const results = await Promise.all(Array.from({ length: 6 }, () => suggest(alice.token)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
  });
});

describe('POST /api/help/:id/outcome', () => {
  /** Signs up and gets a pending session; returns { account, sessionId }. */
  async function pendingSession(email = 'alice@example.com') {
    const account = await signUp({ email });
    const res = await suggest(account.token);
    return { account, sessionId: res.body.session.id };
  }

  it('"fixed" closes the session with no ticket', async () => {
    const { account, sessionId } = await pendingSession();
    const res = await sendOutcome(account.token, sessionId, { outcome: 'fixed' });

    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({ outcome: 'fixed', ticket_id: null });
    expect((await sessionRow(sessionId)).finished_at).not.toBeNull();
    expect(await count('tickets')).toBe(0);
  });

  it('"still_broken" auto-assigns the ticket like any new one', async () => {
    const sam = await signUpAs('technician', 'sam@example.com');
    await pool.query('UPDATE users SET last_seen_at = NOW(), last_active_at = NOW() WHERE id = $1', [sam.user.id]);
    const { account, sessionId } = await pendingSession();
    const res = await sendOutcome(account.token, sessionId, { outcome: 'still_broken' });
    expect((await ticketRow(res.body.ticket_id)).assigned_to).toBe(sam.user.id);
  });

  it('"still_broken" counts toward an outage like any new ticket', async () => {
    const network = await addCategory('Network'); // the fake AI suggests Network
    const { account, sessionId } = await pendingSession();
    for (const title of ['Wi-Fi down', 'No Wi-Fi']) {
      await request(app).post('/api/tickets').set(bearer(account.token)).send({ title, description: 'Since 9', category_id: network });
    }
    const res = await sendOutcome(account.token, sessionId, { outcome: 'still_broken' });
    expect((await ticketRow(res.body.ticket_id)).outage_id).not.toBeNull();
    expect(await count('outages')).toBe(1);
  });

  it('"still_broken" opens a ticket with the steps, marked tried or not', async () => {
    const network = await addCategory('Network');
    const { account, sessionId } = await pendingSession();
    const res = await sendOutcome(account.token, sessionId, { outcome: 'still_broken', tried: [1] });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({ outcome: 'still_broken', ticket_id: res.body.ticket_id });
    expect(await ticketRow(res.body.ticket_id)).toMatchObject({
      created_by: account.user.id,
      priority: 'high',
      category_id: network, // the AI's suggestion, since the user picked none
      steps_tried: [
        { ...safeAnswer.steps[0], tried: false },
        { ...safeAnswer.steps[1], tried: true },
      ],
    });
  });

  it('marks every step tried when the list is left out', async () => {
    const { account, sessionId } = await pendingSession();
    const res = await sendOutcome(account.token, sessionId, { outcome: 'still_broken' });
    expect((await ticketRow(res.body.ticket_id)).steps_tried.map((s) => s.tried)).toEqual([true, true]);
  });

  it('skips a suggested category that was archived in the meantime', async () => {
    const network = await addCategory('Network');
    const { account, sessionId } = await pendingSession();
    await pool.query('UPDATE categories SET active = false WHERE id = $1', [network]);
    const res = await sendOutcome(account.token, sessionId, { outcome: 'still_broken' });
    expect((await ticketRow(res.body.ticket_id)).category_id).toBeNull();
  });

  it('records only one outcome (a second click gets 409)', async () => {
    const { account, sessionId } = await pendingSession();
    await sendOutcome(account.token, sessionId, { outcome: 'still_broken' });
    const again = await sendOutcome(account.token, sessionId, { outcome: 'fixed' });
    expect(again.status).toBe(409);
    expect(await count('tickets')).toBe(1);
  });

  it('opens only one ticket even when clicked twice at the same moment', async () => {
    const { account, sessionId } = await pendingSession();
    const results = await Promise.all([
      sendOutcome(account.token, sessionId, { outcome: 'still_broken' }),
      sendOutcome(account.token, sessionId, { outcome: 'still_broken' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await count('tickets')).toBe(1);
  });

  it('refuses an escalated session (it already has a ticket)', async () => {
    const alice = await signUp();
    aiAnswers({ escalate: true, reason: 'Needs a technician.', steps: [] });
    const { body } = await suggest(alice.token);
    expect((await sendOutcome(alice.token, body.session.id, { outcome: 'fixed' })).status).toBe(409);
  });

  it("returns 404 for someone else's session, even for staff", async () => {
    const { sessionId } = await pendingSession('alice@example.com');
    const bob = await signUp({ email: 'bob@example.com' });
    const tech = await signUpAs('owner', 'boss@example.com');
    expect((await sendOutcome(bob.token, sessionId, { outcome: 'fixed' })).status).toBe(404);
    expect((await sendOutcome(tech.token, sessionId, { outcome: 'fixed' })).status).toBe(404);
    expect((await sendOutcome(bob.token, 'abc', { outcome: 'fixed' })).status).toBe(404);
  });

  it('checks the outcome and the tried list', async () => {
    const { account, sessionId } = await pendingSession();
    expect((await sendOutcome(account.token, sessionId, { outcome: 'abandoned' })).status).toBe(400);
    expect((await sendOutcome(account.token, sessionId, { outcome: 'still_broken', tried: 'all' })).status).toBe(400);
    expect((await sendOutcome(account.token, sessionId, { outcome: 'still_broken', tried: [0.5] })).status).toBe(400);
    expect((await sessionRow(sessionId)).outcome).toBe('pending');
  });
});

describe('GET /api/help/sessions (staff list)', () => {
  const list = (token) => request(app).get('/api/help/sessions').set(bearer(token));

  it('is for staff only', async () => {
    const alice = await signUp();
    expect((await list(alice.token)).status).toBe(403);
    expect((await request(app).get('/api/help/sessions')).status).toBe(401);
  });

  it('lists every attempt newest first, with counts for each result', async () => {
    const alice = await signUp({ name: 'Alice', email: 'alice@example.com' });
    const tech = await signUpAs('technician', 'tech@example.com');

    const fixed = await suggest(alice.token, { title: 'Fixed one' });
    await sendOutcome(alice.token, fixed.body.session.id, { outcome: 'fixed' });
    const broken = await suggest(alice.token, { title: 'Broken one' });
    await sendOutcome(alice.token, broken.body.session.id, { outcome: 'still_broken', tried: [0] });
    aiAnswers({ escalate: true, reason: 'Possible phishing.', steps: [] });
    await suggest(alice.token, { title: 'Escalated one' });

    const res = await list(tech.token);
    expect(res.status).toBe(200);
    expect(res.body.counts.all).toEqual({ fixed: 1, still_broken: 1, escalated: 1, pending: 0, failed: 0 });
    expect(res.body.counts.fix).toEqual(res.body.counts.all); // no Ask IT questions here
    expect(res.body.sessions.map((s) => [s.title, s.outcome])).toEqual([
      ['Escalated one', 'escalated'],
      ['Broken one', 'still_broken'],
      ['Fixed one', 'fixed'],
    ]);

    const [escalated, stillBroken, fixedRow] = res.body.sessions;
    expect(fixedRow).toMatchObject({ user_name: 'Alice', ticket_id: null, steps: safeAnswer.steps, steps_tried: null });
    expect(stillBroken.steps_tried.map((s) => s.tried)).toEqual([true, false]); // from the ticket
    expect(escalated).toMatchObject({ escalate_reason: 'Possible phishing.', ticket_id: expect.any(Number) });
  });

  it('shows the asker by name, never by email', async () => {
    const alice = await signUp({ name: 'Alice', email: 'alice@example.com' });
    const admin = await signUpAs('admin', 'boss@example.com');
    await suggest(alice.token);
    const res = await list(admin.token);
    expect(res.body.sessions[0].user_name).toBe('Alice');
    expect(JSON.stringify(res.body)).not.toContain('alice@example.com');
  });

  it('includes failed attempts, and never shows model names or token counts', async () => {
    const alice = await signUp();
    const tech = await signUpAs('technician', 'tech@example.com');
    askForFix.mockRejectedValue(new AiUnavailableError('down', { usage }));
    await suggest(alice.token);
    const res = await list(tech.token);
    expect(res.body.counts.all.failed).toBe(1);
    expect(res.body.sessions[0]).not.toHaveProperty('model');
    expect(res.body.sessions[0]).not.toHaveProperty('input_tokens');
  });
});

describe('tickets opened through Get help', () => {
  it('mark their "created" history entry and send steps_tried with the ticket', async () => {
    const alice = await signUp();
    const { body } = await suggest(alice.token);
    const res = await sendOutcome(alice.token, body.session.id, { outcome: 'still_broken', tried: [1] });

    const ticket = await request(app).get(`/api/tickets/${res.body.ticket_id}`).set(bearer(alice.token));
    expect(ticket.body.ticket.steps_tried.map((s) => [s.title, s.tried])).toEqual([
      [safeAnswer.steps[0].title, false],
      [safeAnswer.steps[1].title, true],
    ]);
    expect(ticket.body.history[0]).toMatchObject({ action: 'created', new_value: 'get_help' });
  });

  it('leave ordinary tickets unmarked, with an empty steps list', async () => {
    const alice = await signUp();
    const created = await request(app)
      .post('/api/tickets')
      .set(bearer(alice.token))
      .send({ title: 'Plain ticket', description: 'No AI here.' });
    expect(created.body.ticket.steps_tried).toEqual([]);
    expect(created.body.history[0]).toMatchObject({ action: 'created', new_value: null });
  });
});

describe('coming back to unfinished requests', () => {
  it('GET /mine lists only my pending requests from the last 7 days, newest first', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    const older = await suggest(alice.token, { title: 'Older one' });
    const newer = await suggest(alice.token, { title: 'Newer one' });
    const done = await suggest(alice.token, { title: 'Finished one' });
    await sendOutcome(alice.token, done.body.session.id, { outcome: 'fixed' });
    const stale = await suggest(alice.token, { title: 'Stale one' });
    await pool.query("UPDATE help_sessions SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1", [stale.body.session.id]);
    await suggest(bob.token, { title: "Bob's" });
    await pool.query("UPDATE help_sessions SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [older.body.session.id]);

    const res = await request(app).get('/api/help/mine').set(bearer(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s) => s.title)).toEqual(['Newer one', 'Older one']);
    expect(res.body.sessions[0]).toMatchObject({
      id: newer.body.session.id,
      outcome: 'pending',
      steps: safeAnswer.steps,
      description: 'Every hour or so.',
    });
  });

  it('GET /:id returns my request with its steps, without asking the AI again', async () => {
    const alice = await signUp();
    const { body } = await suggest(alice.token);
    askForFix.mockClear();

    const res = await request(app).get(`/api/help/${body.session.id}`).set(bearer(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({ outcome: 'pending', title: 'Wi-Fi keeps dropping', steps: safeAnswer.steps });
    expect(askForFix).not.toHaveBeenCalled();
    expect(await count('help_sessions')).toBe(1); // nothing new counted toward the limit
  });

  it("GET /:id is 404 for someone else's request, even for staff", async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const owner = await signUpAs('owner', 'boss@example.com');
    const { body } = await suggest(alice.token);
    expect((await request(app).get(`/api/help/${body.session.id}`).set(bearer(owner.token))).status).toBe(404);
    expect((await request(app).get('/api/help/abc').set(bearer(alice.token))).status).toBe(404);
  });

  it('the staff list still works next to the new routes', async () => {
    const tech = await signUpAs('technician', 'tech@example.com');
    expect((await request(app).get('/api/help/sessions').set(bearer(tech.token))).status).toBe(200);
  });
});

describe('blocked steps are kept for staff', () => {
  it('saves what the guardrail threw away, shows it on the staff list, never to the user', async () => {
    const alice = await signUp();
    const tech = await signUpAs('technician', 'tech@example.com');
    aiAnswers({ steps: [{ title: 'Edit the registry', detail: 'Open regedit and change the key.' }] });
    const res = await suggest(alice.token);

    expect(JSON.stringify(res.body)).not.toContain('regedit'); // the user sees only the reason
    const list = await request(app).get('/api/help/sessions').set(bearer(tech.token));
    expect(list.body.sessions[0].blocked_steps).toEqual([{ title: 'Edit the registry', detail: 'Open regedit and change the key.' }]);
  });
});

describe('Ask IT (POST /api/help/ask)', () => {
  it('answers a question and logs it with who asked', async () => {
    const alice = await signUp({ name: 'Alice' });
    const res = await ask(alice.token);

    expect(res.status).toBe(200);
    expect(res.body.question).toMatchObject({
      question: 'How do I add the office printer?',
      answer: 'Open Settings, then Printers & scanners, and choose Add device.',
      outcome: 'pending', // waiting for "Did this answer your question?"
      needs_technician: false,
      reason: null,
    });
    expect(askQuestion).toHaveBeenCalledWith('How do I add the office printer?'); // only the question
    expect(await sessionRow(res.body.question.id)).toMatchObject({
      user_id: alice.user.id,
      kind: 'question',
      outcome: 'pending',
      finished_at: null,
      model: 'test-model',
      input_tokens: 1200,
    });
  });

  it('says "needs a technician" when the AI says so, with the reason', async () => {
    const alice = await signUp();
    questionAnswered({ answer: '', needs_technician: true, reason: 'Registry changes need IT.' });
    const res = await ask(alice.token, 'How do I edit the registry?');
    expect(res.body.question).toMatchObject({ outcome: 'escalated', needs_technician: true, reason: 'Registry changes need IT.' });
    expect(res.body.question.answer).toMatch(/Get help/);
    expect(await count('tickets')).toBe(0); // Ask IT never opens a ticket itself
  });

  it('replaces a risky answer and keeps it for staff only', async () => {
    const alice = await signUp();
    const tech = await signUpAs('technician', 'tech@example.com');
    questionAnswered({ answer: 'Open Command Prompt and run sfc /scannow.' });
    const res = await ask(alice.token, 'How do I fix Windows?');

    expect(res.body.question.needs_technician).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('sfc');
    const list = await request(app).get('/api/help/sessions').set(bearer(tech.token));
    expect(list.body.sessions[0]).toMatchObject({ kind: 'question', blocked_steps: [{ title: 'Answer', detail: 'Open Command Prompt and run sfc /scannow.' }] });
  });

  it('allows ordinary password advice in answers', async () => {
    const alice = await signUp();
    questionAnswered({ answer: 'Use a long password, and change it with the normal password reset page.' });
    expect((await ask(alice.token, 'How do I pick a good password?')).body.question.needs_technician).toBe(false);
  });

  it('shares the daily limit with Get help', async () => {
    process.env.AI_DAILY_LIMIT_PER_USER = '2';
    const alice = await signUp();
    await suggest(alice.token);
    await ask(alice.token);
    const third = await ask(alice.token);
    expect(third.status).toBe(429);
    expect(third.body.error).toMatch(/all 2 automatic answers/);
    expect(askQuestion).toHaveBeenCalledTimes(1);
  });

  it('checks the question, and answers 503 without a key or when the AI fails', async () => {
    const alice = await signUp();
    expect((await ask(alice.token, '  ')).status).toBe(400);
    expect((await ask(alice.token, 'x'.repeat(501))).status).toBe(400);

    askQuestion.mockRejectedValueOnce(new AiUnavailableError('down', { usage }));
    expect((await ask(alice.token)).status).toBe(503);
    expect((await pool.query("SELECT outcome FROM help_sessions WHERE kind = 'question'")).rows).toEqual([{ outcome: 'failed' }]);

    process.env.ANTHROPIC_API_KEY = '';
    expect((await ask(alice.token)).status).toBe(503);
  });

  it('GET /questions/mine lists only my answered questions, newest first', async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    await ask(alice.token, 'First?');
    await ask(alice.token, 'Second?');
    await ask(bob.token, "Bob's?");
    const res = await request(app).get('/api/help/questions/mine').set(bearer(alice.token));
    expect(res.body.questions.map((q) => q.question)).toEqual(['Second?', 'First?']);
  });

  it("stays out of Get help's unfinished list and can't be reopened there", async () => {
    const alice = await signUp();
    const { body } = await ask(alice.token);
    expect((await request(app).get('/api/help/mine').set(bearer(alice.token))).body.sessions).toEqual([]);
    expect((await request(app).get(`/api/help/${body.question.id}`).set(bearer(alice.token))).status).toBe(404);
  });

  it('counts questions per source on the staff list', async () => {
    const alice = await signUp();
    const tech = await signUpAs('technician', 'tech@example.com');
    const { body } = await ask(alice.token);
    await sendOutcome(alice.token, body.question.id, { outcome: 'fixed' });
    await suggest(alice.token); // a Get help request, left pending

    const res = await request(app).get('/api/help/sessions').set(bearer(tech.token));
    expect(res.body.counts.question).toMatchObject({ fixed: 1, pending: 0 });
    expect(res.body.counts.fix).toMatchObject({ fixed: 0, pending: 1 });
    expect(res.body.counts.all).toMatchObject({ fixed: 1, pending: 1 });
    expect(res.body.sessions.find((s) => s.kind === 'question')).toMatchObject({ answer: expect.stringContaining('Printers') });
  });
});

describe('Ask IT: "Did this answer your question?"', () => {
  it('"Yes, that helped" records the question as fixed', async () => {
    const alice = await signUp();
    const { body } = await ask(alice.token);
    const res = await sendOutcome(alice.token, body.question.id, { outcome: 'fixed' });
    expect(res.status).toBe(200);
    expect(res.body.question).toMatchObject({ outcome: 'fixed' });
    expect((await sessionRow(body.question.id)).finished_at).not.toBeNull();
  });

  it('"No" records it as still broken, without opening a ticket', async () => {
    const alice = await signUp();
    const { body } = await ask(alice.token);
    const res = await sendOutcome(alice.token, body.question.id, { outcome: 'still_broken' });
    expect(res.status).toBe(200);
    expect(res.body.question).toMatchObject({ outcome: 'still_broken' });
    expect(await count('tickets')).toBe(0);
  });

  it('takes one answer only, and none for a "needs a technician" question', async () => {
    const alice = await signUp();
    const { body } = await ask(alice.token);
    await sendOutcome(alice.token, body.question.id, { outcome: 'fixed' });
    expect((await sendOutcome(alice.token, body.question.id, { outcome: 'still_broken' })).status).toBe(409);

    questionAnswered({ answer: '', needs_technician: true, reason: 'Needs IT.' });
    const escalated = await ask(alice.token, 'How do I edit the registry?');
    expect((await sendOutcome(alice.token, escalated.body.question.id, { outcome: 'fixed' })).status).toBe(409);
  });

  it("is only for the person who asked", async () => {
    const alice = await signUp({ email: 'alice@example.com' });
    const bob = await signUp({ email: 'bob@example.com' });
    const { body } = await ask(alice.token);
    expect((await sendOutcome(bob.token, body.question.id, { outcome: 'fixed' })).status).toBe(404);
  });

  it('GET /questions/mine shows whether each one helped', async () => {
    const alice = await signUp();
    const first = await ask(alice.token, 'First?');
    await sendOutcome(alice.token, first.body.question.id, { outcome: 'still_broken' });
    await ask(alice.token, 'Second?');
    const res = await request(app).get('/api/help/questions/mine').set(bearer(alice.token));
    expect(res.body.questions.map((q) => [q.question, q.outcome])).toEqual([
      ['Second?', 'pending'],
      ['First?', 'still_broken'],
    ]);
  });
});
