import { defineConfig } from 'vitest/config';
import { getTestDbUrl } from './test/testDb.js';

export default defineConfig({
  test: {
    // Environment for the tests. These are set BEFORE the app loads, and dotenv never overwrites
    // a variable that's already set, so the app connects to the TEST database, not the real one.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: getTestDbUrl(),
      JWT_SECRET: 'test-only-secret',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      DISABLE_RATE_LIMIT: '1', // test/rateLimit.test.js switches this back off
    },
    globalSetup: './test/globalSetup.js', // once: create the test DB + apply schema.sql
    setupFiles: './test/setup.js',        // every file: empty the tables before each test
    fileParallelism: false,               // files share one database, so run them one at a time
  },
});
