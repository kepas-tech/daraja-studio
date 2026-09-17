import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { hashPassword } from '../src/auth/password.js';
import { MAX_FAILURES } from '../src/auth/lockout.js';
import { makeApp, resetTables } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(close);

async function seedOwner() {
  await deps.db.query(
    `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner',$1,true)`,
    [await hashPassword('correct horse')],
  );
}

describe('auth', () => {
  beforeEach(async () => { await resetTables(deps.db); await seedOwner(); });

  it('logs in, sets cookie, returns csrf, /me works', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
    expect(r.status).toBe(200);
    expect(r.body.person.username).toBe('owner');
    expect(r.body.csrf).toMatch(/^[A-Za-z0-9_-]+$/);
    const cookie = r.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.person.is_owner).toBe(true);
    expect(me.body.person.password_hash).toBeUndefined();
    // Home's header: the environment in use, its shortcode and the name Safaricom holds for it.
    expect(me.body.org).toMatchObject({ environment: 'sandbox', shortcode: null, safaricomName: null });
    await deps.settings.set('env.sandbox.shortcode', '600999');
    await deps.settings.set('env.sandbox.safaricomName', 'ACME TRADERS');
    const again = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(again.body.org).toMatchObject({ shortcode: '600999', safaricomName: 'ACME TRADERS', operatorName: null });
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, environment, verified_at) VALUES ('APIONE API', 'x', 'verified', 'sandbox', now())`);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.org.operatorName).toBe('APIONE API');
  });

  it('rejects wrong password and locks after 5 failures', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'nope' });
      expect(r.status).toBe(401);
    }
    const r = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe('locked');
  });

  it('requires csrf on state-changing calls', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
    const cookie = login.headers['set-cookie'][0];
    const noCsrf = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(noCsrf.status).toBe(403);
    const ok = await request(app).post('/api/auth/logout').set('Cookie', cookie).set('x-csrf-token', login.body.csrf);
    expect(ok.status).toBe(204);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
  });

  it('signs out every session, this one included, and only with the password', async () => {
    const first = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
    const second = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
    const other = second.headers['set-cookie'][0];
    // The wrong password ends nothing.
    const wrong = await request(app).post('/api/auth/sign-out-everywhere').set('Cookie', other).set('x-csrf-token', second.body.csrf).send({ password: 'not it' });
    expect(wrong.status).toBe(403);
    expect((await request(app).get('/api/auth/me').set('Cookie', other)).status).toBe(200);
    const done = await request(app).post('/api/auth/sign-out-everywhere').set('Cookie', other).set('x-csrf-token', second.body.csrf).send({ password: 'correct horse' });
    expect(done.status).toBe(204);
    // Both sessions are gone: the one that asked, and the one from the other device.
    expect((await request(app).get('/api/auth/me').set('Cookie', other)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', first.headers['set-cookie'][0])).status).toBe(401);
  });

  it('change-password requires the current password', async () => {
    const login = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
    const cookie = login.headers['set-cookie'][0];
    const bad = await request(app).post('/api/auth/change-password').set('Cookie', cookie).set('x-csrf-token', login.body.csrf)
      .send({ currentPassword: 'wrong', newPassword: 'new long password' });
    expect(bad.status).toBe(403);
    const good = await request(app).post('/api/auth/change-password').set('Cookie', cookie).set('x-csrf-token', login.body.csrf)
      .send({ currentPassword: 'correct horse', newPassword: 'new long password' });
    expect(good.status).toBe(204);
    const relogin = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'new long password' });
    expect(relogin.status).toBe(200);
  });

  it('gives identical 401s for an unknown username and a wrong password for a known one', async () => {
    const unknown = await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'whatever-1234' });
    const wrongPw = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'wrong-password' });
    expect(unknown.status).toBe(401);
    expect(wrongPw.status).toBe(401);
    expect(unknown.body.error).toEqual(wrongPw.body.error);
    const rows = await deps.db.query<{ key: string }>('SELECT key FROM login_attempts ORDER BY key');
    const keys = rows.map((row) => row.key);
    expect(keys).toContain('u:ghost');
    expect(keys).toContain('u:owner');
    expect(keys.some((k) => k.startsWith('ip:'))).toBe(true);
  });

  it('locks atomically under a concurrent wrong-password burst', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post('/api/auth/login').send({ username: 'owner', password: 'nope' })),
    );
    const rows = await deps.db.query<{ failures: number; locked_until: Date | null }>(
      'SELECT failures, locked_until FROM login_attempts WHERE key=$1', ['u:owner'],
    );
    // Postgres serializes the conflicting upserts one at a time, so once the lock engages the
    // remaining attempts in the same burst must not keep incrementing (that is the A2 fix) — the
    // count stops at MAX_FAILURES+1 instead of reaching 10.
    expect(rows[0]?.failures).toBe(MAX_FAILURES + 1);
    expect(rows[0]?.locked_until).not.toBeNull();
    expect(rows[0]!.locked_until!.getTime()).toBeGreaterThan(Date.now());
    const r = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe('locked');
  });
});
