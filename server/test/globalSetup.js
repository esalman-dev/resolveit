// Test global setup: runs once before all test files.
//
// Makes sure the test database exists and has the latest schema.

import fs from 'node:fs';
import pg from 'pg';
import { getTestDbUrl } from './testDb.js';

export default async function setup() {
  const testUrl = new URL(getTestDbUrl());
  const dbName = testUrl.pathname.slice(1);

  // Connect to the built-in "postgres" database to create the test database if it's missing.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${dbName}"`); // name comes from our own config, not user input
  }
  await admin.end();

  // Apply schema.sql (safe to re-run), so the test database always matches the real one.
  const db = new pg.Client({ connectionString: testUrl.toString() });
  await db.connect();
  await db.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await db.end();
}
