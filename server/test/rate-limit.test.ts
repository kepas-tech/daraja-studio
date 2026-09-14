import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { resetContextForTests, type Db } from '../src/db/pool.js';
import { hit } from '../src/util/rateLimit.js';
import { ANON_PER_MINUTE, isSafaricomPath } from '../src/http/rateLimit.js';
import { housekeepingHandler } from '../src/scheduler/handlers.js';
import { makeApp, makePerson, loginAs, resetTables, TEST_ORG_ID } from './helpers.js';

const single = makeApp();

afterAll(async () => {
  // Leave rate_limits clean too: this file's counters must not leak into a file that runs after it.
  await resetTables();
  await single.close();
  resetContextForTests();
});

beforeEach(async () => {
  await resetTables();
  await makePerson(single.deps.db, TEST_ORG_ID, { username: 'owner', password: 'correct horse', displayName: 'Owner', isOwner: true, role: 'owner' });
});

describe('hit()', () => {
  it('counts inside the window, flips past the maximum, and restarts once the window is over', async () => {
    const db: Db = single.deps.db;
    expect(await hit(db, 'k:one', 2, 60)).toMatchObject({ hits: 1, exceeded: false });
    expect(await hit(db, 'k:one', 2, 60)).toMatchObject({ hits: 2, exceeded: false });
    expect(await hit(db, 'k:one', 2, 60)).toMatchObject({ hits: 3, exceeded: true });
    // Age the window rather than sleeping for it.
    await db.query(`UPDATE rate_limits SET window_start = now() - interval '2 minutes' WHERE key = 'k:one'`);
    expect(await hit(db, 'k:one', 2, 60)).toMatchObject({ hits: 1, exceeded: false });
  });

  it('reports how long the window has left', async () => {
    const s = await hit(single.deps.db, 'k:two', 1, 3600);
    expect(s.retryAfterSeconds).toBeGreaterThan(3500);
    expect(s.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });
});

describe('isSafaricomPath', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';

  it.each([
    '/send/phone',
    '/balances/refresh',
    '/lookup',
    `/requests/${UUID}/check`,
    '/settings/environments/production/daraja',
    '/settings/environments/production/shortcode',
    '/settings/environments/production/operators',
    `/settings/operators/${UUID}/probe`,
    `/settings/operators/${UUID}/rotate`,
    '/settings/public-url/test',
    '/setup/daraja',
    '/setup/shortcode',
    '/setup/operator',
    '/setup/public-url/test',
    '/signup/operator',
    '/auth/recover/start',
  ])('matches %s, a real route that reaches Safaricom', (path) => {
    expect(isSafaricomPath(path)).toBe(true);
  });

  it.each([
    `/requests/${UUID}/checked`,
    `/settings/operators/${UUID}/disable`,
    '/settings/mode',
    '/setup/environment',
  ])('does not match %s, a real route that never reaches Safaricom', (path) => {
    expect(isSafaricomPath(path)).toBe(false);
  });
});

describe('single mode', () => {
  it('has no rate limit beyond the login lockout', async () => {
    const { cookie, csrf } = await loginAs(single.app, 'owner', 'correct horse');
    await single.deps.db.query(
      `INSERT INTO rate_limits(key, hits, window_start) VALUES ($1, 100000, now()) ON CONFLICT (key) DO UPDATE SET hits = 100000`,
      [`org:${TEST_ORG_ID}:mutations`],
    );
    const r = await request(single.app).post('/api/auth/logout').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(r.status).toBe(204);
  });

  it('does not meter anonymous mutations either', async () => {
    for (let i = 0; i < ANON_PER_MINUTE; i++) await hit(single.deps.db, 'anon:ip:::ffff:127.0.0.1', ANON_PER_MINUTE, 60);
    for (let i = 0; i < ANON_PER_MINUTE; i++) await hit(single.deps.db, 'anon:ip:127.0.0.1', ANON_PER_MINUTE, 60);
    const r = await request(single.app).post('/api/auth/login').send({ username: 'nobody', password: 'whatever' });
    expect(r.status).not.toBe(429);
  });
});

describe('housekeeping', () => {
  it('deletes rate-limit windows that can no longer be current', async () => {
    const db = single.deps.db;
    await db.query(`INSERT INTO rate_limits(key, hits, window_start) VALUES ('old', 3, now() - interval '2 days')`);
    await db.query(`INSERT INTO rate_limits(key, hits, window_start) VALUES ('fresh', 3, now())`);
    await housekeepingHandler({ db })({}, { id: 'j', kind: 'housekeeping', payload: {}, attempts: 1, max_attempts: 1, recurring: true });
    const rows = await db.query<{ key: string }>('SELECT key FROM rate_limits ORDER BY key');
    expect(rows.map((r) => r.key)).toEqual(['fresh']);
  });
});
