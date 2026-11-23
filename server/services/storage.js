// File storage: saves, reads and removes attachment files.
//
// Why one small module: the rest of the app never knows where files live. Two places:
//   a folder (UPLOAD_DIR, default server/uploads/): a developer's computer
//   the database (FILE_STORAGE=database, the stored_files table): the live site, whose free
//     server wipes its disk on every restart
// No other file knows which one is in use.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pool from '../db/index.js';

/** The folder files are saved in. Read on every call, so tests can point it somewhere else. */
const folder = () => process.env.UPLOAD_DIR || fileURLToPath(new URL('../uploads/', import.meta.url));

/** Makes a new random file name (32 hex characters). Uploaded names are never used on disk. */
export const newStorageKey = () => crypto.randomBytes(16).toString('hex');

/**
 * The full path for a key.
 * Security: only keys this module made are accepted, so a key like "../../.env" can never
 * reach outside the folder.
 */
function pathFor(key) {
  if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('Invalid storage key');
  return path.join(folder(), key);
}

/** True when files are kept in the database. Read on every call, so tests can switch it. */
const inDatabase = () => process.env.FILE_STORAGE === 'database';

/** Saves a file. Fails rather than overwrite an existing one. */
export async function saveFile(key, data) {
  pathFor(key); // checks the key, whichever place is used
  if (inDatabase()) {
    // A plain INSERT: a key already in use breaks the primary key, so nothing is overwritten.
    await pool.query('INSERT INTO stored_files (storage_key, data) VALUES ($1, $2)', [key, data]);
    return;
  }
  await fs.mkdir(folder(), { recursive: true });
  await fs.writeFile(pathFor(key), data, { flag: 'wx' }); // wx: create only, never overwrite
}

/** Reads a whole file. Files are at most 5 MB, so reading it into memory is fine. */
export async function readFile(key) {
  if (!inDatabase()) return fs.readFile(pathFor(key));
  pathFor(key);
  const row = (await pool.query('SELECT data FROM stored_files WHERE storage_key = $1', [key])).rows[0];
  // The same error the folder gives, so callers handle a missing file one way.
  if (!row) throw Object.assign(new Error(`File not found: ${key}`), { code: 'ENOENT' });
  return row.data;
}

/** Removes a file. A file that's already gone is not an error. */
export async function removeFile(key) {
  if (!inDatabase()) return fs.rm(pathFor(key), { force: true });
  pathFor(key);
  await pool.query('DELETE FROM stored_files WHERE storage_key = $1', [key]);
}
