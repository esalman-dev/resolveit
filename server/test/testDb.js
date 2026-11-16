// Test database: which database the tests use. Never the real one, because tests wipe the
// tables before every test.
//
// Uses TEST_DATABASE_URL if set (e.g. in GitHub Actions); otherwise the DATABASE_URL from .env
// with the database name swapped to "resolveit_test" (same server, same password).

import 'dotenv/config';

export function getTestDbUrl() {
  const source = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!source) {
    throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) in server/.env to run tests');
  }

  const url = new URL(source);
  if (!process.env.TEST_DATABASE_URL) url.pathname = '/resolveit_test';

  // Safety net: refuse to run against anything that isn't clearly a test database.
  if (!url.pathname.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${url.pathname.slice(1)}": the name must end in _test`);
  }
  return url.toString();
}
