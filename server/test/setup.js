// Test setup: runs inside every test file.
//
// Starts each test with empty tables, and closes the database pool at the end.

import { beforeEach, afterAll } from 'vitest';
import pool from '../db/index.js';

beforeEach(async () => {
  // TRUNCATE empties the tables instantly, RESTART IDENTITY resets ids to 1, and CASCADE handles foreign keys.
  await pool.query('TRUNCATE users, tickets, refresh_tokens, categories, ticket_comments, comment_edits, ticket_events, account_events RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});
