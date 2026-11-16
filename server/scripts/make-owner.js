// make-owner script: makes an existing account an owner, or turns an owner back into an admin.
//
// Usage (from the server folder):
//   npm run make-owner -- someone@example.com            makes them an owner
//   npm run make-owner -- --remove someone@example.com   turns an owner back into an admin
//
// Why: owners sit at the top. They control the admins, and no owner can demote another, so
// the website has no way to create or remove an owner (see roles.js). Running this needs
// access to the server and its database. The change is logged in the account history with
// no actor ("server command").

import pool, { withTransaction } from '../db/index.js';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const email = args.find((arg) => !arg.startsWith('--'))?.trim().toLowerCase();

if (!email) {
  console.error('Usage: npm run make-owner -- someone@example.com');
  console.error('       npm run make-owner -- --remove someone@example.com');
  process.exit(1);
}

const newRole = remove ? 'admin' : 'owner';

try {
  // The role change and its history entry are saved together, or not at all (see db/index.js).
  const outcome = await withTransaction(async (db) => {
    const found = await db.query('SELECT id, name, email, role FROM users WHERE email = $1', [email]);
    const user = found.rows[0];
    if (!user) return { error: `No account found for ${email}. Sign up on the website first, then run this again.` };
    // --remove only works on someone who is an owner, so it can never promote anyone by accident.
    if (remove && user.role !== 'owner') return { error: `${email} isn't an owner. Nothing changed.` };
    if (user.role === newRole) return { user, unchanged: true };

    await db.query('UPDATE users SET role = $1 WHERE id = $2', [newRole, user.id]);
    // actor_id NULL means "done by a server command" in the history.
    await db.query(
      `INSERT INTO account_events (user_id, actor_id, action, old_value, new_value)
       VALUES ($1, NULL, 'role_changed', $2, $3)`,
      [user.id, user.role, newRole]
    );
    return { user };
  });

  if (outcome.error) {
    console.error(outcome.error);
    process.exitCode = 1;
  } else {
    const { name } = outcome.user;
    console.log(outcome.unchanged ? `${name} (${email}) is already an ${newRole}.` : `Done: ${name} (${email}) is now an ${newRole}.`);
    console.log('Permissions change immediately. Their screen updates after they refresh the page or log in again.');
  }
} finally {
  await pool.end(); // close the connections, or Node keeps running
}
