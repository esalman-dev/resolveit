// Attachments API: upload a screenshot or file, download it, or remove it before it's sent.
//
// A file is uploaded first and attached second. POST /api/attachments stores it and returns its
// id; sending a ticket, comment or Get help request with `attachment_ids` then claims it
// (claimAttachments below). Until then only the uploader can see it, and unclaimed files are
// removed after a day.
//
// Who can open a file: whoever can see what it's attached to. Files on a ticket follow the
// ticket's rule (its creator, or staff); files on an internal note are staff-only; files on a
// Get help request are for the person who asked, and staff.
//
// Mounted at /api/attachments (see app.js).

import { Router } from 'express';
import multer from 'multer';
import pool from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF } from '../roles.js';
import { detectType, cleanFileName } from '../services/fileCheck.js';
import { newStorageKey, saveFile, readFile, removeFile } from '../services/storage.js';
import { parseId } from './tickets.js';

const router = Router();

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_FILES_PER_ITEM = 3; // per comment, ticket or Get help request

/** Uploads allowed per person per rolling 24 hours (ATTACHMENT_DAILY_LIMIT in .env). */
const dailyLimit = () => Number(process.env.ATTACHMENT_DAILY_LIMIT) || 30;

const TYPE_ERROR = 'Only images (PNG, JPG, WebP, GIF), PDF and text logs (.txt, .log) can be attached';

// Why memory storage: the file is checked before anything is written, so a refused file never
// touches the disk. The size limit is enforced while the file arrives: multer stops reading at
// 5 MB, so nobody can make the server read a 2 GB "screenshot".
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0 },
}).single('file');

router.use(requireAuth, requireRole(...ROLES));

/** True for technicians, admins and owners. */
const isStaff = (user) => STAFF.includes(user.role);

// --- Helpers shared with the ticket and help routes ---

/** An attachment as the browser sees it. The storage key never leaves the server. */
export const publicAttachment = (row) => ({
  id: row.id,
  name: row.original_name,
  content_type: row.content_type,
  size_bytes: row.size_bytes,
  comment_id: row.comment_id ?? null,
  uploaded_by_name: row.uploaded_by_name,
  created_at: row.created_at,
});

/** Columns for publicAttachment, with the uploader's name. Alias the table as a. */
export const ATTACHMENT_SELECT = `
  SELECT a.*, u.name AS uploaded_by_name
    FROM attachments a
    JOIN users u ON u.id = a.uploaded_by`;

/**
 * Checks `attachment_ids` from a request body: a list of at most 3 of the user's own files that
 * haven't been sent with anything yet. Returns { ids } or { error }.
 */
export async function checkAttachmentIds(value, user) {
  if (value === undefined || value === null) return { ids: [] };
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id) && id > 0)) {
    return { error: 'attachment_ids must be a list of attachment ids' };
  }
  const ids = [...new Set(value)];
  if (ids.length > MAX_FILES_PER_ITEM) return { error: `At most ${MAX_FILES_PER_ITEM} files can be attached` };
  if (ids.length === 0) return { ids };
  const result = await pool.query(
    'SELECT id FROM attachments WHERE id = ANY($1) AND uploaded_by = $2 AND attached_at IS NULL',
    [ids, user.id]
  );
  // Security: someone else's file, or one already sent, gets the same answer as a missing one.
  if (result.rows.length !== ids.length) return { error: 'An attached file was not found. Try adding it again.' };
  return { ids };
}

/**
 * Attaches checked files to a ticket, comment or Get help request. Run it inside the same
 * transaction that saves that item, so the item and its files are saved together or not at all.
 * @param {{ ticketId?: number, commentId?: number, helpSessionId?: number }} target
 */
export async function claimAttachments(db, ids, user, { ticketId = null, commentId = null, helpSessionId = null }) {
  if (ids.length === 0) return;
  const result = await db.query(
    `UPDATE attachments
        SET ticket_id = $3, comment_id = $4, help_session_id = $5, attached_at = NOW()
      WHERE id = ANY($1) AND uploaded_by = $2 AND attached_at IS NULL`,
    [ids, user.id, ticketId, commentId, helpSessionId]
  );
  // Note: checkAttachmentIds already passed, so this only fails if the same file was sent twice
  // at the same moment. Throwing rolls the whole transaction back.
  if (result.rowCount !== ids.length) throw new Error('Attachments changed while being attached');
}

/**
 * Removes unclaimed uploads older than a day, and their files.
 * Why here: it runs on each upload, so no separate scheduled job is needed.
 */
