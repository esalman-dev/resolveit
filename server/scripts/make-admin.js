// Promote an existing account to admin from the command line.
// Usage (from the server folder):  npm run make-admin -- someone@example.com
//
// Why a script? Sign-up always creates a plain 'user' (so nobody can make themselves admin),
// which means the FIRST admin can't be created through the website. Running this requires
// access to the server and its database, which is exactly who should be allowed to do it.
// After that, admins can change other people's roles from the admin screen.
import pool from '../db/index.js';

const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  console.error('Usage: npm run make-admin -- someone@example.com');
  process.exit(1);
}

try {
  const result = await pool.query(
    "UPDATE users SET role = 'admin' WHERE email = $1 RETURNING id, name, email, role",
    [email]
  );

  if (result.rowCount === 0) {
    console.error(`No account found for ${email}. Sign up on the website first, then run this again.`);
    process.exitCode = 1;
  } else {
    const user = result.rows[0];
    console.log(`Done: ${user.name} (${user.email}) is now an admin.`);
    console.log('They will see admin features within 15 minutes, or right away after logging in again.');
  }
} finally {
  await pool.end(); // close the DB connection so the script exits
}
