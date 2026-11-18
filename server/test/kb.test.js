// Tests for the knowledge base: drafting an article when a ticket is resolved, the safety check
// on publishing, who sees drafts, search, and how Get help uses articles.
//
// The AI (draftArticle and askForFix) is replaced with fakes, so nothing is sent or spent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';
import { askForFix, draftArticle } from '../services/ai.js';
import { draftFromTicket } from '../routes/kb.js';

vi.mock('../services/ai.js', async (importOriginal) => ({
  ...(await importOriginal()),
  askForFix: vi.fn(),
  draftArticle: vi.fn(),
}));

const usage = { input_tokens: 900, output_tokens: 300 };
const goodDraft = {
  skip: false,
  skip_reason: '',
  title: 'Outlook says Working Offline',
  problem: 'Outlook shows Working Offline at the bottom and new emails do not arrive.',
  steps: [
    { title: 'Turn off Work Offline', detail: 'On the Send/Receive tab, click Work Offline so it is no longer highlighted.' },
    { title: 'Restart Outlook', detail: 'Close Outlook and open it again.' },
  ],
  suggested_category: 'Email',
};

/** Makes the fake AI draft `draft` (merged over a good one). */
const aiDrafts = (draft = {}) => draftArticle.mockResolvedValue({ answer: { ...goodDraft, ...draft }, refused: false, model: 'test', usage });

let user, tech, admin;
beforeEach(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'; // AI "on"; the AI functions are fakes
  draftArticle.mockReset();
  askForFix.mockReset();
  aiDrafts();
  askForFix.mockResolvedValue({
    answer: { escalate: false, reason: '', steps: [{ title: 'Restart the app', detail: 'Close and reopen it.' }, { title: 'Sign out and in', detail: 'Then try again.' }], suggested_category: '', suggested_priority: 'medium' },
    refused: false,
    model: 'test',
    usage,
  });
  user = await signUp({ name: 'Jo Smith', email: 'jo@example.com' });
  tech = await signUp({ name: 'Sam Rivera', email: 'sam@example.com' });
  admin = await signUp({ name: 'Ada', email: 'ada@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [tech.user.id]);
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.user.id]);
  await pool.query("INSERT INTO categories (name) VALUES ('Email'), ('Network')");
});

afterEach(() => {
  delete process.env.AI_DAILY_LIMIT_PER_USER;
});

/** A ticket from Jo with a public reply and an internal note. */
async function ticketWithConversation() {
  const ticket = (await request(app).post('/api/tickets').set(bearer(user.token)).send({ title: 'Outlook offline', description: 'No new email since 9' })).body.ticket;
  await request(app).post(`/api/tickets/${ticket.id}/comments`).set(bearer(tech.token)).send({ body: 'Click Work Offline on the Send/Receive tab.' });
  await request(app).post(`/api/tickets/${ticket.id}/comments`).set(bearer(tech.token)).send({ body: 'Jo has a weird VPN setup, secret note', is_internal: true });
  return ticket;
}

const resolve = (id, draft = true) =>
  request(app).patch(`/api/tickets/${id}`).set(bearer(tech.token)).send({ status: 'resolved', draft_article: draft });

/** Publishes a fresh article and returns it. */
async function publishedArticle(fields = {}) {
  const created = await request(app)
    .post('/api/kb')
    .set(bearer(tech.token))
    .send({ title: goodDraft.title, problem: goodDraft.problem, steps: goodDraft.steps, ...fields });
  return (await request(app).post(`/api/kb/${created.body.article.id}/publish`).set(bearer(tech.token))).body.article;
}

describe('drafting from a resolved ticket', () => {
  it('drafts an article in the background when staff resolve with the box ticked', async () => {
    const ticket = await ticketWithConversation();
    const res = await resolve(ticket.id);
    expect(res.body.article_drafting).toBe(true);
    await vi.waitFor(async () => {
      const drafts = await request(app).get('/api/kb?status=draft').set(bearer(tech.token));
      expect(drafts.body.articles).toHaveLength(1);
    });
    const article = (await request(app).get(`/api/kb?source_ticket=${ticket.id}`).set(bearer(tech.token))).body.articles[0];
    expect(article).toMatchObject({ status: 'draft', title: goodDraft.title, category_name: 'Email', created_by_name: 'Sam Rivera', flagged: false });
  });

  it('sends the AI public comments only, with roles instead of names', async () => {
    const ticket = await ticketWithConversation();
    await draftFromTicket(ticket.id, tech.user.id);
    const sent = draftArticle.mock.calls[0][0];
    expect(sent.comments).toEqual([{ from: 'Technician', body: 'Click Work Offline on the Send/Receive tab.' }]);
    expect(JSON.stringify(sent)).not.toMatch(/secret note|Jo Smith|Sam Rivera|example\.com/);
  });

  it("doesn't draft when the box is unticked, or twice for one ticket", async () => {
    const ticket = await ticketWithConversation();
    await resolve(ticket.id, false);
    expect(draftArticle).not.toHaveBeenCalled();
    await draftFromTicket(ticket.id, tech.user.id);
    expect((await draftFromTicket(ticket.id, tech.user.id)).skipped).toMatch(/already/);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM kb_articles')).rows[0].n).toBe(1);
  });

  it('saves nothing when the AI says there is nothing reusable', async () => {
    aiDrafts({ skip: true, skip_reason: 'Only IT can grant access.' });
    const ticket = await ticketWithConversation();
    expect(await draftFromTicket(ticket.id, tech.user.id)).toEqual({ skipped: 'Only IT can grant access.' });
  });
});

