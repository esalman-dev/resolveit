// Tests for the knowledge base: drafting an article (from a resolved ticket, or "Write with
// AI"), the safety check on publishing, who sees drafts, search and categories, "Missing
// articles", and how Get help uses articles (the AI check, "That fixed it", "Still broken").
//
// The AI functions are replaced with fakes, so nothing is sent or spent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';
import { askForFix, draftArticle, findMissingArticles, pickArticles, writeArticle, AiUnavailableError } from '../services/ai.js';
import { draftFromTicket } from '../routes/kb.js';

vi.mock('../services/ai.js', async (importOriginal) => ({
  ...(await importOriginal()),
  askForFix: vi.fn(),
  draftArticle: vi.fn(),
  writeArticle: vi.fn(),
  pickArticles: vi.fn(),
  findMissingArticles: vi.fn(),
}));

const usage = { input_tokens: 900, output_tokens: 300 };
const goodDraft = {
  skip: false,
  skip_reason: '',
  already_covered_id: 0,
  title: 'Outlook says Working Offline',
  problem: 'Outlook shows Working Offline at the bottom and new emails do not arrive.',
  also_called: ['email not arriving', 'outlook disconnected'],
  steps: [
    { title: 'Turn off Work Offline', detail: 'On the Send/Receive tab, click Work Offline so it is no longer highlighted.' },
    { title: 'Restart Outlook', detail: 'Close Outlook and open it again.' },
  ],
  if_still_broken: 'Note any error message, then use Get help.',
  suggested_category: 'Email',
};

/** Makes the fake AI draft `draft` (merged over a good one). */
const aiDrafts = (draft = {}) => draftArticle.mockResolvedValue({ answer: { ...goodDraft, ...draft }, refused: false, model: 'test', usage });
/** Makes the fake "Write with AI" answer `draft` (merged over a good one). */
const aiWrites = (draft = {}) => writeArticle.mockResolvedValue({ answer: { ...goodDraft, ...draft }, refused: false, model: 'test', usage });
/** Makes the fake article check keep `ids`. */
const aiPicks = (ids) => pickArticles.mockResolvedValue({ ids, model: 'test', usage });

