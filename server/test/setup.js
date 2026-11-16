// Runs inside EVERY test file: start each test with empty tables, and close the DB pool at the end.
import { beforeEach, afterAll } from 'vitest';
import pool from '../db/index.js';

beforeEach(async () => {
  // TRUNCATE empties tables instantly. RESTART IDENTITY resets ids to 1. CASCADE handles foreign keys.
  await pool.query('TRUNCATE users, tickets, refresh_tokens, categories, ticket_comments RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pool.end();
});
