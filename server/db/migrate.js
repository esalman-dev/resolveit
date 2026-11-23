// Migrations: bringing a database up to date (the command is scripts/migrate.js, npm run migrate;
// the live server runs it before it starts, see render.yaml).
//
// A brand-new, empty database gets all of schema.sql (the full picture), and every migration
// file is marked as done, since schema.sql already includes them.
// A database that's already in use only gets the migration files it hasn't had yet, in name
// order, each in its own transaction, and each one is recorded in schema_migrations.
//
// Changing a table from now on: add db/migrations/NNNN-what-changes.sql (ALTER TABLE …) AND make
// the same change in schema.sql, which stays the full picture for new databases and the tests.

import fs from 'node:fs';
import pool, { withTransaction } from './index.js';

const MIGRATIONS = new URL('./migrations/', import.meta.url);

/** The migration files, in the order they run (0001-…, 0002-…). */
function migrationFiles(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
}

/**
 * Brings the database up to date.
 * @param folder where the migration files are (tests pass their own)
 * @returns {Promise<string[]>} what was done, for the log
 */
export async function migrate({ folder = MIGRATIONS } = {}) {
  const done = [];
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  );
  const files = migrationFiles(folder);
  const fresh = (await pool.query("SELECT to_regclass('public.users') IS NULL AS empty")).rows[0].empty;

  if (fresh) {
    await withTransaction(async (db) => {
      await db.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      for (const name of files) await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    done.push(`New database: built from schema.sql (${files.length} migration file(s) marked as included)`);
    return done;
  }

  const applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const name of files.filter((f) => !applied.has(f))) {
    // Each file and its record together: a failed migration leaves no trace, and stops the start.
    await withTransaction(async (db) => {
      await db.query(fs.readFileSync(new URL(name, folder), 'utf8'));
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    done.push(`Applied ${name}`);
  }
  if (done.length === 0) done.push('Up to date');
  return done;
}