describe('publishing', () => {
  it('flags a risky draft and refuses to publish it until the step is fixed', async () => {
    aiDrafts({ steps: [{ title: 'Open regedit', detail: 'Change the Outlook key.' }, ...goodDraft.steps] });
    const ticket = await ticketWithConversation();
    const { article } = await draftFromTicket(ticket.id, tech.user.id);
    expect(article.flagged).toBe(true);

    const refused = await request(app).post(`/api/kb/${article.id}/publish`).set(bearer(tech.token));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/registry/);

    await request(app).patch(`/api/kb/${article.id}`).set(bearer(tech.token)).send({ steps: goodDraft.steps });
    const ok = await request(app).post(`/api/kb/${article.id}/publish`).set(bearer(tech.token));
    expect(ok.body.article).toMatchObject({ status: 'published', flagged: false, published_by_name: 'Sam Rivera' });
  });

  it("won't let a published article be edited into something risky", async () => {
    const article = await publishedArticle();
    const res = await request(app).patch(`/api/kb/${article.id}`).set(bearer(tech.token)).send({ steps: [{ title: 'Run cmd', detail: 'ipconfig /flushdns' }] });
    expect(res.status).toBe(409);
  });

  it('lets only staff write, and only admins archive and restore', async () => {
    expect((await request(app).post('/api/kb').set(bearer(user.token)).send({ title: 'x', problem: 'y', steps: goodDraft.steps })).status).toBe(403);
    const article = await publishedArticle();
    expect((await request(app).post(`/api/kb/${article.id}/archive`).set(bearer(tech.token))).status).toBe(403);
    expect((await request(app).post(`/api/kb/${article.id}/archive`).set(bearer(admin.token))).body.article.status).toBe('archived');
    expect((await request(app).post(`/api/kb/${article.id}/publish`).set(bearer(tech.token))).status).toBe(403);
    expect((await request(app).post(`/api/kb/${article.id}/publish`).set(bearer(admin.token))).body.article.status).toBe('published');
  });

  it('discards drafts but never published articles', async () => {
    const draft = (await request(app).post('/api/kb').set(bearer(tech.token)).send({ title: 'x', problem: 'y', steps: goodDraft.steps })).body.article;
    expect((await request(app).delete(`/api/kb/${draft.id}`).set(bearer(tech.token))).status).toBe(204);
    const live = await publishedArticle();
    expect((await request(app).delete(`/api/kb/${live.id}`).set(bearer(admin.token))).status).toBe(404);
  });
});

describe('reading and searching', () => {
  it('shows users only published articles', async () => {
    const draft = (await request(app).post('/api/kb').set(bearer(tech.token)).send({ title: 'Secret draft', problem: 'y', steps: goodDraft.steps })).body.article;
    const live = await publishedArticle();
    expect((await request(app).get(`/api/kb/${draft.id}`).set(bearer(user.token))).status).toBe(404);
    expect((await request(app).get(`/api/kb?status=draft`).set(bearer(user.token))).body.articles.map((a) => a.id)).toEqual([live.id]);
  });

  it('finds articles by words, including other forms of the word', async () => {
    const live = await publishedArticle();
    const found = (await request(app).get('/api/kb?q=offline emails').set(bearer(user.token))).body.articles;
    expect(found.map((a) => a.id)).toEqual([live.id]);
    expect((await request(app).get('/api/kb?q=printer jammed').set(bearer(user.token))).body.articles).toEqual([]);
  });

  it('counts "Was this helpful?"', async () => {
    const live = await publishedArticle();
    await request(app).post(`/api/kb/${live.id}/feedback`).set(bearer(user.token)).send({ helpful: true });
    await request(app).post(`/api/kb/${live.id}/feedback`).set(bearer(user.token)).send({ helpful: false });
    const row = (await pool.query('SELECT helpful_count, not_helpful_count FROM kb_articles')).rows[0];
    expect(row).toEqual({ helpful_count: 1, not_helpful_count: 1 });
  });
});

describe('Get help with articles', () => {
  const problem = { title: 'Outlook working offline', description: 'Outlook says working offline and no new emails arrive.' };

  it('matches articles before the AI, without calling it', async () => {
    const live = await publishedArticle();
    const res = await request(app).post('/api/help/match').set(bearer(user.token)).send(problem);
    expect(res.body.articles.map((a) => a.id)).toEqual([live.id]);
    const none = await request(app).post('/api/help/match').set(bearer(user.token)).send({ title: 'Printer jammed', description: 'Paper stuck in tray 2.' });
    expect(none.body.articles).toEqual([]);
    expect(askForFix).not.toHaveBeenCalled();
  });

  it('records "That fixed it" as fixed, without using the daily limit', async () => {
    process.env.AI_DAILY_LIMIT_PER_USER = '1';
    const live = await publishedArticle();
    const fixed = await request(app).post('/api/help/article-fixed').set(bearer(user.token)).send({ article_id: live.id, ...problem });
    expect(fixed.status).toBe(201);
    expect(fixed.body.session.outcome).toBe('fixed');
    await request(app).post('/api/help/article-fixed').set(bearer(user.token)).send({ article_id: live.id, ...problem });
    expect((await request(app).post('/api/help/suggest').set(bearer(user.token)).send(problem)).status).toBe(200); // limit 1 still free
    expect((await pool.query('SELECT helpful_count FROM kb_articles')).rows[0].helpful_count).toBe(2);
  });

  it('gives the AI the best articles as background, and counts passed-on ones as not helpful', async () => {
    const live = await publishedArticle();
    await request(app).post('/api/help/suggest').set(bearer(user.token)).send({ ...problem, skipped_article_ids: [live.id] });
    expect(askForFix.mock.calls[0][0].articles).toEqual([{ title: live.title, steps: live.steps }]);
    expect((await pool.query('SELECT not_helpful_count FROM kb_articles')).rows[0].not_helpful_count).toBe(1);
  });
});
