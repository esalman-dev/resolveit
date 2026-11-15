// One shared connection pool for the whole server.
// Any file that needs the database does: import pool from './db/index.js'
import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, // from .env, so the password stays out of the code
});

export default pool;
