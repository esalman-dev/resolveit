// Test setup: runs inside every test file.
//
// Starts each test with empty tables, and closes the database pool at the end.

import { beforeEach, afterAll } from 'vitest';
import pool from '../db/index.js';

beforeEach(async () => {
  // TRUNCATE empties the tables instantly, RESTART IDENTITY resets ids to 1, and CASCADE handles foreign keys.
  await pool.query('TRUNCATE users, tickets, refresh_tokens, categories, ticket_comments, comment_edits, ticket_events, account_events, help_sessions, attachments, ticket_ratings, kb_articles, outages RESTART IDENTITY CASCADE');
  // Note: CASCADE also empties sla_targets, team_goals, app_settings and notifications (they
  // point at users), but the app needs the first three, so the defaults from schema.sql are put back.
  await pool.query('INSERT INTO app_settings (id) VALUES (TRUE) ON CONFLICT (id) DO UPDATE SET auto_assign = TRUE, updated_by = NULL');
  await pool.query(
    `INSERT INTO team_goals (metric, target)
     VALUES ('self_solved_rate', 25), ('average_rating', 4.5), ('fixed_on_time_rate', 90)
     ON CONFLICT (metric) DO UPDATE SET target = EXCLUDED.target, updated_by = NULL`
  );
  await pool.query(
    `INSERT INTO sla_targets (priority, first_response_minutes, resolve_minutes)
     VALUES ('urgent', 60, 240), ('high', 240, 1440), ('medium', 1440, 4320), ('low', 2880, 10080)
     ON CONFLICT (priority) DO UPDATE
       SET first_response_minutes = EXCLUDED.first_response_minutes,
           resolve_minutes = EXCLUDED.resolve_minutes, updated_by = NULL`
  );
});

afterAll(async () => {
  await pool.end();
});
