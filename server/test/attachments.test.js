// Tests for attachments: uploading, the file-type and size checks, attaching files to tickets
// and comments, and who can open them.

import { describe, it, expect, afterEach } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';

// Only the first bytes decide the type, so a magic-bytes header plus filler is a valid "file".
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const PDF = Buffer.from('%PDF-1.7\nfake pdf body');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 0)]); // a Windows program

/** Uploads a file as this user and returns the response. */
const upload = (token, data = PNG, name = 'error.png') =>
  request(app).post('/api/attachments').set(bearer(token)).attach('file', data, name);

/** Signs up a user and a technician. */
async function people() {
  const user = await signUp({ name: 'Jo', email: 'jo@example.com' });
  const tech = await signUp({ name: 'Sam', email: 'sam@example.com' });
  await pool.query("UPDATE users SET role = 'technician' WHERE id = $1", [tech.user.id]);
  const other = await signUp({ name: 'Eve', email: 'eve@example.com' });
  return { user, tech, other };
}

/** Opens a ticket with these files attached. */
const openTicket = (token, attachment_ids = []) =>
  request(app)
    .post('/api/tickets')
    .set(bearer(token))
    .send({ title: 'Printer error', description: 'See the screenshot', attachment_ids });

afterEach(() => {
  delete process.env.ATTACHMENT_DAILY_LIMIT;
});

describe('POST /api/attachments', () => {
  it('stores an image and returns it without the storage key', async () => {
    const { user } = await people();
    const res = await upload(user.token, PNG, 'C:\\Users\\jo\\Desktop\\error.png');
    expect(res.status).toBe(201);
    expect(res.body.attachment).toMatchObject({ name: 'error.png', content_type: 'image/png', size_bytes: PNG.length });
    expect(JSON.stringify(res.body)).not.toContain('storage_key');
  });

  it('reads the real type from the file, not its name', async () => {
    const { user } = await people();
    expect((await upload(user.token, EXE, 'photo.png')).status).toBe(415);
    expect((await upload(user.token, PDF, 'scan.png')).body.attachment.content_type).toBe('application/pdf');
  });

  it('accepts text logs only with a .txt or .log name', async () => {
    const { user } = await people();
    const log = Buffer.from('2026-11-17 ERROR printer offline\n');
    expect((await upload(user.token, log, 'printer.log')).body.attachment.content_type).toBe('text/plain');
    expect((await upload(user.token, log, 'printer.html')).status).toBe(415);
  });

  it('refuses files over 5 MB', async () => {
    const { user } = await people();
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(user.token, big)).status).toBe(413);
  });

  it('refuses a request with no file', async () => {
    const { user } = await people();
    const res = await request(app).post('/api/attachments').set(bearer(user.token));
    expect(res.status).toBe(400);
  });

  it('enforces the daily upload limit', async () => {
    process.env.ATTACHMENT_DAILY_LIMIT = '2';
    const { user } = await people();
    await upload(user.token);
    await upload(user.token);
    expect((await upload(user.token)).status).toBe(429);
  });

  it('removes unsent uploads older than a day on the next upload', async () => {
    const { user } = await people();
    const old = (await upload(user.token)).body.attachment;
    await pool.query("UPDATE attachments SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1", [old.id]);
    await upload(user.token);
    const left = await pool.query('SELECT id FROM attachments WHERE id = $1', [old.id]);
    expect(left.rows).toHaveLength(0);
  });

  it('needs a login', async () => {
    expect((await request(app).post('/api/attachments').attach('file', PNG, 'a.png')).status).toBe(401);
  });
});

