// Tests for keeping attachment files in the database (FILE_STORAGE=database), as on the live
// site, whose free server wipes its disk on every restart.

import { describe, it, expect, afterEach } from 'vitest';
import { app, pool, request, signUp, bearer } from './helpers.js';
import { newStorageKey, readFile, removeFile, saveFile } from '../services/storage.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);

afterEach(() => {
  delete process.env.FILE_STORAGE;
});

describe('files in the database', () => {
  it('saves, reads and removes a file, and never overwrites one', async () => {
    process.env.FILE_STORAGE = 'database';
    const key = newStorageKey();
    await saveFile(key, PNG);
    expect(Buffer.compare(await readFile(key), PNG)).toBe(0);
    await expect(saveFile(key, Buffer.from('other'))).rejects.toThrow();
    await removeFile(key);
    await expect(readFile(key)).rejects.toMatchObject({ code: 'ENOENT' });
    await removeFile(key); // already gone: not an error
    await expect(saveFile('../../.env', PNG)).rejects.toThrow('Invalid storage key');
  });

  it('serves an uploaded screenshot from the database, with no file on disk', async () => {
    process.env.FILE_STORAGE = 'database';
    const jo = await signUp({ email: 'jo@example.com' });
    const uploaded = (await request(app).post('/api/attachments').set(bearer(jo.token)).attach('file', PNG, 'error.png')).body.attachment;
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM stored_files')).rows[0].n).toBe(1);
    const res = await request(app).get(`/api/attachments/${uploaded.id}`).set(bearer(jo.token)).buffer(true).parse((r, cb) => {
      const parts = [];
      r.on('data', (c) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, PNG)).toBe(0);
  });
});
