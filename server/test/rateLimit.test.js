// Tests for rate limiting.
//
// The other test files switch the limits off; this one switches them back on. Vitest gives
// each test file fresh copies of the app's modules, so the counters start at zero.

import { describe, it, expect, beforeAll } from 'vitest';
import { app, request, signUp } from './helpers.js';

beforeAll(() => {
  process.env.DISABLE_RATE_LIMIT = '0';
});

const login = (password) =>
  request(app).post('/api/auth/login').send({ email: 'ada@example.com', password });

describe('login rate limit', () => {
  it('allows 10 failed logins, then blocks with 429', async () => {
    await signUp({ email: 'ada@example.com', password: 'password123' });

    for (let i = 0; i < 10; i++) {
      expect((await login('wrong-password')).status).toBe(401);
    }
    const blocked = await login('wrong-password');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many attempts/i);

    // Even the right password is blocked now; that's what stops a guessing script.
    expect((await login('password123')).status).toBe(429);
  });
});
