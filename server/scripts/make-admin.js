// Promote an existing account to admin from the command line.
// Usage (from the server folder):  npm run make-admin -- someone@example.com
//
// Why a script? Sign-up always creates a plain 'user' (so nobody can make themselves admin),
// which means the FIRST admin can't be created through the website. Running this requires
// access to the server and its database, which is exactly who should be allowed to do it.
// After that, admins can change technicians' and users' roles from the admin screen.
// Owners (ranked above admins) have their own script: npm run make-owner.
import pool from '../db/index.js';

const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  console.error('Usage: npm run make-admin -- someone@example.com');
  process.exit(1);
}

try {
  const result = await pool.query(
    // AND role <> 'owner': this script must never quietly demote an owner (use make-owner --remove)
    "UPDATE users SET role = 'admin' WHERE email = $1 AND role <> 'owner' RETURNING id, name, email, role",
    [email]
  );

  if (result.rowCount === 0) {
    console.error(`No account found for ${email} (or they're an owner). Sign up on the website first, then run this again.`);
    console.error('To turn an owner back into an admin, use: npm run make-owner -- --remove ' + email);
    process.exitCode = 1;
  } else {
    const user = result.rows[0];
    console.log(`Done: ${user.name} (${user.email}) is now an admin.`);
    console.log('Admin permissions work immediately. The admin screen appears after they refresh the page or log in again.');
  }
} finally {
  await pool.end(); // close the DB connection so the script exits
}
