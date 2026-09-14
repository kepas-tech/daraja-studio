import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { withOrg } from '../src/db/pool.js';
import { decrypt, encrypt } from '../src/crypto/secrets.js';
import { makeApp, loginAsOwner } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(async () => { await close(); });

describe('withOrg', () => {
  it('refuses an empty organisation id instead of quietly seeing nothing', async () => {
    await expect(withOrg('', async () => 1)).rejects.toThrow('withOrg needs an organisation id');
  });
});

describe('decrypt', () => {
  const key = Buffer.alloc(32, 7);
  const packed = encrypt(key, 'hello');

  it('still reads what encrypt wrote', () => {
    expect(decrypt(key, packed)).toBe('hello');
  });

  it('refuses a nonce that is not 12 bytes', () => {
    const [v, , tag, ct] = packed.split(':');
    const wrongIv = Buffer.alloc(16, 1).toString('base64');
    expect(() => decrypt(key, [v, wrongIv, tag, ct].join(':'))).toThrow('bad ciphertext format');
  });

  it('refuses an authentication tag that is not 16 bytes', () => {
    const [v, iv, tag, ct] = packed.split(':');
    const shortTag = Buffer.from(tag, 'base64').subarray(0, 12).toString('base64');
    expect(() => decrypt(key, [v, iv, shortTag, ct].join(':'))).toThrow(/authentication tag length/i);
  });
});

describe('the organisation context middleware', () => {
  it('runs for /api and /healthz and for nothing else', async () => {
    const { cookie } = await loginAsOwner(app, deps);
    const real = deps.db.query.bind(deps.db);
    let lookups = 0;
    // Matches loadSession's own UPDATE (server/src/auth/sessions.ts) — if that query is ever
    // reworded, this counter goes to 0 rather than catching the middleware boundary, so a reworded
    // query is the first thing to check if this test goes red.
    deps.db.query = ((sql: string, params?: unknown[]) => {
      if (/UPDATE sessions SET expires_at/.test(sql)) lookups += 1;
      return real(sql, params);
    }) as typeof deps.db.query;
    try {
      await request(app).get('/api/auth/me').set('Cookie', cookie);
      expect(lookups).toBe(1);
      await request(app).get('/healthz').set('Cookie', cookie);
      expect(lookups).toBe(2);
      // A static asset or the SPA shell carries no organisation-scoped data: no session read at all.
      await request(app).get('/favicon.ico').set('Cookie', cookie);
      await request(app).get('/some/page').set('Cookie', cookie);
      expect(lookups).toBe(2);
    } finally {
      deps.db.query = real;
    }
  });
});
