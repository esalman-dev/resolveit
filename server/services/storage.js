// File storage: saves, reads and removes attachment files.
//
// Why one small module: the rest of the app never knows where files live. For now they're kept
// in a folder on this computer (UPLOAD_DIR, default server/uploads/). The free production server
// wipes its disk on every restart, so a storage service gets added here at deploy time, and no
// other file has to change.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

/** Saves a file. Fails rather than overwrite an existing one. */
export async function saveFile(key, data) {
  await fs.mkdir(folder(), { recursive: true });
  await fs.writeFile(pathFor(key), data, { flag: 'wx' }); // wx: create only, never overwrite
}

/** Reads a whole file. Files are at most 5 MB, so reading it into memory is fine. */
export const readFile = (key) => fs.readFile(pathFor(key));

/** Removes a file. A file that's already gone is not an error. */
export const removeFile = (key) => fs.rm(pathFor(key), { force: true });
