// The live demo: the three shared demo accounts, and the switches for the public site.
//
//   DEMO_MODE=true      the "Try as…" buttons work, and demo accounts can't make admin changes
//   ALLOW_SIGNUP=false  nobody can create a new account (the demo buttons instead)
//
// Both are off on a developer's computer (unset), so the demo admin can still test every admin
// page there. Only the live server sets them.

import pool from '../db/index.js';

export const DEMO_DOMAIN = 'demo.example.com';

/** The three accounts anyone can log in with to try the app (made by scripts/seed-demo.js). */
export const DEMO_LOGINS = {
  user: { name: 'Demo User', email: `demo.user@${DEMO_DOMAIN}`, role: 'user' },
  technician: { name: 'Demo Technician', email: `demo.tech@${DEMO_DOMAIN}`, role: 'technician' },
  admin: { name: 'Demo Admin', email: `demo.admin@${DEMO_DOMAIN}`, role: 'admin' },
};

/** True on the live site, where the demo buttons work and demo accounts are limited. */
export const demoMode = () => process.env.DEMO_MODE === 'true';

/** False on the live site: no new accounts (sign-up or a first Google sign-in). */
export const signupOpen = () => process.env.ALLOW_SIGNUP !== 'false';

/** Whether an email belongs to the demo data (the shared accounts and the made-up people). */
export const isDemoEmail = (email) => String(email ?? '').toLowerCase().endsWith(`@${DEMO_DOMAIN}`);

export const DEMO_BLOCKED = "This is a shared demo account, so that's switched off. Everything else works.";

/**
 * Middleware: in demo mode, refuses admin changes (roles, disabling, names, passwords, settings)
 * from the shared demo accounts with 403. Must run after requireAuth.
 * Why: anyone can log in as the demo admin, so without this one visitor could rename everyone or
 * switch auto-assign off for the next. Everything else (Get help, tickets) still works.
 */
export async function blockDemo(req, res, next) {
  if (!demoMode()) return next();
  const email = (await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id])).rows[0]?.email;
  if (isDemoEmail(email)) return res.status(403).json({ error: DEMO_BLOCKED });
  next();
}
