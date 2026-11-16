// Promote an existing account to admin from the command line.
// Usage (from the server folder):  npm run make-admin -- someone@example.com
//
// Why a script? Sign-up always creates a plain 'user' (so nobody can make themselves admin),
// which means the FIRST admin can't be created through the website. Running this requires
// access to the server and its database, which is exactly who should be allowed to do it.
// After that, admins can change technicians' and users' roles from the admin screen.
// Owners (ranked above admins) have their own script: npm run make-owner.
import pool, { withTransaction } from '../db/index.js';

const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  console.error('Usage: npm run make-admin -- someone@example.com');
  process.exit(1);
}

try {
  // Change the role AND write it to the account history, all or nothing (see db/index.js)
  const outcome = await withTransaction(async (db) => {
    const found = await db.query('SELECT id, name, email, role FROM users WHERE email = $1', [email]);
    const user = found.rows[0];
    if (!user) return { error: `No account found for ${email}. Sign up on the website first, then run this again.` };
    // This script must never quietly demote an owner
    if (user.role === 'owner') {
      return { error: `${email} is an owner. To turn them back into an admin, use: npm run make-owner -- --remove ${email}` };
    }
    if (user.role === 'admin') return { user, unchanged: true };

    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    // actor_id NULL = "done by a server command", shown as "server" in the history
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
  await pool.end(); // close the DB connection so the script exits
}
