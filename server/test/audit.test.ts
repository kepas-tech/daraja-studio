import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, type Db } from '../src/db/pool.js';
import { audit } from '../src/audit/log.js';
import { ensureTestOrg, TEST_ORG_ID } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
let db: Db;
beforeAll(async () => {
  db = createPool(url);
  await ensureTestOrg();
  db.setFallbackOrg(TEST_ORG_ID);
});
afterAll(() => db.end());

describe('audit', () => {
  it('appends a row', async () => {
    await audit(db, { action: 'settings.set', target: 'org.name', before: null, after: 'APIONE', ip: '127.0.0.1' });
    const rows = await db.query<{ action: string; after_json: string }>(`SELECT action, after_json FROM audit_log WHERE target='org.name' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].action).toBe('settings.set');
    expect(rows[0].after_json).toBe('APIONE');
  });
});
