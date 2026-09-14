import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, withOrg, type Db } from '../src/db/pool.js';
import { createCache } from '../src/db/cache.js';
import { resetTables, TEST_ORG_ID } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
let db: Db;
beforeAll(async () => { db = createPool(url); await resetTables(db); });
afterAll(() => db.end());

describe('cache', () => {
  it('sets, gets, expires', async () => {
    const c = createCache(db);
    await c.set('k', { a: 1 }, 60);
    expect(await c.get<{ a: number }>('k')).toEqual({ a: 1 });
    await c.set('k2', 'v', -1);
    expect(await c.get('k2')).toBeNull();
    await c.del('k');
    expect(await c.get('k')).toBeNull();
  });

  it('namespaces by organisation, and leaves install-wide keys bare', async () => {
    const c = createCache(db);
    await c.set('bare', 1, 60);
    await withOrg(TEST_ORG_ID, () => c.set('mine', 2, 60));
    const keys = (await db.query<{ key: string }>('SELECT key FROM cache ORDER BY key')).map((r) => r.key);
    expect(keys).toContain('bare');
    expect(keys).toContain(`org:${TEST_ORG_ID}:mine`);
    expect(await withOrg(TEST_ORG_ID, () => c.get('mine'))).toBe(2);
    expect(await c.get('mine')).toBeNull();
  });
});