async function removeAbandoned() {
  const removed = await pool.query(
    "DELETE FROM attachments WHERE attached_at IS NULL AND created_at < NOW() - INTERVAL '1 day' RETURNING storage_key"
  );
  await Promise.all(removed.rows.map((row) => removeFile(row.storage_key)));
}

/**
 * Whether this user may open this attachment row (joined with its ticket, comment and request).
 * Security: everything that isn't allowed answers 404 in the routes, the same as a missing file.
 */
function canOpen(row, user) {
  if (row.attached_at === null) return row.uploaded_by === user.id;
  if (row.ticket_id !== null) {
    if (!isStaff(user) && row.ticket_created_by !== user.id) return false;
    return !row.comment_is_internal || isStaff(user);
  }
  return isStaff(user) || row.session_user_id === user.id;
}

// --- Routes ---

/**
 * POST /api/attachments
 * Uploads one file (form field "file"). It isn't attached to anything until it's sent.
 * - 201 { attachment }
 * - 413 the file is over 5 MB; 415 not an allowed type; 429 the daily upload limit was reached.
 * Access: anyone logged in.
 * Body: multipart/form-data with one file named "file"
 */
router.post('/', async (req, res) => {
  const count = await pool.query(
    "SELECT COUNT(*)::int AS n FROM attachments WHERE uploaded_by = $1 AND created_at > NOW() - INTERVAL '24 hours'",
    [req.user.id]
  );
  if (count.rows[0].n >= dailyLimit()) {
    return res.status(429).json({ error: `You can add up to ${dailyLimit()} files a day. Try again tomorrow.` });
  }

  try {
    await new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve())));
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Files can be up to 5 MB' });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Send one file in the "file" field' });
    throw err;
  }
  if (!req.file || req.file.size === 0) return res.status(400).json({ error: 'No file was sent' });

  const name = cleanFileName(req.file.originalname);
  const type = detectType(req.file.buffer, name);
  if (!type) return res.status(415).json({ error: TYPE_ERROR });

  await removeAbandoned();
  const key = newStorageKey();
  await saveFile(key, req.file.buffer);
  try {
    const inserted = await pool.query(
      `INSERT INTO attachments (uploaded_by, original_name, content_type, size_bytes, storage_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.user.id, name, type, req.file.size, key]
    );
    const row = await pool.query(`${ATTACHMENT_SELECT} WHERE a.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ attachment: publicAttachment(row.rows[0]) });
  } catch (err) {
    await removeFile(key); // no row, so no file either
    throw err;
  }
});

/**
 * GET /api/attachments/:id
 * Downloads a file. Images open in place; PDFs and text logs download.
 * Access: whoever can see what it's attached to (see the top of this file). 404 otherwise.
 */
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'File not found' });
  const result = await pool.query(
    `SELECT a.*, t.created_by AS ticket_created_by, c.is_internal AS comment_is_internal, s.user_id AS session_user_id
       FROM attachments a
       LEFT JOIN tickets t ON t.id = a.ticket_id
       LEFT JOIN ticket_comments c ON c.id = a.comment_id
       LEFT JOIN help_sessions s ON s.id = a.help_session_id
      WHERE a.id = $1`,
    [id]
  );
  const row = result.rows[0];
  if (!row || !canOpen(row, req.user)) return res.status(404).json({ error: 'File not found' });

  const data = await readFile(row.storage_key);
  const inline = row.content_type.startsWith('image/');
  // Security: the browser is told exactly what this is and not to guess (nosniff), and the file
  // may not run anything (CSP sandbox), so even a crafted file can't act as a web page.
  res.set({
    'Content-Type': row.content_type === 'text/plain' ? 'text/plain; charset=utf-8' : row.content_type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  });
  res.send(data);
});

/**
 * DELETE /api/attachments/:id
 * Removes a file that hasn't been sent yet (the ✕ on the picker). Sent files stay, like comments.
 * Access: the uploader. 404 for anyone else, or once the file was sent.
 */
router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const removed = id
    ? await pool.query(
        'DELETE FROM attachments WHERE id = $1 AND uploaded_by = $2 AND attached_at IS NULL RETURNING storage_key',
        [id, req.user.id]
      )
    : { rows: [] };
  if (!removed.rows[0]) return res.status(404).json({ error: 'File not found' });
  await removeFile(removed.rows[0].storage_key);
  res.status(204).end();
});

export default router;
