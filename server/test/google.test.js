// Sign in with Google. We can't get real Google tokens in a test, so we replace Google's
// verifier with a fake ("mock"): tokens starting with "valid:" pass and carry a made-up payload.
// This tests OUR logic (create, match, link, reject) without calling Google.
import { describe, it, expect, vi } from 'vitest';
import { app, pool, request, signUp } from './helpers.js';

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    async verifyIdToken({ idToken, audience }) {
      if (!idToken.startsWith('valid:') || audience !== process.env.GOOGLE_CLIENT_ID) {
        throw new Error('Invalid token');
      }
      const payload = JSON.parse(idToken.slice('valid:'.length));
      return { getPayload: () => payload };
    }
  },
}));

// Build a fake Google credential
const googleToken = (payload) =>
  'valid:' + JSON.stringify({ sub: 'google-123', email: 'ada@gmail.com', email_verified: true, name: 'Ada', ...payload });

const googleLogin = (credential) => request(app).post('/api/auth/google').send({ credential });

describe('POST /api/auth/google', () => {
  it('creates a new account with no password and the "user" role', async () => {
    const res = await googleLogin(googleToken());
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'ada@gmail.com', role: 'user' });

    const { rows } = await pool.query('SELECT google_id, password_hash FROM users');
    expect(rows[0]).toEqual({ google_id: 'google-123', password_hash: null });
  });

  it('logs a returning user into the SAME account, matched by Google id', async () => {
    const first = await googleLogin(googleToken());
    const second = await googleLogin(googleToken({ email: 'ada.new.address@gmail.com' })); // email changed
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it('links Google to an existing password account when the email is verified', async () => {
    const { user } = await signUp({ email: 'ada@gmail.com' });
    const res = await googleLogin(googleToken());
    expect(res.body.user.id).toBe(user.id);

    const { rows } = await pool.query('SELECT google_id, password_hash FROM users');
    expect(rows).toHaveLength(1);
    expect(rows[0].google_id).toBe('google-123');
    expect(rows[0].password_hash).not.toBeNull(); // password login still works too
  });

  it('refuses an UNVERIFIED email (blocks account takeover)', async () => {
    await signUp({ email: 'ada@gmail.com' });
    const res = await googleLogin(googleToken({ email_verified: false }));
    expect(res.status).toBe(401);

    const { rows } = await pool.query('SELECT google_id FROM users');
    expect(rows[0].google_id).toBeNull(); // not linked
  });

  it('rejects a token Google did not sign (401)', async () => {
    const res = await googleLogin('forged-token');
    expect(res.status).toBe(401);
  });

  it('rejects a missing credential (400)', async () => {
    const res = await request(app).post('/api/auth/google').send({});
    expect(res.status).toBe(400);
  });

  it('does NOT replace an existing Google link with a different Google account (409)', async () => {
    await googleLogin(googleToken()); // ada@gmail.com linked to google-123
    const res = await googleLogin(googleToken({ sub: 'google-999' })); // another Google account, same email
    expect(res.status).toBe(409);

    const { rows } = await pool.query('SELECT google_id FROM users');
    expect(rows).toEqual([{ google_id: 'google-123' }]); // still the original link
  });

  it('updates the email when it changed (and is verified) at Google', async () => {
    await googleLogin(googleToken());
    const res = await googleLogin(googleToken({ email: 'ada.lovelace@gmail.com' }));
    expect(res.body.user.email).toBe('ada.lovelace@gmail.com');
  });

  it('keeps the old email if the new one is unverified or already used by another account', async () => {
    await googleLogin(googleToken());
    const unverified = await googleLogin(googleToken({ email: 'other@gmail.com', email_verified: false }));
    expect(unverified.body.user.email).toBe('ada@gmail.com');

    await signUp({ email: 'taken@gmail.com' });
    const taken = await googleLogin(googleToken({ email: 'taken@gmail.com' }));
    expect(taken.status).toBe(200); // still logs in
    expect(taken.body.user.email).toBe('ada@gmail.com');
  });

  it('refuses a disabled account (403)', async () => {
    const first = await googleLogin(googleToken());
    await pool.query('UPDATE users SET disabled_at = NOW() WHERE id = $1', [first.body.user.id]);
    expect((await googleLogin(googleToken())).status).toBe(403);
  });
});
