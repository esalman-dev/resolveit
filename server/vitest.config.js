// Vitest config: how the server tests run.
//
// Points the app at the test database, sets test-only secrets, and runs one test file at a
// time because they share one database.

import { defineConfig } from 'vitest/config';
import { getTestDbUrl } from './test/testDb.js';

export default defineConfig({
  test: {
    // Environment for the tests. These are set before the app loads, and dotenv never overwrites
    // a variable that's already set, so the app connects to the test database, not the real one.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: getTestDbUrl(),
      JWT_SECRET: 'test-only-secret',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      DISABLE_RATE_LIMIT: '1', // test/rateLimit.test.js switches this back off
    },
    globalSetup: './test/globalSetup.js', // once: create the test database and apply schema.sql
    setupFiles: './test/setup.js',        // every file: empty the tables before each test
    fileParallelism: false,               // files share one database, so run them one at a time
  },
});
