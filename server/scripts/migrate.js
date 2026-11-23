// Migrate: brings the database in DATABASE_URL up to date (see db/migrate.js for how).
//
//   npm run migrate
//
// The live server runs this before it starts (render.yaml), so a deploy with a new migration
// file updates the database first. Safe to run again: it only does what's missing.

import pool from '../db/index.js';
import { migrate } from '../db/migrate.js';

try {
  for (const line of await migrate()) console.log(line);
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1; // the server doesn't start on a half-updated database
} finally {
  await pool.end();
}
