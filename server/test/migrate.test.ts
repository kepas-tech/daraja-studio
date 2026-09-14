import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureTestOrg, TEST_ORG_ID } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: Db;

beforeAll(async () => {
  db = createPool(url);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});
afterAll(async () => { await ensureTestOrg(db); await db.end(); });

describe('migrate', () => {
  it('applies 001 and is idempotent', async () => {
    const first = await migrate(db, dir);
    expect(first).toContain('001');
    const second = await migrate(db, dir);
    expect(second).toEqual([]);
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['settings','people','permissions','sessions','login_attempts','audit_log','jobs','cache','callbacks_raw','requests','balances','operators','schema_migrations']) {
      expect(names).toContain(t);
    }
  });
  it('audit_log rejects updates and deletes', async () => {
    await ensureTestOrg(db);
    db.setFallbackOrg(TEST_ORG_ID);
    await db.query(`INSERT INTO audit_log(action) VALUES ('t')`);
    await expect(db.query(`UPDATE audit_log SET action='x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
});
