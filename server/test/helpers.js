// Shortcuts shared by the test files
import request from 'supertest';
import app from '../app.js';
import pool from '../db/index.js';

export { app, pool, request };

// Create an account and return { user, token, agent }.
// agent = a fake browser that remembers cookies, so it can call /refresh and /logout.
export async function signUp({ name = 'Test User', email = 'test@example.com', password = 'password123' } = {}) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send({ name, email, password });
  if (res.status !== 201) throw new Error(`signUp failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { user: res.body.user, token: res.body.token, agent };
}

// Same as signUp, then promote to admin directly in the database (like `npm run make-admin`)
export async function signUpAdmin(options = {}) {
  const account = await signUp({ name: 'Admin', email: 'admin@example.com', ...options });
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [account.user.id]);
  return account;
}

// Same idea for an owner (like `npm run make-owner`)
export async function signUpOwner(options = {}) {
  const account = await signUp({ name: 'Owner', email: 'owner@example.com', ...options });
  await pool.query("UPDATE users SET role = 'owner' WHERE id = $1", [account.user.id]);
  return account;
}

// "Authorization: Bearer <token>" header for a request
export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// The raw refresh cookie from a response, e.g. "resolveit_refresh=abc123"
export function refreshCookie(res) {
  const header = res.headers['set-cookie']?.find((c) => c.startsWith('resolveit_refresh='));
  return header?.split(';')[0];
}

// Decode a JWT's payload (the middle part) without verifying it, to inspect what's inside
export const decodeJwt = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
