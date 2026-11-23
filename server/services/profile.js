// Profile details: a person's name, job title and department.
//
// Shared by the Profile page (you change your own) and the Users screen (an admin changes
// someone ranked below them), so both check and save them the same way.

import { MAX_NAME } from '../routes/auth.js';

const MAX_WORK_TEXT = 80; // job title and department; matches the CHECKs in schema.sql

/** The columns of a user that the Profile page and the Users screen show. */
export const PROFILE_COLUMNS = `id, name, email, role, job_title, department, created_at, disabled_at,
  password_hash IS NOT NULL AS has_password, -- true/false only; never the hash itself
  google_id IS NOT NULL     AS has_google`;

/**
 * Checks the details from a request. Every field is optional; a job title or department sent
 * as '' (or null) is cleared.
 * @returns {{ fields: { name?: string, job_title?: string|null, department?: string|null } } | { error: string }}
 */
export function checkProfileFields(body) {
  const fields = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { error: 'Name is required' };
    if (name.length > MAX_NAME) return { error: `Name must be ${MAX_NAME} characters or fewer` };
    fields.name = name;
  }
  for (const [key, label] of [['job_title', 'Job title'], ['department', 'Department']]) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== 'string') return { error: `${label} must be text` };
    const text = (body[key] ?? '').trim();
    if (text.length > MAX_WORK_TEXT) return { error: `${label} must be ${MAX_WORK_TEXT} characters or fewer` };
    fields[key] = text || null; // empty means "not set"
  }
  return { fields };
}

/**
 * Saves checked details for one person, inside a transaction (`db`). A name change is written
 * to the account history (who renamed whom, from what to what); job title and department aren't,
 * since they don't affect access.
 * @param target the person's current row (at least id and name)
 * @param actorId who made the change: themselves, or an admin
 * @returns the updated row (PROFILE_COLUMNS)
 */
export async function saveProfile(db, target, fields, actorId) {
  const next = {
    name: fields.name ?? target.name,
    job_title: fields.job_title !== undefined ? fields.job_title : target.job_title,
    department: fields.department !== undefined ? fields.department : target.department,
  };
  const updated = await db.query(
    `UPDATE users SET name = $2, job_title = $3, department = $4 WHERE id = $1 RETURNING ${PROFILE_COLUMNS}`,
    [target.id, next.name, next.job_title, next.department]
  );
  if (next.name !== target.name) {
    await db.query(
      `INSERT INTO account_events (user_id, actor_id, action, old_value, new_value) VALUES ($1, $2, 'renamed', $3, $4)`,
      [target.id, actorId, target.name, next.name]
    );
  }
  return updated.rows[0];
}
