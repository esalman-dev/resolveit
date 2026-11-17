// Tests for screenshots and files on Get help requests: sending images to the AI, moving files
// onto the ticket a request opens, and giving them back when the AI fails.
//
// askForFix is replaced with a fake, so nothing is sent to the real AI.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';
import { askForFix, AiUnavailableError } from '../services/ai.js';

vi.mock('../services/ai.js', async (importOriginal) => ({
  ...(await importOriginal()),
  askForFix: vi.fn(),
}));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 7)]);
const LOG = Buffer.from('ERROR 0x8007 printer spooler stopped\n');
const usage = { input_tokens: 1200, output_tokens: 300 };

const steps = [
  { title: 'Restart the printer', detail: 'Turn it off for 30 seconds.' },
  { title: 'Clear the print queue', detail: 'Cancel the stuck job.' },
];

/** Makes the fake AI give steps, or send the problem to a technician. */
function aiAnswers({ escalate = false } = {}) {
  askForFix.mockResolvedValue({
    answer: { escalate, reason: escalate ? 'Needs a technician.' : '', steps: escalate ? [] : steps, suggested_category: '', suggested_priority: 'medium' },
    refused: false,
    model: 'test-model',
    usage,
  });
}

const upload = (token, data, name) =>
  request(app).post('/api/attachments').set(bearer(token)).attach('file', data, name);

const suggest = (token, attachment_ids) =>
  request(app)
    .post('/api/help/suggest')
    .set(bearer(token))
    .send({ title: 'Printer error', description: 'See the screenshot.', attachment_ids });

let jo;
beforeEach(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'; // turns AI help on; askForFix is fake
  askForFix.mockReset();
  aiAnswers();
  jo = await signUp({ name: 'Jo', email: 'jo@example.com' });
});

describe('screenshots on Get help', () => {
  it('sends images to the AI, but not text logs', async () => {
    const image = (await upload(jo.token, PNG, 'error.png')).body.attachment;
    const log = (await upload(jo.token, LOG, 'spooler.log')).body.attachment;
    expect((await suggest(jo.token, [image.id, log.id])).status).toBe(200);

    const sent = askForFix.mock.calls[0][0];
    expect(sent.images).toEqual([{ media_type: 'image/png', data: PNG.toString('base64') }]);
  });

  it('sends no images when none are attached', async () => {
    await suggest(jo.token);
    expect(askForFix.mock.calls[0][0].images).toEqual([]);
  });

  it('moves the files onto the ticket when the steps did not work', async () => {
    const image = (await upload(jo.token, PNG, 'error.png')).body.attachment;
    const session = (await suggest(jo.token, [image.id])).body.session;
    const outcome = await request(app)
      .post(`/api/help/${session.id}/outcome`)
      .set(bearer(jo.token))
      .send({ outcome: 'still_broken' });

    const list = await request(app).get(`/api/tickets/${outcome.body.ticket_id}/attachments`).set(bearer(jo.token));
    expect(list.body.attachments.map((a) => a.id)).toEqual([image.id]);
  });

  it('moves the files onto the ticket when it goes straight to a technician', async () => {
    aiAnswers({ escalate: true });
    const image = (await upload(jo.token, PNG, 'error.png')).body.attachment;
    const res = await suggest(jo.token, [image.id]);
    expect(res.status).toBe(201);
    const list = await request(app).get(`/api/tickets/${res.body.ticket_id}/attachments`).set(bearer(jo.token));
    expect(list.body.attachments).toHaveLength(1);
  });

  it('gives the files back when the AI fails, so the plain ticket form can use them', async () => {
    askForFix.mockRejectedValue(new AiUnavailableError('down'));
    const image = (await upload(jo.token, PNG, 'error.png')).body.attachment;
    expect((await suggest(jo.token, [image.id])).status).toBe(503);

    const ticket = await request(app)
      .post('/api/tickets')
      .set(bearer(jo.token))
      .send({ title: 'Printer error', description: 'See the screenshot.', attachment_ids: [image.id] });
    expect(ticket.status).toBe(201);
  });

  it('shows the files when an unfinished request is reopened', async () => {
    const image = (await upload(jo.token, PNG, 'error.png')).body.attachment;
    const session = (await suggest(jo.token, [image.id])).body.session;
    const reopened = await request(app).get(`/api/help/${session.id}`).set(bearer(jo.token));
    expect(reopened.body.session.attachments).toEqual([expect.objectContaining({ id: image.id, name: 'error.png' })]);
  });

  it('lets staff open the screenshots of a request that was fixed', async () => {
    const image = (await upload(jo.token, PNG, 'error.png')).body.attachment;
    const session = (await suggest(jo.token, [image.id])).body.session;
    await request(app).post(`/api/help/${session.id}/outcome`).set(bearer(jo.token)).send({ outcome: 'fixed' });

    const sam = await signUp({ name: 'Sam', email: 'sam@example.com' });
    const eve = await signUp({ name: 'Eve', email: 'eve@example.com' });
    await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [sam.user.id]);
    expect((await request(app).get(`/api/attachments/${image.id}`).set(bearer(sam.token))).status).toBe(200);
    expect((await request(app).get(`/api/attachments/${image.id}`).set(bearer(eve.token))).status).toBe(404);
  });

  it("refuses someone else's file", async () => {
    const eve = await signUp({ name: 'Eve', email: 'eve@example.com' });
    const theirs = (await upload(eve.token, PNG, 'x.png')).body.attachment;
    expect((await suggest(jo.token, [theirs.id])).status).toBe(400);
    expect(askForFix).not.toHaveBeenCalled();
  });
});