let user, tech, admin;
beforeEach(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'; // AI "on"; the AI functions are fakes
  draftArticle.mockReset();
  writeArticle.mockReset();
  pickArticles.mockReset();
  findMissingArticles.mockReset();
  askForFix.mockReset();
  aiDrafts();
  aiWrites();
  // By default the check keeps every candidate, so tests that aren't about it see the word search.
  pickArticles.mockImplementation(async (problem, candidates) => ({ ids: candidates.map((a) => a.id).slice(0, 3), model: 'test', usage }));
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
    .send({ title: goodDraft.title, problem: goodDraft.problem, steps: goodDraft.steps, also_called: goodDraft.also_called, if_still_broken: goodDraft.if_still_broken, ...fields });
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
    expect(article).toMatchObject({
      status: 'draft',
      title: goodDraft.title,
      also_called: goodDraft.also_called,
      if_still_broken: goodDraft.if_still_broken,
      category_name: 'Email',
      created_by_name: 'Sam Rivera',
      flagged: false,
    });
  });

  it('shows the AI the published articles that look related, and skips a problem one already covers', async () => {
    const live = await publishedArticle();
    aiDrafts({ skip: true, skip_reason: 'Covered.', already_covered_id: live.id });
    const ticket = await ticketWithConversation();
    expect(await draftFromTicket(ticket.id, tech.user.id)).toEqual({ skipped: `Already covered by "${live.title}"` });
    expect(draftArticle.mock.calls[0][0].similar).toEqual([{ id: live.id, title: live.title }]);
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

  it('checks "If it still doesn\'t work" too', async () => {
    aiDrafts({ if_still_broken: 'Open regedit and delete the Outlook profile key.' });
    const ticket = await ticketWithConversation();
    const { article } = await draftFromTicket(ticket.id, tech.user.id);
    expect(article.flagged).toBe(true);
    expect((await request(app).post(`/api/kb/${article.id}/publish`).set(bearer(tech.token))).status).toBe(409);
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

  it('lists an article with the word in its title before one with it only in a step', async () => {
    const inStep = await publishedArticle({ title: 'Shared drive has a red X', problem: 'The drive will not open.', steps: [{ title: 'Connect the VPN', detail: 'Then open the drive.' }] });
    const inTitle = await publishedArticle({ title: 'VPN will not connect', problem: 'The app keeps trying.', also_called: [] });
    const found = (await request(app).get('/api/kb?q=vpn').set(bearer(user.token))).body.articles.map((a) => a.id);
    expect(found).toEqual([inTitle.id, inStep.id]);
  });

  it('finds articles by their "Also called" words', async () => {
    const live = await publishedArticle({ also_called: ['email stuck', 'no new mail'] });
    expect((await request(app).get('/api/kb?q=stuck').set(bearer(user.token))).body.articles.map((a) => a.id)).toEqual([live.id]);
  });

  it('lists published articles by category, with a count for each', async () => {
    const email = (await pool.query("SELECT id FROM categories WHERE name = 'Email'")).rows[0].id;
    const network = (await pool.query("SELECT id FROM categories WHERE name = 'Network'")).rows[0].id;
    const a = await publishedArticle({ category_id: email });
    await publishedArticle({ title: 'Wi-Fi drops', category_id: network });
    const res = await request(app).get(`/api/kb?category=${email}`).set(bearer(user.token));
    expect(res.body.articles.map((x) => x.id)).toEqual([a.id]);
    expect(res.body.categories).toEqual([
      { id: email, name: 'Email', count: 1 },
      { id: network, name: 'Network', count: 1 },
    ]);
    expect((await request(app).get('/api/kb?category=abc').set(bearer(user.token))).status).toBe(400);
  });
});

describe('Write with AI', () => {
  const write = (token, problem = 'Outlook stuck offline') => request(app).post('/api/kb/write').set(bearer(token)).send({ problem });

  it('saves the AI\'s article as a draft for staff to check', async () => {
    const res = await write(tech.token);
    expect(res.status).toBe(201);
    expect(res.body.article).toMatchObject({ status: 'draft', title: goodDraft.title, also_called: goodDraft.also_called, created_by_name: 'Sam Rivera' });
    expect(writeArticle.mock.calls[0][0].problem).toBe('Outlook stuck offline');
  });

  it('points to the published article that already covers it, and saves nothing', async () => {
    const live = await publishedArticle();
    aiWrites({ skip: true, skip_reason: 'Covered.', already_covered_id: live.id });
    const res = await write(tech.token);
    expect(res.status).toBe(200);
    expect(res.body.covered.id).toBe(live.id);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM kb_articles WHERE status = 'draft'")).rows[0].n).toBe(0);
  });

  it('ignores a "covered by" number that isn\'t one of the related articles', async () => {
    aiWrites({ skip: true, skip_reason: 'Only IT can grant access.', already_covered_id: 999 });
    const res = await write(tech.token, 'Need access to the finance drive');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only IT can grant access.');
  });

  it('is for staff only, and says so when the AI is down', async () => {
    expect((await write(user.token)).status).toBe(403);
    writeArticle.mockRejectedValue(new AiUnavailableError('down'));
    expect((await write(tech.token)).status).toBe(503);
  });
});

describe('Missing articles', () => {
  /** Saves finished Get help requests with these titles (no article helped). */
  async function requests(...titles) {
    for (const title of titles) {
      await pool.query("INSERT INTO help_sessions (user_id, kind, title, description, outcome, finished_at) VALUES ($1, 'fix', $2, 'x', 'fixed', NOW())", [user.user.id, title]);
    }
  }

  it('sends recent unhelped request titles and the article titles to the AI, and returns its groups', async () => {
    await publishedArticle();
    await requests('VPN drops at home', 'VPN keeps disconnecting', 'Teams camera black');
    await pool.query("INSERT INTO help_sessions (user_id, kind, title, description, outcome) VALUES ($1, 'fix', 'Still deciding', 'x', 'pending')", [user.user.id]);
    const groups = [{ problem: 'VPN keeps dropping', count: 2, examples: ['VPN drops at home'] }];
    findMissingArticles.mockResolvedValue({ groups, model: 'test', usage });
    const res = await request(app).post('/api/kb/missing').set(bearer(tech.token));
    expect(res.body).toEqual({ groups, request_count: 3 });
    const sent = findMissingArticles.mock.calls[0][0];
    expect(sent.requests.sort()).toEqual(['Teams camera black', 'VPN drops at home', 'VPN keeps disconnecting']);
    expect(sent.articles).toEqual([goodDraft.title]);
  });

  it('leaves out tickets that belong to an outage', async () => {
    await requests('VPN drops at home', 'VPN keeps disconnecting', 'Teams camera black');
    const network = (await pool.query("SELECT id FROM categories WHERE name = 'Network'")).rows[0].id;
    const outage = (await pool.query('INSERT INTO outages (category_id) VALUES ($1) RETURNING id', [network])).rows[0].id;
    const ticket = (await request(app).post('/api/tickets').set(bearer(user.token)).send({ title: 'Floor 2 network down', description: 'Nothing loads.' })).body.ticket;
    await pool.query('UPDATE tickets SET outage_id = $1 WHERE id = $2', [outage, ticket.id]);
    findMissingArticles.mockResolvedValue({ groups: [], model: 'test', usage });
    await request(app).post('/api/kb/missing').set(bearer(tech.token));
    expect(findMissingArticles.mock.calls[0][0].requests).not.toContain('Floor 2 network down');
  });

  it("doesn't ask the AI with fewer than 3 requests, and is staff only", async () => {
    await requests('One thing');
    expect((await request(app).post('/api/kb/missing').set(bearer(tech.token))).body).toEqual({ groups: [], request_count: 1 });
    expect(findMissingArticles).not.toHaveBeenCalled();
    expect((await request(app).post('/api/kb/missing').set(bearer(user.token))).status).toBe(403);
  });
});

describe('Get help with articles', () => {
  const problem = { title: 'Outlook working offline', description: 'Outlook says working offline and no new emails arrive.' };

  const match = (body = problem) => request(app).post('/api/help/match').set(bearer(user.token)).send(body);

  it('matches articles before asking for AI steps', async () => {
    const live = await publishedArticle();
    const res = await match();
    expect(res.body.articles.map((a) => a.id)).toEqual([live.id]);
    expect(res.body.articles[0]).toMatchObject({ also_called: goodDraft.also_called, if_still_broken: goodDraft.if_still_broken });
    expect(askForFix).not.toHaveBeenCalled();
  });

  it('skips the AI check when no article shares a word', async () => {
    await publishedArticle();
    expect((await match({ title: 'Printer jammed', description: 'Paper stuck in tray 2.' })).body.articles).toEqual([]);
    expect(pickArticles).not.toHaveBeenCalled();
  });

  it('shows only the articles the AI check keeps, in its order', async () => {
    const wifi = await publishedArticle({ title: 'Wi-Fi offline after password change', problem: 'Wi-Fi says offline.' });
    const outlook = await publishedArticle();
    aiPicks([outlook.id]);
    expect((await match()).body.articles.map((a) => a.id)).toEqual([outlook.id]);
    expect(pickArticles.mock.calls[0][1].map((a) => a.id).sort()).toEqual([wifi.id, outlook.id].sort()); // both were shortlisted
    aiPicks([]);
    expect((await match()).body.articles).toEqual([]);
  });

  it('falls back to the strict word match when the AI check is unavailable', async () => {
    const live = await publishedArticle();
    pickArticles.mockRejectedValue(new AiUnavailableError('down'));
    expect((await match()).body.articles.map((a) => a.id)).toEqual([live.id]);
    // One shared word isn't enough for the strict rule.
    expect((await match({ title: 'Outlook', description: 'Help with my calendar please.' })).body.articles).toEqual([]);
  });

  it('opens a ticket from "Still broken", with the steps listed as tried', async () => {
    const email = (await pool.query("SELECT id FROM categories WHERE name = 'Email'")).rows[0].id;
    const live = await publishedArticle({ category_id: email });
    process.env.AI_DAILY_LIMIT_PER_USER = '0'; // no AI is used, so the limit doesn't apply
    const res = await request(app).post('/api/help/article-broken').set(bearer(user.token)).send({ article_id: live.id, details: 'Still offline after both.', tried: [0] });
    expect(res.status).toBe(201);
    const ticket = (await request(app).get(`/api/tickets/${res.body.ticket_id}`).set(bearer(user.token))).body.ticket;
    expect(ticket).toMatchObject({ title: live.title, description: 'Still offline after both.', category_id: email });
    expect(ticket.steps_tried.map((s) => s.tried)).toEqual([true, false]);
    const session = (await pool.query('SELECT outcome, article_id, ticket_id FROM help_sessions')).rows[0];
    expect(session).toEqual({ outcome: 'still_broken', article_id: live.id, ticket_id: res.body.ticket_id });
    const created = (await pool.query("SELECT new_value FROM ticket_events WHERE ticket_id = $1 AND action = 'created'", [res.body.ticket_id])).rows[0];
    expect(created.new_value).toBe('knowledge_base'); // the history says it came from an article
    expect((await pool.query('SELECT not_helpful_count FROM kb_articles')).rows[0].not_helpful_count).toBe(1);
  });

  it('writes a description for "Still broken" when none is given, and refuses a draft', async () => {
    const live = await publishedArticle();
    const res = await request(app).post('/api/help/article-broken').set(bearer(user.token)).send({ article_id: live.id });
    const ticket = (await request(app).get(`/api/tickets/${res.body.ticket_id}`).set(bearer(user.token))).body.ticket;
    expect(ticket.description).toMatch(/followed the knowledge base article/);
    expect(ticket.steps_tried.every((s) => s.tried)).toBe(true);
    const draft = (await request(app).post('/api/kb').set(bearer(tech.token)).send({ title: 'x', problem: 'y', steps: goodDraft.steps })).body.article;
    expect((await request(app).post('/api/help/article-broken').set(bearer(user.token)).send({ article_id: draft.id })).status).toBe(404);
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
