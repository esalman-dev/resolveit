// make-admin script: promotes an existing account to admin from the command line.
//
// Usage (from the server folder):  npm run make-admin -- someone@example.com
//
// Why: sign-up always creates a 'user', so nobody can make themselves admin, which means the
// first admin can't come from the website. Running this needs access to the server and its
// database, which is exactly who should be allowed to do it. Owners have their own script
// (make-owner.js). The change is logged in the account history with no actor ("server command").

import pool, { withTransaction } from '../db/index.js';

const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  console.error('Usage: npm run make-admin -- someone@example.com');
  process.exit(1);
}

try {
  // The role change and its history entry are saved together, or not at all (see db/index.js).
  const outcome = await withTransaction(async (db) => {
    const found = await db.query('SELECT id, name, email, role FROM users WHERE email = $1', [email]);
    const user = found.rows[0];
    if (!user) return { error: `No account found for ${email}. Sign up on the website first, then run this again.` };
    // Never quietly demote an owner; that takes make-owner --remove.
    if (user.role === 'owner') {
      return { error: `${email} is an owner. To turn them back into an admin, use: npm run make-owner -- --remove ${email}` };
    }
    if (user.role === 'admin') return { user, unchanged: true };

    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    // actor_id NULL means "done by a server command" in the history.
    await db.query(
      `INSERT INTO account_events (user_id, actor_id, action, old_value, new_value)
       VALUES ($1, NULL, 'role_changed', $2, 'admin')`,
      [user.id, user.role]
    );
    return { user };
  });

  if (outcome.error) {
    console.error(outcome.error);
    process.exitCode = 1;
  } else {
    const { name } = outcome.user;
    console.log(outcome.unchanged ? `${name} (${email}) is already an admin.` : `Done: ${name} (${email}) is now an admin.`);
    console.log('Admin permissions work immediately. The admin screen appears after they refresh the page or log in again.');
  }
} finally {
  await pool.end(); // close the connections, or Node keeps running
}
