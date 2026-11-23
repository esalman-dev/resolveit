// Tests for migrations on a database that's already in use: new files run once, in order, and a
// failing one leaves no trace. (A brand-new database just gets schema.sql, as the tests' own
// database does in globalSetup.js.)

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from './helpers.js';
import { migrate } from '../db/migrate.js';

let dir;

/** A folder of migration files for one test: { '0001-name.sql': 'SQL…' }. */
function migrationsFolder(files) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return pathToFileURL(`${dir}${path.sep}`);
}

afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await pool.query('DROP TABLE IF EXISTS migrate_probe, schema_migrations');
});

describe('migrate on a database in use', () => {
  it('runs each new file once, in name order, and records it', async () => {
    const folder = migrationsFolder({
      '0002-add-column.sql': 'ALTER TABLE migrate_probe ADD COLUMN note TEXT;',
      '0001-add-table.sql': 'CREATE TABLE migrate_probe (id INTEGER);',
      'notes.txt': 'not a migration',
    });
    expect(await migrate({ folder })).toEqual(['Applied 0001-add-table.sql', 'Applied 0002-add-column.sql']);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'migrate_probe' ORDER BY 1")).rows.map((r) => r.column_name)).toEqual(['id', 'note']);
    expect(await migrate({ folder })).toEqual(['Up to date']);
  });

  it('rolls back a failing file and stops, so it runs again next time', async () => {
    const folder = migrationsFolder({
      '0001-add-table.sql': 'CREATE TABLE migrate_probe (id INTEGER);',
      '0002-broken.sql': 'ALTER TABLE migrate_probe ADD COLUMN note TEXT; SELECT * FROM no_such_table;',
    });
    await expect(migrate({ folder })).rejects.toThrow(/no_such_table/);
    const recorded = (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name);
    expect(recorded).toEqual(['0001-add-table.sql']);
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'migrate_probe'")).rows;
    expect(columns.map((c) => c.column_name)).toEqual(['id']); // the half-done ALTER was undone
  });
});
