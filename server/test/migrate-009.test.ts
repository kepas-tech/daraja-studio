import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ensureTestOrg } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: Db;

beforeAll(() => { db = createPool(url); });
afterAll(async () => { await ensureTestOrg(db); await db.end(); });

describe('migration 009', () => {
  it('adds a case-insensitive unique index on username, and is a no-op the second time', async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const applied = await migrate(db, migrationsDir);
    expect(applied).toContain('009');

    const idx = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'people' AND indexname = 'people_username_lower_uniq'`,
    );
    expect(idx).toHaveLength(1);

    expect(await migrate(db, migrationsDir)).toEqual([]);
  });
});
