// Database connection: one shared PostgreSQL connection pool for the whole server.
//
// Any file that needs the database imports it: import pool from '../db/index.js'

import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, // from .env, so the password stays out of the code
});

/**
 * Runs several queries as one all-or-nothing unit (a transaction).
 *
 * Why: changing a ticket and writing its history are two queries. If the second failed after
 * the first succeeded, there'd be a change with no record of it. In a transaction, either
 * everything is saved (COMMIT) or nothing is (ROLLBACK).
 *
 * Every query inside must use the `db` it's given (one dedicated connection), not `pool`.
 *
 * @example
 * const id = await withTransaction(async (db) => {
 *   const row = await db.query('INSERT ... RETURNING id');
 *   await db.query('INSERT INTO ticket_events ...');
 *   return row.rows[0].id;
 * });
 */
export async function withTransaction(work) {
  const db = await pool.connect(); // a transaction must stay on one connection
  try {
    await db.query('BEGIN');
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK'); // undo everything since BEGIN
    throw err;
  } finally {
    db.release(); // always give the connection back to the pool
  }
}

export default pool;
