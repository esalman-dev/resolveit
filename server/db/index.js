// One shared connection pool for the whole server.
// Any file that needs the database does: import pool from './db/index.js'
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, // from .env, so the password stays out of the code
});

// Run several queries as ONE all-or-nothing unit (a "transaction").
// Example: changing a ticket AND writing its history. If the history insert failed after the
// ticket was already changed, we'd have a change with no record of it. In a transaction,
// either everything is saved (COMMIT) or nothing is (ROLLBACK).
//
// Usage:  const result = await withTransaction(async (db) => { await db.query(...); return ...; });
// Every query inside must use `db` (one dedicated connection), not `pool`.
export async function withTransaction(work) {
  const db = await pool.connect(); // borrow one connection; a transaction must stay on one connection
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK'); // undo everything since BEGIN
    throw err;
  } finally {
    db.release(); // give the connection back to the pool
  }
}

export default pool;