describe('attaching files', () => {
  it('attaches files to a new ticket and lists them', async () => {
    const { user } = await people();
    const file = (await upload(user.token)).body.attachment;
    const ticket = (await openTicket(user.token, [file.id])).body.ticket;

    const list = await request(app).get(`/api/tickets/${ticket.id}/attachments`).set(bearer(user.token));
    expect(list.body.attachments).toEqual([expect.objectContaining({ id: file.id, comment_id: null, uploaded_by_name: 'Jo' })]);
  });

  it("refuses someone else's file, a file already sent, and more than 3 files", async () => {
    const { user, other } = await people();
    const theirs = (await upload(other.token)).body.attachment;
    expect((await openTicket(user.token, [theirs.id])).status).toBe(400);

    const mine = (await upload(user.token)).body.attachment;
    expect((await openTicket(user.token, [mine.id])).status).toBe(201);
    expect((await openTicket(user.token, [mine.id])).status).toBe(400);

    const four = [];
    for (let i = 0; i < 4; i++) four.push((await upload(user.token)).body.attachment.id);
    expect((await openTicket(user.token, four)).status).toBe(400);
  });

  it('saves nothing when the ticket is invalid', async () => {
    const { user } = await people();
    const file = (await upload(user.token)).body.attachment;
    const res = await request(app).post('/api/tickets').set(bearer(user.token)).send({ title: '', attachment_ids: [file.id] });
    expect(res.status).toBe(400);
    const row = await pool.query('SELECT attached_at FROM attachments WHERE id = $1', [file.id]);
    expect(row.rows[0].attached_at).toBeNull();
  });

  it('attaches files to a comment', async () => {
    const { user } = await people();
    const ticket = (await openTicket(user.token)).body.ticket;
    const file = (await upload(user.token)).body.attachment;
    const comment = await request(app)
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(bearer(user.token))
      .send({ body: 'Here is the error', attachment_ids: [file.id] });
    expect(comment.status).toBe(201);

    const list = await request(app).get(`/api/tickets/${ticket.id}/attachments`).set(bearer(user.token));
    expect(list.body.attachments[0].comment_id).toBe(comment.body.comment.id);
  });
});

describe('who can open a file', () => {
  it('lets only the uploader open a file that has not been sent', async () => {
    const { user, tech } = await people();
    const file = (await upload(user.token)).body.attachment;
    expect((await request(app).get(`/api/attachments/${file.id}`).set(bearer(user.token))).status).toBe(200);
    expect((await request(app).get(`/api/attachments/${file.id}`).set(bearer(tech.token))).status).toBe(404);
  });

  it("follows the ticket's rule: its creator and staff, not other users", async () => {
    const { user, tech, other } = await people();
    const file = (await upload(user.token)).body.attachment;
    await openTicket(user.token, [file.id]);
    const get = (token) => request(app).get(`/api/attachments/${file.id}`).set(bearer(token));
    expect((await get(user.token)).status).toBe(200);
    expect((await get(tech.token)).status).toBe(200);
    expect((await get(other.token)).status).toBe(404);
  });

  it('keeps files on internal notes from users', async () => {
    const { user, tech } = await people();
    const ticket = (await openTicket(user.token)).body.ticket;
    const file = (await upload(tech.token)).body.attachment;
    await request(app)
      .post(`/api/tickets/${ticket.id}/comments`)
      .set(bearer(tech.token))
      .send({ body: 'Driver log', is_internal: true, attachment_ids: [file.id] });

    expect((await request(app).get(`/api/attachments/${file.id}`).set(bearer(user.token))).status).toBe(404);
    const userList = await request(app).get(`/api/tickets/${ticket.id}/attachments`).set(bearer(user.token));
    expect(userList.body.attachments).toEqual([]);
    const techList = await request(app).get(`/api/tickets/${ticket.id}/attachments`).set(bearer(tech.token));
    expect(techList.body.attachments).toHaveLength(1);
  });

  it('sends the file with headers that stop the browser from running it', async () => {
    const { user } = await people();
    const image = (await upload(user.token)).body.attachment;
    const res = await request(app).get(`/api/attachments/${image.id}`).set(bearer(user.token));
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename\*=UTF-8''error\.png$/);
    expect(Buffer.compare(res.body, PNG)).toBe(0);

    const pdf = (await upload(user.token, PDF, 'scan.pdf')).body.attachment;
    const download = await request(app).get(`/api/attachments/${pdf.id}`).set(bearer(user.token));
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
  });
});

describe('DELETE /api/attachments/:id', () => {
  it('removes a file before it is sent, but not after', async () => {
    const { user } = await people();
    const draft = (await upload(user.token)).body.attachment;
    expect((await request(app).delete(`/api/attachments/${draft.id}`).set(bearer(user.token))).status).toBe(204);

    const sent = (await upload(user.token)).body.attachment;
    await openTicket(user.token, [sent.id]);
    expect((await request(app).delete(`/api/attachments/${sent.id}`).set(bearer(user.token))).status).toBe(404);
  });

  it("can't remove someone else's file", async () => {
    const { user, other } = await people();
    const file = (await upload(user.token)).body.attachment;
    expect((await request(app).delete(`/api/attachments/${file.id}`).set(bearer(other.token))).status).toBe(404);
  });
});
