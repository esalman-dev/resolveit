// Make an existing account an OWNER (or remove owner) from the command line.
// Usage (from the server folder):
//   npm run make-owner -- someone@example.com            -> becomes owner
//   npm run make-owner -- --remove someone@example.com   -> owner goes back to admin
//
// Why only here? Owners sit at the top: they control the admins, and no owner can demote
// another. So the website has NO way to create or remove an owner (see roles.js).
// Running this script needs access to the server and its database, which is exactly
// who should decide who the owners are.
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
  // Change the role AND write it to the account history, all or nothing (see db/index.js)
  const outcome = await withTransaction(async (db) => {
    const found = await db.query('SELECT id, name, email, role FROM users WHERE email = $1', [email]);
    const user = found.rows[0];
    if (!user) return { error: `No account found for ${email}. Sign up on the website first, then run this again.` };
    // --remove only works on someone who IS an owner, so it can never accidentally promote anyone
    if (remove && user.role !== 'owner') return { error: `${email} isn't an owner. Nothing changed.` };
    if (user.role === newRole) return { user, unchanged: true };

    await db.query('UPDATE users SET role = $1 WHERE id = $2', [newRole, user.id]);
    // actor_id NULL = "done by a server command", shown as "server" in the history
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
  await pool.end(); // close the DB connection so the script exits
}
