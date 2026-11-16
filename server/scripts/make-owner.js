// Make an existing account an OWNER (or remove owner) from the command line.
// Usage (from the server folder):
//   npm run make-owner -- someone@example.com            -> becomes owner
//   npm run make-owner -- --remove someone@example.com   -> owner goes back to admin
//
// Why only here? Owners sit at the top: they control the admins, and no owner can demote
// another. So the website has NO way to create or remove an owner (see roles.js).
// Running this script needs access to the server and its database, which is exactly
// who should decide who the owners are.
import pool from '../db/index.js';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const email = args.find((arg) => !arg.startsWith('--'))?.trim().toLowerCase();

if (!email) {
  console.error('Usage: npm run make-owner -- someone@example.com');
  console.error('       npm run make-owner -- --remove someone@example.com');
  process.exit(1);
}

try {
  // Removing only works on someone who IS an owner (so --remove can't accidentally promote anyone)
  const result = remove
    ? await pool.query(
        "UPDATE users SET role = 'admin' WHERE email = $1 AND role = 'owner' RETURNING name, email",
        [email]
      )
    : await pool.query("UPDATE users SET role = 'owner' WHERE email = $1 RETURNING name, email", [email]);

  if (result.rowCount === 0) {
    console.error(
      remove
        ? `${email} isn't an owner (or has no account). Nothing changed.`
        : `No account found for ${email}. Sign up on the website first, then run this again.`
    );
    process.exitCode = 1;
  } else {
    const user = result.rows[0];
    console.log(remove ? `Done: ${user.name} (${user.email}) is now an admin.` : `Done: ${user.name} (${user.email}) is now an owner.`);
    console.log('Permissions change immediately. Their screen updates after they refresh the page or log in again.');
  }
} finally {
  await pool.end(); // close the DB connection so the script exits
}
